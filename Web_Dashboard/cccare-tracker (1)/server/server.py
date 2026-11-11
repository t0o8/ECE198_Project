"""Reference backend for the CCCARE dashboard.

It serves the website and the REST API described in ../API.md from one address, keeps
everything in a JSON file, and checks sign-ins on the server (passwords are stored as
salted PBKDF2 hashes). It uses only Python's standard library.

    python3 server/server.py                 then open http://localhost:8000
    python3 server/server.py --port 9000 --data /path/to/data.json
    python3 server/server.py --host 0.0.0.0  let other devices on the network connect

The first run creates the sample accounts InsU / InsP (instructor) and PatU / PatP
(patient, block 01), unless --no-sample-accounts is given.

This is a starting point to copy from or replace, not a hardened production server: run
it behind HTTPS (a reverse proxy) before real patient data goes near it, and see the
privacy notes in the README.
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
from http import HTTPStatus
from io import BytesIO
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

SITE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MAX_BODY = 4 * 1024 * 1024  # bytes; a session for 30 people is well under this
MAX_PARTICIPANTS = 30
TOKEN_HOURS = 12
USERNAME = re.compile(r'^[A-Za-z0-9._-]{3,24}$')
PHOTO = re.compile(r'^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$')
BIRTHDAY = re.compile(r'^\d{4}-\d{2}-\d{2}$')
SAMPLE_ACCOUNTS = [('InsU', 'InsP', 'instructor', None), ('PatU', 'PatP', 'patient', 'P01')]


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------- storage ----------


class Store:
    """All data in one JSON file. Every change is written to a temporary file first and
    then moved into place, so a crash can't leave half a file."""

    def __init__(self, path, sample_accounts):
        self.path = path
        self.lock = threading.Lock()
        self.data = {'accounts': {}, 'tokens': {}, 'roster': [], 'sessions': [], 'profiles': {}, 'live': None}
        if os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                self.data.update(json.load(f))
        if sample_accounts and not self.data['accounts']:
            for username, password, role, pid in SAMPLE_ACCOUNTS:
                self.data['accounts'][username.lower()] = account_record(username, password, role, pid)
            print('Created the sample accounts InsU / InsP and PatU / PatP.', flush=True)
        self.save()

    def save(self):
        tmp = self.path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(self.data, f)
        os.replace(tmp, self.path)


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 200_000)
    return salt.hex(), digest.hex()


def account_record(username, password, role, pid):
    salt, digest = hash_password(password)
    return {'username': username, 'role': role, 'participantId': pid, 'salt': salt, 'hash': digest}


def public_account(a):
    return {'username': a['username'], 'role': a['role'], 'participantId': a.get('participantId')}


def token_key(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


# ---------- request handling ----------


class Handler(SimpleHTTPRequestHandler):
    server_version = 'CCCARE/1'
    store = None
    cors_origin = '*'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE, **kwargs)

    # Quieter log: one line per request.
    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))

    # ----- static files -----

    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def send_head(self):
        path = urlsplit(self.path).path
        # The data file and this script are not part of the website.
        if path.startswith('/server/') or path == '/server':
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        # The site's config file, pointing the pages at this server's API.
        if path == '/js/config.js':
            body = b"window.CC = window.CC || {};\nwindow.CC.CONFIG = { apiBase: '/api' };\n"
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            return BytesIO(body)
        return super().send_head()

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        super().end_headers()

    # ----- API -----

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Max-Age', '600')
        # Lets a page served over the internet (for example GitHub Pages) reach a server
        # on localhost or the local network in Chrome.
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()

    def do_GET(self):
        if self.is_api():
            return self.api('GET')
        return super().do_GET()

    def do_HEAD(self):
        if self.is_api():
            return self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
        return super().do_HEAD()

    def do_POST(self):
        return self.api('POST') if self.is_api() else self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    def do_PUT(self):
        return self.api('PUT') if self.is_api() else self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    def is_api(self):
        p = urlsplit(self.path).path
        return p == '/api' or p.startswith('/api/')

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', self.cors_origin)
        self.send_header('Vary', 'Origin')

    def reply(self, status, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            raise ApiError(400, 'Bad Content-Length.')
        if length > MAX_BODY:
            raise ApiError(413, 'That request is too large.')
        raw = self.rfile.read(length) if length else b''
        if not raw:
            return None
        try:
            return json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, 'The request body isn’t valid JSON.')

    def signed_in(self):
        """The account for the request's Bearer token, or a 401."""
        header = self.headers.get('Authorization') or ''
        if not header.startswith('Bearer '):
            raise ApiError(401, 'Sign in first.')
        rec = self.store.data['tokens'].get(token_key(header[7:].strip()))
        if not rec or rec['expires'] < time.time():
            raise ApiError(401, 'Your sign-in has expired. Sign in again.')
        account = self.store.data['accounts'].get(rec['username'].lower())
        if not account:
            raise ApiError(401, 'That account no longer exists.')
        return account

    def instructor(self):
        a = self.signed_in()
        if a['role'] != 'instructor':
            raise ApiError(403, 'Only instructors can do that.')
        return a

    def api(self, method):
        path = unquote(urlsplit(self.path).path)[len('/api'):] or '/'
        try:
            with self.store.lock:
                status, data = self.route(method, path)
            self.reply(status, data)
        except ApiError as e:
            self.reply(e.status, {'error': e.message})
        except Exception as e:  # never send a stack trace to the browser
            self.log_error('API error: %r', e)
            self.reply(500, {'error': 'The server hit an unexpected error.'})

    # ----- routes -----

    def route(self, method, path):
        s = self.store
        d = s.data

        if path == '/health' and method == 'GET':
            return 200, {'ok': True}

        # --- accounts ---
        if path == '/auth/signin' and method == 'POST':
            b = self.body() or {}
            username = str(b.get('username') or '').strip()
            password = str(b.get('password') or '')
            a = d['accounts'].get(username.lower())
            ok = False
            if a:
                _, digest = hash_password(password, bytes.fromhex(a['salt']))
                ok = hmac.compare_digest(digest, a['hash'])
            if not ok:
                time.sleep(0.3)  # slows down password guessing
                raise ApiError(401, 'That username and password don’t match an account.')
            return 200, self.new_token(a)

        if path == '/auth/signup' and method == 'POST':
            b = self.body() or {}
            username = str(b.get('username') or '').strip()
            password = str(b.get('password') or '')
            role = b.get('role')
            if not USERNAME.match(username):
                raise ApiError(400, 'Usernames are 3 to 24 letters, numbers, dots, dashes or underscores.')
            if username.lower() in d['accounts']:
                raise ApiError(409, 'That username is taken. Choose another.')
            if len(password) < 4:
                raise ApiError(400, 'Use a password of at least 4 characters.')
            if role not in ('instructor', 'patient'):
                raise ApiError(400, 'Choose instructor or patient.')
            pid = None
            if role == 'patient':
                used = {a.get('participantId') for a in d['accounts'].values()}
                free = [f'P{n:02d}' for n in range(1, MAX_PARTICIPANTS + 1) if f'P{n:02d}' not in used]
                if not free:
                    raise ApiError(409, f'All {MAX_PARTICIPANTS} patient places are taken.')
                pid = free[0]
                # Shows the new patient's username on the roster until the instructor names them.
                slot = next((x for x in d['roster'] if x.get('id') == pid), None)
                if slot is None:
                    d['roster'].append({'id': pid, 'name': username})
                elif not slot.get('name'):
                    slot['name'] = username
            a = account_record(username, password, role, pid)
            d['accounts'][username.lower()] = a
            return 201, self.new_token(a)

        if path == '/auth/signout' and method == 'POST':
            header = self.headers.get('Authorization') or ''
            if header.startswith('Bearer '):
                d['tokens'].pop(token_key(header[7:].strip()), None)
                s.save()
            return 200, {'ok': True}

        # --- roster ---
        if path == '/roster' and method == 'GET':
            me = self.signed_in()
            if me['role'] == 'patient':  # a patient only sees their own place
                return 200, [x for x in d['roster'] if x.get('id') == me.get('participantId')]
            return 200, d['roster']
        if path == '/roster' and method == 'PUT':
            self.instructor()
            b = self.body()
            if not isinstance(b, list) or len(b) > MAX_PARTICIPANTS or not all(isinstance(x, dict) and isinstance(x.get('id'), str) for x in b):
                raise ApiError(400, f'Send a list of up to {MAX_PARTICIPANTS} places, each with an id.')
            d['roster'] = b
            s.save()
            return 200, {'ok': True}

        # --- sessions ---
        if path == '/sessions' and method == 'GET':
            me = self.signed_in()
            if me['role'] == 'patient':  # only sessions they were in, and only their own result
                pid = me.get('participantId')
                out = []
                for sess in d['sessions']:
                    mine = [p for p in sess.get('participants', []) if p.get('id') == pid]
                    if mine:
                        out.append(dict(sess, participants=mine))
                return 200, out
            return 200, d['sessions']
        if path == '/sessions' and method == 'POST':
            self.instructor()
            b = self.body()
            if not (isinstance(b, dict) and isinstance(b.get('id'), str) and isinstance(b.get('participants'), list)):
                raise ApiError(400, 'A session needs an id and a list of participants.')
            if len(b['participants']) > MAX_PARTICIPANTS:
                raise ApiError(400, f'A session has at most {MAX_PARTICIPANTS} participants.')
            d['sessions'] = [x for x in d['sessions'] if x.get('id') != b['id']] + [b]
            s.save()
            return 201, {'ok': True, 'id': b['id']}

        # --- profiles ---
        m = re.fullmatch(r'/profiles/([^/]+)', path)
        if m:
            me = self.signed_in()
            who = m.group(1).strip().lower()
            if method == 'GET':
                if who != me['username'].lower() and me['role'] != 'instructor':
                    raise ApiError(403, 'You can only see your own profile.')
                return 200, d['profiles'].get(who, {'nickname': '', 'bio': '', 'birthday': '', 'photo': ''})
            if method == 'PUT':
                if who != me['username'].lower():
                    raise ApiError(403, 'You can only change your own profile.')
                b = self.body()
                if not isinstance(b, dict):
                    raise ApiError(400, 'Send a profile object.')
                bio = str(b.get('bio') or '')
                nickname = ' '.join(str(b.get('nickname') or '').split())
                birthday = str(b.get('birthday') or '')
                photo = str(b.get('photo') or '')
                if len(nickname) > 30:
                    raise ApiError(400, 'Nicknames are limited to 30 characters.')
                if len(bio) > 500:
                    raise ApiError(400, 'The biography is limited to 500 characters.')
                if birthday and not BIRTHDAY.match(birthday):
                    raise ApiError(400, 'Birthdays are written YYYY-MM-DD.')
                if photo and (len(photo) > 300_000 or not PHOTO.match(photo)):
                    raise ApiError(400, 'The picture must be a JPEG, PNG or WebP data URL under 300 KB.')
                d['profiles'][who] = {'nickname': nickname, 'bio': bio, 'birthday': birthday, 'photo': photo}
                s.save()
                return 200, {'ok': True}

        # --- live session ---
        if path == '/live' and method == 'GET':
            me = self.signed_in()
            live = d.get('live')
            if not live:
                return 200, None
            out = dict(live)
            out['ageMs'] = int((time.time() - live.get('_receivedAt', time.time())) * 1000)
            out.pop('_receivedAt', None)
            if me['role'] == 'patient' and isinstance(out.get('participants'), dict):
                pid = me.get('participantId')
                out['participants'] = {k: v for k, v in out['participants'].items() if k == pid}
            return 200, out
        if path == '/live' and method == 'PUT':
            self.instructor()
            b = self.body()
            if not (isinstance(b, dict) and isinstance(b.get('id'), str) and b.get('state') in ('live', 'ended', 'abandoned')):
                raise ApiError(400, 'A live update needs an id and a state of live, ended or abandoned.')
            b['_receivedAt'] = time.time()
            d['live'] = b  # kept in memory only: it changes twice a second
            return 200, {'ok': True}

        # --- reset to sample data ---
        if path == '/reset' and method == 'POST':
            self.instructor()
            b = self.body() or {}
            sessions = b.get('sessions')
            if not isinstance(sessions, list):
                raise ApiError(400, 'Send the sample sessions to start again with.')
            d['sessions'] = sessions
            d['roster'] = []
            d['live'] = None
            s.save()
            return 200, {'ok': True}

        raise ApiError(404, 'There’s no such API address.')

    def new_token(self, account):
        token = secrets.token_urlsafe(32)
        now = time.time()
        tokens = self.store.data['tokens']
        for k in [k for k, v in tokens.items() if v['expires'] < now]:  # forget expired ones
            del tokens[k]
        tokens[token_key(token)] = {'username': account['username'], 'expires': now + TOKEN_HOURS * 3600}
        self.store.save()
        return {'account': public_account(account), 'token': token}


def main():
    ap = argparse.ArgumentParser(description='Reference backend for the CCCARE dashboard.')
    ap.add_argument('--host', default='127.0.0.1', help='address to listen on (default 127.0.0.1, this computer only)')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--data', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data.json'),
                    help='JSON file to keep the data in (default server/data.json)')
    ap.add_argument('--cors-origin', default='*',
                    help='site allowed to call the API from another address, e.g. https://nugget5637.github.io (default any)')
    ap.add_argument('--no-sample-accounts', action='store_true', help='don’t create InsU / PatU on the first run')
    args = ap.parse_args()

    Handler.store = Store(args.data, not args.no_sample_accounts)
    Handler.cors_origin = args.cors_origin
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    shown = 'localhost' if args.host in ('127.0.0.1', '0.0.0.0', '') else args.host
    print(f'CCCARE dashboard and API on http://{shown}:{args.port}  (data: {args.data})', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()

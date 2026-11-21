"""
Flask server that joins the MediaPipe exercise tracker to the CCCARE web dashboard.

    python app.py                      then open http://localhost:8000
    python app.py --camera 1           use another camera (see find_cameras.py)
    python app.py --pid P03            the camera's person is block P03
    python app.py --host 0.0.0.0       let other devices on the network connect

It serves, from one address:
    /                 the dashboard (eb/Web_Dashboard/cccare-tracker (1))
    /api/...          the dashboard's backend API (the same code as its server/server.py)
    /feed             WebSocket: live reps, motion and posture from the camera
    /camera           a page with the annotated camera picture and the safety controls
    /camera/stream    the annotated camera picture as an MJPEG stream

The instructor page connects to /feed by itself when the site is opened from this server.
"""

import argparse
import json
import os
import queue
import sys

from flask import Flask, Response, abort, jsonify, request, send_from_directory
from flask_sock import Sock
from simple_websocket import ConnectionClosed

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.abspath(os.path.join(HERE, '..', 'Web_Dashboard', 'cccare-tracker (1)'))
sys.path.insert(0, os.path.join(SITE, 'server'))

import server as dashboard_api  # noqa: E402  the dashboard's reference backend
from camera_pipeline import CameraPipeline  # noqa: E402

app = Flask(__name__, static_folder=None)
app.config['SOCK_SERVER_OPTIONS'] = {'ping_interval': 20}
sock = Sock(app)
pipeline = None  # set in main()

# Sent instead of js/config.js: use this server's API, and (once per browser tab, unless
# ?feed= is in the address) this server's camera feed.
CONFIG_JS = """window.CC = window.CC || {};
window.CC.CONFIG = { apiBase: '/api' };
try {
  if (!new URLSearchParams(location.search).has('feed') && !sessionStorage.getItem('cccare.feedAuto')) {
    sessionStorage.setItem('cccare.feed', (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/feed');
    sessionStorage.setItem('cccare.feedAuto', '1');
  }
} catch (e) { /* storage blocked: the simulator is used */ }
"""


# ---------- dashboard website ----------

@app.get('/js/config.js')
def config_js():
    return Response(CONFIG_JS, mimetype='text/javascript', headers={'Cache-Control': 'no-store'})


@app.get('/')
@app.get('/<path:path>')
def site(path='index.html'):
    if path == 'server' or path.startswith('server/'):
        abort(404)  # the data file and backend code are not part of the website
    if os.path.isdir(os.path.join(SITE, path)):
        path = os.path.join(path, 'index.html')
    return send_from_directory(SITE, path)


# ---------- dashboard API: reuses server.py's routes so there is one copy of the rules ----------

class _ApiRequest(dashboard_api.Handler):
    """Runs server.py's Handler.route() on a Flask request instead of a raw socket."""

    def __init__(self, headers, raw):  # deliberately skips the socket set-up
        self.headers = headers
        self._raw = raw

    def body(self):
        if len(self._raw) > dashboard_api.MAX_BODY:
            raise dashboard_api.ApiError(413, 'That request is too large.')
        if not self._raw:
            return None
        try:
            return json.loads(self._raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise dashboard_api.ApiError(400, 'The request body isn’t valid JSON.')


@app.route('/api', defaults={'path': ''}, methods=['GET', 'POST', 'PUT'])
@app.route('/api/<path:path>', methods=['GET', 'POST', 'PUT'])
def api(path):
    handler = _ApiRequest(request.headers, request.get_data())
    try:
        with handler.store.lock:
            status, data = handler.route(request.method, '/' + path)
    except dashboard_api.ApiError as e:
        status, data = e.status, {'error': e.message}
    except Exception as e:  # never send a stack trace to the browser
        app.logger.exception('API error: %r', e)
        status, data = 500, {'error': 'The server hit an unexpected error.'}
    return Response(json.dumps(data), status=status, mimetype='application/json',
                    headers={'Cache-Control': 'no-store'})


# ---------- camera ----------

@sock.route('/feed')
def feed(ws):
    """The instructor page's live feed. Sends events as JSON arrays; receives session messages."""
    pipeline.start()
    q = pipeline.subscribe()
    try:
        while True:
            msg = ws.receive(timeout=0.05)
            if msg is not None:
                pipeline.on_dashboard_message(msg)
            batch = []
            try:
                while len(batch) < 50:
                    batch.append(q.get_nowait())
            except queue.Empty:
                pass
            if batch:
                ws.send(json.dumps(batch))
    except ConnectionClosed:
        pass
    finally:
        pipeline.unsubscribe(q)


@app.get('/camera')
def camera_page():
    return send_from_directory(HERE, 'camera.html')


@app.get('/camera/stream')
def camera_stream():
    pipeline.start()

    def frames():
        last = -1
        while True:
            last, jpeg = pipeline.wait_for_frame(last)
            if not pipeline.running and jpeg is None:
                return
            if jpeg:
                yield b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + jpeg + b'\r\n'
            if not pipeline.running:
                return

    return Response(frames(), mimetype='multipart/x-mixed-replace; boundary=frame',
                    headers={'Cache-Control': 'no-store'})


@app.get('/camera/status')
def camera_status():
    return jsonify(pipeline.snapshot())


@app.post('/camera/<action>')
def camera_action(action):
    if action == 'start':
        pipeline.start()
    elif action == 'clear':
        pipeline.clear_alert()
    elif action == 'reset':
        pipeline.reset()
    else:
        abort(404)
    return jsonify(pipeline.snapshot())


def main():
    global pipeline
    ap = argparse.ArgumentParser(description='CCCARE dashboard + MediaPipe camera feed (Flask).')
    ap.add_argument('--host', default='127.0.0.1')
    # Not 5000: on macOS the AirPlay Receiver already uses port 5000 and answers 403.
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--camera', type=int, default=0, help='camera index (run find_cameras.py)')
    ap.add_argument('--pid', default=None, help='block the camera watches, e.g. P01 (default: first in the session)')
    ap.add_argument('--data', default=os.path.join(HERE, 'data.json'), help='where the dashboard data is kept')
    ap.add_argument('--no-sample-accounts', action='store_true')
    args = ap.parse_args()

    dashboard_api.Handler.store = dashboard_api.Store(args.data, not args.no_sample_accounts)
    pipeline = CameraPipeline(args.camera, args.pid)
    # Open the camera here, on the main thread: on macOS that is the only place OpenCV can
    # ask for camera permission. The tracking itself then runs in a background thread.
    print(f'Opening camera {args.camera}...', flush=True)
    if pipeline.open_camera():
        pipeline.start()
    else:
        print(f'Could not open camera {args.camera}. On a Mac, allow camera access for the app running '
              'Python (System Settings > Privacy & Security > Camera: Terminal or PyCharm), restart it, '
              'and run this again. Or try --camera 1. The dashboard still works, with the simulator.', flush=True)
    shown = 'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host
    print(f'Dashboard: http://{shown}:{args.port}    Camera view: http://{shown}:{args.port}/camera', flush=True)
    # threaded: the MJPEG stream and the WebSocket each hold a request open.
    app.run(host=args.host, port=args.port, threaded=True, debug=False)


if __name__ == '__main__':
    main()

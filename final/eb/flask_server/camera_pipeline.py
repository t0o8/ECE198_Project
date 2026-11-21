"""
Runs the MediaPipe exercise tracker (../../mediapipe_pose_safety) in a background thread
and turns what it sees into the dashboard's live-feed events (see the dashboard README,
"Connecting the camera, neural network and ESP32"):

    {"type": "rep",     "pid": "P01", "quality": 90, "faults": [], "exercise": "squat"}
    {"type": "motion",  "pid": "P01", "level": 0.6}
    {"type": "posture", "pid": "P01", "posture": "upright" | "floor" | "fallen"}

The tracker's own logic (recognizer.py, exercises.py, safety.py, pose_utils.py) is used
as it is. Instead of cv2.imshow, the annotated picture is kept as a JPEG so Flask can
stream it to a web page.

One camera watches one person, so every event is sent for one block (pid). It is the
--pid given to app.py, or else the first participant of the session the instructor starts.
"""

import json
import math
import os
import queue
import sys
import threading
import time
from collections import deque

import cv2

TRACKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'mediapipe_pose_safety'))
if TRACKER_DIR not in sys.path:
    sys.path.insert(0, TRACKER_DIR)

import mediapipe as mp  # noqa: E402
from mediapipe.tasks import python as mp_python  # noqa: E402
from mediapipe.tasks.python import vision  # noqa: E402

from pose_utils import (MODEL_PATH, download_model_if_needed, compute_features,  # noqa: E402
                        LANDMARKS, MIN_VISIBILITY)
from exercises import make_counters, DISPLAY_NAMES  # noqa: E402
from recognizer import ExerciseRecognizer  # noqa: E402
from camera_stream import open_source  # noqa: E402
from safety import SafetyMonitor  # noqa: E402
from exercise_tracker import (Session, draw_body, draw_panel, draw_counter, draw_safety,  # noqa: E402
                              LOOKBACK_SECONDS, YELLOW)

# Tracker exercise names -> dashboard exercise codes (js/exercises.js).
EXERCISE_CODES = {'squat': 'squat', 'pushup': 'push_up', 'curl': 'bicep_curl'}

# ---- rep scoring ----
# Each rep gets a 0-100 score from how close it came to the targets. The targets are YOUR
# numbers in mediapipe_pose_safety/exercises.py, so that is the one place to tune:
#   depth: full marks at GOOD_DEPTH (squat, push-up) or GOOD_TOP (curl); zero depth marks at
#          the shallowest rep that still counts (bottom / MIN_BEND). Worth 50 points.
#   form:  full marks within MAX_TORSO_LEAN / MIN_BODY_LINE / MAX_SWING, zero marks a little
#          past them (FORM_SLACK degrees). Worth 20 points.
# A rep scoring GOOD_SCORE or more is "good". Restart app.py after changing exercises.py.
# Each rule: (measurement, 'low' / 'high' / 'range' of the rep, full marks at, zero marks at,
# points it is worth, fault code).
DEPTH_POINTS = 50
FORM_POINTS = 20
FORM_SLACK = {'torso_lean': 25, 'body_line': 30, 'swing': 20}


def _scoring_rules():
    from exercises import SquatCounter as Sq, PushupCounter as Pu, CurlCounter as Cu
    return {
        'squat': [('knee', 'low', Sq.GOOD_DEPTH, Sq.bottom, DEPTH_POINTS, 'shallow'),
                  ('torso_lean', 'high', Sq.MAX_TORSO_LEAN, Sq.MAX_TORSO_LEAN + FORM_SLACK['torso_lean'],
                   FORM_POINTS, 'back_round')],
        'pushup': [('elbow', 'low', Pu.GOOD_DEPTH, Pu.bottom, DEPTH_POINTS, 'short_range'),
                   ('body_line', 'low', Pu.MIN_BODY_LINE, Pu.MIN_BODY_LINE - FORM_SLACK['body_line'],
                    FORM_POINTS, 'hips_sag')],
        'curl': [('elbow', 'low', Cu.GOOD_TOP, Cu.MIN_BEND, DEPTH_POINTS, 'low_curl'),
                 ('swing', 'range', Cu.MAX_SWING, Cu.MAX_SWING + FORM_SLACK['swing'], FORM_POINTS, 'swing')],
    }


SCORING = _scoring_rules()
FAULT_LOSS = 8       # a rule that costs this many points or more is reported as a fault
GOOD_SCORE = 75      # this score or more shows as a good rep on the camera view
MIN_REP_SECONDS = 0.6  # a rep faster than this (down and back up) is jitter, not a rep
MIN_REP_GAP = 0.8      # two reps of the same exercise closer than this = one rep counted twice

MOTION_EVERY = 1.0     # seconds between motion events
POSTURE_EVERY = 5.0    # re-send the posture this often even if unchanged
MOTION_FULL = 0.5      # body points moving this many torso lengths in a second = level 1
FLOOR_HIP = 0.35       # hip lower than this many torso lengths above the ankle = on the floor
                       # (sitting or lying puts the hip at ankle height, about 0; a deep squat
                       # stays around 0.6 or more, so bending or squatting no longer counts)
SMOOTH_FRAMES = 4      # body points are averaged over this many frames: MediaPipe jitters

# ---- noise reduction (see the README's "Noise" section for where these come from) ----
# One Euro filter on every joint angle: smooths a lot while the angle changes slowly (jitter)
# and little while it changes fast (a real rep), so reps are not delayed.
ANGLE_MIN_CUTOFF = 1.0  # Hz. Lower = smoother when still, more lag
ANGLE_BETA = 0.02       # how fast smoothing backs off as the angle moves (per degree/second)
ANGLE_D_CUTOFF = 1.0    # Hz, for the speed estimate inside the filter
SIDE_MARGIN = 0.15      # switch body side only if the other side is this much more visible...
SIDE_SWITCH_FRAMES = 15 # ...for this many frames in a row (about half a second)
HOLD_GAP = 0.4          # tracking lost for less than this (s): hold everything, don't reset

# Pose models: 'full' (default) or 'heavy' (more accurate, slower). See app.py --model.
MODELS = {
    'full': MODEL_PATH,
    'heavy': os.path.join(os.path.dirname(MODEL_PATH), 'pose_landmarker_heavy.task'),
}
HEAVY_URL = ('https://storage.googleapis.com/mediapipe-models/pose_landmarker/'
             'pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task')
POSTURE_HOLD = 2.0     # a new upright / floor reading must hold this long (s) before it is sent
ALERT_CLEAR = 3.0      # a fall alert clears itself once they have stood upright this long (s)
EDGE = 0.01            # a body point this close to (or past) the picture's edge = only partly in view
AWAY_AFTER = 1.0       # nobody in view this long (s) -> tell the dashboard 'away' (out of frame)
JPEG_QUALITY = 70


def _clean_pid(value):
    """'P03', '3' or 3 -> 'P03'; anything else -> None."""
    s = str(value if value is not None else '').strip().upper().lstrip('P')
    return f'P{int(s):02d}' if s.isdigit() and 1 <= int(s) <= 30 else None


class OneEuro:
    """The 1-euro filter (Casiez, Roussel and Vogel, CHI 2012) for one value.

    A low-pass filter whose cut-off rises with speed: heavy smoothing when the value barely
    changes (removes jitter), light smoothing when it changes fast (keeps real movement on time).
    """

    def __init__(self, min_cutoff, beta, d_cutoff):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.t = self.x = None
        self.dx = 0.0

    @staticmethod
    def _alpha(cutoff, dt):
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, t, x):
        if self.t is None or t <= self.t:
            self.t, self.x, self.dx = t, x, 0.0
            return x
        dt = t - self.t
        a_d = self._alpha(self.d_cutoff, dt)
        self.dx = a_d * ((x - self.x) / dt) + (1 - a_d) * self.dx
        a = self._alpha(self.min_cutoff + self.beta * abs(self.dx), dt)
        self.x = a * x + (1 - a) * self.x
        self.t = t
        return self.x


class AngleFilter:
    """A One Euro filter for each joint angle the counters use."""

    def __init__(self):
        self.filters = {}

    def reset(self):
        self.filters = {}

    def __call__(self, t, features):
        out = {}
        for key, value in features.items():
            f = self.filters.get(key)
            if f is None:
                f = self.filters[key] = OneEuro(ANGLE_MIN_CUTOFF, ANGLE_BETA, ANGLE_D_CUTOFF)
            out[key] = f(t, value)
        return out


def _choose_side(landmarks, state):
    """The body side (left / right) to measure, or None if neither is clearly visible.

    Picking the better side afresh every frame made the angles jump between two different
    limbs (for example the curling arm and the resting one), which counted extra reps. Now
    we stay on one side and only switch when the other is clearly better for a while.
    """
    score = {side: min(landmarks[i].visibility for i in ids.values()) for side, ids in LANDMARKS.items()}
    best = max(score, key=score.get)
    current = state['side']
    if current is None or score[current] < MIN_VISIBILITY:
        state['side'] = best if score[best] >= MIN_VISIBILITY else None
        state['frames'] = 0
        return state['side']
    if best != current and score[best] > score[current] + SIDE_MARGIN:
        state['frames'] += 1
        if state['frames'] >= SIDE_SWITCH_FRAMES:
            state['side'], state['frames'] = best, 0
    else:
        state['frames'] = 0
    return state['side']


def _body_points(landmarks, side, width, height):
    """That side's joints in pixels (angles must be measured in pixels, not 0-1 fractions)."""
    points = {'side': side}
    for part, i in LANDMARKS[side].items():
        points[part] = (int(landmarks[i].x * width), int(landmarks[i].y * height))
    return points


def _model_path(name):
    """Path of the pose model, downloading it the first time."""
    if name == 'full':
        download_model_if_needed()
        return MODEL_PATH
    path = MODELS[name]
    if not os.path.exists(path):
        import ssl
        import urllib.request
        import certifi
        print('Downloading the heavy pose model (about 30 MB, only the first time)...', flush=True)
        ctx = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(HEAVY_URL, context=ctx) as r:
            data = r.read()
        with open(path + '.part', 'wb') as f:
            f.write(data)
        os.replace(path + '.part', path)
    return path


def _score_rep(event, low, high):
    """Give the rep a 0-100 score and its faults (see SCORING), and make the camera view's
    GOOD / BAD message agree with that score."""
    score, faults, worst = 100.0, [], (0.0, None)
    for key, kind, full, zero, points, fault in SCORING[event['exercise']]:
        if kind == 'range':      # how much the torso rocked during the rep
            value = high['torso_lean'] - low['torso_lean']
        else:
            value = (low if kind == 'low' else high)[key]
        # 0 = full marks, 1 = zero marks, in between = in proportion
        short = (value - full) / (zero - full)
        loss = points * min(1.0, max(0.0, short))
        score -= loss
        if loss >= FAULT_LOSS:
            faults.append(fault)
        if loss > worst[0]:
            worst = (loss, fault)
    event['quality'] = int(round(score))
    event['faults'] = faults
    event['status'] = 'good' if score >= GOOD_SCORE else 'bad'
    if event['status'] == 'bad' and worst[1]:
        event['msg'] = FAULT_MESSAGES[worst[1]]
    else:
        event['msg'] = f'Good rep! {event["quality"]}%'


# Camera view messages for each fault code (short, so they fit on the picture).
FAULT_MESSAGES = {'shallow': 'Go lower', 'back_round': 'Keep chest up', 'short_range': 'Go lower',
                  'hips_sag': 'Keep body straight', 'low_curl': 'Curl higher', 'swing': "Don't swing"}


def _fully_in_frame(points, width, height):
    """True if every body point is inside the picture, not on or past its edge."""
    mx, my = EDGE * width, EDGE * height
    return all(mx <= points[k][0] <= width - mx and my <= points[k][1] <= height - my
               for k in ('shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'))


def _average_points(frames):
    """Average body points over the last few frames (keeps the newest frame's 'side')."""
    out = {'side': frames[-1]['side']}
    for k in ('shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'):
        out[k] = (int(round(sum(f[k][0] for f in frames) / len(frames))),
                  int(round(sum(f[k][1] for f in frames) / len(frames))))
    return out


class CameraPipeline:
    def __init__(self, camera_index=0, pid=None, model='full'):
        self.camera_index = camera_index
        self.model = model if model in MODELS else 'full'
        self.fixed_pid = pid            # from --pid; None = take it from the session
        self.pid = pid or 'P01'
        self.thread = None
        self.camera = None              # opened early on the main thread (see open_camera)
        self.running = False
        self.lock = threading.Lock()
        self.error = None
        self.subscribers = set()
        self.frame_cond = threading.Condition()
        self.jpeg = None
        self.frame_no = 0
        self._reset_requested = False
        self._clear_requested = False
        self.status = {'exercise': None, 'safety': 'gone', 'alert': None, 'fps': 0.0, 'totals': {}}

    # ---------- control from Flask ----------

    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            self.running = True
            self.error = None
            self.thread = threading.Thread(target=self._run, name='camera', daemon=True)
            self.thread.start()

    def stop(self):
        self.running = False

    def open_camera(self):
        """Open the camera now. Call this from the MAIN thread at start-up: on macOS, OpenCV
        can only ask for camera permission from the main thread. Returns True if it opened."""
        cam = open_source(self.camera_index)
        if cam.is_open():
            self.camera = cam
            return True
        cam.stop()
        return False

    def reset(self):
        self._reset_requested = True

    def clear_alert(self):
        self._clear_requested = True

    def subscribe(self):
        q = queue.Queue(maxsize=1000)
        with self.lock:
            self.subscribers.add(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.subscribers.discard(q)

    def on_dashboard_message(self, text):
        """Messages the instructor's page sends: session start / pause / resume / end."""
        try:
            msg = json.loads(text)
        except (TypeError, ValueError):
            return
        if not isinstance(msg, dict):
            return
        if msg.get('type') == 'camera':
            # The instructor chose which block the camera watches.
            pid = _clean_pid(msg.get('pid'))
            if pid:
                self.assign(pid)
            return
        if msg.get('type') != 'session':
            return
        if msg.get('state') == 'start':
            participants = msg.get('participants') or []
            chosen = _clean_pid(msg.get('camera'))
            if chosen:
                self.pid = chosen            # the instructor's choice wins over --pid
            elif not (self.fixed_pid and self.fixed_pid in participants) and participants:
                self.pid = str(participants[0])
            self.reset()  # a new class starts with fresh counts
            self._emit({'type': 'camera'})
            print(f'[feed] session started; camera watches {self.pid}', flush=True)
        else:
            print(f"[feed] session {msg.get('state')}", flush=True)

    def assign(self, pid):
        """Watch a different person (block): their counts start from zero."""
        if pid != self.pid:
            self.pid = pid
            self.reset()
        self._emit({'type': 'camera'})  # tells every open dashboard who the camera watches
        print(f'[feed] camera now watches {self.pid}', flush=True)

    def wait_for_frame(self, last_no, timeout=2.0):
        """Next JPEG after frame number last_no, for the MJPEG stream."""
        with self.frame_cond:
            self.frame_cond.wait_for(lambda: self.frame_no != last_no or not self.running, timeout)
            return self.frame_no, self.jpeg

    def snapshot(self):
        return dict(self.status, pid=self.pid, running=self.running and self.thread is not None
                    and self.thread.is_alive(), error=self.error, clients=len(self.subscribers))

    # ---------- events ----------

    def _emit(self, event):
        event = dict(event, pid=self.pid)
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass

    def _emit_rep(self, event):
        self._emit({'type': 'rep', 'quality': event['quality'], 'faults': event['faults'],
                    'exercise': EXERCISE_CODES[event['exercise']]})

    # ---------- the camera loop (adapted from exercise_tracker.main) ----------

    def _run(self):
        try:
            self._loop()
        except Exception as e:  # report it on the camera page instead of dying silently
            self.error = f'{type(e).__name__}: {e}'
            print('[camera] stopped:', self.error, flush=True)
        finally:
            self.running = False
            with self.frame_cond:
                self.frame_cond.notify_all()

    def _loop(self):
        model_path = _model_path(self.model)
        camera, self.camera = self.camera, None   # opened on the main thread, if it was
        if camera is None:
            camera = open_source(self.camera_index)
        if not camera.is_open():
            raise RuntimeError(
                f'Could not open camera {self.camera_index}. On a Mac allow camera access for the app '
                'running Python (System Settings > Privacy & Security > Camera), or try another --camera index.')

        options = vision.PoseLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=model_path),
            running_mode=vision.RunningMode.VIDEO,
            num_poses=1,
        )
        counters = make_counters()
        recognizer = ExerciseRecognizer()
        session = Session()
        safety = SafetyMonitor()
        shadow_events = []
        last_timestamp = -1
        prev_time = time.monotonic()
        fps = 0.0
        frame_id = 0
        motion_window = deque()      # (time, {part: (x, y)}, torso length)
        next_motion = 0.0
        posture, posture_sent_at = None, 0.0
        gone_since = None            # when the person left the picture, or None
        recent_points = deque(maxlen=SMOOTH_FRAMES)
        rep_started = {}             # exercise -> when its current rep started going down
        side_state = {'side': None, 'frames': 0}   # which side of the body is used (see _choose_side)
        angle_filter = AngleFilter()
        last_seen = None             # when a body was last tracked well
        last_rep = {}                # exercise -> when its last rep was counted
        candidate, candidate_since = None, 0.0   # posture reading waiting to be confirmed
        upright_since = None         # how long they have been standing, to clear an old alert

        def record(event, now):
            session.record(event, now)
            self._emit_rep(event)

        print(f'[camera] running on camera {self.camera_index}', flush=True)
        try:
            with vision.PoseLandmarker.create_from_options(options) as landmarker:
                while self.running:
                    if self._reset_requested:
                        self._reset_requested = False
                        session, safety, recognizer = Session(), SafetyMonitor(), ExerciseRecognizer()
                        for c in counters.values():
                            c.reset()
                        shadow_events.clear()
                    if self._clear_requested:
                        self._clear_requested = False
                        safety.clear()

                    frame_id, frame = camera.read(frame_id)
                    if frame is None:
                        raise RuntimeError('No picture from the camera.')

                    frame = cv2.flip(frame, 1)
                    height, width = frame.shape[:2]
                    now = time.monotonic()

                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                    timestamp = max(int(now * 1000), last_timestamp + 1)
                    last_timestamp = timestamp
                    result = landmarker.detect_for_video(mp_image, timestamp)

                    points = None
                    partly = False
                    if result.pose_landmarks:
                        landmarks = result.pose_landmarks[0]
                        side = _choose_side(landmarks, side_state)
                        if side:
                            points = _body_points(landmarks, side, width, height)
                    # Only part of the body in the picture (walking in or out of the frame):
                    # MediaPipe guesses the missing joints, which can look like a fall or like
                    # lying on the floor. Treat it as not in view.
                    if points is not None and not _fully_in_frame(points, width, height):
                        points, partly = None, True
                    # Average the last few frames so a single jumpy frame can't look like a fall.
                    if points is None:
                        recent_points.clear()
                    else:
                        if recent_points and recent_points[-1]['side'] != points['side']:
                            recent_points.clear()  # switched to the other side of the body
                            angle_filter.reset()
                        recent_points.append(points)
                        points = _average_points(recent_points)

                    features = None
                    # A short tracking dropout (a few bad frames): hold everything as it was
                    # instead of treating it as "nobody there", which reset the recogniser.
                    hold = (points is None and not partly and last_seen is not None
                            and now - last_seen < HOLD_GAP)
                    if points is not None:
                        last_seen = now
                    if hold:
                        change = None
                    elif points is None:
                        angle_filter.reset()
                        change = recognizer.update_no_person(now)
                        motion_window.clear()
                        if gone_since is None:
                            gone_since = now
                        text = 'Move fully into view (whole body)' if partly else 'Step into view (side-on, whole body)'
                        cv2.putText(frame, text, (10, height - 70), cv2.FONT_HERSHEY_SIMPLEX, 0.8, YELLOW, 2)
                    else:
                        gone_since = None
                        features = angle_filter(now, compute_features(points))
                        for counter in counters.values():
                            was = counter.state
                            event = counter.update(features)
                            if was == 'UP' and counter.state == 'DOWN':
                                rep_started[counter.name] = now
                            if event is None:
                                continue
                            # Too quick to be a real rep, or right on top of the last one:
                            # MediaPipe jitter crossing the counting angle twice.
                            if (now - rep_started.get(counter.name, now) < MIN_REP_SECONDS
                                    or now - last_rep.get(counter.name, -1e9) < MIN_REP_GAP):
                                continue
                            last_rep[counter.name] = now
                            _score_rep(event, counter.lowest, counter.highest)
                            if event['exercise'] == recognizer.current and recognizer.agrees(event['exercise']):
                                record(event, now)
                            else:
                                shadow_events.append((now, event))
                        change = recognizer.update(now, features)
                        draw_body(frame, points, features)
                        torso = max(math.dist(points['shoulder'], points['hip']), 1.0)
                        motion_window.append((now, points, torso))
                        while now - motion_window[0][0] > MOTION_EVERY:
                            motion_window.popleft()

                    if change in ('locked', 'switched'):
                        name = recognizer.current
                        print(f'--- Exercise detected: {DISPLAY_NAMES[name]} ---', flush=True)
                        for t, event in shadow_events:
                            if event['exercise'] == name and now - t <= LOOKBACK_SECONDS:
                                record(event, now)
                        shadow_events.clear()
                    elif change == 'unlocked':
                        for counter in counters.values():
                            counter.reset()
                        shadow_events.clear()

                    alert = None if hold else safety.update(now, points, features, recognizer.current)
                    if alert:
                        print(f'[SAFETY CHECK] {alert}', flush=True)
                    shadow_events = [(t, e) for t, e in shadow_events if now - t <= LOOKBACK_SECONDS]

                    # --- safety signals for the dashboard ---
                    if now >= next_motion:
                        next_motion = now + MOTION_EVERY
                        level = self._motion_level(motion_window)
                        if level is not None:  # nothing is sent while nobody is in view
                            self._emit({'type': 'motion', 'level': level})
                    away = gone_since is not None and now - gone_since >= AWAY_AFTER
                    # safety.py's alert stays on until the coach clears it. If they are visibly
                    # standing again for ALERT_CLEAR seconds they got up, so clear it here.
                    standing = self._posture(None, points, features, False) == 'upright'
                    upright_since = (upright_since or now) if standing else None
                    if safety.alert and upright_since is not None and now - upright_since >= ALERT_CLEAR:
                        print(f'[SAFETY] cleared, standing again: {safety.alert}', flush=True)
                        safety.clear()
                    p = self._posture(safety, points, features, away)
                    # upright / floor readings must hold POSTURE_HOLD seconds before they are sent;
                    # a confirmed fall and 'away' (already timed) are sent straight away.
                    if p != candidate:
                        candidate, candidate_since = p, now
                    held = p in ('fallen', 'away') or now - candidate_since >= POSTURE_HOLD
                    if p and held and (p != posture or now - posture_sent_at >= POSTURE_EVERY):
                        posture, posture_sent_at = p, now
                        self._emit({'type': 'posture', 'posture': p})

                    fps = 0.9 * fps + 0.1 * (1.0 / max(now - prev_time, 1e-6))
                    prev_time = now
                    draw_panel(frame, session, recognizer, features, fps, now)
                    draw_counter(frame, session, recognizer, now)
                    draw_safety(frame, safety)

                    ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                    with self.frame_cond:
                        if ok:
                            self.jpeg = buf.tobytes()
                            self.frame_no += 1
                        self.status = {
                            'exercise': DISPLAY_NAMES.get(recognizer.current) if recognizer.current else None,
                            'safety': safety.status(),
                            'alert': safety.alert,
                            'fps': round(fps, 1),
                            'totals': {DISPLAY_NAMES[k]: v for k, v in session.totals.items()},
                        }
                        self.frame_cond.notify_all()
        finally:
            camera.stop()
            print('[camera] stopped', flush=True)

    @staticmethod
    def _motion_level(window):
        """0 (still) to 1: how far the body points moved in the last second, in torso lengths."""
        if len(window) < 2:
            return None
        torso = sum(t for _, _, t in window) / len(window)
        # How far each joint's AVERAGE position moved between the first and second half of the
        # last second. Averaging cancels MediaPipe's frame-to-frame jitter, which the old
        # max-min spread counted as movement, so a still person really reads as still.
        half = len(window) // 2
        if half < 2:
            return None
        first, second = list(window)[:half], list(window)[half:]
        mean = lambda frames, part, i: sum(p[part][i] for _, p, _ in frames) / len(frames)
        shifts = []
        for part in ('shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'):
            shifts.append(2 * math.hypot(mean(second, part, 0) - mean(first, part, 0),
                                         mean(second, part, 1) - mean(first, part, 1)))
        # The median, not the mean: one jumpy joint (often a wrist or ankle MediaPipe is
        # unsure of) must not make a still person look as if they're moving.
        shifts.sort()
        median = (shifts[2] + shifts[3]) / 2
        level = median / torso / MOTION_FULL
        return round(min(1.0, level), 2)

    @staticmethod
    def _posture(safety, points, features, away):
        # Only a fall safety.py has CONFIRMED is 'fallen'. A suspected drop is not sent on its
        # own: the person may get straight back up, and walking out of view is not a fall.
        # (safety=None: just read the body, ignoring alerts.)
        if safety is not None and safety.alert:
            return 'fallen'
        if away:
            return 'away'          # out of frame: the dashboard says so, without an alarm
        if points is None:
            return None
        torso = max(math.dist(points['shoulder'], points['hip']), 1.0)
        hip_height = (points['ankle'][1] - points['hip'][1]) / torso
        # On the floor = hip down at ankle height (sitting or lying). Leaning or bending
        # forward on its own is not "on the floor".
        return 'floor' if hip_height < FLOOR_HIP else 'upright'

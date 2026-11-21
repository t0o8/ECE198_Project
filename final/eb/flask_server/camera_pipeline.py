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

from pose_utils import MODEL_PATH, download_model_if_needed, get_body_points, compute_features  # noqa: E402
from exercises import make_counters, DISPLAY_NAMES  # noqa: E402
from recognizer import ExerciseRecognizer  # noqa: E402
from camera_stream import open_source  # noqa: E402
from safety import SafetyMonitor  # noqa: E402
from exercise_tracker import (Session, draw_body, draw_panel, draw_counter, draw_safety,  # noqa: E402
                              LOOKBACK_SECONDS, YELLOW)

# Tracker exercise names -> dashboard exercise codes (js/exercises.js).
EXERCISE_CODES = {'squat': 'squat', 'pushup': 'push_up', 'curl': 'bicep_curl'}

# Tracker feedback messages -> dashboard fault codes.
FAULT_CODES = {
    ('squat', 'Go lower'): 'shallow',
    ('squat', 'Keep chest up'): 'back_round',
    ('pushup', 'Go lower'): 'short_range',
    ('pushup', 'Keep body straight'): 'hips_sag',
    ('curl', 'Curl higher'): 'low_curl',
    ('curl', "Don't swing"): 'swing',
}

# The tracker only says GOOD or BAD; the dashboard wants a 0-100 quality.
QUALITY = {'good': 90, 'bad': 60}

MOTION_EVERY = 1.0     # seconds between motion events
POSTURE_EVERY = 5.0    # re-send the posture this often even if unchanged
MOTION_FULL = 0.5      # body points moving this many torso lengths in a second = level 1
FLOOR_HIP = 0.5        # hip lower than this many torso lengths above the ankle = on the floor
FLOOR_LEAN = 60        # torso lean above this (degrees) = lying / push-up position
JPEG_QUALITY = 70


def _clean_pid(value):
    """'P03', '3' or 3 -> 'P03'; anything else -> None."""
    s = str(value if value is not None else '').strip().upper().lstrip('P')
    return f'P{int(s):02d}' if s.isdigit() and 1 <= int(s) <= 30 else None


class CameraPipeline:
    def __init__(self, camera_index=0, pid=None):
        self.camera_index = camera_index
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
        name = event['exercise']
        code = FAULT_CODES.get((name, event['msg']))
        faults = [] if event['status'] == 'good' else [code or event['msg']]
        self._emit({'type': 'rep', 'quality': QUALITY[event['status']], 'faults': faults,
                    'exercise': EXERCISE_CODES[name]})

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
        download_model_if_needed()
        camera, self.camera = self.camera, None   # opened on the main thread, if it was
        if camera is None:
            camera = open_source(self.camera_index)
        if not camera.is_open():
            raise RuntimeError(
                f'Could not open camera {self.camera_index}. On a Mac allow camera access for the app '
                'running Python (System Settings > Privacy & Security > Camera), or try another --camera index.')

        options = vision.PoseLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=MODEL_PATH),
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
                    if result.pose_landmarks:
                        points = get_body_points(result.pose_landmarks[0], width, height)

                    features = None
                    if points is None:
                        change = recognizer.update_no_person(now)
                        motion_window.clear()
                        cv2.putText(frame, 'Step into view (side-on, whole body)', (10, height - 70),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, YELLOW, 2)
                    else:
                        features = compute_features(points)
                        for counter in counters.values():
                            event = counter.update(features)
                            if event is None:
                                continue
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

                    alert = safety.update(now, points, features, recognizer.current)
                    if alert:
                        print(f'[SAFETY CHECK] {alert}', flush=True)
                    shadow_events = [(t, e) for t, e in shadow_events if now - t <= LOOKBACK_SECONDS]

                    # --- safety signals for the dashboard ---
                    if now >= next_motion:
                        next_motion = now + MOTION_EVERY
                        level = self._motion_level(motion_window)
                        if level is not None:  # nothing is sent while nobody is in view
                            self._emit({'type': 'motion', 'level': level})
                    p = self._posture(safety, points, features)
                    if p and (p != posture or now - posture_sent_at >= POSTURE_EVERY):
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
        spans = []
        for part in ('shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle'):
            xs = [p[part][0] for _, p, _ in window]
            ys = [p[part][1] for _, p, _ in window]
            spans.append(math.hypot(max(xs) - min(xs), max(ys) - min(ys)))
        level = (sum(spans) / len(spans)) / torso / MOTION_FULL
        return round(min(1.0, level), 2)

    @staticmethod
    def _posture(safety, points, features):
        if safety.alert or safety.suspect_since is not None:
            return 'fallen'
        if points is None or not safety.body:
            return None
        hip_height = (points['ankle'][1] - points['hip'][1]) / safety.body
        if hip_height < FLOOR_HIP or features['torso_lean'] > FLOOR_LEAN:
            return 'floor'
        return 'upright'

"""
ECE 198 - Exercise tracker with automatic exercise recognition.

  1. Finds the body with MediaPipe Pose Landmarker.
  2. Works out which exercise is being done (squat / push-up / bicep curl).
  3. Counts reps of that exercise and judges each one GOOD or BAD.

Stand SIDE-ON to the camera with your whole body in view.
For push-ups, put the laptop low (on the floor or a chair).

Controls (click the video window first):  q = quit   r = reset
"""

import math
import time
from collections import deque

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

from pose_utils import (MODEL_PATH, download_model_if_needed,
                        get_body_points, compute_features)
from exercises import make_counters, DISPLAY_NAMES
from recognizer import ExerciseRecognizer

# ============================================================
# Settings
# ============================================================

# Camera index. On a Mac, 0 may be your iPhone (Continuity Camera).
# Run find_cameras.py to see which number is the laptop webcam.
# Later (Phase 2): "http://<ESP32-IP>:81/stream"
CAMERA_SOURCE = 0

FEEDBACK_SECONDS = 1.5   # how long the GOOD/BAD message stays on screen
LOOKBACK_SECONDS = 4.0   # reps finished just before recognition still count

GREEN = (60, 200, 60)
RED = (50, 50, 230)
WHITE = (255, 255, 255)
YELLOW = (0, 220, 255)
DARK = (40, 40, 40)
ORANGE = (0, 140, 255)
ALERT_SECONDS = 5.0      # how long an alert banner stays on screen
ALERT_COLOURS = {"urgent": RED, "help": ORANGE, "check": YELLOW}

# Status box (the green / yellow / red box for this station)
STATION_NUMBER = 1
STATUS_HOLD_SECONDS = 10.0   # an urgent / help alert keeps the box red / yellow this long
RECENT_REPS = 3              # look at the last few reps ...
BAD_FOR_YELLOW = 2           # ... and go yellow if this many were bad
STATUS_COLOURS = {"green": GREEN, "yellow": YELLOW, "red": RED}
STATUS_TEXT = {"green": "GOOD", "yellow": "LOW QUALITY", "red": "URGENT"}


# ============================================================
# Safety monitor: raises alerts when someone may be hurting themselves
# MID-EXERCISE. It only watches while the recogniser says a person is
# exercising (locked on an exercise and still moving like it).
#   urgent = sharp movement, or a possible fall (upright -> horizontal
#            fast, then stays still)
#   help   = stuck at the bottom of a rep for too long
# "Sharp" is judged by speed: main joint angle, torso lean and hip movement.
# The screen shows a "sharp" percentage where 100% = alert. Do normal reps,
# then fake a fall, watch the numbers and set the limits in between.
# Hip movement is divided by torso length, so distance from the camera
# does not matter. All numbers are starting points - tune with real tests.
# ============================================================

# ---- when to watch ----
EXERCISE_GRACE = 1.0     # keep watching this long after the "exercising" state drops
                         # (a fall can break the exercise pattern a moment before we react)

# ---- sharp movement (only checked while exercising) ----
SPEED_SPAN = 0.15        # compare the body now with this many seconds ago
MIN_HOT_FRAMES = 2       # over the limit for this many frames in a row (ignores 1-frame glitches)
MAIN_ANGLE_SPEED = {"squat": 250, "pushup": 250, "curl": 320}   # degrees/second
LEAN_SPEED = 120         # degrees/second - torso tipping or swinging
HIP_SPEED = 1.5          # torso lengths per second - hips moving fast
SHARP_LEVEL = "urgent"   # "urgent" = red box, "help" = yellow box

# ---- fall detection ----
FALL_WINDOW = 1.0        # a fall must happen within this many seconds
UPRIGHT_LEAN = 35        # torso lean below this counts as upright
FALLEN_LEAN = 55         # torso lean above this counts as horizontal
LEAN_JUMP = 30           # lean must increase by this much inside FALL_WINDOW
HIP_DROP = 0.35          # hip must drop this many torso lengths inside FALL_WINDOW
CONFIRM_STILL = 2.0      # must stay still this long to confirm the fall
STILL_MOVE = 0.25        # hip range (torso lengths) below this means "still"
SUSPECT_TIMEOUT = 8.0    # give up on a suspected fall after this long

# ---- stuck mid-rep ----
STUCK_SECONDS = 8.0      # rep counter in DOWN longer than this

COOLDOWN = 10.0          # do not repeat the same alert more often than this
HISTORY_SECONDS = 3.0

# which measurement to watch for each exercise (index into the history tuple)
_KNEE, _ELBOW = 4, 5
MAIN_ANGLE_INDEX = {"squat": _KNEE, "pushup": _ELBOW, "curl": _ELBOW}


class SafetyMonitor:
    def __init__(self):
        self.hist = deque()          # (t, lean, hip_x, hip_y, knee, elbow)
        self.ref_len = None          # smoothed torso length in pixels
        self.suspect_since = None    # time a fall was suspected
        self.down_since = None       # time the rep counter entered DOWN
        self.last_alert = {}
        self.last_active = -1e9      # last time the person was exercising
        self.last_exercise = None
        self.active = False          # True while we are watching (exercising)
        self.hot_frames = 0          # frames in a row over the sharp limit
        self.sharp_now = 0.0         # speed as a fraction of the limit (1.0 = alert)
        self.sharp_peak = 0.0        # highest value in the last few seconds (for tuning)
        self.peak_time = 0.0

    # ------------------------------------------------------------
    def update(self, t, points, f, exercise, exercising, rep_state):
        """Call once per frame when a person is visible. Returns an alert dict or None.

        exercise   - name of the locked exercise, or None
        exercising - True while the person is actually doing the exercise
        rep_state  - "UP" / "DOWN" from that exercise's rep counter, or None
        """
        sx, sy = points["shoulder"]
        hx, hy = points["hip"]
        torso = math.hypot(sx - hx, sy - hy)
        if torso > 1:
            self.ref_len = torso if self.ref_len is None else 0.99 * self.ref_len + 0.01 * torso
        if not self.ref_len:
            return None

        self.hist.append((t, f["torso_lean"], hx / self.ref_len, hy / self.ref_len,
                          f["knee"], f["elbow"]))
        while self.hist and t - self.hist[0][0] > HISTORY_SECONDS:
            self.hist.popleft()

        if exercising:
            self.last_active = t
            self.last_exercise = exercise
        self.active = exercising or (t - self.last_active < EXERCISE_GRACE)

        self._measure_sharpness(t)
        for check in (self._check_fall, self._check_sharp, self._check_stuck):
            alert = check(t, rep_state)
            if alert:
                return alert
        return None

    def update_no_person(self, t):
        """Call when nobody is visible. A fall can push the person out of view."""
        self.active = False
        self.sharp_now = 0.0
        self.hot_frames = 0
        self.down_since = None
        if self.suspect_since is not None and t - self.suspect_since >= CONFIRM_STILL:
            self.suspect_since = None
            return self._alert(t, "urgent", "fall", "Possible fall (lost sight)")
        return None

    # ------------------------------------------------------------
    def _measure_sharpness(self, t):
        """Set self.sharp_now: how fast the body moves compared with the limits."""
        ratio = 0.0
        now = self.hist[-1]
        old = None
        for h in reversed(self.hist):
            if t - h[0] >= SPEED_SPAN:
                old = h
                break
        if old is not None and self.active:
            dt = max(now[0] - old[0], 1e-6)
            ratio = max(abs(now[1] - old[1]) / dt / LEAN_SPEED,
                        math.hypot(now[2] - old[2], now[3] - old[3]) / dt / HIP_SPEED)
            index = MAIN_ANGLE_INDEX.get(self.last_exercise)
            if index is not None:
                limit = MAIN_ANGLE_SPEED[self.last_exercise]
                ratio = max(ratio, abs(now[index] - old[index]) / dt / limit)
        self.sharp_now = ratio
        if ratio >= self.sharp_peak or t - self.peak_time > 3.0:
            self.sharp_peak, self.peak_time = ratio, t
        self.hot_frames = self.hot_frames + 1 if ratio >= 1.0 else 0

    def _check_sharp(self, t, rep_state):
        if self.hot_frames >= MIN_HOT_FRAMES:
            return self._alert(t, SHARP_LEVEL, "sharp", "Sharp movement - check now")
        return None

    def _check_fall(self, t, rep_state):
        now = self.hist[-1]

        if self.suspect_since is None:
            if not self.active:          # only look for falls mid-exercise
                return None
            recent = [h for h in self.hist if t - h[0] <= FALL_WINDOW]
            if len(recent) < 5:
                return None
            lean_jump = now[1] - min(h[1] for h in recent)
            hip_drop = now[3] - min(h[3] for h in recent)   # image y grows downward
            if now[1] > FALLEN_LEAN and lean_jump > LEAN_JUMP and hip_drop > HIP_DROP:
                self.suspect_since = t
            return None

        elapsed = t - self.suspect_since
        if now[1] < UPRIGHT_LEAN + 10 or elapsed > SUSPECT_TIMEOUT:
            self.suspect_since = None          # got back up, or gave up waiting
            return None
        if elapsed >= CONFIRM_STILL:
            window = [h for h in self.hist if t - h[0] <= CONFIRM_STILL]
            x_range = max(h[2] for h in window) - min(h[2] for h in window)
            y_range = max(h[3] for h in window) - min(h[3] for h in window)
            if max(x_range, y_range) < STILL_MOVE and now[1] > FALLEN_LEAN - 10:
                self.suspect_since = None
                return self._alert(t, "urgent", "fall", "Possible fall - check now")
        return None

    def _check_stuck(self, t, rep_state):
        if rep_state != "DOWN":
            self.down_since = None
            return None
        if self.down_since is None:
            self.down_since = t
        elif t - self.down_since >= STUCK_SECONDS:
            return self._alert(t, "help", "stuck", "Stuck mid-rep")
        return None

    def _alert(self, t, level, reason, msg):
        if t - self.last_alert.get(reason, -1e9) < COOLDOWN:
            return None
        self.last_alert[reason] = t
        return {"level": level, "reason": reason, "msg": msg, "t": t}


class Session:
    """Keeps the totals for each exercise and the latest feedback."""

    def __init__(self):
        self.totals = {name: {"reps": 0, "good": 0, "bad": 0}
                       for name in DISPLAY_NAMES}
        self.feedback = None
        self.feedback_until = 0.0
        self.alert = None
        self.alert_until = 0.0
        self.recent = deque(maxlen=RECENT_REPS)   # last few rep results: "good" / "bad"
        self.red_until = 0.0
        self.red_reason = ""
        self.yellow_until = 0.0
        self.yellow_reason = ""
        self.status = "green"            # "green" / "yellow" / "red"  <- send this to the dashboard
        self.status_reason = "All good"

    def raise_alert(self, alert, now):
        # Phase 3/dashboard: this is where we will send the alert out
        print("ALERT:", alert)
        self.alert = alert
        self.alert_until = now + ALERT_SECONDS
        if alert["level"] == "urgent":
            self.red_until = now + STATUS_HOLD_SECONDS
            self.red_reason = alert["msg"]
        elif alert["level"] == "help":
            self.yellow_until = now + STATUS_HOLD_SECONDS
            self.yellow_reason = alert["msg"]

    def record(self, event, now):
        t = self.totals[event["exercise"]]
        t["reps"] += 1
        t[event["status"]] += 1
        self.recent.append(event["status"])
        event["count"] = t["reps"]
        # Phase 3: this is the message we will send to the ESP32
        print(event)
        colour = GREEN if event["status"] == "good" else RED
        self.feedback = (event["msg"], colour)
        self.feedback_until = now + FEEDBACK_SECONDS

    def update_status(self, now):
        """Work out the box colour. Call once per frame.
        red    = urgent alert (possible fall)
        yellow = 'help' alert (stuck mid-rep) or too many bad reps lately
        green  = everything else"""
        if now < self.red_until:
            self.status, self.status_reason = "red", self.red_reason
        elif now < self.yellow_until:
            self.status, self.status_reason = "yellow", self.yellow_reason
        elif self.recent.count("bad") >= BAD_FOR_YELLOW:
            self.status, self.status_reason = "yellow", "Recent reps need work"
        else:
            self.status, self.status_reason = "green", "All good"


def draw_body(frame, p, features):
    arm = [p["shoulder"], p["elbow"], p["wrist"]]
    leg = [p["shoulder"], p["hip"], p["knee"], p["ankle"]]
    for chain in (arm, leg):
        for a, b in zip(chain, chain[1:]):
            cv2.line(frame, a, b, WHITE, 3)
    for part in ("shoulder", "elbow", "wrist", "hip", "knee", "ankle"):
        cv2.circle(frame, p[part], 6, YELLOW, -1)
    for part in ("knee", "elbow"):
        x, y = p[part]
        cv2.putText(frame, f"{int(features[part])}", (x + 10, y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, YELLOW, 2)


def draw_status_box(frame, session):
    """Station number with the green / yellow / red box under it (top right)."""
    w = frame.shape[1]
    x1, y1, x2, y2 = w - 250, 45, w - 10, 145
    cv2.rectangle(frame, (x1 - 8, 6), (x2 + 8, y2 + 8), DARK, -1)
    cv2.putText(frame, f"Station {STATION_NUMBER}", (x1, 33),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, WHITE, 2)
    cv2.rectangle(frame, (x1, y1), (x2, y2), STATUS_COLOURS[session.status], -1)
    text_colour = WHITE if session.status == "red" else DARK
    cv2.putText(frame, STATUS_TEXT[session.status], (x1 + 12, y1 + 42),
                cv2.FONT_HERSHEY_SIMPLEX, 0.9, text_colour, 2)
    cv2.putText(frame, session.status_reason[:26], (x1 + 12, y1 + 78),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, text_colour, 1)


def draw_panel(frame, session, recognizer, features, fps, now, safety):
    cv2.rectangle(frame, (0, 0), (360, 215), DARK, -1)
    current = recognizer.current
    title = DISPLAY_NAMES[current] if current else "Detecting..."
    cv2.putText(frame, f"Exercise: {title}", (10, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.75, YELLOW, 2)

    y = 62
    for name, label in DISPLAY_NAMES.items():
        t = session.totals[name]
        colour = YELLOW if name == current else WHITE
        cv2.putText(frame, f"{label}: {t['reps']}  (good {t['good']} / bad {t['bad']})",
                    (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, colour, 2)
        y += 26

    if features:
        info = (f"Knee {features['knee']:.0f}  Elbow {features['elbow']:.0f}  "
                f"Lean {features['torso_lean']:.0f}")
    else:
        info = "Knee -  Elbow -  Lean -"
    cv2.putText(frame, info, (10, y + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.55, WHITE, 2)
    cv2.putText(frame, f"FPS: {fps:.0f}", (10, y + 36),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, WHITE, 2)
    watch = "ON" if safety.active else "off"
    cv2.putText(frame, f"Safety {watch}  sharp {safety.sharp_now * 100:.0f}%  "
                f"peak {safety.sharp_peak * 100:.0f}%",
                (10, y + 62), cv2.FONT_HERSHEY_SIMPLEX, 0.55, WHITE, 2)

    if session.feedback and now < session.feedback_until:
        text, colour = session.feedback
        cv2.putText(frame, text, (10, frame.shape[0] - 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.4, colour, 3)

    if session.alert and now < session.alert_until:
        colour = ALERT_COLOURS[session.alert["level"]]
        w = frame.shape[1]
        cv2.rectangle(frame, (0, 230), (w, 280), colour, -1)
        cv2.putText(frame, session.alert["level"].upper() + ": " + session.alert["msg"],
                    (10, 266), cv2.FONT_HERSHEY_SIMPLEX, 0.9, WHITE, 2)


def main():
    download_model_if_needed()

    cap = cv2.VideoCapture(CAMERA_SOURCE)
    if not cap.isOpened():
        print("Could not open the camera.")
        print("On a Mac: System Settings > Privacy & Security > Camera, "
              "allow PyCharm, then restart PyCharm.")
        return

    options = vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODEL_PATH),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
    )

    counters = make_counters()        # one counter per exercise
    recognizer = ExerciseRecognizer()
    session = Session()
    safety = SafetyMonitor()          # fall / stuck / sudden-movement alerts
    shadow_events = []                # reps finished before recognition locked in
    last_timestamp = -1
    prev_time = time.monotonic()
    fps = 0.0

    print("Running. Stand side-on to the camera, whole body in view.")
    print("Press q to quit, r to reset.")

    with vision.PoseLandmarker.create_from_options(options) as landmarker:
        while True:
            ok, frame = cap.read()
            if not ok:
                print("No frame from the camera.")
                break

            frame = cv2.flip(frame, 1)
            height, width = frame.shape[:2]
            now = time.monotonic()

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            timestamp = max(int(now * 1000), last_timestamp + 1)
            last_timestamp = timestamp
            result = landmarker.detect_for_video(mp_image, timestamp)

            alert = None
            points = None
            if result.pose_landmarks:
                points = get_body_points(result.pose_landmarks[0], width, height)

            features = None
            if points is None:
                change = recognizer.update_no_person(now)
                alert = safety.update_no_person(now)
                cv2.putText(frame, "Step into view (side-on, whole body)",
                            (10, height - 70), cv2.FONT_HERSHEY_SIMPLEX,
                            0.8, YELLOW, 2)
            else:
                features = compute_features(points)

                # Every counter watches every frame, so the first rep is not
                # lost while the recogniser is still deciding.
                for counter in counters.values():
                    event = counter.update(features)
                    if event is None:
                        continue
                    if event["exercise"] == recognizer.current:
                        session.record(event, now)
                    else:
                        shadow_events.append((now, event))

                change = recognizer.update(now, features)
                rep_state = (counters[recognizer.current].state
                             if recognizer.current else None)
                # exercising = locked on an exercise AND still moving like it
                exercising = (recognizer.current is not None
                              and recognizer.idle_since is None)
                alert = safety.update(now, points, features,
                                      recognizer.current, exercising, rep_state)
                draw_body(frame, points, features)

            if alert:
                session.raise_alert(alert, now)

            if change in ("locked", "switched"):
                name = recognizer.current
                print(f"--- Exercise detected: {DISPLAY_NAMES[name]} ---")
                for t, event in shadow_events:
                    if event["exercise"] == name and now - t <= LOOKBACK_SECONDS:
                        session.record(event, now)
                shadow_events.clear()
            elif change == "unlocked":
                print("--- Set finished ---")
                session.recent.clear()
                for counter in counters.values():
                    counter.reset()
                shadow_events.clear()

            # keep only recent shadow events
            shadow_events = [(t, e) for t, e in shadow_events
                             if now - t <= LOOKBACK_SECONDS]

            fps = 0.9 * fps + 0.1 * (1.0 / max(now - prev_time, 1e-6))
            prev_time = now

            session.update_status(now)
            draw_panel(frame, session, recognizer, features, fps, now, safety)
            draw_status_box(frame, session)
            cv2.imshow("ECE 198 Exercise Tracker", frame)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord("r"):
                session = Session()
                recognizer = ExerciseRecognizer()
                safety = SafetyMonitor()
                for counter in counters.values():
                    counter.reset()
                shadow_events.clear()
                print("Reset.")

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
"""
ECE 198 - Exercise tracker with automatic exercise recognition.

  1. Finds the body with MediaPipe Pose Landmarker.
  2. Works out which exercise is being done (squat / push-up / bicep curl).
  3. Counts reps of that exercise and judges each one GOOD or BAD.

Stand SIDE-ON to the camera with your whole body in view.
For push-ups, put the laptop low (on the floor or a chair).

Controls (click the video window first):  q = quit   r = reset
"""

import time

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


class Session:
    """Keeps the totals for each exercise and the latest feedback."""

    def __init__(self):
        self.totals = {name: {"reps": 0, "good": 0, "bad": 0}
                       for name in DISPLAY_NAMES}
        self.feedback = None
        self.feedback_until = 0.0

    def record(self, event, now):
        t = self.totals[event["exercise"]]
        t["reps"] += 1
        t[event["status"]] += 1
        event["count"] = t["reps"]
        # Phase 3: this is the message we will send to the ESP32
        print(event)
        colour = GREEN if event["status"] == "good" else RED
        self.feedback = (event["msg"], colour)
        self.feedback_until = now + FEEDBACK_SECONDS


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


def draw_panel(frame, session, recognizer, features, fps, now):
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

    if session.feedback and now < session.feedback_until:
        text, colour = session.feedback
        cv2.putText(frame, text, (10, frame.shape[0] - 25),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.4, colour, 3)


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

            points = None
            if result.pose_landmarks:
                points = get_body_points(result.pose_landmarks[0], width, height)

            features = None
            if points is None:
                change = recognizer.update_no_person(now)
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
                draw_body(frame, points, features)

            if change in ("locked", "switched"):
                name = recognizer.current
                print(f"--- Exercise detected: {DISPLAY_NAMES[name]} ---")
                for t, event in shadow_events:
                    if event["exercise"] == name and now - t <= LOOKBACK_SECONDS:
                        session.record(event, now)
                shadow_events.clear()
            elif change == "unlocked":
                print("--- Set finished ---")
                for counter in counters.values():
                    counter.reset()
                shadow_events.clear()

            # keep only recent shadow events
            shadow_events = [(t, e) for t, e in shadow_events
                             if now - t <= LOOKBACK_SECONDS]

            fps = 0.9 * fps + 0.1 * (1.0 / max(now - prev_time, 1e-6))
            prev_time = now

            draw_panel(frame, session, recognizer, features, fps, now)
            cv2.imshow("ECE 198 Exercise Tracker", frame)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord("r"):
                session = Session()
                recognizer = ExerciseRecognizer()
                for counter in counters.values():
                    counter.reset()
                shadow_events.clear()
                print("Reset.")

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()

# ECE 198 - Exercise Tracking (Challenge 2)

Camera-based exercise tracker. It recognises which exercise the user is doing
(squat, push-up or bicep curl), counts the reps, and judges each rep as
GOOD or BAD using joint angles from MediaPipe Pose Landmarker.

## Files

| File | What it does |
|---|---|
| `exercise_tracker.py` | **Main program - run this.** Camera loop, recognition, counting, drawing |
| `pose_utils.py` | Model download, angle maths, landmarks to measurements |
| `exercises.py` | Rep counters and form rules for each exercise (thresholds at the top of each class) |
| `recognizer.py` | Works out which exercise is being done (thresholds at the top of the file) |
| `find_cameras.py` | Shows each camera index, to find the right `CAMERA_SOURCE` |
| `squat_counter.py` | Earlier squat-only version, kept for reference |
| `requirements.txt` | Python libraries needed |

## Setup

1. Install Python 3.13 (or 3.12).
2. Create a virtual environment and install the libraries:
   ```
   python3 -m venv .venv
   source .venv/bin/activate        # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
   In PyCharm: open the folder, set a new virtual environment as the interpreter,
   then run `pip install -r requirements.txt` in the Terminal.
3. Run `exercise_tracker.py`. The pose model (about 10 MB) downloads into
   `models/` automatically the first time.

## Using it

- Stand **side-on** to the camera with your whole body in view (about 2.5-3 m away).
- For push-ups, put the camera low (floor or chair).
- Click the video window, then press `q` to quit or `r` to reset.
- If the wrong camera opens (for example an iPhone on a Mac), run
  `find_cameras.py` and change `CAMERA_SOURCE` near the top of `exercise_tracker.py`.

## Status

- [x] Phase 1: laptop webcam + MediaPipe + rep counting
- [x] Automatic exercise recognition (squat / push-up / curl)
- [ ] Phase 2: read the video stream from the ESP32-S3 camera
- [ ] Phase 3: send results to the ESP32 (OLED + buzzer)
- [ ] Phase 4: tune thresholds with recorded test data

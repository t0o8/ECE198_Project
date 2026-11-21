# ECE 198 - Exercise Tracking (Challenge 2): motion recognition + safety alerts

Camera-based exercise coach that runs on the laptop. It recognises which
exercise the user is doing (squat, push-up or bicep curl), counts the reps,
and judges each rep as GOOD or BAD using joint angles from MediaPipe Pose
Landmarker. The laptop screen is the coaching display.

This version adds a **fall alert for the coach** (`safety.py`): if the person drops
to the floor and does not get up, or goes out of view, a red CHECK alert is shown.

## Files

| File | What it does |
|---|---|
| `exercise_tracker.py` | **Main program - run this.** Camera loop, recognition, counting, drawing |
| `pose_utils.py` | Model download, angle maths, landmarks to measurements |
| `recognizer.py` | Works out which exercise is being done (thresholds at the top of the file) |
| `exercises.py` | Rep counters and form rules for each exercise (thresholds at the top of each class) |
| `safety.py` | Fall detection for the coach (thresholds at the top of the file) |
| `camera_stream.py` | Reads pictures from the computer camera |
| `requirements.txt` | Python libraries needed |

`find_cameras.py` (one folder up) shows each camera index, to find the right `CAMERA_SOURCE`.
The pose model is stored in `models/` one folder up and downloads automatically the first time.

## Setup

1. Install Python 3.13 (or 3.12).
2. Create a virtual environment and install the libraries:
   ```
   python3 -m venv .venv
   source .venv/bin/activate        # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
   In PyCharm: set a virtual environment as the interpreter, then run
   `pip install -r requirements.txt` in the Terminal.
3. Run `exercise_tracker.py`.

## Using it

- Stand **side-on** to the camera with your whole body in view (about 2.5-3 m away).
- For push-ups, put the laptop low (floor or chair).
- Click the video window, then press `q` to quit, `r` to reset, or `c` to clear a safety alert
  after checking on the person (the red CHECK alert stays until `c` is pressed).
- If the wrong camera opens (for example an iPhone on a Mac), run
  `find_cameras.py` and change `CAMERA_SOURCE` near the top of `exercise_tracker.py`.

## Status

- [x] Laptop camera + MediaPipe + rep counting
- [x] Automatic exercise recognition (squat / push-up / curl)
- [x] GOOD / BAD form feedback on screen
- [x] Fall alert (fell and has not got up, or fell out of view)
- [ ] Tune thresholds with recorded test data (falls: slow, safe simulations on a mat)

## Fall alert

1. **Suspected:** within 1 s the hip drops at least half a torso length and the person ends
   up on the floor: hip at about ankle height (lying, sitting, or propped up on the arms). The safety box turns red.
2. **Alert:** 3 s later the person is still not standing again, or they have been out of view
   for 1 s. A red CHECK banner stays until the coach presses `c`.

If the person gets back up in time, nothing more is shown.

**Cannot get up during an exercise:** the person stays in the low position of a squat
or push-up for 8 s (for example they sank to the floor mid-rep). Same red CHECK alert.
This is a helper that tells the coach to look; it is not a medical device.

## Feedback colours

Green = good rep. Yellow = rep not up to standard. Red = suspected or confirmed fall.

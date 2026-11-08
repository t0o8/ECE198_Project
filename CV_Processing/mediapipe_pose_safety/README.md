# ECE 198 - Exercise Tracking (Challenge 2): motion recognition + safety alerts

Camera-based exercise coach that runs on the laptop. It recognises which
exercise the user is doing (squat, push-up or bicep curl), counts the reps,
and judges each rep as GOOD or BAD using joint angles from MediaPipe Pose
Landmarker. The laptop screen is the coaching display.

This version adds **safety alerts for the coach** (`safety.py`), aimed at older adults:
a red URGENT alert for a possible fall, and yellow CHECK alerts for not getting up,
losing sight of the person mid-rep, sudden fast movement and signs of tiredness.

## Files

| File | What it does |
|---|---|
| `exercise_tracker.py` | **Main program - run this.** Camera loop, recognition, counting, drawing |
| `pose_utils.py` | Model download, angle maths, landmarks to measurements |
| `recognizer.py` | Works out which exercise is being done (thresholds at the top of the file) |
| `exercises.py` | Rep counters and form rules for each exercise (thresholds at the top of each class) |
| `safety.py` | Safety monitor: danger rules with staged confirmation (thresholds at the top of the file) |
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
  after checking on the person (a red URGENT alert stays until `c` is pressed).
- If the wrong camera opens (for example an iPhone on a Mac), run
  `find_cameras.py` and change `CAMERA_SOURCE` near the top of `exercise_tracker.py`.

## Status

- [x] Laptop camera + MediaPipe + rep counting
- [x] Automatic exercise recognition (squat / push-up / curl)
- [x] GOOD / BAD form feedback on screen
- [x] Safety alerts (fall, not getting up, lost mid-rep, sudden movement, tiredness)
- [ ] Tune thresholds with recorded test data (falls: slow, safe simulations on a mat)

## Safety alerts

| Alert | Level | How it is detected |
|---|---|---|
| Possible fall | URGENT | Fast drop (upright to near horizontal within 1 s, hip drops half a torso length), then lying still for 2 s or leaving the view |
| On the floor after a fast drop | CHECK | Fast drop, still on the floor after 6 s but moving |
| Has not come up | CHECK | In the low position of a squat or push-up for 8 s |
| Lost sight mid-rep | CHECK | Body out of view for 2 s in the middle of a rep |
| Sudden fast movement | CHECK | Torso tipping > 150 deg/s or hips > 2 torso lengths/s for 3 frames |
| Tired: bad form | CHECK | 2 of the last 3 reps BAD |
| Tired: slowing down | CHECK | Latest rep takes 1.8x the normal time |

A suspected fall is cancelled if the person gets back up or starts moving their arms (push-ups).
This is a helper that tells the coach to look; it is not a medical device.

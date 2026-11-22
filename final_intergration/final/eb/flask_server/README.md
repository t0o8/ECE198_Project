# Flask server: MediaPipe tracker + CCCARE dashboard

Runs the camera tracker from `../../mediapipe_pose_safety` and the web dashboard from
`../Web_Dashboard/cccare-tracker (1)` together, on the laptop that has the camera.

## Run it

```
cd eb/flask_server
../../mediapipe_pose_safety/.venv/bin/python app.py
```

(Or activate that venv and `pip install -r requirements.txt` first, then `python app.py`.)

- Dashboard: <http://localhost:8000> (sign in as `InsU` / `InsP`)
- Camera view, with the safety "clear alert" button: <http://localhost:8000/camera>

**Using an ESP32 camera instead of the laptop camera:** put the ESP32 on the same Wi-Fi, then

```
python app.py --camera http://<esp32-ip>:81/stream
```

Any camera that streams MJPEG over HTTP works (the standard ESP32 `CameraWebServer` serves it at
port 81, `/stream`). The tracker always uses the newest picture, so a slow Wi-Fi link drops
frames rather than falling behind, and if the ESP32 restarts or Wi-Fi drops, it reconnects by
itself (the camera page says "Waiting for the ESP32 camera..." meanwhile). The ESP32's picture
is not mirrored, unlike the laptop camera's. Check the address first by opening it in a browser.

Options: `--camera 1` (another camera index), `--pid P03` (which block the camera's person is;
default is the first participant of the session), `--host 0.0.0.0` (other devices on the network).

The instructor page connects to the camera feed by itself when opened from this server. Add
`?feed=off` to its address to use the simulator instead.

**Choosing who the camera watches:** during a live session, the instructor picks the person from the
**camera** menu at the top of the dashboard. That block gets a black "camera" tag, and the camera's
counts start from zero for them. The choice is remembered for the next session in that tab.

## What is sent to the dashboard

| Tracker | Dashboard event |
|---|---|
| counted rep (GOOD / BAD) | `rep`, quality 90 / 60, fault code, exercise `squat` / `push_up` / `bicep_curl` |
| body points movement, every second | `motion` level 0-1 |
| confirmed safety alert (fell and has not got up) | `posture: fallen` |
| nobody fully in view for 1 s | `posture: away` (dashboard shows "Out of frame for …" after 10 s, not an emergency) |
| hip near the floor, or lying | `posture: floor`, otherwise `upright` |

## Limits

- One camera = one person (one block). Set the session to 1 participant, or the others show "waiting".
- Put squat, push-up and/or bicep curl in that person's workout; reps of an exercise that is not in
  the workout are counted against the current exercise.
- No exertion (no heart-rate sensor yet), so exertion alerts never fire.
- Cloudflare Workers / GitHub Pages only host static files: they cannot run this server or reach the camera.

## Noise: how reps are kept accurate

MediaPipe's single-camera joint angles are typically 6-15 degrees off and jump between frames.
Validation studies found knee angles poor without filtering bad frames and much better with it,
and MediaPipe's current API (1.2.0) has no built-in smoothing option (the old `smooth_landmarks`
is gone). So the tracker does its own:

| Step | Where | What it stops |
|---|---|---|
| Stay on one side of the body; switch only if the other side is clearly more visible for 0.5 s | `_choose_side`, `SIDE_MARGIN`, `SIDE_SWITCH_FRAMES` | angles jumping between two limbs (the curling arm and the resting one), which made phantom reps |
| Hold through tracking dropouts shorter than 0.4 s | `HOLD_GAP` | one bad frame resetting exercise recognition |
| Average body points over 4 frames | `SMOOTH_FRAMES` | jumpy points in falls / posture |
| One Euro filter on every angle (Casiez et al. 2012): smooth when slow, light when fast | `ANGLE_MIN_CUTOFF`, `ANGLE_BETA` | jitter, adding only about 30 ms delay |
| Three-angle counter: start, a bottom the rep must reach, finish, each held 3 frames | `exercises.py` (`start`, `bottom`, `finish`, `CONFIRM_FRAMES`) | wobble near one line counting twice |
| A rep must take at least 0.6 s and be 0.8 s after the last | `MIN_REP_SECONDS`, `MIN_REP_GAP` | any double that still gets through |

Counting angles (`exercises.py`), from biomechanics sources and open-source MediaPipe counters:

| Exercise | Angle | Start (going down) | Must reach | Finish (back up) |
|---|---|---|---|---|
| Squat | hip-knee-ankle (about 175 standing; parallel is roughly 80-100) | below 145 | 125 | above 160 |
| Push-up | shoulder-elbow-wrist (about 165 arms straight; test standard 90) | below 140 | 115 | above 155 |
| Curl | shoulder-elbow-wrist (about 165 hanging; full curl 30-60) | below 120 | 95 | above 150 |

Tuning: if slow movement still jitters, lower `ANGLE_MIN_CUTOFF` (e.g. 0.7); if reps feel late,
raise `ANGLE_BETA`. For better accuracy try `python app.py --model heavy`: in Google's tests it
is clearly more accurate than the default full model (2D mAP 68.1 vs 62.6) but slower, so check
the fps on the camera page stays above about 15.

For the cleanest data: film side-on, whole body in view, good even lighting, plain background,
camera at hip height and still, fitted clothing.

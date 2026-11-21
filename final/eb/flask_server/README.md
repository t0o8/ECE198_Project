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
| safety alert / suspected fall | `posture: fallen` |
| hip near the floor, or lying | `posture: floor`, otherwise `upright` |

## Limits

- One camera = one person (one block). Set the session to 1 participant, or the others show "waiting".
- Put squat, push-up and/or bicep curl in that person's workout; reps of an exercise that is not in
  the workout are counted against the current exercise.
- No exertion (no heart-rate sensor yet), so exertion alerts never fire.
- Cloudflare Workers / GitHub Pages only host static files: they cannot run this server or reach the camera.

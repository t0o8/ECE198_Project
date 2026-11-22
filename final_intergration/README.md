# ECE 198 exercise tracking: ESP32 camera → MediaPipe → web dashboard

```
ESP32 camera ──Wi-Fi, MJPEG──▶ laptop: app.py (MediaPipe tracker + Flask) ──▶ browser dashboard
 ESP32_Firmware/               final/eb/flask_server/                           http://localhost:8000
```

| Folder | What it is |
|---|---|
| `ESP32_Firmware/ESP_Firmware/` | PlatformIO firmware: joins Wi-Fi and streams the camera at `http://<esp32-ip>:81/stream` |
| `final/mediapipe_pose_safety/` | The tracker: recognises squats / push-ups / curls, counts and scores reps, fall alerts |
| `final/eb/flask_server/` | `app.py`: runs the tracker on a camera and serves the dashboard and its live feed |
| `final/eb/Web_Dashboard/` | The instructor / patient dashboard website |

## Running it

1. **Wi-Fi.** Turn on the hotspot named in `ESP32_Firmware/ESP_Firmware/src/Constants.cpp`
   (`WifiConstants::SSID` / `PASSWORD`) and connect **the laptop to the same hotspot**.
2. **Flash the ESP32** with PlatformIO (VS Code: PlatformIO → Upload, then Monitor at 115200 baud).
   The serial monitor prints `Camera stream ready. Open to http://<ip>:81/stream`.
3. **Check the stream** by opening that address in a browser: you should see live video. Close
   the tab afterwards: the ESP32 serves one viewer at a time, and the tracker needs that slot.
4. **Start the tracker** (from `final/eb/flask_server`, with the project's Python environment):
   ```
   python app.py --camera http://<ip>:81/stream
   ```
   Without `--camera`, it uses the laptop's own camera as before.
5. Open <http://localhost:8000> (dashboard; instructor InsU / InsP) and
   <http://localhost:8000/camera> (camera view with the skeleton and rep counter).

If the ESP32 restarts or Wi-Fi drops, the tracker keeps running and reconnects by itself; the
camera page says "Waiting for the ESP32 camera..." meanwhile.

## Notes on the firmware

- The camera pins in `Constants.cpp` are the ESP32-WROVER-KIT layout (matching `platformio.ini`).
- The picture is 320×240 (`FRAMESIZE_QVGA`). For better tracking at 2.5-3 m try
  `FRAMESIZE_VGA` (640×480): a bigger body in the picture gives MediaPipe steadier joints.
- Each frame is captured as YUV and converted to JPEG in software (`fmt2jpg`), which is slow on an
  ESP32. If the camera module is an OV2640 (it can make JPEG itself), `PIXFORMAT_JPEG` sends the
  camera's own JPEG and is much faster (then `jpeg_quality` 10-12 sets the quality). An OV7670
  has no JPEG, so it needs the YUV conversion.
- The Wi-Fi password is in `Constants.cpp` in plain text; don't publish that file as is.

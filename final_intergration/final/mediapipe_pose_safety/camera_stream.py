"""
Video input for the tracker: the computer's own camera, or an ESP32 camera over Wi-Fi.

  open_source(0)                               computer camera number 0
  open_source("http://192.168.1.50:81/stream")  an ESP32 camera's MJPEG stream

The camera is CAMERA_SOURCE in exercise_tracker.py, or --camera for the web version.
On a Mac, 0 may be your iPhone (Continuity Camera) - run find_cameras.py
to see which number is the laptop webcam.
"""

import threading
import time
import urllib.request

import cv2
import numpy as np


class WebcamReader:
    """Reads one picture at a time from a computer camera."""

    network = False

    def __init__(self, index):
        self.source = index
        self.cap = cv2.VideoCapture(index)
        self.frame_id = 0

    def is_open(self):
        return self.cap.isOpened()

    def read(self, last_id):
        """Returns (frame_id, frame). frame is None if no picture came."""
        ok, frame = self.cap.read()
        if not ok:
            return last_id, None
        self.frame_id += 1
        return self.frame_id, frame

    def stop(self):
        self.cap.release()


class NetworkCameraReader:
    """Reads an MJPEG stream over HTTP, such as an ESP32 camera's http://<ip>:81/stream.

    A background thread reads the stream all the time and keeps only the NEWEST picture, so
    if the tracker is slower than the camera, old pictures are skipped instead of piling up
    (which would make the video fall further and further behind). If Wi-Fi drops, it keeps
    reconnecting by itself.

    It finds each JPEG in the stream by its start (FF D8) and end (FF D9) bytes, so it works
    with any MJPEG server, whatever boundary text it uses.
    """

    network = True
    CONNECT_TIMEOUT = 5.0    # seconds to wait for the camera to answer
    WAIT_FIRST = 8.0         # is_open() waits this long for the first picture
    RETRY_SECONDS = 2.0      # wait between reconnect attempts
    MAX_BUFFER = 2_000_000   # bytes; a stream with no complete picture in this much is reset

    def __init__(self, url):
        self.source = url
        self.frame_id = 0
        self.frame = None
        self.error = None
        self.cond = threading.Condition()
        self.running = True
        self.thread = threading.Thread(target=self._run, name='esp32-stream', daemon=True)
        self.thread.start()

    def is_open(self):
        """True once the first picture has arrived (waits up to WAIT_FIRST seconds)."""
        with self.cond:
            self.cond.wait_for(lambda: self.frame is not None, self.WAIT_FIRST)
            return self.frame is not None

    def read(self, last_id, timeout=2.0):
        """Returns (frame_id, frame) for the next picture newer than last_id.
        frame is None if none came within timeout (camera off or Wi-Fi down)."""
        with self.cond:
            self.cond.wait_for(lambda: self.frame_id != last_id or not self.running, timeout)
            if self.frame_id == last_id or self.frame is None:
                return last_id, None
            return self.frame_id, self.frame

    def stop(self):
        self.running = False
        with self.cond:
            self.cond.notify_all()

    def _run(self):
        while self.running:
            try:
                with urllib.request.urlopen(self.source, timeout=self.CONNECT_TIMEOUT) as stream:
                    self.error = None
                    print(f'[camera] connected to {self.source}', flush=True)
                    self._read_stream(stream)
            except Exception as e:  # camera off, wrong address, Wi-Fi dropped...
                if self.error != str(e):
                    print(f'[camera] {self.source}: {e}. Retrying...', flush=True)
                self.error = str(e)
            if self.running:
                time.sleep(self.RETRY_SECONDS)

    def _read_stream(self, stream):
        buf = b''
        while self.running:
            chunk = stream.read(4096)
            if not chunk:
                raise ConnectionError('the stream ended')
            buf += chunk
            # Decode only the newest complete picture in the buffer; skip older ones.
            end = buf.rfind(b'\xff\xd9')
            if end < 0:
                if len(buf) > self.MAX_BUFFER:
                    buf = b''
                continue
            start = buf.rfind(b'\xff\xd8', 0, end)
            if start < 0:
                buf = buf[end + 2:]
                continue
            jpeg, buf = buf[start:end + 2], buf[end + 2:]
            frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                continue  # a damaged picture: wait for the next one
            with self.cond:
                self.frame = frame
                self.frame_id += 1
                self.cond.notify_all()


def open_source(source):
    """Open a computer camera (0, 1, ...) or an ESP32 camera stream ("http://...")."""
    if isinstance(source, str) and source.startswith(('http://', 'https://')):
        return NetworkCameraReader(source)
    return WebcamReader(int(source))

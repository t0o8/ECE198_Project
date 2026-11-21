"""
Video input for the tracker: the computer's own camera.

The camera index is CAMERA_SOURCE in exercise_tracker.py.
On a Mac, 0 may be your iPhone (Continuity Camera) - run find_cameras.py
to see which number is the laptop webcam.
"""

import cv2


class WebcamReader:
    """Reads one picture at a time from a computer camera."""

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


def open_source(index):
    """Open the computer camera with this index (0, 1, ...)."""
    return WebcamReader(index)

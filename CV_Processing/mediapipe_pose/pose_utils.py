"""
Shared helpers: model download, angle maths, and turning MediaPipe
landmarks into the body measurements (features) we use.
"""

import os
import ssl
import urllib.request

import certifi
import numpy as np

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "../models", "pose_landmarker_full.task")
MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
             "pose_landmarker_full/float16/latest/pose_landmarker_full.task")

MIN_VISIBILITY = 0.5   # ignore landmarks MediaPipe is not sure about

# MediaPipe landmark index numbers for each side of the body
LANDMARKS = {
    "left":  {"shoulder": 11, "elbow": 13, "wrist": 15,
              "hip": 23, "knee": 25, "ankle": 27},
    "right": {"shoulder": 12, "elbow": 14, "wrist": 16,
              "hip": 24, "knee": 26, "ankle": 28},
}


def download_model_if_needed():
    """Download the pose model file once and save it in the models folder."""
    if os.path.exists(MODEL_PATH):
        return
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    print("Downloading the pose model (about 10 MB, only the first time)...")
    context = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(MODEL_URL, context=context) as response:
        data = response.read()
    with open(MODEL_PATH, "wb") as f:
        f.write(data)
    print("Model saved to", MODEL_PATH)


def joint_angle(a, b, c):
    """Angle (degrees) at point b, formed by a-b-c. Points are (x, y) pixels.

    cos(angle) = (BA . BC) / (|BA| * |BC|)
    """
    ba = np.array(a, dtype=float) - np.array(b, dtype=float)
    bc = np.array(c, dtype=float) - np.array(b, dtype=float)
    lengths = np.linalg.norm(ba) * np.linalg.norm(bc)
    if lengths == 0:
        return 180.0
    cos_value = np.clip(np.dot(ba, bc) / lengths, -1.0, 1.0)
    return float(np.degrees(np.arccos(cos_value)))


def lean_from_vertical(top, bottom):
    """Angle (degrees) between the line bottom->top and straight up.

    0 = upright (standing), about 90 = horizontal (push-up position).
    In images y grows DOWNWARD, so "straight up" is the vector (0, -1).
    """
    v = np.array(top, dtype=float) - np.array(bottom, dtype=float)
    length = np.linalg.norm(v)
    if length == 0:
        return 0.0
    cos_value = np.clip(np.dot(v, np.array([0.0, -1.0])) / length, -1.0, 1.0)
    return float(np.degrees(np.arccos(cos_value)))


def get_body_points(landmarks, width, height):
    """Pick the body side the camera sees better and return its points in pixels.

    Returns None if even the better side is not clearly visible.
    Landmarks are fractions (0-1) of the image, so we multiply by the image
    size. Angles must be measured in pixels, otherwise a wide 16:9 image
    would distort them.
    """
    best_side, best_score = None, -1.0
    for side, ids in LANDMARKS.items():
        score = min(landmarks[i].visibility for i in ids.values())
        if score > best_score:
            best_side, best_score = side, score
    if best_score < MIN_VISIBILITY:
        return None

    points = {"side": best_side}
    for part, i in LANDMARKS[best_side].items():
        points[part] = (int(landmarks[i].x * width), int(landmarks[i].y * height))
    return points


def compute_features(p):
    """All the measurements the recogniser and the rep counters need."""
    return {
        "knee": joint_angle(p["hip"], p["knee"], p["ankle"]),
        "elbow": joint_angle(p["shoulder"], p["elbow"], p["wrist"]),
        "hip": joint_angle(p["shoulder"], p["hip"], p["knee"]),
        "body_line": joint_angle(p["shoulder"], p["hip"], p["ankle"]),
        "torso_lean": lean_from_vertical(p["shoulder"], p["hip"]),
    }

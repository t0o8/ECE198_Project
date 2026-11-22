"""
Safety monitor: fall detection for the coach.

Rule 1 - a fall, in two stages:

  1. SUSPECT - a fast drop: within FALL_WINDOW seconds the hip drops and the
     person ends up ON THE FLOOR: the hip is at about the same height as
     the ankle. This is true lying flat, sitting, or propped up on the
     arms, whatever angle the torso and arms are at. (In a push-up plank
     the hip stays clearly above the ankle, so that is not "on the floor".)
  2. ALERT   - after the drop the person has still not got up after
     DOWN_SECONDS, or has gone out of view for GONE_SECONDS.
     If the person gets back up in time, nothing is shown.

Rule 2 - cannot get up during an exercise:

  The person stays in the low position of a squat or push-up for
  STUCK_SECONDS (for example they sank to the floor in the middle of a rep).

Both rules give the same red CHECK alert, which stays on screen until the
coach presses c.

All numbers are starting values - tune them with SAFE tests (slow, on a mat).
This is a helper that tells the coach to look; it is not a medical device.
"""

import math
from collections import deque

# ---- Stage 1: the fast drop ----
FALL_WINDOW = 1.0      # the drop must happen within this many seconds
UPRIGHT_LEAN = 35      # torso lean below this = upright (deg)
HIP_DROP = 0.5         # hip must drop at least this many torso lengths inside FALL_WINDOW
FLOOR_HIP = 0.2        # hip less than this many torso lengths above the ankle = on the floor
                       # (a push-up plank keeps the hip higher than this, about 0.3-0.4)
STAND_HIP = 0.7        # hip must be at least this high again to count as "got up"

# ---- Stage 2: not up again ----
DOWN_SECONDS = 3.0     # still not upright this long after the drop -> alert
GONE_SECONDS = 1.0     # out of view this long after the drop -> alert

# ---- Cannot get up during an exercise ----
STUCK_SECONDS = 4.0    # in the low position this long -> alert
LOW_KNEE = 140         # squat: knee below this = low position (deg)
LOW_ELBOW = 140        # push-up: elbow below this = low position (deg)
LYING_LEAN = 55        # push-up: torso lean above this = lying, not standing (deg)
RECENT_EXERCISE = 15.0 # only checked if a squat / push-up set was going on in the last ... (s)


class SafetyMonitor:
    def __init__(self):
        self.history = deque()     # (time, torso lean, hip y) for the last FALL_WINDOW
        self.visible = False       # is a person in view right now?
        self.suspect_since = None  # time of the fast drop, or None
        self.gone_since = None     # time the person went out of view, or None
        self.alert = None          # alert message waiting for the coach, or None
        self.body = None           # torso length in pixels while standing: our unit of body size
        self.exercise = None       # last exercise the recogniser locked onto
        self.exercise_time = 0.0   # ... and when
        self.low_since = None      # time the person went into the low position, or None

    def clear(self):
        """The coach has checked on the person: remove the alert."""
        self.alert = None
        self.suspect_since = None
        self.low_since = None

    def status(self):
        """'red' (alert or suspected fall), 'green' (OK) or 'gone' (nobody in view)."""
        if self.alert or self.suspect_since is not None:
            return "red"
        return "green" if self.visible else "gone"

    def update(self, now, points, features, exercise):
        """Check one frame. Returns the alert message if a NEW alert starts, else None.

        exercise is the recogniser's locked exercise ("squat", "pushup", "curl" or None).
        """
        if exercise:
            self.exercise = exercise
            self.exercise_time = now
        if points is None:
            return self._no_person(now)

        self.visible = True
        self.gone_since = None
        lean = features["torso_lean"]
        hip_y = points["hip"][1]
        torso = max(math.dist(points["shoulder"], points["hip"]), 1.0)
        if self.body is None:
            self.body = torso
        elif lean < UPRIGHT_LEAN:
            # Measure body size only while upright: after a fall the torso can
            # point towards the camera and look much shorter than it is.
            self.body = 0.9 * self.body + 0.1 * torso
        # Hip height above the ankle, in torso lengths (y grows downward).
        # Standing is about 1.5 or more, sitting or lying on the floor is near 0.
        hip_height = (points["ankle"][1] - hip_y) / self.body

        self.history.append((now, lean, hip_y))
        while now - self.history[0][0] > FALL_WINDOW:
            self.history.popleft()

        if self.suspect_since is None:
            if self._fast_drop(hip_y, hip_height):
                self.suspect_since = now
                return None
            return self._check_stuck(now, features)

        # A fall is suspected: did they get up, or are they still down?
        if lean < UPRIGHT_LEAN and hip_height > STAND_HIP:
            self.suspect_since = None            # upright AND hip off the floor: all fine
            return None
        if now - self.suspect_since >= DOWN_SECONDS:
            return self._raise("Person fell and has not got up")
        return None

    def _check_stuck(self, now, features):
        """Rule 2: still in the low position of a squat / push-up after STUCK_SECONDS."""
        low = False
        if now - self.exercise_time <= RECENT_EXERCISE:
            if self.exercise == "squat":
                low = features["knee"] < LOW_KNEE
            elif self.exercise == "pushup":
                low = features["elbow"] < LOW_ELBOW and features["torso_lean"] > LYING_LEAN
        if not low:
            self.low_since = None
            return None
        if self.low_since is None:
            self.low_since = now
        if now - self.low_since >= STUCK_SECONDS:
            self.low_since = None
            return self._raise("Person has not got up from the exercise")
        return None

    def _no_person(self, now):
        self.low_since = None
        self.history.clear()
        if self.visible or self.gone_since is None:
            self.gone_since = now                # just went out of view
        self.visible = False
        if self.suspect_since is not None and now - self.gone_since >= GONE_SECONDS:
            return self._raise("Person fell and is out of view")
        return None

    def _fast_drop(self, hip_y, hip_height):
        """True if, within FALL_WINDOW, an upright person dropped and is now on the floor."""
        start = min(self.history, key=lambda s: s[1])    # most upright moment in the window
        hip_drop = (hip_y - start[2]) / self.body        # y grows downward: positive = went down
        on_floor = hip_height < FLOOR_HIP
        return start[1] < UPRIGHT_LEAN and hip_drop >= HIP_DROP and on_floor

    def _raise(self, message):
        self.suspect_since = None
        if self.alert:                           # already showing an alert
            return None
        self.alert = message
        return message

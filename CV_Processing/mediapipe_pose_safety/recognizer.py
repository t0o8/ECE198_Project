"""
Works out WHICH exercise the user is doing, from the last 2 seconds of movement.

Rules (no training needed):
  - Body roughly horizontal + elbows bending        -> push-up
  - Body upright + knees bending                    -> squat
  - Body upright + elbows bending, knees and
    upper arms still                                -> bicep curl
  - Nothing moving much                             -> idle (no exercise)

To avoid flickering:
  - A guess must stay the same for CONFIRM_SECONDS before we lock it in.
  - Once locked, we only unlock after IDLE_SECONDS of no exercise
    (end of a set), or switch after SWITCH_SECONDS of a different exercise.
"""

from collections import deque

WINDOW_SECONDS = 2.0     # how much recent movement we look at
MIN_HISTORY = 1.0        # need at least this much data before guessing
CONFIRM_SECONDS = 0.5
IDLE_SECONDS = 3.0
SWITCH_SECONDS = 3.0

HORIZONTAL_LEAN = 60     # torso lean above this means "lying / push-up position"
KNEE_MOVING = 35         # knee angle range (degrees) that means "knees bending"
ELBOW_MOVING = 40        # elbow angle range that means "elbows bending"
KNEE_STILL = 20          # knee range below this means "legs still"
UPPER_ARM_STILL = 35     # upper arm range below this means "only the forearm moves" (a curl)


class ExerciseRecognizer:
    def __init__(self):
        self.history = deque()       # (time, measurements)
        self.current = None          # locked exercise, e.g. "squat"
        self.candidate = None
        self.candidate_since = 0.0
        self.idle_since = None
        self.other_since = None

    def guess(self):
        """Best guess from the recent window, or None for idle / not sure."""
        if not self.history:
            return None
        span = self.history[-1][0] - self.history[0][0]
        if span < MIN_HISTORY:
            return None

        frames = [f for _, f in self.history]
        mean_lean = sum(f["torso_lean"] for f in frames) / len(frames)
        knees = [f["knee"] for f in frames]
        elbows = [f["elbow"] for f in frames]
        knee_range = max(knees) - min(knees)
        elbow_range = max(elbows) - min(elbows)

        if mean_lean > HORIZONTAL_LEAN:
            return "pushup" if elbow_range > ELBOW_MOVING else None
        if knee_range > KNEE_MOVING:
            return "squat"
        upper_arms = [f["upper_arm"] for f in frames]
        upper_arm_range = max(upper_arms) - min(upper_arms)
        if (elbow_range > ELBOW_MOVING and knee_range < KNEE_STILL
                and upper_arm_range < UPPER_ARM_STILL):
            return "curl"
        return None

    def agrees(self, exercise):
        """False if the last 2 seconds clearly look like a DIFFERENT exercise.

        Used when a rep finishes: right after switching exercises the locked
        exercise is still the old one for a few seconds, and this stops a
        rep of the new exercise being counted as the old one.
        """
        g = self.guess()
        return g is None or g == exercise

    def update(self, t, f):
        """Add one frame. Returns "locked", "switched", "unlocked" or None."""
        self.history.append((t, f))
        while self.history and t - self.history[0][0] > WINDOW_SECONDS:
            self.history.popleft()
        return self._decide(t, self.guess())

    def update_no_person(self, t):
        """Call this when nobody is visible."""
        self.history.clear()
        return self._decide(t, None)

    def _decide(self, t, g):
        # Not locked yet: wait until the same guess holds for a short time
        if self.current is None:
            if g is None:
                self.candidate = None
                return None
            if g != self.candidate:
                self.candidate, self.candidate_since = g, t
                return None
            if t - self.candidate_since >= CONFIRM_SECONDS:
                self.current = g
                self.idle_since = self.other_since = None
                return "locked"
            return None

        # Locked: watch for the end of the set or a different exercise
        if g is None:
            self.other_since = None
            if self.idle_since is None:
                self.idle_since = t
            elif t - self.idle_since >= IDLE_SECONDS:
                self.current = None
                self.candidate = None
                return "unlocked"
        elif g != self.current:
            self.idle_since = None
            if self.other_since is None:
                self.other_since = t
            elif t - self.other_since >= SWITCH_SECONDS:
                self.current = g
                self.other_since = None
                return "switched"
        else:
            self.idle_since = self.other_since = None
        return None

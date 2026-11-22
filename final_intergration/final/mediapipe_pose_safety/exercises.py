"""
Rep counters for each exercise, plus the rules that judge each rep.

Every exercise uses the same UP/DOWN state machine on one main angle:
  UP   -> main angle below START for CONFIRM_FRAMES frames  -> DOWN  (rep has started)
  DOWN -> main angle above FINISH for CONFIRM_FRAMES frames -> UP    (rep finished)
A finished rep only counts if the main angle got down to BOTTOM at some point.
While DOWN, we remember the smallest and largest value of every
measurement, then the judge() rules decide GOOD or BAD.

Why three angles and a frame count (noise): MediaPipe's single-camera joint angles are
typically off by about 6-15 degrees and jump from frame to frame. With START and FINISH
close together, jitter near them counted one rep twice. Now jitter has to cross the whole
START..FINISH gap (30-40 degrees), stay there for CONFIRM_FRAMES frames, AND the rep must
have reached BOTTOM, so a wobble at the top or bottom can't make an extra rep.

All numbers are starting points - tune them with real tests.
"""

DISPLAY_NAMES = {"squat": "Squat", "pushup": "Push-up", "curl": "Bicep curl"}


CONFIRM_FRAMES = 3   # the angle must stay past START / FINISH this many frames in a row (~0.1 s)


class RepCounter:
    name = ""
    main_angle = ""      # which measurement drives the counting
    start = 140          # main angle below this: rep started
    bottom = None        # main angle must get down to this for the rep to count (None = any)
    finish = 160         # main angle above this: rep finished

    def __init__(self):
        self.reset()

    def reset(self):
        self.state = "UP"
        self.lowest = {}     # smallest value of each measurement during the rep
        self.highest = {}    # largest value of each measurement during the rep
        self.streak = 0      # frames in a row past the next line

    def update(self, f):
        """Feed one frame of measurements. Returns a result when a rep finishes."""
        angle = f[self.main_angle]

        if self.state == "UP":
            if angle < self.start:
                if self.streak == 0:
                    self.lowest, self.highest = dict(f), dict(f)
                else:
                    self._track(f)
                self.streak += 1
                if self.streak >= CONFIRM_FRAMES:
                    self.state, self.streak = "DOWN", 0
            else:
                self.streak = 0
            return None

        self._track(f)
        if angle > self.finish:
            self.streak += 1
        else:
            self.streak = 0
        if self.streak >= CONFIRM_FRAMES:
            self.state, self.streak = "UP", 0
            if self.bottom is not None and self.lowest[self.main_angle] > self.bottom:
                return None                      # never got deep enough: not a rep
            if not self.is_real_rep(self.lowest, self.highest):
                return None                      # just moving around, not a rep
            status, message = self.judge(self.lowest, self.highest)
            return {"exercise": self.name, "status": status, "msg": message,
                    "lowest_angle": round(self.lowest[self.main_angle])}
        return None

    def _track(self, f):
        for key, value in f.items():
            self.lowest[key] = min(self.lowest[key], value)
            self.highest[key] = max(self.highest[key], value)

    def is_real_rep(self, low, high):
        """False if the movement was not really an attempt at this exercise."""
        return True

    def judge(self, low, high):
        return "good", "Good rep!"


class SquatCounter(RepCounter):
    name = "squat"
    main_angle = "knee"
    # Knee angle (hip-knee-ankle) is about 170-180 standing; thighs parallel to the floor is
    # roughly 80-100 (sources differ). Open-source MediaPipe counters use down < 90-110 and
    # up > 150-170.
    start = 145
    bottom = 135         # must bend at least this far to count (shallow ones count, but score badly)
    finish = 160
    GOOD_DEPTH = 70        # knee must bend to this angle or lower
    MAX_TORSO_LEAN = 50     # chest should not drop too far forward

    def judge(self, low, high):
        if low["knee"] > self.GOOD_DEPTH:
            return "bad", "Go lower"
        if high["torso_lean"] > self.MAX_TORSO_LEAN:
            return "bad", "Keep chest up"
        return "good", "Good rep!"


class PushupCounter(RepCounter):
    name = "pushup"
    main_angle = "elbow"
    # Elbow about 160-180 with arms straight; the standard test depth is 90 degrees.
    start = 140
    bottom = 130         # must lower at least this far to count (shallow ones score badly)
    finish = 155
    GOOD_DEPTH = 80        # elbow must bend to this angle or lower
    MIN_BODY_LINE = 150     # shoulder-hip-ankle should stay close to 180

    def judge(self, low, high):
        if low["elbow"] > self.GOOD_DEPTH:
            return "bad", "Go lower"
        if low["body_line"] < self.MIN_BODY_LINE:
            return "bad", "Keep body straight"
        return "good", "Good rep!"


class CurlCounter(RepCounter):
    name = "curl"
    main_angle = "elbow"
    # Elbow about 160-170 with the arm hanging; a full curl closes to about 30-60 degrees.
    # Open-source counters use up < 30-40 and down > 150-160.
    start = 120
    finish = 150
    MIN_BEND = 105          # elbow must bend below this, or it is not a curl at all (ignored)
    bottom = MIN_BEND
    MAX_ARM_SWING = 35      # upper arm swinging more than this = swinging the arm, not a curl (ignored)
    GOOD_TOP = 60           # elbow must close to this angle or lower
    MAX_SWING = 15          # torso should not rock more than this (degrees)

    def is_real_rep(self, low, high):
        if low["elbow"] > self.MIN_BEND:
            return False
        return high["upper_arm"] - low["upper_arm"] <= self.MAX_ARM_SWING

    def judge(self, low, high):
        if low["elbow"] > self.GOOD_TOP:
            return "bad", "Curl higher"
        if high["torso_lean"] - low["torso_lean"] > self.MAX_SWING:
            return "bad", "Don't swing"
        return "good", "Good rep!"


def make_counters():
    return {c.name: c() for c in (SquatCounter, PushupCounter, CurlCounter)}

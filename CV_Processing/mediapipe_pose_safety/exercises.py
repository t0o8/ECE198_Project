"""
Rep counters for each exercise, plus the rules that judge each rep.

Every exercise uses the same UP/DOWN state machine on one main angle:
  UP   -> main angle drops below START  -> DOWN  (rep has started)
  DOWN -> main angle rises above FINISH -> UP    (rep finished, judge it)
While DOWN, we remember the smallest and largest value of every
measurement, then the judge() rules decide GOOD or BAD.

All numbers are starting points - tune them with real tests.
"""

DISPLAY_NAMES = {"squat": "Squat", "pushup": "Push-up", "curl": "Bicep curl"}


class RepCounter:
    name = ""
    main_angle = ""      # which measurement drives the counting
    start = 140          # main angle below this: rep started
    finish = 160         # main angle above this: rep finished

    def __init__(self):
        self.reset()

    def reset(self):
        self.state = "UP"
        self.lowest = {}     # smallest value of each measurement during the rep
        self.highest = {}    # largest value of each measurement during the rep

    def update(self, f):
        """Feed one frame of measurements. Returns a result when a rep finishes."""
        angle = f[self.main_angle]

        if self.state == "UP":
            if angle < self.start:
                self.state = "DOWN"
                self.lowest = dict(f)
                self.highest = dict(f)
            return None

        for key, value in f.items():
            self.lowest[key] = min(self.lowest[key], value)
            self.highest[key] = max(self.highest[key], value)

        if angle > self.finish:
            self.state = "UP"
            status, message = self.judge(self.lowest, self.highest)
            return {"exercise": self.name, "status": status, "msg": message,
                    "lowest_angle": round(self.lowest[self.main_angle])}
        return None

    def judge(self, low, high):
        return "good", "Good rep!"


class SquatCounter(RepCounter):
    name = "squat"
    main_angle = "knee"
    start = 120 #org 140
    finish = 160
    GOOD_DEPTH = 100        # knee must bend to this angle or lower
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
    start = 140
    finish = 155
    GOOD_DEPTH = 100        # elbow must bend to this angle or lower
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
    start = 120     #original was 140
    finish = 160  
    GOOD_TOP = 60           # elbow must close to this angle or lower
    MAX_SWING = 15          # torso should not rock more than this (degrees)

    def judge(self, low, high):
        if low["elbow"] > self.GOOD_TOP:
            return "bad", "Curl higher"
        if high["torso_lean"] - low["torso_lean"] > self.MAX_SWING:
            return "bad", "Don't swing"
        return "good", "Good rep!"


def make_counters():
    return {c.name: c() for c in (SquatCounter, PushupCounter, CurlCounter)}

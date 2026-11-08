"""
Safety monitor - Plan B: rules + staged confirmation.

Watches the body for signs of danger and raises alerts for the coach.

  URGENT (red) - stays on screen until the coach presses c:
    - Possible fall: a fast drop to the floor, then lying still,
      or dropping out of view.
  CHECK (yellow) - shown for WARNING_HOLD seconds:
    - On the floor after a fast drop, but moving (not confirmed as a fall)
    - Has not come up from the low position of a squat / push-up
    - Lost sight of the person in the middle of a rep
    - Sudden fast movement
    - Several bad reps in a row, or reps getting much slower (tiredness)

A danger is never alarmed on one frame. It goes through stages, like the
exercise recogniser's "lock", so normal movement does not raise alarms:

    normal  ->  suspected (a sudden change)  ->  confirmed (what happens next)  ->  alert

All numbers are starting values - tune them with SAFE tests (slow, on a mat).
This is a helper that tells the coach to look; it is not a medical device.
"""

import math
from collections import deque

# ---- Alerts ----
WARNING_HOLD = 10.0      # a CHECK alert stays on screen this long (s)
COOLDOWN = 15.0          # the same kind of alert is not repeated sooner than this (s)
HISTORY_SECONDS = 3.0    # how much recent movement is kept

# ---- Fall (stage 1: suspect) ----
FALL_WINDOW = 1.0        # the drop must happen within this many seconds
UPRIGHT_LEAN = 35        # torso lean below this = upright (deg)
FALLEN_LEAN = 55         # torso lean above this = near horizontal (deg)
LEAN_JUMP = 30           # lean must grow by at least this much inside FALL_WINDOW (deg)
HIP_DROP = 0.5           # hip must drop at least this many torso lengths inside FALL_WINDOW

# ---- Fall (stage 2: confirm or cancel) ----
CONFIRM_STILL = 2.0      # lying still this long after the drop = confirmed fall (s)
STILL_MOVE = 0.25        # hip moving less than this (torso lengths) = "still"
ARMS_MOVING = 40         # elbow range above this after the drop = push-ups, cancel (deg)
GONE_AFTER_DROP = 1.0    # body out of view this long after the drop = confirmed fall (s)
SUSPECT_TIMEOUT = 6.0    # give up on a suspected fall after this long (s)

# ---- Has not come up ----
STUCK_SECONDS = 8.0      # in the low position this long (s)
LOW_KNEE = 140           # squat: knee below this = low position (deg)
LOW_ELBOW = 140          # push-up: elbow below this = low position (deg)
LYING_LEAN = 60          # push-up: torso lean above this = lying (deg)
RECENT_EXERCISE = 15.0   # only check if this exercise was done in the last ... (s)

# ---- Lost sight mid-rep ----
GONE_SECONDS = 2.0       # body out of view this long while in the middle of a rep (s)

# ---- Sudden movement ----
SPEED_SPAN = 0.15        # compare the body now with this many seconds ago
LEAN_SPEED = 150         # torso tipping faster than this (deg/s)
HIP_SPEED = 2.0          # hip moving faster than this (torso lengths/s)
MIN_HOT_FRAMES = 3       # over the limit this many frames in a row (ignores glitches)

# ---- Tiredness ----
RECENT_REPS = 3          # look at the last few reps of a set ...
BAD_FOR_TIRED = 2        # ... and alert if this many were BAD
BASELINE_REPS = 3        # the first gaps between reps set the normal speed
SLOW_FACTOR = 1.8        # a gap this many times the normal gap = much slower
REST_GAP = 10.0          # a gap longer than this = a new set (s)

URGENT = "urgent"
CHECK = "check"


class SafetyMonitor:
    def __init__(self):
        self.reset()

    def reset(self):
        self.history = deque()        # (time, lean, hip_y, torso_length, elbow)
        self.visible = False
        self.fall_state = "normal"    # "normal" or "suspect"
        self.suspect_since = None
        self.gone_since = None
        self.gone_mid_rep = False
        self.low_since = None
        self.stuck_reported = False
        self.hot_frames = 0
        self.last_exercise = None
        self.last_exercise_time = -1e9
        self.sets = {}                # exercise -> {"statuses": deque, "times": list}
        self.urgent = None            # the URGENT alert waiting for the coach
        self.warning = None           # the latest CHECK alert
        self.last_raised = {}         # alert kind -> time, for COOLDOWN

    # ============================================================
    # Alerts
    # ============================================================

    def _raise(self, now, level, kind, msg):
        """Create an alert, unless the same kind was raised very recently."""
        if now - self.last_raised.get(kind, -1e9) < COOLDOWN:
            return None
        self.last_raised[kind] = now
        alert = {"level": level, "kind": kind, "msg": msg, "time": now}
        if level == URGENT:
            self.urgent = alert
        else:
            self.warning = alert
        return alert

    def clear(self):
        """The coach has checked: remove the alerts on screen."""
        self.urgent = None
        self.warning = None

    def active_alert(self, now):
        """The alert to show now (URGENT first), or None."""
        if self.urgent:
            return self.urgent
        if self.warning and now - self.warning["time"] < WARNING_HOLD:
            return self.warning
        return None

    def status(self, now):
        """'red', 'yellow', 'green' or 'gone' (nobody in view)."""
        alert = self.active_alert(now)
        if alert:
            return "red" if alert["level"] == URGENT else "yellow"
        return "green" if self.visible else "gone"

    # ============================================================
    # Called every frame
    # ============================================================

    def update(self, now, points, features, recognizer, counters):
        """Check one frame. Returns the list of NEW alerts (often empty)."""
        new = []
        if recognizer.current:
            self.last_exercise = recognizer.current
            self.last_exercise_time = now

        if points is None or features is None:
            self._no_person(now, recognizer, counters, new)
        else:
            self._person(now, points, features, new)
        return [a for a in new if a]

    def _person(self, now, points, features, new):
        self.visible = True
        self.gone_since = None
        self.gone_mid_rep = False

        shoulder, hip = points["shoulder"], points["hip"]
        torso = max(math.dist(shoulder, hip), 1.0)   # body size in pixels
        lean = features["torso_lean"]
        self.history.append((now, lean, hip[1], torso, features["elbow"]))
        while self.history and now - self.history[0][0] > HISTORY_SECONDS:
            self.history.popleft()

        self._check_fall(now, lean, hip[1], new)
        if self.fall_state == "normal":
            self._check_sudden(now, new)
        self._check_stuck(now, features, new)

    def _no_person(self, now, recognizer, counters, new):
        if self.visible or self.gone_since is None:
            # the body has just disappeared: remember if it was mid-rep
            self.visible = False
            self.gone_since = now
            current = recognizer.current
            self.gone_mid_rep = current in counters and counters[current].state == "DOWN"

        gone_for = now - self.gone_since
        if self.fall_state == "suspect" and gone_for >= GONE_AFTER_DROP:
            new.append(self._raise(now, URGENT, "fall",
                                   "Possible FALL - person dropped out of view"))
            self.fall_state = "normal"
        elif self.gone_mid_rep and gone_for >= GONE_SECONDS:
            new.append(self._raise(now, CHECK, "lost",
                                   "Lost sight of the person in the middle of a rep"))
            self.gone_mid_rep = False

        self.history.clear()
        self.low_since = None
        self.hot_frames = 0

    # ============================================================
    # 1. Fall: suspect (fast drop) -> confirm (still / out of view) or cancel
    # ============================================================

    def _check_fall(self, now, lean, hip_y, new):
        if self.fall_state == "normal":
            recent = [s for s in self.history if now - s[0] <= FALL_WINDOW]
            start = min(recent, key=lambda s: s[1])      # most upright moment in the window
            drop = (hip_y - start[2]) / start[3]         # y grows downward: positive = hip went down
            if (start[1] < UPRIGHT_LEAN and lean > FALLEN_LEAN
                    and lean - start[1] >= LEAN_JUMP and drop >= HIP_DROP):
                self.fall_state = "suspect"
                self.suspect_since = now
            return

        # --- a fall is suspected: watch what happens next ---
        since = now - self.suspect_since
        if lean < UPRIGHT_LEAN:
            self.fall_state = "normal"                   # got back up by themselves
            return

        after = [s for s in self.history if s[0] >= self.suspect_since + 0.3]
        if after:
            elbows = [s[4] for s in after]
            if max(elbows) - min(elbows) > ARMS_MOVING:
                self.fall_state = "normal"               # arms working: push-ups, not a fall
                return

        if since >= CONFIRM_STILL + 0.3:
            # look at the last CONFIRM_STILL seconds (skip the moment of impact)
            window = [s for s in self.history
                      if s[0] >= max(self.suspect_since + 0.3, now - CONFIRM_STILL)]
            hips = [s[2] / s[3] for s in window]         # hip height in torso lengths
            if len(hips) >= 2 and max(hips) - min(hips) < STILL_MOVE and lean > FALLEN_LEAN:
                new.append(self._raise(now, URGENT, "fall",
                                       "Possible FALL - person on the floor and not moving"))
                self.fall_state = "normal"
                return

        if since > SUSPECT_TIMEOUT:
            if lean > FALLEN_LEAN:
                new.append(self._raise(now, CHECK, "floor",
                                       "Person is on the floor after a fast drop"))
            self.fall_state = "normal"

    # ============================================================
    # 2. Sudden movement: too fast for several frames in a row
    # ============================================================

    def _check_sudden(self, now, new):
        older = [s for s in self.history if now - s[0] >= SPEED_SPAN]
        if not older:
            self.hot_frames = 0
            return
        then, cur = older[-1], self.history[-1]
        dt = cur[0] - then[0]
        if dt <= 0:
            return
        lean_speed = abs(cur[1] - then[1]) / dt
        hip_speed = abs(cur[2] - then[2]) / cur[3] / dt
        if lean_speed > LEAN_SPEED or hip_speed > HIP_SPEED:
            self.hot_frames += 1
        else:
            self.hot_frames = 0
        if self.hot_frames >= MIN_HOT_FRAMES:
            new.append(self._raise(now, CHECK, "sudden",
                                   "Sudden fast movement - ask them to slow down"))
            self.hot_frames = 0

    # ============================================================
    # 3. Has not come up: stays in the low position too long
    # ============================================================

    def _check_stuck(self, now, features, new):
        exercise = self.last_exercise
        if exercise is None or now - self.last_exercise_time > RECENT_EXERCISE:
            self.low_since = None
            return
        if exercise == "squat":
            low = features["knee"] < LOW_KNEE
            where = "squat"
        elif exercise == "pushup":
            low = features["elbow"] < LOW_ELBOW and features["torso_lean"] > LYING_LEAN
            where = "push-up"
        else:
            self.low_since = None                        # curls have no risky low position
            return

        if not low:
            self.low_since = None
            self.stuck_reported = False
            return
        if self.low_since is None:
            self.low_since = now
        if not self.stuck_reported and now - self.low_since >= STUCK_SECONDS:
            new.append(self._raise(now, CHECK, "stuck",
                                   f"Has not come up from the {where} for "
                                   f"{STUCK_SECONDS:.0f} s - check they are OK"))
            self.stuck_reported = True

    # ============================================================
    # 4. Tiredness: called once for every counted rep
    # ============================================================

    def on_rep(self, event, now):
        """Check a finished rep. Returns the list of NEW alerts (often empty)."""
        exercise = event["exercise"]
        rep_set = self.sets.get(exercise)
        if rep_set is None or now - rep_set["times"][-1] > REST_GAP:
            rep_set = {"statuses": deque(maxlen=RECENT_REPS), "times": []}   # a new set
            self.sets[exercise] = rep_set
        rep_set["statuses"].append(event["status"])
        rep_set["times"].append(now)

        new = []
        statuses = rep_set["statuses"]
        if len(statuses) == RECENT_REPS and list(statuses).count("bad") >= BAD_FOR_TIRED:
            new.append(self._raise(now, CHECK, "tired-form",
                                   "Several bad reps in a row - they may be tired"))

        times = rep_set["times"]
        if len(times) >= BASELINE_REPS + 2:
            gaps = [b - a for a, b in zip(times, times[1:])]
            first = sorted(gaps[:BASELINE_REPS])
            normal_gap = first[len(first) // 2]          # median of the first gaps
            if gaps[-1] > SLOW_FACTOR * normal_gap:
                new.append(self._raise(now, CHECK, "tired-slow",
                                       "Reps are getting much slower - they may be tired"))
        return [a for a in new if a]

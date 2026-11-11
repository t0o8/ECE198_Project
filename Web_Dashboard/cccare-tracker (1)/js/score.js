/* How a workout is scored, and the live state kept for each participant. */
(function () {
  'use strict';
  const CC = (window.CC = window.CC || {});
  const { clamp, round1, mean, fmtExertion, fmtDuration, fmtClock, plural } = CC.util;

  const LIMITS = {
    exertionHigh: 8, // 0–10 scale. 8 and above is "very hard".
    idleSeconds: 25, // flag anyone mid-set (or not started) with no rep for this long
    // Rest after a finished set is set per exercise by the instructor (CC.restOf); the
    // no-rep flag waits that long plus idleSeconds.
    setGapSeconds: 15, // a pause at least this long ends a set, so the next rep starts the next set
    faultHoldSeconds: 10, // a form fault stays on screen this long after it was seen
    recentReps: 5, // the quality figure on each block is the average of the last five reps
    errorReps: 2, // a form fault, or going over the planned reps, only counts once at least this many reps show it

    // ---- safety (see Tracker.condition) ----
    stillMotion: 0.05, // camera movement level (0-1) below which someone counts as not moving
    stillSeconds: 30, // not moving for this long (outside a planned rest) is flagged
    unconsciousSeconds: 15, // fallen, or on the floor in a standing exercise, and not moving this long
    exhaustedExertion: 9, // exertion at or above this for exhaustedSeconds counts as exhausted
    exhaustedSeconds: 20,
    exhaustedPeak: 9.5, // exertion this high counts as exhausted straight away
    qualityDrop: 30, // the last 3 reps this many points below the usual: a sudden change
  };

  // ---------- scoring ----------
  // An exercise result is { sets, reps, done: [reps done in each set], extra, quality }.
  // extra counts reps done after the last planned set.

  const planned = (e) => e.sets * e.reps;
  const setsDone = (e) => e.done.filter((d) => d >= e.reps).length;
  const repsDone = (e) => e.done.reduce((a, b) => a + b, 0) + (e.extra || 0);

  // Share of the planned reps done as planned, 0–1. Every rep short of a set and every rep
  // past it counts against it.
  function adherence(e) {
    const p = planned(e);
    if (!p) return 0;
    let off = e.extra || 0;
    for (let k = 0; k < e.sets; k++) off += Math.abs((e.done[k] || 0) - e.reps);
    return clamp(1 - off / p, 0, 1);
  }

  // Exercise success, 0–100: adherence times the average movement quality of its reps.
  const exerciseValue = (e) => (e.quality == null || !repsDone(e) ? 0 : adherence(e) * e.quality);
  const exerciseSuccess = (e) => Math.round(exerciseValue(e));

  // Workout success, 0–100: the exercises' success weighted by how many reps each one plans.
  function workoutSuccess(list) {
    let num = 0;
    let den = 0;
    for (const e of list) {
      num += exerciseValue(e) * planned(e);
      den += planned(e);
    }
    return den ? Math.round(num / den) : 0;
  }

  // Colour of a saved result's wheel, 0–100: the plain average of each exercise's success.
  // The wheel's fill still shows overall success; its colour shows how well each exercise
  // went on average, so one long exercise doesn't outweigh the others.
  function colorScore(list) {
    if (!list || !list.length) return null;
    return Math.round(mean(list.map((e) => exerciseValue(e))));
  }

  // ---------- live tracker ----------

  class Tracker {
    // speed is above 1 when the simulator runs faster than real time; waits scale with it.
    constructor(slot, startedAt, speed) {
      this.id = slot.id;
      this.name = slot.name;
      this.speed = speed || 1;
      this.plan = slot.workout.map((w) => ({
        exercise: w.exercise,
        sets: w.sets,
        reps: w.reps,
        rest: CC.restOf(w),
        done: new Array(w.sets).fill(0),
        extra: 0,
        qualities: [],
        faults: {},
      }));
      this.ex = 0; // current exercise
      this.set = 0; // current set; equals the exercise's set count once past its last set
      this.reps = 0;
      this.recent = [];
      this.currentFaults = [];
      this.faultsAt = -Infinity;
      this.exertion = null;
      this.exertionSum = 0;
      this.exertionCount = 0;
      this.exertionPeak = null;
      this.lastRepAt = startedAt;

      // Safety signals from the camera pipeline. Their times are real (wall-clock) times,
      // not session time, so they keep counting while the session is paused.
      this.startedAt = startedAt;
      this.motionAt = -Infinity; // when the last movement level arrived (-Infinity: none ever)
      this.stillSince = null; // when they stopped moving, or null while moving
      this.posture = null; // 'upright', 'floor' or 'fallen'; null until the pipeline says
      this.fallAt = null;
      this.highSince = null; // when exertion reached exhaustedExertion
      this.lastRepReal = null;
      this.allQualities = [];
      this.ack = ''; // the alert the instructor has marked as checked
      this.incidents = []; // every possible emergency, for the saved result
      this.activeKinds = new Set();
    }

    seconds(since, now) {
      return Math.max(0, ((now - since) / 1000) * this.speed);
    }

    // Where the next rep goes. A pause of setGapSeconds or more after a rep starts a new set.
    // When the camera pipeline names the exercise, a different exercise moves straight to it.
    nextPosition(exercise, now) {
      const plan = this.plan;
      if (exercise && plan[this.ex].exercise !== exercise) {
        const matches = plan.map((_, i) => i).filter((i) => plan[i].exercise === exercise);
        if (matches.length) {
          const open = matches.find((i) => plan[i].done.includes(0));
          const ex = open == null ? matches[0] : open;
          const set = plan[ex].done.indexOf(0);
          return { ex, set: set === -1 ? plan[ex].sets : set };
        }
      }
      const e = plan[this.ex];
      const started = this.set >= e.sets || e.done[this.set] > 0;
      if (!this.reps || !started || this.seconds(this.lastRepAt, now) < LIMITS.setGapSeconds) {
        return { ex: this.ex, set: this.set };
      }
      if (this.set + 1 < e.sets) return { ex: this.ex, set: this.set + 1 };
      if (!exercise && this.ex + 1 < plan.length) return { ex: this.ex + 1, set: 0 };
      return { ex: this.ex, set: e.sets };
    }

    // Events come from the simulator or the live socket, already validated by feed.js.
    // now is session time (it stands still while paused); real is the wall-clock time.
    apply(event, now, real) {
      if (real == null) real = now;
      if (event.type === 'motion') {
        this.motionAt = real;
        if (event.level < LIMITS.stillMotion) {
          if (this.stillSince == null) this.stillSince = real;
        } else {
          this.stillSince = null;
        }
        return;
      }
      if (event.type === 'posture') {
        if (event.posture === 'fallen' && this.posture !== 'fallen') this.fallAt = real;
        if (event.posture !== 'fallen') this.fallAt = null;
        this.posture = event.posture;
        return;
      }
      if (event.type === 'rep') {
        // A rep means they're moving, and upright enough to exercise.
        this.stillSince = null;
        this.lastRepReal = real;
        this.allQualities.push(event.quality);
        const pos = this.nextPosition(event.exercise, now);
        this.ex = pos.ex;
        this.set = pos.set;
        const e = this.plan[this.ex];
        if (this.set < e.sets) e.done[this.set] += 1;
        else e.extra += 1;
        e.qualities.push(event.quality);
        for (const code of new Set(event.faults)) e.faults[code] = (e.faults[code] || 0) + 1;
        this.recent.push(event.quality);
        if (this.recent.length > LIMITS.recentReps) this.recent.shift();
        this.reps += 1;
        this.currentFaults = event.faults.slice(0, 3);
        this.faultsAt = now;
        this.lastRepAt = now;
      } else if (event.type === 'faults') {
        this.currentFaults = event.faults.slice(0, 3);
        this.faultsAt = now;
      } else if (event.type === 'exertion') {
        this.exertion = event.value;
        this.exertionSum += event.value;
        this.exertionCount += 1;
        this.exertionPeak = Math.max(this.exertionPeak == null ? 0 : this.exertionPeak, event.value);
        if (event.value >= LIMITS.exhaustedExertion) {
          if (this.highSince == null) this.highSince = real;
        } else {
          this.highSince = null;
        }
      }
    }

    // ---------- safety ----------

    // Seconds without movement, from the camera's movement level. null when the pipeline
    // doesn't send movement levels (then only "no reps" can be told).
    stillFor(real) {
      if (this.motionAt === -Infinity) return null;
      return this.stillSince == null ? 0 : this.seconds(this.stillSince, real);
    }

    // Form suddenly much worse: the last 3 reps against the 10 before them.
    qualityDropped() {
      const q = this.allQualities;
      if (q.length < 8) return false;
      return mean(q.slice(-13, -3)) - mean(q.slice(-3)) >= LIMITS.qualityDrop;
    }

    // Signs that someone may be hurt, exhausted or unconscious, most serious first. Each is
    // { kind: 'unconscious' | 'hurt' | 'exhausted', message, cue }. A sign is a reason to go
    // and check on the person; the camera can't tell for certain.
    dangers(real) {
      const list = [];
      const still = this.stillFor(real);
      const ex = CC.EXERCISES[this.current().exercise];
      const floorExercise = !!(ex && ex.floor);
      const fallen = this.posture === 'fallen';
      const downUnexpectedly = fallen || (this.posture === 'floor' && !floorExercise);

      if (downUnexpectedly && still != null && still >= LIMITS.unconsciousSeconds) {
        list.push({
          kind: 'unconscious',
          summary: fallen ? 'Possibly unconscious after a fall' : 'Possibly unconscious on the floor',
          message: `May be unconscious: ${fallen ? 'fell and has' : 'on the floor and has'} not moved for ${fmtDuration(still)}`,
          cue: 'Stay still. Your instructor is coming to check on you.',
        });
      } else if (fallen) {
        list.push({
          kind: 'hurt',
          summary: 'Possible fall',
          message: `May be hurt: fell ${fmtDuration(this.seconds(this.fallAt, real))} ago`,
          cue: 'Stay where you are. Your instructor is coming to help.',
        });
      } else if (downUnexpectedly) {
        list.push({
          kind: 'hurt',
          summary: 'On the floor during a standing exercise',
          message: 'May be hurt: on the floor during a standing exercise',
          cue: 'Stay where you are. Your instructor is coming to check on you.',
        });
      }

      const high = this.highSince == null ? 0 : this.seconds(this.highSince, real);
      if (this.exertion != null && (this.exertion >= LIMITS.exhaustedPeak || high >= LIMITS.exhaustedSeconds)) {
        list.push({
          kind: 'exhausted',
          summary: `Possibly exhausted (effort ${fmtExertion(this.exertion)} of 10)`,
          message: `May be exhausted: effort ${fmtExertion(this.exertion)} of 10${high >= 1 ? ` for ${fmtDuration(high)}` : ''}`,
          cue: 'Stop now and rest. Sit down and breathe slowly.',
        });
      } else if (this.exertion != null && this.exertion >= LIMITS.exertionHigh && this.qualityDropped()) {
        list.push({
          kind: 'exhausted',
          summary: 'Possibly exhausted (high effort, form suddenly worse)',
          message: `May be exhausted: effort ${fmtExertion(this.exertion)} of 10 and form suddenly much worse`,
          cue: 'Stop now and rest. Sit down and breathe slowly.',
        });
      }

      // Form suddenly much worse, then stopped part-way through a set: possibly in pain.
      if (!list.some((d) => d.kind === 'hurt') && this.qualityDropped() && !this.setFinished() && !this.complete() &&
        this.lastRepReal != null && this.seconds(this.lastRepReal, real) >= LIMITS.idleSeconds) {
        list.push({
          kind: 'hurt',
          summary: 'Possibly hurt (form suddenly worse, then stopped mid-set)',
          message: 'May be hurt: form suddenly got much worse, then stopped mid-set',
          cue: 'If anything hurts, stop. Your instructor is coming to check on you.',
        });
      }
      return list;
    }

    // What state someone is in: { state, label, danger, key, acknowledged, still }.
    // state is 'waiting', 'exercising', 'resting', 'still' (not moving for a while),
    // 'done' or 'danger'. The label is a few words for the block.
    condition(real) {
      const danger = this.dangers(real);
      const key = danger.map((d) => d.kind).join('+');
      if (!key) this.ack = ''; // once it's over, the next alert shows in full again

      // Keep a record of each new kind of alert for the saved result.
      const kinds = new Set(danger.map((d) => d.kind));
      for (const d of danger) {
        if (!this.activeKinds.has(d.kind)) {
          this.incidents.push({ kind: d.kind, message: d.summary, atMs: Math.max(0, real - this.startedAt) });
        }
      }
      this.activeKinds = kinds;

      const still = this.stillFor(real);
      const resting = this.reps > 0 && this.setFinished() && !this.complete();
      const stillLimit = resting ? this.restSeconds() + LIMITS.stillSeconds : LIMITS.stillSeconds;
      let state;
      let label;
      if (danger.length) {
        state = 'danger';
        label = 'Possible emergency';
      } else if (this.complete()) {
        state = 'done';
        label = 'Finished';
      } else if (still != null && still >= stillLimit) {
        state = 'still';
        label = `Not moving for ${fmtDuration(still)}`;
      } else if (!this.reps) {
        state = 'waiting';
        label = 'Waiting to start';
      } else if (resting) {
        state = 'resting';
        label = 'Resting';
      } else {
        state = 'exercising';
        label = 'Exercising';
      }
      return { state, label, danger, key, acknowledged: !!key && key === this.ack, still };
    }

    // The instructor has checked on them: the alert stops pulsing until a different one starts.
    acknowledge(key) {
      this.ack = key || '';
    }

    current() {
      return this.plan[this.ex];
    }
    // The current set has reached its reps (or they're past the exercise's last set).
    setFinished() {
      const e = this.current();
      return this.set >= e.sets || e.done[this.set] >= e.reps;
    }
    // Reached the end: the last set of the last exercise is finished.
    complete() {
      const last = this.plan.length - 1;
      return this.reps > 0 && this.ex === last && this.setFinished() && this.set >= this.plan[last].sets - 1;
    }
    // Rest after each set of the current exercise, as the instructor set it.
    restSeconds() {
      return this.current().rest;
    }
    restLeft(now) {
      if (!this.reps || !this.setFinished() || this.complete()) return 0;
      return Math.max(0, this.restSeconds() - this.seconds(this.lastRepAt, now));
    }

    // How well each exercise is going so far, averaged over the exercises, 0–100, or null
    // before the first rep. Unlike success it doesn't count reps not done yet: only sets
    // already finished (or passed) count toward adherence, so a good start shows green.
    performance() {
      const values = this.plan.map((_, i) => this.exercisePerformance(i)).filter((v) => v != null);
      return values.length ? Math.round(mean(values)) : null;
    }

    // The same for one exercise, or null if it hasn't been reached.
    exercisePerformance(i) {
      const e = this.plan[i];
      const started = e.qualities.length > 0;
      if (!started) return i >= this.ex ? null : 0; // not reached yet, or passed without doing any
      let off = e.extra;
      let count = 0;
      e.done.forEach((d, k) => {
        const inProgress = i === this.ex && k === this.set && d < e.reps;
        if (inProgress || (d === 0 && i >= this.ex)) return;
        off += Math.abs(d - e.reps);
        count += 1;
      });
      const adh = count ? clamp(1 - off / (count * e.reps), 0, 1) : 1;
      return Math.round(adh * mean(e.qualities));
    }

    // The current exercise for the big wheel: which set it's on and the reps in that set.
    currentSet() {
      const e = this.current();
      const r = this.exerciseResult(e);
      const extra = this.set >= e.sets;
      return {
        exercise: e.exercise,
        sets: e.sets,
        reps: e.reps,
        set: Math.min(this.set, e.sets - 1) + 1,
        inSet: extra ? e.done[e.sets - 1] : e.done[this.set],
        extra: e.extra,
        setsDone: setsDone(r),
        success: r.success,
        color: this.exercisePerformance(this.ex),
      };
    }

    // Short state for the corner of the block.
    head(now) {
      if (this.complete()) return 'done';
      if (!this.reps) return 'starting';
      const rest = this.restLeft(now);
      if (rest > 0) return 'rest ' + fmtClock(rest * 1000);
      const pos = this.setFinished() ? this.nextPosition(null, Infinity) : { ex: this.ex, set: this.set };
      const e = this.plan[pos.ex];
      return pos.set < e.sets ? `set ${pos.set + 1} of ${e.sets}` : 'extra reps';
    }

    // Shown along the bottom of the block when nothing needs attention.
    status() {
      if (this.complete()) return 'Workout complete';
      if (!this.reps) return 'Waiting for the first rep';
      if (this.setFinished()) {
        const next = this.nextPosition(null, Infinity);
        const e = this.plan[next.ex];
        if (next.ex !== this.ex) return `Rest, then ${CC.exerciseName(e.exercise).toLowerCase()}`;
        if (next.set < e.sets) return `Rest, then set ${next.set + 1} of ${e.sets}`;
        return 'Rest';
      }
      return 'Form looks good';
    }

    // What needs attention right now, most urgent first. Each item is { message, cue }.
    issues(now, real) {
      const list = [];
      const e = this.current();
      const finished = this.complete();
      if (this.exertion != null && this.exertion >= LIMITS.exertionHigh) {
        list.push({ message: `Very hard effort, ${fmtExertion(this.exertion)} of 10`, cue: 'Slow down or take a rest.' });
      }
      if (this.set < e.sets && e.done[this.set] - e.reps >= LIMITS.errorReps) {
        const over = e.done[this.set] - e.reps;
        list.push({
          message: `${plural(over, 'rep')} over in set ${this.set + 1} (${e.done[this.set]} of ${e.reps})`,
          cue: 'That’s the end of this set. Stop and rest.',
        });
      } else if (this.set >= e.sets && e.extra >= LIMITS.errorReps) {
        list.push({
          message: `${plural(e.extra, 'rep')} past the last set`,
          cue: finished ? 'That’s the whole workout. Time to stop and rest.' : 'This exercise is finished. Rest, then move on.',
        });
      }
      if (this.seconds(this.faultsAt, now) <= LIMITS.faultHoldSeconds) {
        // A fault is only shown once it has been seen on at least errorReps reps of this exercise.
        for (const code of this.currentFaults.filter((c) => (e.faults[c] || 0) >= LIMITS.errorReps)) {
          const f = CC.fault(e.exercise, code);
          list.push({ message: f.message, cue: f.cue });
        }
      }
      if (!finished) {
        const idle = this.seconds(this.lastRepAt, now);
        const allowed = this.reps && this.setFinished() ? this.restSeconds() + LIMITS.idleSeconds : LIMITS.idleSeconds;
        // With movement levels from the camera, say when they've stopped moving altogether.
        const cond = this.condition(real == null ? now : real);
        if (cond.state === 'still') list.push({ message: cond.label, cue: 'Is everything OK? Carry on when you’re ready.' });
        else if (idle >= allowed) list.push({ message: `No reps for ${fmtDuration(idle)}`, cue: 'Carry on when you’re ready.' });
      }
      return list;
    }

    exerciseResult(e) {
      const r = {
        exercise: e.exercise,
        sets: e.sets,
        reps: e.reps,
        done: e.done.slice(),
        extra: e.extra,
        quality: e.qualities.length ? Math.round(mean(e.qualities)) : null,
        faults: Object.assign({}, e.faults),
      };
      r.success = exerciseSuccess(r);
      return r;
    }

    success() {
      return workoutSuccess(this.plan.map((e) => this.exerciseResult(e)));
    }

    // Everything a block needs to draw itself. The patient's screen gets the same object.
    snapshot(now, real) {
      if (real == null) real = now;
      const condition = this.condition(real);
      const finished = this.complete();
      return {
        id: this.id,
        name: this.name,
        success: this.success(),
        color: this.performance(),
        resting: this.restLeft(now) > 0,
        repsDone: this.reps,
        repsPlanned: this.plan.reduce((n, e) => n + planned(e), 0),
        setsDone: this.plan.reduce((n, e) => n + setsDone(e), 0),
        setsPlanned: this.plan.reduce((n, e) => n + e.sets, 0),
        now: this.currentSet(),
        quality: this.recent.length ? Math.round(mean(this.recent)) : null,
        exertion: this.exertion,
        head: this.head(now),
        status: this.status(),
        exercises: this.plan.map((e, i) => {
          const r = this.exerciseResult(e);
          return {
            exercise: e.exercise, sets: e.sets, reps: e.reps,
            done: repsDone(r), planned: planned(r), success: r.success, setsDone: setsDone(r),
            current: !finished && i === this.ex,
          };
        }),
        issues: this.issues(now, real),
        condition,
      };
    }

    // Where this person was when the session ended, or null if they had finished.
    stoppedAt() {
      if (this.complete()) return null;
      const e = this.current();
      return {
        exercise: e.exercise,
        exerciseNumber: this.ex + 1,
        exercises: this.plan.length,
        set: Math.min(this.set, e.sets - 1) + 1,
        sets: e.sets,
        inSet: this.set < e.sets ? e.done[this.set] : e.done[e.sets - 1],
        reps: e.reps,
        resting: this.reps > 0 && this.setFinished(), // between sets: that set was finished
      };
    }

    // The saved result. When the session ended before this person finished, only what they
    // reached counts: the exercises up to the current one, and its sets up to the current
    // set. Exercises they never got to aren't counted against them.
    result() {
      const stop = this.stoppedAt();
      let plan = this.plan;
      if (stop) {
        plan = this.plan.slice(0, this.ex + 1).map((e, i) => {
          if (i < this.ex) return e;
          const keep = Math.min(e.sets, this.set + 1);
          return Object.assign({}, e, { sets: keep, done: e.done.slice(0, keep) });
        });
      }
      const exercises = plan.map((e) => this.exerciseResult(e));
      const all = plan.flatMap((e) => e.qualities);
      return {
        id: this.id,
        name: this.name,
        stoppedAt: stop,
        incidents: this.incidents.slice(),
        exercisesPlanned: this.plan.length,
        exercises,
        repsDone: this.reps,
        repsPlanned: exercises.reduce((n, e) => n + planned(e), 0),
        setsDone: exercises.reduce((n, e) => n + setsDone(e), 0),
        setsPlanned: exercises.reduce((n, e) => n + e.sets, 0),
        quality: all.length ? Math.round(mean(all)) : null,
        exertionAvg: this.exertionCount ? round1(this.exertionSum / this.exertionCount) : null,
        exertionPeak: this.exertionPeak,
        success: workoutSuccess(exercises),
      };
    }
  }

  CC.LIMITS = LIMITS;
  CC.score = { planned, repsDone, setsDone, adherence, exerciseSuccess, workoutSuccess, colorScore };
  CC.Tracker = Tracker;
})();

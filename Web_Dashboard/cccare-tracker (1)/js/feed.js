/* Where live exercise data comes from.

   Both sources produce the same events:
     { type: 'rep',      pid: 'P03', quality: 82, faults: ['knees_in'], exercise: 'sit_to_stand' }
         one finished repetition, quality 0–100. exercise is optional.
     { type: 'exertion', pid: 'P03', value: 6 }                exertion, 0–10
     { type: 'faults',   pid: 'P03', faults: ['knees_in'] }    form feedback between reps (optional)

   With ?feed=ws://host:port in the page address, events come from the camera pipeline
   over a WebSocket. Otherwise a simulator makes them up. */
(function () {
  'use strict';
  const CC = (window.CC = window.CC || {});
  const { clamp, gauss, half, pick, shuffle } = CC.util;

  // ---------- validation of incoming messages ----------

  function toPid(v) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= CC.MAX_PARTICIPANTS) return 'P' + String(v).padStart(2, '0');
    const s = String(v == null ? '' : v).trim().toUpperCase();
    const m = /^P?(\d{1,2})$/.exec(s);
    return m ? 'P' + m[1].padStart(2, '0') : null;
  }
  function toFaults(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim().slice(0, 60)).slice(0, 3);
  }
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  // Posture names the pipeline may send, and what the dashboard calls them.
  const POSTURES = {
    upright: 'upright', standing: 'upright', sitting: 'upright', kneeling: 'upright',
    floor: 'floor', lying: 'floor',
    fallen: 'fallen', fall: 'fallen',
  };

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const pid = toPid(raw.pid);
    if (!pid) return null;
    if (raw.type === 'rep') {
      const q = num(raw.quality);
      if (q == null) return null;
      const exercise = typeof raw.exercise === 'string' && CC.EXERCISES[raw.exercise] ? raw.exercise : null;
      return { type: 'rep', pid, quality: clamp(q, 0, 100), faults: toFaults(raw.faults), exercise };
    }
    if (raw.type === 'exertion') {
      const v = num(raw.value);
      return v == null ? null : { type: 'exertion', pid, value: clamp(v, 0, 10) };
    }
    if (raw.type === 'faults') return { type: 'faults', pid, faults: toFaults(raw.faults) };
    if (raw.type === 'motion') {
      // How much the person is moving, 0 (completely still) to 1.
      const v = num(raw.level != null ? raw.level : raw.value);
      return v == null ? null : { type: 'motion', pid, level: clamp(v, 0, 1) };
    }
    if (raw.type === 'posture') {
      const posture = POSTURES[String(raw.posture || '').toLowerCase()];
      return posture ? { type: 'posture', pid, posture } : null;
    }
    return null;
  }

  // ---------- simulator ----------
  // Each simulated person works through their workout: a set of reps, a rest, the next set.
  // Some stop sets short, some go past them, and a few give up part-way through.

  function simulated(slots, emit, speed) {
    const rnd = Math.random;
    let timer = null;

    const people = slots.map((slot) => {
      const habits = {};
      for (const w of slot.workout) habits[w.exercise] = shuffle(Object.keys(CC.EXERCISES[w.exercise].faults), rnd).slice(0, 2);
      const over = rnd() < 0.25 ? 0.2 + rnd() * 0.3 : rnd() * 0.06;
      const under = rnd() < 0.25 ? 0.2 + rnd() * 0.3 : rnd() * 0.06;
      const exBase = 1.5 + rnd() * 1.5;
      return {
        id: slot.id,
        plan: slot.workout,
        ex: 0,
        set: 0,
        inSet: 0,
        stopAt: 0,
        tempo: 2.8 + rnd() * 2.4, // seconds per rep
        quality: 66 + rnd() * 28, // typical movement quality
        fatigue: 4 + rnd() * 12, // quality points lost by the end of a set
        habits,
        under,
        over,
        quitAfter: slot.workout.length > 1 && rnd() < 0.06 ? Math.floor(rnd() * (slot.workout.length - 1)) : null,
        exBase,
        exGain: 0.22 + rnd() * 0.2 + over * 0.6, // exertion added per rep
        exertion: exBase,
        state: 'rest',
        nextAt: 0,
        tickAt: 0,
        motionAt: 0,
        posture: null,
        incident: null, // { kind: 'fall' | 'faint' | 'exhaust', at, started }
      };
    });

    // Now and then someone in the simulation has an emergency, so the safety alerts can be
    // seen. ?incidents=N in the page address makes N people have one (for a demonstration);
    // otherwise each person has a 2% chance. The time is 25 to 80 simulated seconds in.
    const forced = Math.max(0, Math.min(people.length, Math.round(Number(CC.util.param('incidents')) || 0)));
    const chosen = new Set(forced ? shuffle(people, rnd).slice(0, forced) : people.filter(() => rnd() < 0.02));
    const KINDS = ['fall', 'faint', 'exhaust'];
    [...chosen].forEach((p, i) => {
      p.incident = { kind: forced ? KINDS[i % KINDS.length] : pick(KINDS, rnd), delay: 25 + rnd() * 55, started: false };
    });

    function setPosture(p, posture) {
      if (p.posture === posture) return;
      p.posture = posture;
      emit({ type: 'posture', pid: p.id, posture });
    }

    // Movement level and posture, about every 1.5 seconds.
    function body(p, now) {
      if (now < p.motionAt) return;
      p.motionAt = now + 1500 / speed;
      const w = p.plan[Math.min(p.ex, p.plan.length - 1)];
      let level;
      if (p.state === 'incident') {
        level = p.incident.kind === 'faint' ? rnd() * 0.02 : p.incident.kind === 'fall' ? 0.08 + rnd() * 0.12 : 0.1 + rnd() * 0.1;
      } else if (p.state === 'work') {
        level = 0.5 + rnd() * 0.4;
      } else {
        level = 0.12 + rnd() * 0.22;
      }
      emit({ type: 'motion', pid: p.id, level: Math.round(level * 100) / 100 });
      if (p.state !== 'incident') setPosture(p, CC.EXERCISES[w.exercise].floor && p.state !== 'done' ? 'floor' : 'upright');
    }

    function startIncident(p, now) {
      p.incident.started = true;
      if (p.incident.kind === 'exhaust') {
        // Pushes on with effort climbing and form falling apart, then stops mid-set.
        p.exGain = 0.9;
        p.fatigue = 60;
        p.stopAt = p.inSet + 4;
        return;
      }
      p.state = 'incident';
      setPosture(p, 'fallen');
      p.motionAt = now;
    }

    function stopFor(p, w) {
      const r = rnd();
      if (r < p.under) return Math.max(1, w.reps - 1 - Math.floor(rnd() * 3));
      if (r < p.under + p.over) return w.reps + 1 + Math.floor(rnd() * 3);
      return w.reps;
    }

    function step(p, now) {
      body(p, now);
      if (p.incident && !p.incident.started && now >= p.incident.at) startIncident(p, now);
      if (p.state === 'incident') return;
      // Exertion comes back down while resting.
      if (p.state !== 'work' && now >= p.tickAt) {
        if (p.exertion > p.exBase + 0.25) {
          p.exertion = Math.max(p.exBase, p.exertion - 0.5);
          emit({ type: 'exertion', pid: p.id, value: half(p.exertion) });
        }
        p.tickAt = now + 4000 / speed;
      }
      if (p.state === 'done' || now < p.nextAt) return;

      const w = p.plan[p.ex];
      if (p.state === 'rest') {
        p.state = 'work';
        p.inSet = 0;
        p.stopAt = stopFor(p, w);
      }
      p.inSet += 1;
      const q = Math.round(clamp(p.quality - p.fatigue * (p.inSet / w.reps) - 2 * p.ex + gauss(rnd) * 7, 15, 100));
      const codes = Object.keys(CC.EXERCISES[w.exercise].faults);
      const faults = [];
      if (q < 72) faults.push(rnd() < 0.8 ? pick(p.habits[w.exercise], rnd) : pick(codes, rnd));
      if (q < 55) {
        const second = pick(codes, rnd);
        if (!faults.includes(second)) faults.push(second);
      }
      emit({ type: 'rep', pid: p.id, quality: q, faults, exercise: w.exercise });
      p.exertion = clamp(p.exertion + p.exGain + gauss(rnd) * 0.12, 0, 10);
      emit({ type: 'exertion', pid: p.id, value: half(p.exertion) });

      if (p.incident && p.incident.started && p.incident.kind === 'exhaust' && p.inSet >= p.stopAt) {
        p.state = 'incident'; // stops part-way through the set, exhausted
        p.exertion = Math.max(p.exertion, 9.5);
        emit({ type: 'exertion', pid: p.id, value: half(p.exertion) });
        return;
      }
      if (p.inSet < p.stopAt) {
        // Cardio and held exercises have their own pace; others go at the person's tempo.
        const tempo = CC.EXERCISES[w.exercise].tempo || p.tempo;
        let gap = tempo * (0.85 + rnd() * 0.3);
        if (rnd() < 0.04) gap += 2 + rnd() * 5; // a short breather, shorter than a rest
        p.nextAt = now + (gap * 1000) / speed;
        return;
      }

      // End of the set: move on, then rest.
      p.set += 1;
      if (p.set >= w.sets) {
        p.ex += 1;
        p.set = 0;
      }
      const gaveUp = p.quitAfter != null && p.ex > p.quitAfter && p.set === 0;
      p.tickAt = now + 4000 / speed;
      if (p.ex >= p.plan.length || gaveUp) {
        p.state = 'done';
        return;
      }
      // Rests roughly as long as the instructor set for the exercise just done. Never less
      // than the gap the tracker needs to see a new set starting.
      p.state = 'rest';
      const rest = Math.max(CC.LIMITS.setGapSeconds + 1, CC.restOf(w) * (0.8 + rnd() * 0.4));
      p.nextAt = now + (rest * 1000) / speed;
    }

    let pausedAt = null;

    return {
      label: speed === 1 ? 'simulated' : `simulated ×${speed}`,
      speed,
      start() {
        const now = Date.now();
        people.forEach((p) => {
          p.nextAt = now + ((1 + rnd() * 4) * 1000) / speed;
          p.tickAt = now + 4000 / speed;
          if (p.incident) p.incident.at = now + (p.incident.delay * 1000) / speed;
        });
        timer = setInterval(() => {
          const now = Date.now();
          people.forEach((p) => step(p, now));
        }, 100);
      },
      stop() {
        clearInterval(timer);
        timer = null;
      },
      // Everyone freezes where they are; on resume their next rep is pushed back by the pause.
      pause() {
        if (pausedAt != null) return;
        pausedAt = Date.now();
        clearInterval(timer);
        timer = null;
      },
      resume() {
        if (pausedAt == null) return;
        const shift = Date.now() - pausedAt;
        pausedAt = null;
        people.forEach((p) => {
          p.nextAt += shift;
          p.tickAt += shift;
          p.motionAt += shift;
          if (p.incident && !p.incident.started) p.incident.at += shift;
        });
        timer = setInterval(() => {
          const now = Date.now();
          people.forEach((p) => step(p, now));
        }, 100);
      },
    };
  }

  // ---------- live WebSocket feed ----------

  function socket(url, slots, emit, onStatus) {
    const wanted = new Set(slots.map((s) => s.id));
    let ws = null;
    let stopped = false;
    let retries = 0;
    let retryTimer = null;
    let paused = false;

    const send = (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    function connect() {
      onStatus('connecting');
      try {
        ws = new WebSocket(url);
      } catch (e) {
        onStatus('could not open');
        return;
      }
      ws.onopen = () => {
        retries = 0;
        onStatus('connected');
        // Tells the pipeline which stations are in this session and what each one is doing.
        const workouts = {};
        slots.forEach((s) => (workouts[s.id] = s.workout));
        send({ type: 'session', state: 'start', participants: [...wanted], workouts });
      };
      ws.onmessage = (m) => {
        if (typeof m.data !== 'string' || m.data.length > 100000) return;
        let data;
        try {
          data = JSON.parse(m.data);
        } catch (e) {
          return;
        }
        (Array.isArray(data) ? data : [data]).forEach((raw) => {
          const ev = normalize(raw);
          if (!ev || !wanted.has(ev.pid)) return;
          // While paused, reps and form feedback don't count, but the safety signals
          // (movement, posture, exertion) still do.
          if (paused && (ev.type === 'rep' || ev.type === 'faults')) return;
          emit(ev);
        });
      };
      ws.onclose = () => {
        if (stopped) return;
        onStatus('reconnecting');
        retryTimer = setTimeout(connect, Math.min(10000, 1000 * 2 ** retries++));
      };
    }

    return {
      label: 'live',
      speed: 1,
      start: connect,
      stop() {
        stopped = true;
        clearTimeout(retryTimer);
        send({ type: 'session', state: 'end' });
        if (ws) ws.close();
      },
      pause() {
        paused = true;
        send({ type: 'session', state: 'pause' });
      },
      resume() {
        paused = false;
        send({ type: 'session', state: 'resume' });
      },
    };
  }

  CC.feed = {
    normalize,
    // slots: participants in this session. emit(event) is called for each event.
    // onStatus(text) reports the socket state. The returned feed's speed tells the
    // trackers how much faster than real time the simulator runs (?speed=3 in the address).
    create(slots, emit, onStatus) {
      const speed = clamp(Number(CC.util.param('speed')) || 1, 0.25, 20);
      const address = CC.store.feedUrl();
      if (address) {
        try {
          const u = new URL(address);
          if (u.protocol === 'ws:' || u.protocol === 'wss:') return socket(u.href, slots, emit, onStatus);
        } catch (e) {
          /* not a valid address: fall back to the simulator */
        }
        const sim = simulated(slots, emit, speed);
        sim.label = 'simulated (feed address not valid)';
        return sim;
      }
      return simulated(slots, emit, speed);
    },
  };
})();

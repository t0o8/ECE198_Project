/* Instructor: set up the class and each person's workout, watch everyone live, pause or
   end the session. */
CC.start(function () {
  'use strict';
  const account = CC.auth.require('instructor');
  if (!account) return;

  const { h, fill, pad2, toInt, fmtDate, fmtTime, fmtClock, mean, firstName, deepCopy, plural } = CC.util;
  CC.ui.frame(account);

  const MAX = CC.MAX_PARTICIPANTS;
  const LIM = CC.WORKOUT_LIMITS;
  const roster = CC.roster.all();
  const setupEl = document.getElementById('setup');
  const liveEl = document.getElementById('live');
  const tbody = document.getElementById('roster');
  const countInput = document.getElementById('count');
  let count = toInt(CC.store.lastCount(), 1, MAX, 12);

  // ---------- set-up ----------

  function numberInput(value, min, max, label, onChange) {
    const input = h('input', { type: 'number', min, max, value, inputmode: 'numeric', 'aria-label': label });
    input.addEventListener('change', () => {
      const v = toInt(input.value, min, max, value);
      input.value = v;
      value = v;
      onChange(v);
    });
    return input;
  }

  // Only one workout dropdown is open at a time. Clicking elsewhere or Escape closes it.
  function closeDropdowns(except) {
    document.querySelectorAll('details.wk-drop[open]').forEach((d) => {
      if (d !== except) d.open = false;
    });
  }
  document.addEventListener('click', (e) => {
    closeDropdowns(e.target.closest('details.wk-drop'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('details.wk-drop[open]');
    if (open) {
      open.open = false;
      open.querySelector('summary').focus();
    }
  });

  // The workout column: a dropdown whose closed state is one short line, so a long workout
  // never runs into the Edit button.
  function workoutDropdown() {
    const label = h('span', { class: 'wk-drop-label' });
    const list = h('ol', { class: 'wk-drop-list' });
    const el = h('details', { class: 'wk-drop pop' }, h('summary', null, label), list);
    el.addEventListener('toggle', () => {
      if (el.open) closeDropdowns(el);
    });
    return {
      el,
      render(workout) {
        label.textContent = `${plural(workout.length, 'exercise')}: ${CC.exerciseName(workout[0].exercise)}${workout.length > 1 ? ', …' : ''}`;
        fill(list, workout.map((w) => h('li', null,
          h('span', null, CC.exerciseName(w.exercise)),
          h('span', { class: 'mono muted' }, `${CC.planText(w)} · rest ${CC.restOf(w)}s`))));
      },
    };
  }

  // Exercise library: square cards with the animation, grouped by muscle group.
  // filter is a key of CC.MUSCLE_GROUPS, or null for all of them.
  function library(slot, n, state, onChange) {
    const codes = Object.keys(CC.EXERCISES);
    const inWorkout = (code) => slot.workout.some((w) => w.exercise === code);

    const filters = h('div', { class: 'filters', role: 'group', 'aria-label': 'Show exercises for' },
      [null, ...Object.keys(CC.MUSCLE_GROUPS)].map((g) => {
        const b = h('button', { type: 'button', class: 'filter', 'aria-pressed': String(state.filter === g) },
          g ? CC.MUSCLE_GROUPS[g] : 'All muscle groups');
        b.addEventListener('click', () => {
          state.filter = g;
          onChange({ focus: 'filter:' + (g || 'all') });
        });
        b.dataset.focus = 'filter:' + (g || 'all');
        return b;
      }));

    const groups = Object.keys(CC.MUSCLE_GROUPS).filter((g) => !state.filter || state.filter === g);
    const sections = groups.map((g) => {
      const cards = codes.filter((c) => CC.EXERCISES[c].group === g).map((code) => {
        const ex = CC.EXERCISES[code];
        const added = inWorkout(code);
        const onlyOne = added && slot.workout.length === 1;
        const full = !added && slot.workout.length >= LIM.exercises;
        const card = h('button', {
          type: 'button', class: 'ex-card', 'aria-pressed': String(added),
          'aria-disabled': onlyOne || full ? 'true' : null,
          title: onlyOne ? 'A workout needs at least one exercise' : full ? `A workout has at most ${LIM.exercises} exercises` : null,
          'aria-label': `${ex.name}, works ${ex.muscles.join(', ').toLowerCase()}, ${added ? 'in the workout. Press to remove' : 'press to add'}, participant ${n}`,
        },
        h('img', { class: 'ex-gif', src: ex.gif, alt: '', loading: 'lazy', width: 200, height: 200 }),
        h('span', { class: 'ex-card-text' },
          h('span', { class: 'ex-card-name' }, ex.name),
          h('span', { class: 'ex-card-muscles' }, ex.muscles.join(' · '))),
        h('span', { class: 'ex-card-state' }, added ? 'Added' : '+ Add'));
        card.dataset.focus = 'card:' + code;
        card.addEventListener('click', () => {
          if (onlyOne || full) return;
          if (added) slot.workout = slot.workout.filter((w) => w.exercise !== code);
          else slot.workout.push(Object.assign({ exercise: code, rest: LIM.rest }, CC.defaultsFor(code)));
          onChange({ focus: 'card:' + code });
        });
        return card;
      });
      if (!cards.length) return null;
      return h('section', { class: 'ex-group' },
        h('h4', null, CC.MUSCLE_GROUPS[g]),
        h('div', { class: 'ex-grid' }, cards));
    });

    return h('div', { class: 'ex-library' },
      h('h3', null, 'Exercise library'),
      h('p', { class: 'muted ex-library-note' }, 'Muscles worked are shown in red. Press a square to add it to the workout, or press again to remove it.'),
      filters,
      sections);
  }

  // One participant: a row with the name and workout, and a hidden row below it with the
  // workout editor.
  function rowFor(slot) {
    const n = CC.slotNumber(slot.id);
    const drop = workoutDropdown();
    const refresh = () => drop.render(slot.workout);
    const nameInput = h('input', {
      type: 'text', name: 'name', value: slot.name, placeholder: CC.defaultName(slot.id),
      maxlength: 40, autocomplete: 'off', 'aria-label': `Name, participant ${n}`,
    });
    nameInput.addEventListener('input', () => (slot.name = nameInput.value.trim().slice(0, 40)));
    const editBtn = h('button', { type: 'button', class: 'link-btn', 'aria-expanded': 'false' }, 'Edit');
    const editor = h('div', { class: 'wk', id: 'wk-' + slot.id });
    editBtn.setAttribute('aria-controls', editor.id);
    const row = h('tr', null,
      h('td', null, pad2(n)),
      h('td', null, nameInput),
      h('td', null, drop.el),
      h('td', null, editBtn));
    const editorRow = h('tr', { class: 'wk-row', hidden: true }, h('td', { colspan: 4 }, editor));
    const libState = { filter: null };

    function renderEditor(opts) {
      const lines = slot.workout.map((w, i) => {
        const label = `${CC.exerciseName(w.exercise)}, exercise ${i + 1}, participant ${n}`;
        const sets = numberInput(w.sets, 1, LIM.sets, `Sets, ${label}`, (v) => {
          w.sets = v;
          refresh();
        });
        const timed = CC.timed(w.exercise);
        const reps = numberInput(w.reps, 1, LIM.reps, `${timed ? 'Seconds' : 'Reps'} per set, ${label}`, (v) => {
          w.reps = v;
          refresh();
        });
        const rest = numberInput(CC.restOf(w), LIM.restMin, LIM.restMax, `Rest in seconds after each set, ${label}`, (v) => {
          w.rest = v;
          refresh();
        });
        const remove = h('button', {
          type: 'button', class: 'link-btn', disabled: slot.workout.length === 1, 'aria-label': `Remove ${label}`,
        }, 'Remove');
        remove.addEventListener('click', () => {
          slot.workout.splice(i, 1);
          refresh();
          renderEditor();
        });
        const ex = CC.EXERCISES[w.exercise];
        return h('div', { class: 'wk-line' },
          h('span', { class: 'wk-ex' },
            ex && ex.gif ? h('img', { class: 'wk-thumb', src: ex.gif, alt: '', width: 36, height: 36 }) : null,
            h('span', null, CC.exerciseName(w.exercise), timed ? h('small', { class: 'muted' }, ' (seconds)') : null)),
          sets, reps, rest, remove);
      });

      const copy = h('button', { type: 'button', class: 'btn btn-light' }, `Copy to all ${count}`);
      CC.ui.confirmButton(copy, `Press again to copy to all ${count}`, () => {
        roster.slice(0, count).forEach((s) => {
          if (s !== slot) s.workout = deepCopy(slot.workout);
        });
        setCount(count, slot.id);
      });
      const done = h('button', { type: 'button', class: 'btn' }, 'Done');
      done.addEventListener('click', () => {
        toggle(false);
        editBtn.focus();
      });

      fill(editor,
        h('h3', null, 'Workout'),
        h('div', { class: 'wk-labels mono muted', 'aria-hidden': 'true' },
          h('span', null, 'exercise'), h('span', null, 'sets'), h('span', null, 'reps per set'), h('span', null, 'rest (sec)'), h('span')),
        slot.workout.some((w) => CC.timed(w.exercise))
          ? h('p', { class: 'mono muted wk-note' }, 'For held exercises such as the plank, "reps per set" is the seconds to hold.') : null,
        lines,
        library(slot, n, libState, (o) => {
          refresh();
          renderEditor(o);
        }),
        h('div', { class: 'wk-actions' }, copy, done));

      // Re-rendering replaces the buttons, so put the focus back where it was.
      if (opts && opts.focus) {
        const again = editor.querySelector(`[data-focus="${opts.focus}"]`);
        if (again) again.focus();
      }
    }

    // The editor slides open below the row, and slides shut before the row is hidden.
    async function toggle(open) {
      editBtn.setAttribute('aria-expanded', String(open));
      editBtn.textContent = open ? 'Close' : 'Edit';
      if (open) {
        editorRow.hidden = false;
        renderEditor();
        editor.hidden = true;
        await CC.motion.slide(editor, true);
      } else {
        await CC.motion.slide(editor, false);
        if (editBtn.getAttribute('aria-expanded') === 'false') editorRow.hidden = true;
        editor.hidden = false;
      }
    }
    editBtn.addEventListener('click', () => toggle(editorRow.hidden));

    refresh();
    return { slot, rows: [row, editorRow], open: () => toggle(true) };
  }

  // Shows the first n participants. openId keeps that participant's editor open.
  function setCount(n, openId) {
    count = toInt(n, 1, MAX, count);
    countInput.value = count;
    const built = roster.slice(0, count).map(rowFor);
    tbody.replaceChildren(...built.flatMap((b) => b.rows));
    const keep = built.find((b) => b.slot.id === openId);
    if (keep) keep.open();
  }

  document.querySelectorAll('[data-step]').forEach((btn) =>
    btn.addEventListener('click', () => setCount(count + Number(btn.dataset.step))));
  countInput.addEventListener('change', () => setCount(countInput.value));
  setCount(count);

  document.getElementById('start').addEventListener('click', () => {
    CC.roster.save(roster).catch((e) => alert(`The names and workouts weren’t saved: ${e.message}`));
    CC.store.setLastCount(count);
    // The set-up fades away before the live view comes in.
    const startBtn = document.getElementById('start');
    startBtn.disabled = true;
    const slots = CC.roster.all().slice(0, count);
    const fade = CC.motion.reduced() || !setupEl.animate ? null
      : setupEl.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px)' }],
        { duration: 220, easing: 'ease-in', fill: 'forwards' });
    (fade ? fade.finished : Promise.resolve()).then(() => {
      if (fade) fade.cancel();
      startBtn.disabled = false;
      startLive(slots);
    });
  });

  function renderRecent() {
    const list = CC.sessions.all().slice(-6).reverse();
    document.getElementById('recent').replaceChildren(...list.map((s) => {
      const avg = Math.round(mean(s.participants.map((p) => p.success)) || 0);
      return h('li', null, h('a', { href: 'session-results.html?s=' + encodeURIComponent(s.id) },
        h('span', { class: 'mono' }, `${fmtDate(s.startedAt)}, ${fmtTime(s.startedAt)}`),
        h('span', null, `${s.participants.length} participants`),
        h('span', { class: 'mono' }, `avg ${avg}%`),
        h('span', { class: 'mono muted' }, s.sample ? 'sample' : '')));
    }));
  }
  renderRecent();

  // ---------- live ----------

  // Label in the "needs attention" list: number and first name, or just the number.
  function attentionLabel(t) {
    const num = pad2(CC.slotNumber(t.id));
    const first = firstName(t.name);
    return first ? `${num} ${first}` : num;
  }

  function startLive(slots) {
    const startedAt = Date.now();
    const sessionId = CC.sessions.newId(startedAt);
    // "Checked, OK" on a block's alert: the instructor has seen to them.
    const onAck = (id, key) => {
      const t = trackers.get(id);
      if (t) t.acknowledge(key);
      draw();
    };
    const blocks = new Map(slots.map((s) => [s.id, CC.ui.block(s, { audience: 'instructor', onAck })]));
    const grid = document.getElementById('grid');
    const clock = document.getElementById('clock');
    const feedEl = document.getElementById('feed');
    const attention = document.getElementById('attention');
    const pauseBtn = document.getElementById('pause');
    const titleText = document.getElementById('live-word');

    document.getElementById('legend').append(' 0% ', CC.ui.swatches(), ' 100%');
    // Each block comes in a moment after the one before (--i sets the delay).
    [...blocks.values()].forEach((b, i) => b.el.style.setProperty('--i', String(i)));
    grid.replaceChildren(...[...blocks.values()].map((b) => b.el));
    liveEl.classList.add('entering');
    setTimeout(() => liveEl.classList.remove('entering'), 600 + slots.length * 30 + 400);
    grid.classList.toggle('grid-dense', slots.length > 16);
    document.getElementById('live-count').textContent = slots.length;
    setupEl.hidden = true;
    liveEl.hidden = false;
    window.scrollTo(0, 0);

    // Session time stands still while paused, so rest countdowns and "no reps for" timers
    // pick up where they left off.
    let pausedMs = 0;
    let pausedAt = null;
    const sessionNow = () => Date.now() - pausedMs - (pausedAt == null ? 0 : Date.now() - pausedAt);

    // The feed is created first because the trackers need its speed. Its events only
    // start arriving after feed.start(), by which time the trackers exist.
    const feed = CC.feed.create(
      slots,
      (ev) => {
        const t = trackers.get(ev.pid);
        if (!t) return;
        // Paused: reps don't count, but safety signals (movement, posture, exertion) always do.
        const safety = ev.type === 'motion' || ev.type === 'posture' || ev.type === 'exertion';
        if (pausedAt == null || safety) t.apply(ev, sessionNow(), Date.now());
      },
      (status) => (feedEl.textContent = `${feed.label}, ${status}`));
    const trackers = new Map(slots.map((s) => [s.id, new CC.Tracker(s, startedAt, feed.speed)]));
    feedEl.textContent = feed.label;

    let running = true;
    let flaggedKey = null;
    function draw() {
      const now = sessionNow();
      const paused = pausedAt != null;
      clock.textContent = fmtClock(now - startedAt);
      const snapshots = {};
      const flagged = [];
      const emergencies = [];
      for (const [id, t] of trackers) {
        const snap = t.snapshot(now, Date.now());
        if (paused) {
          snap.paused = true;
          snap.head = 'paused';
          snap.status = 'Paused by the instructor';
          snap.issues = [];
          // A possible emergency still shows while paused.
          if (snap.condition.state !== 'danger') snap.condition = Object.assign({}, snap.condition, { state: 'paused', label: 'Paused' });
        }
        snapshots[id] = snap;
        blocks.get(id).update(snap);
        if (snap.condition.state === 'danger' && !snap.condition.acknowledged) emergencies.push(t);
        else if (snap.issues.length || snap.condition.state === 'danger') flagged.push(t);
      }
      // Patient pages open in this browser show their own block from this.
      CC.live.write({ state: 'live', paused, id: sessionId, startedAt, updatedAt: Date.now(), participants: snapshots });

      const key = (paused ? 'p:' : '') + emergencies.map((t) => t.id).join(',') + '|' + flagged.map((t) => t.id).join(',');
      if (key === flaggedKey) return;
      flaggedKey = key;
      // Possible emergencies come first, in red, so they can't be missed.
      const urgent = emergencies.length
        ? [h('span', { class: 'emergency-list' },
          h('b', null, `Possible emergency (${emergencies.length})`),
          ...emergencies.map((t) => h('a', { href: '#block-' + t.id }, attentionLabel(t))))]
        : [];
      fill(attention, ...urgent, ...(paused
        ? [h('b', null, 'Paused. '), h('span', { class: 'muted' }, 'Reps aren’t counted until you resume.')]
        : flagged.length
          ? [h('b', null, `Needs attention (${flagged.length})`),
            ...flagged.map((t) => h('a', { href: '#block-' + t.id }, attentionLabel(t)))]
          : emergencies.length ? [] : [h('span', { class: 'muted' }, 'Nobody needs attention right now.')]));
    }

    pauseBtn.addEventListener('click', () => {
      if (pausedAt == null) {
        pausedAt = Date.now();
        if (feed.pause) feed.pause();
      } else {
        pausedMs += Date.now() - pausedAt;
        pausedAt = null;
        if (feed.resume) feed.resume();
      }
      const paused = pausedAt != null;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      pauseBtn.setAttribute('aria-pressed', String(paused));
      titleText.textContent = paused ? 'Paused' : 'Live';
      liveEl.classList.toggle('is-paused', paused);
      draw();
    });

    draw();
    const timer = setInterval(draw, 500);
    feed.start();

    const guard = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    // Leaving the page mid-session stops it for patients too.
    window.addEventListener('pagehide', () => {
      if (running) CC.live.write({ state: 'abandoned', id: sessionId, updatedAt: Date.now() }, { final: true });
    });

    const endBtn = document.getElementById('end');
    CC.ui.confirmButton(endBtn, 'Press again to end', async () => {
      running = false;
      clearInterval(timer);
      feed.stop();
      const endedAt = Date.now();
      const participants = [...trackers.values()].map((t) => t.result());
      const session = {
        id: sessionId,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        // Ended before everyone finished. Each unfinished result records where it stopped.
        endedEarly: participants.some((p) => p.stoppedAt),
        elapsedMs: sessionNow() - startedAt,
        participants,
      };
      endBtn.disabled = true;
      endBtn.textContent = 'Saving…';
      // The results page reads the saved session, so wait for the save. If it fails (for
      // example the server is down), offer to try again rather than lose the session.
      for (;;) {
        try {
          await CC.sessions.add(session);
          break;
        } catch (e) {
          if (!confirm(`The results weren’t saved: ${e.message}\n\nTry again?`)) {
            endBtn.textContent = 'Not saved';
            return;
          }
        }
      }
      // Tells patient pages the results are saved, so they can open them.
      await CC.live.write({ state: 'ended', id: sessionId, updatedAt: endedAt });
      window.removeEventListener('beforeunload', guard);
      // The blocks fold away, then the page fades to the results.
      liveEl.classList.add('ending');
      if (!CC.motion.reduced()) await CC.motion.wait(320);
      CC.go('session-results.html?s=' + encodeURIComponent(sessionId));
    });
  }
});

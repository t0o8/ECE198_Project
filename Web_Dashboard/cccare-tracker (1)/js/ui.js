/* Shared interface pieces: page frame, the success wheel and the participant block. */
(function () {
  'use strict';
  const CC = (window.CC = window.CC || {});
  const { h, svg, fill, clamp, pad2, fmtDate, fmtExertion, plural, fmtClock } = CC.util;

  // A percentage as a colour: 0% red, 50% yellow, 100% green, blending smoothly in between.
  // Bars are coloured by the percentage they show. Wheels are filled by success but
  // coloured by how well each exercise is going on average (see ring.set).
  function percentColor(p) {
    if (p == null) return 'transparent';
    return `hsl(${Math.round(clamp(p, 0, 100) * 1.2)}, 72%, 41%)`;
  }

  // Hollow wheel. Fills clockwise from 12 o'clock.
  function ring(size, stroke) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const mid = size / 2;
    const arc = svg('circle', {
      class: 'ring-arc', cx: mid, cy: mid, r, fill: 'none', 'stroke-width': stroke,
      'stroke-dasharray': c.toFixed(2), 'stroke-dashoffset': c.toFixed(2), transform: `rotate(-90 ${mid} ${mid})`,
    });
    const el = svg('svg', { class: 'ring', viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true' },
      svg('circle', { class: 'ring-track', cx: mid, cy: mid, r, fill: 'none', 'stroke-width': stroke }),
      arc);
    return {
      el,
      // value sets how far the wheel is filled. colorValue, when given, sets its colour;
      // otherwise the colour follows value.
      set(value, colorValue) {
        const v = clamp(value || 0, 0, 100);
        arc.style.strokeDashoffset = (c * (1 - v / 100)).toFixed(2) + 'px';
        arc.style.stroke = percentColor(colorValue === undefined ? v : colorValue == null ? 0 : colorValue);
      },
    };
  }

  // Small static wheel for tables.
  function miniRing(value, colorValue) {
    const r = ring(30, 4);
    r.el.classList.add('ring-static');
    r.set(value, colorValue);
    return r.el;
  }

  // ---------- coloured stat boxes, red (poor) to green (good) ----------

  // Each stat as 0–100, where 100 is best.
  const statScore = {
    // Reps done against reps planned. Going over counts against it as much as stopping short.
    reps(done, planned) {
      if (!planned) return null;
      return clamp(Math.round(100 - (Math.abs(done - planned) / planned) * 100), 0, 100);
    },
    sets(done, planned) {
      return planned ? clamp(Math.round((done / planned) * 100), 0, 100) : null;
    },
    quality(q) {
      return q == null ? null : clamp(q, 0, 100);
    },
    // Exertion is judged by the hardest moment: green up to 5 of 10, red at 9 and above.
    exertion(peak) {
      return peak == null ? null : clamp(Math.round(((9 - peak) / 4) * 100), 0, 100);
    },
  };

  // A small square in a score's colour. Grey when there's no score.
  function statBox(score, label) {
    return h('i', {
      class: 'stat-box' + (score == null ? ' stat-box-none' : ''),
      style: score == null ? null : `background:${percentColor(score)}`,
      title: label ? `${label}: ${score == null ? 'no data' : score + ' out of 100'}` : null,
      'aria-hidden': 'true',
    });
  }

  // Thin bar filled to a percentage, in that percentage's colour.
  function bar(value) {
    const inner = h('i');
    const el = h('span', { class: 'bar', 'aria-hidden': 'true' }, inner);
    const set = (v) => {
      inner.style.width = clamp(v || 0, 0, 100) + '%';
      inner.style.background = percentColor(v || 0);
    };
    set(value);
    return { el, set };
  }

  // Squares at 0, 25, 50, 75 and 100% for the legend.
  function swatches() {
    return h('span', { class: 'swatches', 'aria-hidden': 'true' },
      [0, 25, 50, 75, 100].map((p) => h('i', { style: `background:${percentColor(p)}` })));
  }

  // A participant block: number, name, two wheels, live numbers, one row per exercise and,
  // along the bottom, what is going wrong. audience 'patient' adds a cue to each issue.
  // The big wheel is the current exercise: it fills to that exercise's success and shows the
  // set it's on and the reps done in that set. The small wheel beside it is the whole session.
  // update() takes a snapshot from Tracker.snapshot().
  function block(slot, opts) {
    opts = opts || {};
    const large = opts.size === 'large';
    const patient = opts.audience === 'patient';
    const exWheel = ring(large ? 240 : 104, large ? 17 : 9);
    const sessionWheel = ring(large ? 110 : 52, large ? 9 : 5);
    const exPct = h('span', { class: 'wheel-pct' }, '0%');
    const setText = h('span', { class: 'wheel-set' }, '');
    const repText = h('span', { class: 'wheel-reps' }, '');
    const exName = h('p', { class: 'wheel-ex-name' }, '');
    const sessionPct = h('span', { class: 'wheel-pct' }, '0%');
    const sessionSets = h('span', { class: 'wheel-side-sets' }, '');
    const quality = h('dd', null, '—');
    const exertion = h('dd', null, '—');
    const state = h('span', { class: 'block-state' }, 'starting');
    const nameEl = h('h2', { class: 'block-name' }, opts.name || CC.displayName(slot));
    const exList = h('ol', { class: 'block-ex' });
    const issues = h('div', { class: 'issues' }, h('p', null, 'Waiting for the first rep'));
    if (patient) issues.setAttribute('aria-live', 'polite');
    // Exercising, resting, not moving…: from Tracker.condition().
    const condEl = h('p', { class: 'block-cond cond-waiting' }, 'Waiting to start');
    // A possible emergency: a banner across the top of the block.
    const alertText = h('div', { class: 'block-alert-text' });
    const ackBtn = !patient && opts.onAck ? h('button', { type: 'button', class: 'block-ack' }, 'Checked, OK') : null;
    const alertEl = h('div', { class: 'block-alert', role: 'alert', hidden: true }, alertText, ackBtn);
    let alertKey = '';
    let alertShown = '';
    if (ackBtn) ackBtn.addEventListener('click', () => opts.onAck(slot.id, alertKey));

    function renderCondition(c) {
      condEl.className = 'block-cond cond-' + c.state;
      condEl.textContent = c.label;
      const danger = c.state === 'danger' ? c.danger : [];
      el.classList.toggle('danger', danger.length > 0 && !c.acknowledged);
      el.classList.toggle('danger-ack', danger.length > 0 && !!c.acknowledged);
      alertKey = c.key || '';
      const shown = danger.length ? alertKey + '|' + danger.map((d) => d.message).join('|') + '|' + !!c.acknowledged : '';
      if (shown === alertShown) return;
      alertShown = shown;
      alertEl.hidden = !danger.length;
      if (!danger.length) return;
      // The instructor sees what the signs are; the patient sees what to do.
      fill(alertText, patient
        ? [h('strong', null, 'Are you OK? Your instructor has been alerted.'), h('span', null, danger[0].cue)]
        : danger.map((d) => h('strong', { class: 'warn' }, d.message)));
      if (ackBtn) {
        ackBtn.disabled = !!c.acknowledged;
        ackBtn.textContent = c.acknowledged ? 'Checked' : 'Checked, OK';
      }
    }

    const el = h('article', { class: 'block' + (large ? ' block-large' : ''), id: 'block-' + slot.id, 'aria-label': CC.displayName(slot) },
      alertEl,
      h('div', { class: 'block-head' }, h('span', { class: 'block-n' }, pad2(CC.slotNumber(slot.id))), state),
      nameEl,
      condEl,
      h('div', { class: 'wheels' },
        h('div', { class: 'wheel wheel-ex', title: 'This exercise' },
          exWheel.el, h('div', { class: 'wheel-text' }, exPct, setText, repText)),
        h('div', { class: 'wheel-side' },
          h('div', { class: 'wheel wheel-session', title: 'Whole session' },
            sessionWheel.el, h('div', { class: 'wheel-text' }, sessionPct)),
          h('span', { class: 'wheel-side-label' }, 'session'),
          sessionSets)),
      exName,
      h('dl', { class: 'block-stats' },
        h('div', null, h('dt', null, 'quality'), quality),
        h('div', null, h('dt', null, 'exertion'), exertion)),
      exList,
      issues);

    const unit = (code) => (CC.timed(code) ? 's' : ' reps');

    // The current exercise: its name, the set it's on and the reps done in that set.
    function renderCurrent(now) {
      exWheel.set(now.success, now.color);
      exPct.textContent = now.success + '%';
      exName.textContent = CC.exerciseName(now.exercise);
      setText.textContent = `set ${now.set} of ${now.sets}`;
      repText.textContent = `${now.inSet}/${now.reps}${unit(now.exercise)}` + (now.extra ? ` +${now.extra}` : '');
    }

    let exKey = '';
    let rows = [];
    function renderExercises(list) {
      const key = list.map((e) => `${e.exercise}:${e.sets}x${e.reps}`).join('|');
      if (key !== exKey) {
        exKey = key;
        rows = list.map((e) => {
          const count = h('span', { class: 'ex-count' });
          const b = bar(0);
          const li = h('li', null,
            h('span', { class: 'ex-line' },
              h('span', { class: 'ex-name' }, CC.exerciseName(e.exercise),
                large ? h('span', { class: 'ex-plan' }, ` ${CC.planText(e)}`) : null),
              count),
            b.el);
          li.title = CC.describeWorkout([e], true);
          return { li, count, bar: b };
        });
        exList.replaceChildren(...rows.map((r) => r.li));
      }
      list.forEach((e, i) => {
        rows[i].count.textContent = `${e.setsDone || 0}/${e.sets} sets`;
        rows[i].bar.set(e.success);
        rows[i].li.classList.toggle('current', !!e.current);
      });
    }

    let lastKey = '';
    function renderIssues(list, status) {
      const key = list.length ? list.map((i) => i.message).join('|') : 'ok:' + status;
      if (key === lastKey) return;
      lastKey = key;
      issues.classList.toggle('alert', list.length > 0);
      if (!list.length) {
        issues.classList.remove('two');
        fill(issues, h('p', null, status));
        return;
      }
      const max = patient ? 3 : 2;
      const shown = list.slice(0, max);
      issues.classList.toggle('two', shown.length > 1);
      fill(issues, ...shown.map((it, i) =>
        h('p', null, it.message,
          !patient && i === shown.length - 1 && list.length > max ? h('span', { class: 'more' }, ` +${list.length - max}`) : null,
          patient && it.cue ? h('span', { class: 'cue' }, it.cue) : null)));
    }

    // Before the session starts: the plan with nothing done yet.
    const first = slot.workout[0];
    renderExercises(slot.workout.map((w, i) => ({
      exercise: w.exercise, sets: w.sets, reps: w.reps, setsDone: 0, success: 0, current: i === 0,
    })));
    renderCurrent({ exercise: first.exercise, sets: first.sets, reps: first.reps, set: 1, inSet: 0, extra: 0, success: 0, color: null });
    sessionWheel.set(0, null);
    sessionSets.textContent = `0/${slot.workout.reduce((n, w) => n + w.sets, 0)} sets`;

    return {
      el,
      update(snap) {
        sessionWheel.set(snap.success, snap.color === undefined ? null : snap.color);
        sessionPct.textContent = snap.success + '%';
        sessionSets.textContent = `${snap.setsDone || 0}/${snap.setsPlanned} sets`;
        if (snap.now) renderCurrent(snap.now);
        quality.textContent = snap.quality == null ? '—' : snap.quality + '%';
        exertion.textContent = snap.exertion == null ? '—' : fmtExertion(snap.exertion) + '/10';
        state.textContent = snap.head;
        nameEl.textContent = opts.name || CC.displayName(snap);
        renderExercises(snap.exercises);
        // During a possible emergency, "no reps" and "not moving" add nothing (the alert says
        // more), and telling the person to carry on would contradict it.
        const danger = snap.condition && snap.condition.state === 'danger';
        const shownIssues = danger ? snap.issues.filter((i) => !/^(No reps|Not moving)/.test(i.message)) : snap.issues;
        renderIssues(shownIssues, danger ? (patient ? 'Your instructor is on the way.' : 'Check on them now.') : snap.status);
        el.classList.toggle('needs-attention', snap.issues.length > 0);
        el.classList.toggle('paused', !!snap.paused);
        if (snap.condition) renderCondition(snap.condition);
      },
      message(text) {
        lastKey = 'msg:' + text;
        issues.classList.remove('alert', 'two');
        fill(issues, h('p', null, text));
      },
    };
  }

  // Faults across all exercises of a saved result, most frequent first. A fault seen on
  // fewer than LIMITS.errorReps reps isn't counted as an error.
  function faultList(result) {
    const list = [];
    for (const e of result.exercises) {
      for (const [code, count] of Object.entries(e.faults || {})) {
        if (count < CC.LIMITS.errorReps) continue;
        list.push(Object.assign({ count, exercise: e.exercise, of: CC.score.repsDone(e) }, CC.fault(e.exercise, code)));
      }
    }
    return list.sort((a, b) => b.count - a.count);
  }

  // Everything that went wrong in a saved result: { message, detail, cue }.
  function whatWentWrong(result) {
    const items = [];
    // Possible emergencies during the session come first.
    for (const inc of result.incidents || []) {
      items.push({
        message: inc.message,
        detail: `${fmtClock(inc.atMs)} into the session`,
        cue: 'Tell your instructor or doctor how you felt at that point.',
      });
    }
    for (const e of result.exercises) {
      const name = CC.exerciseName(e.exercise);
      if (!CC.score.repsDone(e)) {
        items.push({ message: `${name} not started`, detail: `0 of ${e.sets * e.reps} reps`, cue: 'Try to get to every exercise next time.' });
        continue;
      }
      e.done.forEach((d, k) => {
        if (d === 0) {
          items.push({ message: `${name} set ${k + 1} not done`, detail: `0 of ${e.reps} reps`, cue: 'Try to finish every set, resting between them if you need to.' });
        } else if (d < e.reps) {
          items.push({ message: `${name} set ${k + 1} stopped ${plural(e.reps - d, 'rep')} short`, detail: `${d} of ${e.reps} reps`, cue: 'Rest for a moment if you need to, then finish the set.' });
        } else if (d - e.reps >= CC.LIMITS.errorReps) {
          items.push({ message: `${name} set ${k + 1} went ${plural(d - e.reps, 'rep')} over`, detail: `${d} of ${e.reps} reps`, cue: 'Stop when you reach the reps for the set.' });
        }
      });
      if (e.extra >= CC.LIMITS.errorReps) {
        items.push({ message: `${name}: ${plural(e.extra, 'rep')} past the last set`, detail: `${e.sets} ${e.sets === 1 ? 'set' : 'sets'} planned`, cue: 'Stopping when the sets are done protects you from overdoing it.' });
      }
    }
    if (result.exertionPeak != null && result.exertionPeak >= CC.LIMITS.exertionHigh) {
      items.push({ message: `Exertion reached ${fmtExertion(result.exertionPeak)} of 10`, detail: '', cue: 'If it feels very hard, slow down or rest.' });
    }
    for (const f of faultList(result)) {
      items.push({
        message: f.message,
        detail: `${CC.exerciseName(f.exercise).toLowerCase()}, ${f.count} of ${f.of} reps`,
        cue: f.cue,
      });
    }
    return items;
  }

  // Where someone was when a session ended early: "squat, set 2 of 3 (6 of 12 reps),
  // exercise 2 of 4".
  function stoppedText(stop) {
    const unit = CC.timed(stop.exercise) ? 'seconds' : 'reps';
    return `${stop.resting ? 'rest after ' : ''}${CC.exerciseName(stop.exercise).toLowerCase()}, set ${stop.set} of ${stop.sets} ` +
      `(${stop.inSet} of ${stop.reps} ${unit}), exercise ${stop.exerciseNumber} of ${stop.exercises}`;
  }

  // Two-step button for things that can't be undone: the first press arms it, a second
  // press within four seconds confirms.
  function confirmButton(btn, armedText, onConfirm) {
    let label = btn.textContent;
    let timer = null;
    let armedAt = 0;
    btn.addEventListener('click', () => {
      if (timer) {
        if (Date.now() - armedAt < 300) return; // ignore an accidental double-click
        clearTimeout(timer);
        timer = null;
        btn.textContent = label;
        btn.classList.remove('btn-armed');
        onConfirm();
        return;
      }
      label = btn.textContent;
      armedAt = Date.now();
      btn.textContent = armedText;
      btn.classList.add('btn-armed');
      timer = setTimeout(() => {
        timer = null;
        btn.textContent = label;
        btn.classList.remove('btn-armed');
      }, 4000);
    });
  }

  // Fills in the parts of the page header and footer that depend on who is signed in.
  // Round profile picture, or the first letter of the username when there isn't one.
  // A little secret: the nickname "Tree Gaming" gives the picture a rainbow outline.
  const rainbowNick = (nickname) => String(nickname || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'tree gaming';

  // opts.nickname: the person's nickname, for the rainbow outline.
  function avatar(username, photo, size, opts) {
    const rainbow = rainbowNick(opts && opts.nickname);
    const el = h('span', { class: 'avatar' + (rainbow ? ' avatar-rainbow' : ''), style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px`, 'aria-hidden': 'true' });
    if (photo) el.append(h('img', { src: photo, alt: '' }));
    else el.textContent = String(username || '?').charAt(0).toUpperCase();
    return el;
  }

  function frame(account) {
    // The footers say data stays in this browser; with a backend, say where it goes instead.
    if (CC.backend.enabled) {
      document.querySelectorAll('.foot > p:first-child').forEach((el) =>
        (el.textContent = `Data is saved on the server at ${CC.backend.url}.`));
    }
    document.querySelectorAll('[data-who]').forEach((el) => {
      // The nickname, if they've set one; the username is in the tooltip.
      el.textContent = `${account.role} · ${CC.profiles.nameFor(account)}`;
      el.title = 'Signed in as ' + account.username;
      // Profile link with the picture, just before the name.
      if (!el.parentNode.querySelector('.profile-link')) {
        const profile = CC.profiles.get(account.username);
        el.before(h('a', { class: 'profile-link', href: 'profile.html' },
          avatar(CC.profiles.nameFor(account), profile.photo, 24, { nickname: profile.nickname }), 'Profile'));
      }
    });
    document.querySelectorAll('[data-today]').forEach((el) => (el.textContent = fmtDate(new Date())));
    document.querySelectorAll('[data-signout]').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.preventDefault();
        CC.auth.signOut();
      }));
    document.querySelectorAll('[data-reset]').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const where = CC.backend.enabled ? 'on the server' : 'in this browser';
        if (confirm(`Delete every session, name and workout saved ${where} and start again with sample data?`)) {
          CC.store.reset().then(
            () => CC.go(CC.auth.home(account)),
            (err) => alert(`Couldn’t reset: ${err.message}`));
        }
      }));
  }

  CC.ui = {
    percentColor, ring, miniRing, bar, swatches, statScore, statBox, avatar, rainbowNick, stoppedText,
    block, faultList, whatWentWrong, confirmButton, frame,
  };
})();

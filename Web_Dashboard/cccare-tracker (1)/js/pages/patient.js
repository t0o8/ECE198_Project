/* Patient: one block for the signed-in participant. It follows the instructor's session:
   it goes live when the instructor starts, and opens the results when the instructor ends.
   The patient can't start or end a session. */
CC.start(function () {
  'use strict';
  const account = CC.auth.require('patient');
  if (!account) return;

  const { h, fill, fmtDate } = CC.util;
  CC.ui.frame(account);

  // If the instructor's page stops updating for this long, say so.
  const STALE_MS = 90 * 1000;

  const pid = account.participantId;
  const slot = CC.roster.get(pid);
  const nameEl = document.getElementById('name');
  const planEl = document.getElementById('plan');
  const stateEl = document.getElementById('state');
  const lastEl = document.getElementById('last');

  // Their own nickname, if they've set one, over the name the instructor gave them.
  const nickname = CC.profiles.get(account.username).nickname;
  nameEl.textContent = nickname || CC.displayName(slot);
  planEl.textContent = `Today’s workout: ${CC.describeWorkout(slot.workout, true).toLowerCase()}.`;

  const block = CC.ui.block(slot, { audience: 'patient', size: 'large', name: nickname || null });
  block.message('Waiting for your instructor to start the session.');
  // The "went live" animation is removed when it finishes, so it can't hold back the
  // emergency outline's pulse later.
  block.el.addEventListener('animationend', (e) => {
    if (e.animationName === 'went-live') block.el.classList.remove('went-live');
  });
  const cheerEl = h('p', { class: 'cheer', hidden: true });
  document.getElementById('slot').append(cheerEl, block.el);

  // ---------- encouragement ----------
  // A short message above the block that changes every so often while the session runs.
  // It suits the moment: starting, working, resting, nearly done, finished or paused.
  const CHEER_MS = 18 * 1000;
  const CHEERS = {
    start: ['Let’s get moving. You’ve got this!', 'Nice and steady to start.', 'Take a breath, then begin when you’re ready.'],
    work: ['You’re doing great. Keep it up!', 'Strong work. Every rep counts.', 'Nice rhythm. Keep going!', 'Look at you go!',
      'Steady and smooth. Well done.', 'You’re getting stronger with every session.', 'Great effort. Stay with it!'],
    good: ['Beautiful form. Keep it just like that!', 'Excellent reps. Really well done!', 'Your form is looking great today.'],
    rest: ['Nice set! Enjoy your rest.', 'Good work. Shake it out and breathe.', 'Well earned rest. Next set soon.'],
    almost: ['Almost there. Finish strong!', 'Just a little more. You can do it!', 'The end is in sight. Keep going!'],
    done: ['Workout complete. Fantastic job today!', 'You did it! Be proud of that.', 'All done. Great work today!'],
    paused: ['Your instructor paused the session. Take a breather.', 'Short break. Relax your shoulders and breathe.'],
  };
  let cheerKind = '';
  let cheerAt = 0;
  let cheerLast = '';

  function cheerKindFor(snap, paused) {
    if (paused) return 'paused';
    if (snap.head === 'done') return 'done';
    if (!snap.repsDone) return 'start';
    if (snap.resting) return 'rest';
    if (snap.repsPlanned && snap.repsDone / snap.repsPlanned >= 0.75) return 'almost';
    if (snap.color != null && snap.color >= 80) return 'good';
    return 'work';
  }

  function cheer(snap, paused) {
    const kind = cheerKindFor(snap, paused);
    const now = Date.now();
    if (kind === cheerKind && now - cheerAt < CHEER_MS) return;
    const options = CHEERS[kind].filter((t) => t !== cheerLast);
    const first = CC.util.firstName(nickname || snap.name || slot.name);
    const base = options[Math.floor(Math.random() * options.length)];
    // Now and then, use their first name.
    const text = first && kind !== 'paused' && Math.random() < 0.35
      ? `${first}, ${base.charAt(0).toLowerCase()}${base.slice(1)}` : base;
    cheerKind = kind;
    cheerAt = now;
    cheerLast = base;
    cheerEl.textContent = text;
    cheerEl.hidden = false;
  }
  function hideCheer() {
    cheerEl.hidden = true;
    cheerKind = '';
  }

  const last = CC.sessions.latestFor(pid);
  if (last) {
    const r = last.participants.find((p) => p.id === pid);
    fill(lastEl,
      `Last session, ${fmtDate(last.startedAt)}: ${r.success}%. `,
      h('a', { href: 'patient-results.html?s=' + encodeURIComponent(last.id) }, 'See results and progress'));
  }

  let watching = null; // id of the session this page has shown live
  let shown = '';

  function setState(text, key) {
    if (shown === key) return;
    shown = key;
    stateEl.textContent = text;
  }

  function check(live) {
    const now = Date.now();

    if (live && live.state === 'live' && now - live.updatedAt < STALE_MS) {
      const snap = live.participants && live.participants[pid];
      if (!snap) {
        setState('A session is running, but you’re not in it. Ask your instructor to add you.', 'not-in');
        return;
      }
      if (watching !== live.id) {
        watching = live.id;
        // The block comes alive as the session starts.
        block.el.classList.remove('went-live');
        void block.el.offsetWidth;
        block.el.classList.add('went-live');
        planEl.textContent = `Today’s workout: ${CC.describeWorkout(snap.exercises, true).toLowerCase()}.`;
      }
      if (snap.name && !nickname) nameEl.textContent = snap.name; // the instructor may have named them
      if (live.paused) setState('Your instructor has paused the session.', 'paused');
      else setState('Your session is running.', 'live');
      block.update(snap);
      // During a possible emergency the block's alert says what to do; no cheering.
      if (snap.condition && snap.condition.state === 'danger') hideCheer();
      else cheer(snap, !!live.paused);
      return;
    }
    hideCheer();

    if (live && live.state === 'ended' && watching && live.id === watching) {
      setState('Session over. Opening your results…', 'ended');
      CC.go('patient-results.html?s=' + encodeURIComponent(live.id));
      return;
    }

    if (watching) {
      watching = null;
      const text = live && live.state === 'abandoned'
        ? 'Your instructor’s session stopped before it finished.'
        : 'Lost contact with your instructor’s screen.';
      block.message(text);
      setState(text + ' Waiting for the next session.', 'lost');
      return;
    }

    if (!shown) setState('Waiting for your instructor to start the session.', 'waiting');
  }

  // The instructor's page sends its blocks twice a second. watch() passes them on about
  // once a second (from this browser's storage, or from the backend), which also notices
  // when updates stop.
  CC.live.watch(check);
});

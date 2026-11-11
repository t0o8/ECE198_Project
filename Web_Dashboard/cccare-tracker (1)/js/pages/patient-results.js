/* One patient's results for one session: overall success, each exercise, what went wrong,
   and a Progress button with a line graph across sessions (overall or one exercise).
   Used by instructors and patients; a patient can only ever see their own results. */
CC.start(function () {
  'use strict';
  const account = CC.auth.require();
  if (!account) return;

  const { h, fill, pad2, fmtDate, fmtDay, fmtTime, fmtExertion, plural } = CC.util;
  const score = CC.score;
  CC.ui.frame(account);

  const isPatient = account.role === 'patient';
  const pid = isPatient ? account.participantId : CC.util.param('p');
  const main = document.getElementById('main');
  document.getElementById('home').href = CC.auth.home(account);

  const wanted = CC.util.param('s');
  let session = wanted ? CC.sessions.get(wanted) : null;
  if (!session || !session.participants.some((p) => p.id === pid)) session = pid ? CC.sessions.latestFor(pid) : null;
  const result = session && session.participants.find((p) => p.id === pid);

  if (!result) {
    main.replaceChildren(h('section', { class: 'empty' },
      h('h1', null, 'No results yet'),
      h('p', null, 'Results appear here after a session ends. ',
        h('a', { href: CC.auth.home(account) }, isPatient ? 'Back to today' : 'Back to sessions'))));
    return;
  }

  // A patient sees their own nickname, if they've set one.
  const name = (isPatient && CC.profiles.get(account.username).nickname) || CC.displayName(result);
  const self = (sid) => `patient-results.html?s=${encodeURIComponent(sid)}` + (isPatient ? '' : `&p=${encodeURIComponent(pid)}`);
  document.title = `${name}, ${fmtDate(session.startedAt)} · CCCARE exercise tracking`;

  // ---------- navigation ----------

  const crumbs = h('nav', { class: 'crumbs mono', 'aria-label': 'Results navigation' });
  if (isPatient) {
    crumbs.append(h('a', { href: 'patient.html' }, 'Back to today'));
  } else {
    const people = session.participants.slice().sort((a, b) => CC.slotNumber(a.id) - CC.slotNumber(b.id));
    const i = people.findIndex((p) => p.id === pid);
    const to = (p) => `patient-results.html?s=${encodeURIComponent(session.id)}&p=${encodeURIComponent(p.id)}`;
    fill(crumbs,
      h('a', { href: 'session-results.html?s=' + encodeURIComponent(session.id) }, 'All results'),
      h('span', { class: 'muted' }, `${i + 1} of ${people.length}`),
      i > 0 ? h('a', { href: to(people[i - 1]) }, 'Previous') : null,
      i < people.length - 1 ? h('a', { href: to(people[i + 1]) }, 'Next') : null);
  }

  // ---------- summary ----------

  const { statScore, statBox } = CC.ui;
  const wheel = CC.ui.ring(240, 16);
  requestAnimationFrame(() => requestAnimationFrame(() => wheel.set(result.success, score.colorScore(result.exercises))));

  // One big number per tile, a one- or two-word label, and a box coloured red to green.
  const tile = (value, label, boxScore, sub) => h('div', { class: 'tile' },
    h('dt', null, statBox(boxScore, label), label),
    h('dd', null, value, sub ? h('small', null, sub) : null));

  const summary = h('section', { class: 'result' },
    h('div', { class: 'wheel' }, wheel.el,
      h('div', { class: 'wheel-text' },
        h('span', { class: 'wheel-pct' }, result.success + '%'),
        h('span', { class: 'wheel-reps' }, 'success'))),
    h('dl', { class: 'tiles' },
      tile(`${result.repsDone}/${result.repsPlanned}`, 'reps', statScore.reps(result.repsDone, result.repsPlanned)),
      tile(`${result.setsDone}/${result.setsPlanned}`, 'sets', statScore.sets(result.setsDone, result.setsPlanned)),
      tile(result.quality == null ? '—' : result.quality + '%', 'form', statScore.quality(result.quality)),
      tile(result.exertionAvg == null ? '—' : fmtExertion(result.exertionAvg), 'effort', statScore.exertion(result.exertionPeak),
        result.exertionAvg == null ? null : `/10 · peak ${fmtExertion(result.exertionPeak)}`)));

  // ---------- each exercise ----------

  const exercises = h('section', { class: 'exercises' },
    h('h2', null, 'Exercises'),
    h('ul', { class: 'ex-cards' }, result.exercises.map((e) => {
      const ex = CC.EXERCISES[e.exercise];
      return h('li', { class: 'ex-result' },
        ex && ex.gif ? h('img', { class: 'ex-result-gif', src: ex.gif, alt: '', width: 64, height: 64, loading: 'lazy' }) : null,
        h('div', { class: 'ex-result-head' },
          h('h3', null, CC.exerciseName(e.exercise)),
          h('span', { class: 'cell-success' }, CC.ui.miniRing(e.success), e.success + '%')),
        h('dl', { class: 'ex-result-stats' },
          h('div', null, h('dt', null, CC.timed(e.exercise) ? 'seconds' : 'reps'), h('dd', null, statBox(statScore.reps(score.repsDone(e), score.planned(e)), 'Reps'), `${score.repsDone(e)}/${score.planned(e)}`)),
          h('div', null, h('dt', null, 'form'), h('dd', null, statBox(statScore.quality(e.quality), 'Form'), e.quality == null ? '—' : e.quality + '%')),
          h('div', null, h('dt', null, 'each set'), h('dd', null, e.done.join(' · ') + (e.extra ? ` +${e.extra}` : '')))));
    })));

  // ---------- what went wrong ----------

  // The few most important items show; the rest fold away behind "Show N more".
  const TOP = 4;
  const items = CC.ui.whatWentWrong(result).map((it) =>
    h('li', null,
      h('span', null, it.message),
      it.detail ? h('span', { class: 'count' }, it.detail) : h('span'),
      isPatient && it.cue ? h('p', { class: 'cue' }, it.cue) : null));
  const more = items.slice(TOP);
  const wrong = h('section', { class: 'wrong' },
    h('h2', null, 'To work on'),
    items.length ? h('ul', null, items.slice(0, TOP)) : h('p', { class: 'muted' }, 'Nothing was flagged this session.'),
    more.length ? h('details', { class: 'wrong-more' },
      h('summary', { class: 'mono' }, `Show ${more.length} more`),
      h('ul', null, more)) : null);

  // ---------- progress ----------

  const history = CC.sessions.historyFor(pid);
  const codes = [];
  history.forEach(({ result: r }) => r.exercises.forEach((e) => {
    if (!codes.includes(e.exercise)) codes.push(e.exercise);
  }));

  // Points for the graph: overall success (code null) or one exercise's success.
  function pointsFor(code) {
    return history.map(({ session: s, result: r }) => {
      const base = { at: new Date(s.startedAt), current: s.id === session.id, href: self(s.id) };
      if (!code) {
        return Object.assign(base, { value: r.success, note: `${plural(r.exercises.length, 'exercise')} · ${r.repsDone}/${r.repsPlanned} reps` });
      }
      const e = r.exercises.find((x) => x.exercise === code);
      if (!e) return null;
      return Object.assign(base, { value: e.success, note: `${CC.planText(e)} · ${score.repsDone(e)}/${score.planned(e)}${CC.timed(e.exercise) ? 's' : ' reps'}` });
    }).filter(Boolean);
  }

  const panel = h('div', { class: 'progress-panel', id: 'progress-panel', hidden: true });
  const sign = h('span', { class: 'sign', 'aria-hidden': 'true' }, '+');
  const button = h('button', {
    type: 'button', class: 'btn progress-btn', 'aria-expanded': 'false', 'aria-controls': 'progress-panel',
  }, 'Progress', sign);
  const filters = h('div', { class: 'filters', role: 'group', 'aria-label': 'Show progress for' });
  const statsBox = h('div');
  const chartBox = h('div');
  const note = h('p', { class: 'progress-note mono muted' });
  let selected = null;
  let drawn = false;

  function renderFilters() {
    fill(filters, [null, ...codes].map((code) => {
      const b = h('button', { type: 'button', class: 'filter', 'aria-pressed': String(code === selected) },
        code ? CC.exerciseName(code) : 'All exercises');
      b.addEventListener('click', () => {
        selected = code;
        renderFilters();
        drawProgress();
      });
      return b;
    }));
  }

  function drawProgress() {
    const points = pointsFor(selected);
    const label = selected ? CC.exerciseName(selected) : 'Overall';
    if (!points.length) {
      fill(statsBox);
      fill(chartBox, h('p', { class: 'muted' }, 'No sessions with this exercise yet.'));
      note.textContent = '';
      return;
    }
    const first = points[0];
    const best = points.reduce((a, b) => (b.value > a.value ? b : a), first);
    const here = points.find((p) => p.current);
    const end = here || points[points.length - 1];
    const change = end.value - first.value;
    fill(statsBox, h('dl', { class: 'progress-stats' },
      h('div', null, h('dt', null, 'sessions'), h('dd', null, String(points.length))),
      h('div', null, h('dt', null, `first, ${fmtDay(first.at)}`), h('dd', null, first.value + '%')),
      h('div', null, h('dt', null, `best, ${fmtDay(best.at)}`), h('dd', null, best.value + '%')),
      h('div', null, h('dt', null, 'this session'), h('dd', null, here ? here.value + '%' : 'not done')),
      h('div', null, h('dt', null, 'change since first'),
        h('dd', null, `${change > 0 ? '+' : ''}${change} ${Math.abs(change) === 1 ? 'point' : 'points'}`))));
    CC.progressChart(chartBox, points, { label: `${name}: ${label.toLowerCase()} success by session` });
    note.textContent = points.length > 1
      ? 'Hover or tap the graph to read a session. Click a square to open that session.'
      : 'Only one session so far. The line appears after the next one.';
  }

  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    sign.textContent = open ? '−' : '+';
    if (open && !drawn) {
      // Drawn while visible (the graph needs its width), then slid open from closed.
      drawn = true;
      panel.hidden = false;
      fill(panel, codes.length > 1 ? filters : null, statsBox, chartBox, note);
      renderFilters();
      drawProgress();
      panel.hidden = true;
    }
    CC.motion.slide(panel, open);
  });

  const progress = h('section', { class: 'progress' }, button, panel);

  // ---------- how it's worked out ----------

  const how = h('details', { class: 'how' },
    h('summary', null, 'How success is worked out'),
    h('p', null,
      'The wheel fills to the overall success. Its colour is the average of the exercises’ scores, from red to green. ',
      'Each exercise scores the share of its planned reps that were done as planned, multiplied by the average movement quality of its reps. ',
      'Stopping a set short and going past it both count against it. ',
      'The overall score combines the exercises, weighted by how many reps each one plans. ',
      'For example, 2 sets of 10 done as 10 and 10 at 85% quality scores 85%. Done as 10 and 5, or as 10 and 15, at 85% quality it scores 64%.'));

  const early = result.stoppedAt ? h('section', { class: 'ended-early', role: 'alert' },
    h('h2', null, 'This session was ended early'),
    h('p', null,
      `It ended during ${CC.ui.stoppedText(result.stoppedAt)}. `,
      'Only the exercises and sets reached are counted.')) : null;

  fill(main,
    early,
    crumbs,
    h('section', { class: 'result-head' },
      h('h1', null, name),
      h('p', { class: 'mono muted' },
        `${pad2(CC.slotNumber(pid))} · ${fmtDate(session.startedAt)}, ${fmtTime(session.startedAt)}`,
        session.sample ? ' · sample data' : '')),
    summary,
    exercises,
    wrong,
    progress,
    how);
});

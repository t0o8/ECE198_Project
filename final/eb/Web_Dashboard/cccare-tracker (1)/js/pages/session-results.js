/* Instructor: everyone's results for one session. Each row opens that patient's results. */
CC.start(function () {
  'use strict';
  const account = CC.auth.require('instructor');
  if (!account) return;

  const { h, pad2, fmtDate, fmtTime, fmtMinutes, fmtExertion, mean } = CC.util;
  CC.ui.frame(account);

  const main = document.getElementById('main');
  const id = CC.util.param('s');
  const session = (id && CC.sessions.get(id)) || CC.sessions.latest();

  if (!session) {
    main.replaceChildren(h('section', { class: 'empty' },
      h('h1', null, 'No results yet'),
      h('p', null, 'Results appear here when you end a session. ', h('a', { href: 'instructor.html' }, 'Start a session'))));
    return;
  }

  const people = session.participants.slice().sort((a, b) => CC.slotNumber(a.id) - CC.slotNumber(b.id));
  const avg = Math.round(mean(people.map((p) => p.success)) || 0);
  const below = people.filter((p) => p.success < 50).length;
  const length = new Date(session.endedAt) - new Date(session.startedAt);
  const link = (p) => `patient-results.html?s=${encodeURIComponent(session.id)}&p=${encodeURIComponent(p.id)}`;

  document.title = `Results, ${fmtDate(session.startedAt)} · CCCARE exercise tracking`;

  function mainIssue(p) {
    // A possible emergency during the session outranks everything else.
    const inc = (p.incidents || [])[0];
    if (inc) return h('span', { class: 'incident warn' }, inc.message, (p.incidents.length > 1 ? ` +${p.incidents.length - 1}` : ''));
    const top = CC.ui.faultList(p)[0];
    if (!top) return h('span', { class: 'muted' }, '—');
    return [top.message, ' ', h('span', { class: 'mono muted' }, `×${top.count}`)];
  }

  const { statScore, statBox } = CC.ui;
  // A number with a coloured box in front of it, red (poor) to green (good).
  const stat = (score, label, text) => h('td', null, h('span', { class: 'cell-stat mono' }, statBox(score, label), text));

  const rows = people.map((p, i) => {
    const tr = h('tr', { style: `--i:${i}` },
      h('td', { class: 'mono' }, pad2(CC.slotNumber(p.id))),
      h('td', null, h('a', { href: link(p) }, CC.displayName(p))),
      h('td', null, h('span', { class: 'cell-success' }, CC.ui.miniRing(p.success, CC.score.colorScore(p.exercises)), p.success + '%')),
      stat(statScore.reps(p.repsDone, p.repsPlanned), 'Reps', `${p.repsDone}/${p.repsPlanned}`),
      stat(statScore.sets(p.setsDone, p.setsPlanned), 'Sets finished', `${p.setsDone}/${p.setsPlanned}`),
      stat(statScore.quality(p.quality), 'Quality', p.quality == null ? '—' : p.quality + '%'),
      stat(statScore.exertion(p.exertionPeak), 'Exertion',
        p.exertionAvg == null ? '—' : `${fmtExertion(p.exertionAvg)} / ${fmtExertion(p.exertionPeak)}`),
      h('td', null, mainIssue(p)));
    tr.title = CC.describeWorkout(p.exercises);
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      CC.go(link(p));
    });
    return tr;
  });

  // Ended before everyone finished: say so first, and where each unfinished person stopped.
  const stopped = people.filter((p) => p.stoppedAt);
  let early = null;
  if (session.endedEarly && stopped.length) {
    // Just the heading and one-line summary; the arrow opens the list of where each person stopped.
    const list = h('ul', { class: 'ended-early-list', id: 'ended-early-list', hidden: true },
      stopped.map((p) => h('li', null,
        h('a', { href: link(p) }, `${pad2(CC.slotNumber(p.id))} ${CC.displayName(p)}`),
        h('span', null, ` stopped at ${CC.ui.stoppedText(p.stoppedAt)}`))));
    const toggle = h('button', {
      type: 'button', class: 'ended-early-toggle', 'aria-expanded': 'false', 'aria-controls': 'ended-early-list',
      'aria-label': 'Show where each person stopped', title: 'Show where each person stopped',
    }, h('span', { class: 'arrow', 'aria-hidden': 'true' }));
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      CC.motion.slide(list, open);
      toggle.setAttribute('aria-expanded', String(open));
      const label = open ? 'Hide where each person stopped' : 'Show where each person stopped';
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
    });
    early = h('section', { class: 'ended-early', role: 'status' },
      h('div', { class: 'ended-early-head' },
        h('div', null,
          h('h2', null, 'This session was ended early'),
          h('p', null,
            `It ended at ${fmtTime(session.endedAt)}`,
            session.elapsedMs ? `, ${fmtMinutes(session.elapsedMs)} in` : '',
            `. ${stopped.length} of ${people.length} hadn’t finished. `,
            'Their results only count the exercises and sets they reached.')),
        toggle),
      list);
  }

  CC.util.fill(main,
    early,
    h('div', { class: 'results-top' },
      h('div', null,
        h('h1', null, 'Results'),
        h('p', { class: 'mono muted' },
          `${fmtDate(session.startedAt)} · ${fmtTime(session.startedAt)}–${fmtTime(session.endedAt)} · ${fmtMinutes(length)}`,
          session.sample ? ' · sample data' : '')),
      h('dl', { class: 'kpis' },
        h('div', null, h('dt', null, 'average success'), h('dd', null, avg + '%')),
        h('div', null, h('dt', null, 'participants'), h('dd', null, String(people.length))),
        h('div', null, h('dt', null, 'below 50%'), h('dd', null, String(below))))),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'results-table' },
        h('thead', null, h('tr', null,
          ['No.', 'Name', 'Success', 'Reps', 'Sets finished', 'Quality', 'Exertion avg / peak', 'Most common issue']
            .map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows))),
    h('p', { class: 'legend mono stat-legend' }, 'boxes: poor ', CC.ui.swatches(), ' good. Exertion is judged by its peak: green up to 5, red at 9 or more.'),
    h('div', { class: 'results-actions' },
      h('a', { class: 'btn', href: 'instructor.html' }, 'New session')));
});

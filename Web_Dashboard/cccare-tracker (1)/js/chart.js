/* Line graph of success across sessions, spaced by date.
   Hover, tap or use the arrow keys to read a session; click or Enter opens it. */
(function () {
  'use strict';
  const CC = (window.CC = window.CC || {});
  const { h, svg, fill, clamp, fmtDate, fmtDay } = CC.util;

  // points: [{ at: Date, value: 0–100, current: bool, href: string, note: string }]
  CC.progressChart = function (box, points, opts) {
    opts = opts || {};
    let selected = points.findIndex((p) => p.current);
    if (selected < 0) selected = points.length - 1;

    const tip = h('div', { class: 'chart-tip', 'aria-hidden': 'true' });
    const status = h('p', { class: 'sr-only', 'aria-live': 'polite' });
    const wrap = h('div', {
      class: 'chart', tabindex: 0, role: 'group',
      'aria-label': `${opts.label || 'Success over time'}. Use the left and right arrow keys to move between sessions, Enter to open one.`,
    });
    box.replaceChildren(wrap, status, table());

    let geo = null;

    // The same numbers as a table, for screen readers.
    function table() {
      return h('table', { class: 'sr-only' },
        h('caption', null, opts.label || 'Success over time'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Session'), h('th', { scope: 'col' }, 'Success'))),
        h('tbody', null, points.map((p) => h('tr', null, h('td', null, fmtDate(p.at)), h('td', null, p.value + '%')))));
    }

    function render() {
      const W = Math.max(280, Math.floor(wrap.clientWidth || box.clientWidth || 640));
      const H = W < 520 ? 230 : 290;
      const m = { l: 44, r: 20, t: 22, b: 36 };
      const t0 = points[0].at.getTime();
      const t1 = points[points.length - 1].at.getTime();
      const span = Math.max(1, t1 - t0);
      const innerW = W - m.l - m.r;
      const x = (p) => (points.length === 1 ? m.l + innerW / 2 : m.l + ((p.at.getTime() - t0) / span) * innerW);
      const y = (v) => m.t + (1 - v / 100) * (H - m.t - m.b);

      const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });

      [0, 25, 50, 75, 100].forEach((v) => {
        root.append(svg('line', { class: v === 0 ? 'chart-base' : 'chart-grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
        root.append(svg('text', { class: 'chart-label', x: m.l - 10, y: y(v) + 4, 'text-anchor': 'end' }, v + '%'));
      });

      // Date labels, skipping any that would overlap. The latest date always shows.
      const labels = [];
      points.forEach((p, i) => {
        const px = x(p);
        const last = labels[labels.length - 1];
        if (last && px - last.px < 62) {
          if (i !== points.length - 1) return;
          labels.pop();
        }
        labels.push({ px, text: fmtDay(p.at) });
      });
      labels.forEach((l) => root.append(svg('text', { class: 'chart-label', x: l.px, y: H - 12, 'text-anchor': 'middle' }, l.text)));

      if (points.length > 1) {
        const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
        root.append(svg('path', { class: 'chart-line', d }));
      }
      points.forEach((p) => {
        const size = p.current ? 9 : 6;
        root.append(svg('rect', { class: 'chart-dot', x: x(p) - size / 2, y: y(p.value) - size / 2, width: size, height: size }));
      });

      const guide = svg('line', { class: 'chart-guide', y1: m.t - 6, y2: H - m.b });
      const sel = svg('rect', { class: 'chart-sel', width: 13, height: 13 });
      root.append(guide, sel);

      wrap.replaceChildren(root, tip);
      geo = { x, y, guide, sel, W };
      show(selected, false);
    }

    function show(i, announce) {
      selected = clamp(i, 0, points.length - 1);
      const p = points[selected];
      const px = geo.x(p);
      const py = geo.y(p.value);
      geo.guide.setAttribute('x1', px);
      geo.guide.setAttribute('x2', px);
      geo.sel.setAttribute('x', px - 6.5);
      geo.sel.setAttribute('y', py - 6.5);
      fill(tip,
        h('b', null, p.value + '%'),
        h('span', null, fmtDate(p.at) + (p.current ? ' · this session' : '')),
        p.note ? h('span', null, p.note) : null,
        p.href && !p.current ? h('span', { class: 'chart-open' }, 'click to open') : null);
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      tip.style.left = clamp(px - tw / 2, 0, geo.W - tw) + 'px';
      tip.style.top = (py - th - 16 < 0 ? py + 16 : py - th - 16) + 'px';
      if (announce) status.textContent = `${fmtDate(p.at)}: ${p.value}%`;
    }

    function nearest(clientX) {
      const rect = wrap.getBoundingClientRect();
      const px = clientX - rect.left;
      let best = 0;
      let bestDist = Infinity;
      points.forEach((p, i) => {
        const dist = Math.abs(geo.x(p) - px);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      return best;
    }

    function open(i) {
      const p = points[i];
      if (p.href && !p.current) location.href = p.href;
    }

    // The statistics box shows while the cursor is over the graph (or the graph has keyboard
    // focus), and fades away when it leaves. A tap on a touch screen shows it for a few seconds.
    let hovering = false;
    let touchTimer = null;
    const setTip = () => tip.classList.toggle('on', hovering || wrap.matches(':focus-visible'));
    wrap.addEventListener('pointerenter', () => {
      hovering = true;
      setTip();
    });
    wrap.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return; // a finger lifting isn't the cursor leaving
      hovering = false;
      setTip();
    });
    wrap.addEventListener('focus', setTip);
    wrap.addEventListener('blur', setTip);

    wrap.addEventListener('pointermove', (e) => show(nearest(e.clientX), false));
    wrap.addEventListener('pointerdown', (e) => {
      show(nearest(e.clientX), false);
      if (e.pointerType !== 'touch') return;
      hovering = true;
      setTip();
      clearTimeout(touchTimer);
      touchTimer = setTimeout(() => {
        hovering = false;
        setTip();
      }, 3000);
    });
    wrap.addEventListener('click', (e) => open(nearest(e.clientX)));
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        show(selected + (e.key === 'ArrowLeft' ? -1 : 1), true);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        show(e.key === 'Home' ? 0 : points.length - 1, true);
      } else if (e.key === 'Enter') {
        open(selected);
      }
      setTip();
    });

    // Redraws on resize until the graph is replaced (for example by another exercise's graph).
    let resizeTimer = null;
    function onResize() {
      if (!wrap.isConnected) {
        window.removeEventListener('resize', onResize);
        return;
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 120);
    }
    window.addEventListener('resize', onResize);

    render();
  };
})();

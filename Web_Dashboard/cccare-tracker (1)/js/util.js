/* Small helpers shared by every page. Loaded first. */
(function () {
  'use strict';
  const CC = (window.CC = window.CC || {});

  // Seeded random numbers, so the sample history is identical on every machine.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Roughly normal noise (mean 0, sd 1) from six uniform draws.
  function gauss(rnd) {
    let s = 0;
    for (let i = 0; i < 6; i++) s += rnd();
    return (s - 3) / Math.SQRT1_2;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round1 = (v) => Math.round(v * 10) / 10;
  const half = (v) => Math.round(v * 2) / 2;
  const pad2 = (n) => String(n).padStart(2, '0');
  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
  const pick = (list, rnd) => list[Math.floor(rnd() * list.length)];
  const deepCopy = (v) => JSON.parse(JSON.stringify(v));

  function shuffle(list, rnd) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function toInt(value, lo, hi, fallback) {
    if (value === '' || value == null) return fallback;
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
  }

  // First word of a name: "Margaret Chen" -> "Margaret". Empty when no name was given.
  const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fmtDate(d) {
    d = new Date(d);
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  function fmtDay(d) {
    d = new Date(d);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  function fmtTime(d) {
    d = new Date(d);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = pad2(s % 60);
    return hours ? `${hours}:${pad2(mins)}:${secs}` : `${mins}:${secs}`;
  }
  function fmtMinutes(ms) {
    const m = Math.round(ms / 60000);
    return m < 1 ? 'under a minute' : `${m} min`;
  }
  const fmtExertion = (v) => (v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // A length of time in words, largest unit first, at most two units:
  // "45 seconds", "1 minute 5 seconds", "2 hours 10 minutes", "3 days 1 hour".
  const UNITS = [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  function fmtDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const i = UNITS.findIndex(([, size]) => s >= size);
    if (i === -1) return plural(0, 'second');
    const [name, size] = UNITS[i];
    let text = plural(Math.floor(s / size), name);
    if (i < UNITS.length - 1) {
      const [subName, subSize] = UNITS[i + 1];
      const rest = Math.floor((s % size) / subSize);
      if (rest) text += ' ' + plural(rest, subName);
    }
    return text;
  }

  // Builds DOM elements. Strings always become text nodes, never HTML, because names
  // and feed messages come from people and devices.
  function setAttrs(el, attrs) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  function appendAll(el, children) {
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
  }
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    setAttrs(el, attrs);
    appendAll(el, children);
    return el;
  }
  function svg(tag, attrs, ...children) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    setAttrs(el, attrs);
    appendAll(el, children);
    return el;
  }
  // Replaces an element's children, skipping null and false (replaceChildren would print them).
  function fill(el, ...children) {
    el.replaceChildren();
    appendAll(el, children);
    return el;
  }

  const param = (name) => new URLSearchParams(location.search).get(name);

  CC.util = {
    mulberry32, gauss, clamp, round1, half, pad2, mean, pick, shuffle, toInt, deepCopy, firstName,
    fmtDate, fmtDay, fmtTime, fmtClock, fmtMinutes, fmtExertion, fmtDuration, plural,
    h, svg, fill, param,
  };
})();

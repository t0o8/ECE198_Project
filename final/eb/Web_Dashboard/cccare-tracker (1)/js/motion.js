/* Smooth movement: page changes, dropdowns, and opening or closing panels.
   Loaded in each page's <head>. Everything here does nothing for people who have asked
   their system for reduced motion: then pages, panels and themes change straight away. */
(function () {
  'use strict';
  const CC = (window.CC = window.CC || {});
  const root = document.documentElement;
  const media = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(media && media.matches);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
  const LEAVE_MS = 220;

  // ---------- pages ----------

  // Goes to another page after fading this one out. The next page fades in by itself (see
  // .page-enter in style.css). replace: true replaces this page in the history.
  async function go(url, opts) {
    if (!reduced()) {
      root.classList.add('page-leaving');
      await wait(LEAVE_MS);
    }
    if (opts && opts.replace) location.replace(url);
    else location.href = url;
  }

  // Links to other pages of the site fade out too. Links that open elsewhere, in a new
  // tab, or to a part of this page work as usual.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download') || a.hasAttribute('data-signout') || a.hasAttribute('data-reset')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return; // same page
    if (reduced()) return;
    e.preventDefault();
    go(url.href);
  });

  // Coming back with the browser's Back button can show the faded-out page from memory.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) root.classList.remove('page-leaving');
  });

  // ---------- panels that open and close ----------

  // Height of an element as if it were open, without showing it.
  function naturalHeight(el) {
    return el.scrollHeight;
  }

  // Opens (open = true) or closes an element that is shown and hidden with the hidden
  // attribute, sliding its height and fading it. Resolves when finished.
  async function slide(el, open) {
    if (open === !el.hidden && !el.dataset.sliding) return;
    if (reduced() || !el.animate) {
      el.hidden = !open;
      return;
    }
    if (el._anim) el._anim.cancel();
    el.dataset.sliding = '1';
    const prevOverflow = el.style.overflow;
    el.style.overflow = 'hidden';
    if (open) el.hidden = false;
    const full = naturalHeight(el);
    const frames = [
      { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginTop: '0px' },
      { height: full + 'px', opacity: 1, paddingTop: getComputedStyle(el).paddingTop, paddingBottom: getComputedStyle(el).paddingBottom, marginTop: getComputedStyle(el).marginTop },
    ];
    el._anim = el.animate(open ? frames : frames.slice().reverse(), { duration: open ? 280 : 220, easing: EASE });
    try {
      await el._anim.finished;
      if (!open) el.hidden = true;
    } catch (e) {
      /* cancelled by a newer slide */
    } finally {
      el._anim = null;
      delete el.dataset.sliding;
      el.style.overflow = prevOverflow;
    }
  }

  // <details> dropdowns: every one on every page, including ones added later, opens and
  // closes smoothly. A details element whose content floats over the page (class
  // "pop", like the workout dropdowns) fades and drops down instead of sliding open.
  function contentOf(d) {
    return [...d.children].filter((c) => c.tagName !== 'SUMMARY');
  }

  async function setDetails(d, open) {
    if (d.open === open && !d._closing) return;
    if (reduced() || !d.animate) {
      d.open = open;
      return;
    }
    const parts = contentOf(d);
    if (d.classList.contains('pop')) {
      if (open) {
        d.open = true;
        parts.forEach((p) => p.animate(
          [{ opacity: 0, transform: 'translateY(-6px) scaleY(0.96)' }, { opacity: 1, transform: 'none' }],
          { duration: 180, easing: EASE }));
      } else {
        d._closing = true;
        await Promise.all(parts.map((p) => p.animate(
          [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px) scaleY(0.96)' }],
          { duration: 140, easing: 'ease-in' }).finished.catch(() => {})));
        d._closing = false;
        d.open = false;
      }
      return;
    }
    // Inline details: animate the element's own height between "summary only" and "open".
    const summary = d.querySelector(':scope > summary');
    const closedH = summary ? summary.offsetHeight : 0;
    const startH = d.offsetHeight;
    if (d._anim) d._anim.cancel();
    d.style.overflow = 'hidden';
    if (open) d.open = true;
    const endH = open ? d.scrollHeight : closedH;
    if (!open) d._closing = true;
    d._anim = d.animate([{ height: startH + 'px' }, { height: endH + 'px' }], { duration: open ? 280 : 220, easing: EASE });
    if (open) parts.forEach((p) => p.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: 'ease-out' }));
    try {
      await d._anim.finished;
      if (!open) d.open = false;
    } catch (e) {
      /* cancelled */
    } finally {
      d._anim = null;
      d._closing = false;
      d.style.overflow = '';
    }
  }

  document.addEventListener('click', (e) => {
    const summary = e.target.closest('summary');
    if (!summary || e.defaultPrevented) return;
    const d = summary.parentElement;
    if (!d || d.tagName !== 'DETAILS' || reduced()) return;
    e.preventDefault();
    setDetails(d, !d.open || d._closing);
  });

  // ---------- night mode ----------

  // Runs change() (which switches the theme) with a circle of the new colours spreading
  // out from the point (x, y), or a quick fade where the browser can't do that.
  function themeChange(change, x, y) {
    if (reduced()) {
      change();
      return;
    }
    if (document.startViewTransition) {
      root.style.setProperty('--reveal-x', x + 'px');
      root.style.setProperty('--reveal-y', y + 'px');
      const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.style.setProperty('--reveal-r', Math.ceil(r) + 'px');
      root.classList.add('theme-reveal');
      const t = document.startViewTransition(change);
      t.finished.finally(() => root.classList.remove('theme-reveal'));
      return;
    }
    root.classList.add('theme-fading');
    change();
    setTimeout(() => root.classList.remove('theme-fading'), 450);
  }

  CC.motion = { go, slide, setDetails, themeChange, reduced, wait };
  CC.go = go;
})();

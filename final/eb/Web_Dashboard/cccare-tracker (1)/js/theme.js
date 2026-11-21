/* Night mode, and the GitHub link in the top right of every page.
   Loaded in each page's <head>, so the saved theme is applied before the page is drawn
   (no white flash). The buttons are added to the header once the page has loaded. */
(function () {
  'use strict';
  const KEY = 'cccare.theme';
  const REPO = 'https://github.com/Nugget5637/ECE198_Project';
  const root = document.documentElement;

  function saved() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }
  function apply(theme) {
    root.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  }
  apply(saved());

  const SVG = 'http://www.w3.org/2000/svg';
  function icon(viewBox, d) {
    const el = document.createElementNS(SVG, 'svg');
    el.setAttribute('viewBox', viewBox);
    el.setAttribute('width', '18');
    el.setAttribute('height', '18');
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    el.append(path);
    return el;
  }
  // GitHub mark (Octicons, MIT licence).
  const GITHUB = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z';
  const MOON = 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z';
  const SUN = 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5 1 3h-2l1-3zm0 20-1-3h2l-1 3zM2 12l3-1v2l-3-1zm20 0-3 1v-2l3 1zM4.9 4.9l2.8 1.4-1.4 1.4-1.4-2.8zm14.2 14.2-2.8-1.4 1.4-1.4 1.4 2.8zM4.9 19.1l1.4-2.8 1.4 1.4-2.8 1.4zM19.1 4.9l-1.4 2.8-1.4-1.4 2.8-1.4z';

  function addTools() {
    const header = document.querySelector('header.top');
    if (!header || header.querySelector('.top-tools')) return;
    let who = header.querySelector('.who');
    if (!who) {
      who = document.createElement('p');
      who.className = 'who';
      header.append(who);
    }

    const github = document.createElement('a');
    github.className = 'icon-btn';
    github.href = REPO;
    github.target = '_blank';
    github.rel = 'noopener noreferrer';
    github.title = 'Source code on GitHub';
    github.setAttribute('aria-label', 'Source code on GitHub (opens in a new tab)');
    github.append(icon('0 0 16 16', GITHUB));

    const night = document.createElement('button');
    night.type = 'button';
    night.className = 'icon-btn';
    const render = () => {
      const dark = root.dataset.theme === 'dark';
      night.setAttribute('aria-pressed', String(dark));
      night.setAttribute('aria-label', 'Night mode');
      night.title = dark ? 'Switch to day mode' : 'Switch to night mode';
      night.replaceChildren(icon('0 0 24 24', dark ? SUN : MOON));
    };
    night.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      const change = () => {
        apply(next);
        render();
      };
      // The new colours spread out from the button (see motion.js).
      const r = night.getBoundingClientRect();
      if (window.CC && CC.motion) CC.motion.themeChange(change, r.left + r.width / 2, r.top + r.height / 2);
      else change();
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {
        /* still switches for this page */
      }
    });
    night.addEventListener('refresh', render);
    render();

    const tools = document.createElement('span');
    tools.className = 'top-tools';
    tools.append(github, night);
    who.prepend(tools);
  }

  // Other tabs follow when the theme is switched in one of them.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    apply(e.newValue);
    const btn = document.querySelector('.top-tools button');
    if (btn) btn.dispatchEvent(new Event('refresh'));
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addTools);
  else addTools();
})();

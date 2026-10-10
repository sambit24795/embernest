/* Theme: auto | light | dark, stored per device in localStorage.
   Loaded in <head> (before first paint) so there is no flash of the wrong theme.
   A ?theme=light|dark query param overrides the stored choice without saving it
   (used by scripts/screenshot.sh). */
(function () {
  'use strict';
  var KEY = 'pixelkilnTheme';
  var CHOICES = ['auto', 'light', 'dark'];
  var root = document.documentElement;

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return CHOICES.indexOf(v) >= 0 ? v : 'auto';
    } catch (_) { return 'auto'; }
  }

  function override() {
    try {
      var q = new URLSearchParams(location.search).get('theme');
      return q === 'light' || q === 'dark' ? q : null;
    } catch (_) { return null; }
  }

  function syncControls(choice) {
    var btns = document.querySelectorAll('[data-theme-choice]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-theme-choice') === choice));
    }
  }

  function apply(choice) {
    root.setAttribute('data-theme', choice);
    syncControls(choice);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      var bg = getComputedStyle(root).getPropertyValue('--meta-theme').trim();
      if (bg) meta.setAttribute('content', bg);
    }
  }

  /** Persist and apply a choice. */
  function set(choice) {
    if (CHOICES.indexOf(choice) < 0) return;
    try { localStorage.setItem(KEY, choice); } catch (_) { /* private mode */ }
    apply(choice);
  }

  root.setAttribute('data-theme', override() || read());

  document.addEventListener('DOMContentLoaded', function () {
    apply(override() || read());
    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-theme-choice]') : null;
      if (btn) set(btn.getAttribute('data-theme-choice'));
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var onChange = function () { if (root.getAttribute('data-theme') === 'auto') apply('auto'); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
  });

  window.EmbernestTheme = { get: read, set: set };
})();

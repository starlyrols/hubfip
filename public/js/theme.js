'use strict';

// Bascule clair/sombre — chargé SYNCHRONE dans <head> (fichier externe : la CSP
// n'autorise pas les scripts inline) pour poser data-theme sur <html> avant le
// premier rendu (pas de flash). Préférence persistée ; à défaut, thème système.
window.SumoTheme = (function () {
  const KEY = 'sumo_theme';

  function initial() {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* stockage indisponible (navigation privée) */ }
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch { /* matchMedia indisponible */ }
    return 'dark';
  }

  function get() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }

  function set(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(KEY, t); } catch { /* non bloquant */ }
    document.dispatchEvent(new CustomEvent('sumo:theme', { detail: t }));
  }

  function toggle() { set(get() === 'light' ? 'dark' : 'light'); }

  document.documentElement.dataset.theme = initial();
  return { get, set, toggle };
})();

'use strict';

// =============================================================================
// Compilation LOCALE des utilitaires (correctif B5 / P0 n°8).
//
// AVANT : `cdn.tailwindcss.com` compilait les classes DANS LE NAVIGATEUR — ce qui
// imposait `'unsafe-eval'` dans la CSP et plaçait la console du régulateur sous la
// dépendance d'un CDN étranger : une compromission de cet hôte exécutait du code
// arbitraire dans une session habilitée à révéler des numéros. Le CDN Tailwind est
// d'ailleurs explicitement déconseillé en production par ses propres auteurs.
//
// APRÈS : la feuille est compilée ici, une fois, et servie depuis la plateforme.
// `npm run build-css` la régénère. Le résultat est versionné pour que le dépôt
// reste installable et démarrable SANS accès réseau (souveraineté, site isolé).
//
// Les classes construites dynamiquement (couleurs d'opérateur, habillage des rôles)
// vivent dans le référentiel et l'annuaire : ces fichiers sont donc scannés eux
// aussi, et les familles de teintes correspondantes sont mises en liste de sûreté.
// =============================================================================

const COLOR_FAMILIES = ['emerald', 'teal', 'sky', 'indigo', 'purple', 'slate', 'red', 'amber', 'blue', 'gray'];
const SHADES = [300, 400, 500, 600, 700];

module.exports = {
  darkMode: ['selector', 'html:not([data-theme="light"])'],
  content: [
    './public/**/*.html',
    './public/js/**/*.js',
    './lib/referentiel.js',   // couleurs d'opérateur (bg-*, text-*)
    './lib/users.js',         // habillage des rôles (ROLE_UI)
  ],
  safelist: [
    ...COLOR_FAMILIES.flatMap((c) => SHADES.map((s) => `bg-${c}-${s}`)),
    ...COLOR_FAMILIES.flatMap((c) => SHADES.map((s) => `text-${c}-${s}`)),
    ...COLOR_FAMILIES.flatMap((c) => SHADES.map((s) => `border-t-${c}-${s}`)),
  ],
  theme: {
    extend: {
      fontFamily: {
        // Inter est auto-hébergée (@fontsource) : plus aucun appel à Google Fonts.
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

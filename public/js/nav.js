'use strict';

// Habillage des boutons de navigation. Extrait d'un script inline de index.html :
// la CSP ne porte pas `'unsafe-inline'` sur script-src, ce bloc ne s'exécutait donc
// jamais. Servi comme fichier, il fonctionne — et la CSP reste stricte.
document.querySelectorAll('.nav-btn').forEach((b) => {
  b.className = 'nav-btn w-full flex items-center gap-3 px-3 py-2.5 text-gray-300 rounded-lg text-left hover:bg-gray-800';
  b.setAttribute('aria-selected', 'false');
});

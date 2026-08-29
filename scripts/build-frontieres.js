'use strict';

// =============================================================================
// Construction du fond de carte — frontières RÉELLES, embarquées (outil de dev).
//
// La plateforme ne fait aucune requête externe à l'exécution (correctif P0 n°8).
// Ce script est l'unique endroit où des données cartographiques sont téléchargées :
// il s'exécute SUR LE POSTE DE DÉVELOPPEMENT, une fois, et fige le résultat dans
// deux fichiers versionnés que la plateforme sert ensuite elle-même :
//
//   public/js/gabon-frontieres.js            tracé du Gabon (Natural Earth 10 m,
//                                            simplifié ~400 m de tolérance)
//   public/js/frontieres-afrique-centrale.js voisinage de la sous-région CEEAC
//                                            (Natural Earth 50 m, simplifié,
//                                            découpé à l'emprise de la vue)
//
// Source : Natural Earth (domaine public — aucune clause d'attribution exigée,
// la mention est de courtoisie). Le tracé reste GÉNÉRALISÉ : l'écran porte la
// mention « à titre indicatif », le tracé officiel des frontières relevant des
// instruments internationaux en vigueur.
//
//   npm run build-frontieres
// =============================================================================

const fs = require('fs');
const path = require('path');

const NE = 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master';
const SRC_GABON = `${NE}/10m/cultural/ne_10m_admin_0_countries.json`;
const SRC_MONDE = `${NE}/50m/cultural/ne_50m_admin_0_countries.json`;

// Sous-région représentée (voisinage CEEAC visible depuis l'emprise nationale).
const VOISINS = [
  { iso: 'CMR', nom: 'CAMEROUN', label: [3.30, 12.80] },
  { iso: 'GNQ', nom: 'GUINÉE ÉQUATORIALE', label: [1.55, 10.35] },
  { iso: 'COG', nom: 'CONGO', label: [-0.60, 15.40] },
  { iso: 'COD', nom: 'RD CONGO', label: [-4.60, 17.00] },
  { iso: 'AGO', nom: 'ANGOLA (CABINDA)', label: [-5.10, 12.20] },
  { iso: 'STP', nom: 'SÃO TOMÉ-ET-PRÍNCIPE', label: [0.90, 6.45] },
];

// Emprise de découpe : la vue navigable, plus une marge (le tracé d'un voisin
// n'a pas besoin d'exister au-delà de ce que l'écran peut montrer).
const CLIP = { latMin: -6.8, latMax: 5.2, lngMin: 5.0, lngMax: 18.2 };

// Tolérances de simplification (degrés) — ~1° ≈ 111 km à l'équateur.
const TOL_GABON = 0.0035;   // ≈ 400 m : fidèle à l'échelle d'un écran national
const TOL_VOISIN = 0.02;    // ≈ 2,2 km : contexte d'orientation

// --- Douglas-Peucker --------------------------------------------------------
function simplify(points, tol) {
  if (points.length <= 2) return points;
  const sq = tol * tol;
  const d2seg = ([py, px], [ay, ax], [by, bx]) => {
    let x = ax; let y = ay; let dx = bx - ax; let dy = by - ay;
    if (dx !== 0 || dy !== 0) {
      const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = bx; y = by; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = px - x; dy = py - y;
    return dx * dx + dy * dy;
  };
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0; let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = d2seg(points[i], points[a], points[b]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > sq && idx > 0) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// --- Découpe rectangulaire (Sutherland–Hodgman) -----------------------------
function clipRect(ring) {
  const bords = [
    (p) => p[0] >= CLIP.latMin, (p) => p[0] <= CLIP.latMax,
    (p) => p[1] >= CLIP.lngMin, (p) => p[1] <= CLIP.lngMax,
  ];
  const coupe = [
    (a, b) => { const t = (CLIP.latMin - a[0]) / (b[0] - a[0]); return [CLIP.latMin, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (CLIP.latMax - a[0]) / (b[0] - a[0]); return [CLIP.latMax, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (CLIP.lngMin - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), CLIP.lngMin]; },
    (a, b) => { const t = (CLIP.lngMax - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), CLIP.lngMax]; },
  ];
  let out = ring;
  for (let e = 0; e < 4; e++) {
    const dedans = bords[e]; const inter = coupe[e];
    const entree = out; out = [];
    for (let i = 0; i < entree.length; i++) {
      const cur = entree[i]; const prev = entree[(i + entree.length - 1) % entree.length];
      if (dedans(cur)) { if (!dedans(prev)) out.push(inter(prev, cur)); out.push(cur); }
      else if (dedans(prev)) out.push(inter(prev, cur));
    }
    if (!out.length) return [];
  }
  return out;
}

// GeoJSON [lng, lat] → Leaflet [lat, lng] ; MultiPolygon → liste d'anneaux extérieurs.
function anneaux(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polys.map((p) => p[0].map(([lng, lat]) => [lat, lng]));
}

const aire = (ring) => Math.abs(ring.reduce((s, [y, x], i) => {
  const [y2, x2] = ring[(i + 1) % ring.length]; return s + (x * y2 - x2 * y);
}, 0) / 2);

const fmt = (ring) => '[\n      ' + ring.map(([lat, lng]) => `[${lat.toFixed(4)}, ${lng.toFixed(4)}]`).join(', ') + ',\n    ]';

async function telecharger(url, label) {
  process.stdout.write(`  Téléchargement ${label}… `);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${label} : HTTP ${r.status}`);
  const j = await r.json();
  console.log(`OK (${j.features.length} entités)`);
  return j;
}

const parIso = (fc, iso) => fc.features.find((f) => {
  const p = f.properties;
  return p.ISO_A3 === iso || p.ADM0_A3 === iso || p.ISO_A3_EH === iso;
});

async function main() {
  console.log('Construction du fond de carte (Natural Earth, domaine public)\n');
  const monde10 = await telecharger(SRC_GABON, 'Natural Earth 10 m (détail Gabon)');
  const monde50 = await telecharger(SRC_MONDE, 'Natural Earth 50 m (voisinage)');

  // --- Gabon : anneau principal à 10 m, simplifié ---------------------------
  const gab = parIso(monde10, 'GAB');
  if (!gab) throw new Error('Gabon introuvable dans Natural Earth 10 m');
  const principal = anneaux(gab.geometry).sort((a, b) => aire(b) - aire(a))[0];
  const contour = simplify(principal, TOL_GABON);
  if (contour[0][0] !== contour[contour.length - 1][0] || contour[0][1] !== contour[contour.length - 1][1]) {
    contour.push([...contour[0]]);
  }
  console.log(`  Gabon : ${principal.length} sommets (10 m) → ${contour.length} après simplification (~400 m)`);

  // --- Voisinage : 50 m, simplifié, découpé à l'emprise ---------------------
  const pays = [];
  for (const v of VOISINS) {
    const f = parIso(monde50, v.iso);
    if (!f) { console.warn(`  ! ${v.iso} introuvable — ignoré`); continue; }
    const polys = anneaux(f.geometry)
      .map((r) => clipRect(r))
      .filter((r) => r.length >= 4)
      .map((r) => simplify(r, TOL_VOISIN))
      .filter((r) => r.length >= 4 && aire(r) > 0.002);
    if (!polys.length) { console.warn(`  ! ${v.iso} entièrement hors emprise — ignoré`); continue; }
    pays.push({ ...v, polys });
    console.log(`  ${v.nom.padEnd(22)} ${polys.length} polygone(s), ${polys.reduce((s, p) => s + p.length, 0)} sommets`);
  }

  // --- Écriture : Gabon -----------------------------------------------------
  const enTeteCommun = `// Généré par scripts/build-frontieres.js — NE PAS ÉDITER À LA MAIN.
// Source : Natural Earth (domaine public), téléchargée à la CONSTRUCTION puis
// figée ici : la plateforme ne fait aucune requête externe à l'exécution.
// Tracé généralisé, à titre indicatif — le tracé officiel des frontières relève
// des instruments internationaux en vigueur.`;

  fs.writeFileSync(path.join(__dirname, '..', 'public', 'js', 'gabon-frontieres.js'), `'use strict';

${enTeteCommun}

window.GABON_FRONTIERES = {
  mention: 'Frontières simplifiées (Natural Earth), à titre indicatif — fond local, aucune requête externe',
  source: 'Natural Earth 10 m, simplifié à ~400 m',
  contour: ${fmt(contour).replace(/\n {6}/g, '\n    ').replace(/\n {4}\]$/, '\n  ]')},
};
`);

  // --- Écriture : sous-région ----------------------------------------------
  const corps = pays.map((v) => `    {
      nom: '${v.nom.replace(/'/g, "\\'")}',
      label: [${v.label[0]}, ${v.label[1]}],
      polygones: [
${v.polys.map((p) => '        ' + fmt(p).replace(/\n {6}/g, '\n        ').replace(/\n {4}\]$/, '\n        ]')).join(',\n')},
      ],
    }`).join(',\n');

  fs.writeFileSync(path.join(__dirname, '..', 'public', 'js', 'frontieres-afrique-centrale.js'), `'use strict';

${enTeteCommun}
//
// Voisinage de la SOUS-RÉGION (CEEAC) visible depuis l'emprise nationale :
// contexte d'orientation, tracé plus généralisé que le territoire (50 m,
// simplifié à ~2 km), découpé à l'emprise navigable de la carte.

window.AFRIQUE_CENTRALE = {
  pays: [
${corps},
  ],
};
`);

  console.log('\n  Écrit : public/js/gabon-frontieres.js');
  console.log('  Écrit : public/js/frontieres-afrique-centrale.js');
}

main().catch((e) => { console.error('ÉCHEC :', e.message); process.exit(1); });

'use strict';

// =============================================================================
// Module M14/P6 — Services financiers de l'opérateur postal.
// Volet propre au mandat du régulateur postal (absent des deux référentiels
// commerciaux étudiés) : réseau des points (SP-01), activité par service
// (SP-02), qualité/disponibilité du SI aux guichets (SP-03/04), passerelle
// poste ↔ mobile money (SP-05) et contribution à l'inclusion : localités où le
// point postal est le SEUL accès financier (SP-06, service universel).
// PROTOTYPE : opérateur postal simulé (« La Poste Gabon SA »), activité
// alimentée par tick ; disponibilité déclarée (drapeau DECLARE), réseau
// contrôlé par campagnes mystères simulées (drapeau CONTROLE).
// =============================================================================

const ref = require('./referentiel');

const SERVICES = [
  { id: 'MANDAT_NATIONAL', label: 'Mandats nationaux' },
  { id: 'MANDAT_INTERNATIONAL', label: 'Mandats internationaux' },
  { id: 'VERSEMENT', label: 'Versements' },
  { id: 'RETRAIT', label: 'Retraits' },
  { id: 'MM_POSTAL', label: 'Mobile money postal (passerelle)' },
];

// Localités rurales desservies UNIQUEMENT par la poste (SP-06) — hors du
// référentiel des villes couvertes par les agents mobile money.
const EXCLUSIVES = [
  { name: 'Ndjolé', province: 'Moyen-Ogooué' },
  { name: 'Booué', province: 'Ogooué-Ivindo' },
  { name: 'Mayumba', province: 'Nyanga' },
  { name: 'Mékambo', province: 'Ogooué-Ivindo' },
];

// Réseau : 1 à 3 bureaux par ville du référentiel + les localités exclusives.
const points = [];
(function seedPoints() {
  let n = 0;
  for (const city of ref.CITIES) {
    const count = city.name === 'Libreville' ? 3 : 1;
    for (let i = 0; i < count; i++) {
      n++;
      points.push({
        id: `BP-${String(n).padStart(3, '0')}`, city: city.name, province: city.province,
        lat: city.lat, lng: city.lng, actif: true, exclusif: false,
        // Campagne mystère simulée : ~85 % des points déjà contrôlés sur place.
        controle: Math.random() < 0.85,
      });
    }
  }
  for (const loc of EXCLUSIVES) {
    n++;
    points.push({ id: `BP-${String(n).padStart(3, '0')}`, city: loc.name, province: loc.province, lat: null, lng: null, actif: true, exclusif: true, controle: Math.random() < 0.85 });
  }
}());

// Compteurs d'activité par service (SP-02), alimentés par tick.
const activity = Object.fromEntries(SERVICES.map((s) => [s.id, { count: 0, sumXaf: 0 }]));
const byProvince = new Map();

const AMOUNTS = { MANDAT_NATIONAL: [5_000, 300_000], MANDAT_INTERNATIONAL: [20_000, 1_000_000], VERSEMENT: [2_000, 500_000], RETRAIT: [2_000, 400_000], MM_POSTAL: [1_000, 200_000] };

// Fait avancer l'activité postale simulée (appelé périodiquement par server.js).
function tick(ops = 12) {
  for (let i = 0; i < ops; i++) {
    const s = SERVICES[Math.floor(Math.random() * SERVICES.length)];
    const [lo, hi] = AMOUNTS[s.id];
    const amount = lo + Math.floor(Math.random() * (hi - lo));
    activity[s.id].count++;
    activity[s.id].sumXaf += amount;
    const p = points[Math.floor(Math.random() * points.length)];
    if (!byProvince.has(p.province)) byProvince.set(p.province, { count: 0, sumXaf: 0 });
    const e = byProvince.get(p.province);
    e.count++; e.sumXaf += amount;
  }
}

// Disponibilité SI déclarée par province (SP-03) — valeurs stables de démo.
function declaredAvailability() {
  const provinces = [...new Set(points.map((p) => p.province))];
  return provinces.map((province, i) => ({
    province, flag: 'DECLARE',
    dispoSiPct: +(0.985 - (i % 4) * 0.012).toFixed(3),
    delaiMedianMandatHeures: +(4 + (i % 5) * 1.5).toFixed(1),
  }));
}

function report() {
  const actifs = points.filter((p) => p.actif);
  const provinces = [...new Set(points.map((p) => p.province))];
  return {
    operateur: { id: 'poste-ga', name: 'La Poste Gabon SA (simulée)' },
    sp01: {
      flag: 'CONTROLE', // réseau déclaré, corrigé par les constats mystères
      points: actifs.length,
      provincesCouvertes: provinces.length,
      controlesSurPlace: points.filter((p) => p.controle).length,
      parProvince: provinces.map((province) => ({
        province,
        points: actifs.filter((p) => p.province === province).length,
        exclusifs: actifs.filter((p) => p.province === province && p.exclusif).length,
      })),
    },
    sp02: {
      flag: 'DECLARE',
      parService: SERVICES.map((s) => ({ service: s.id, label: s.label, ...activity[s.id] })),
      parProvince: [...byProvince.entries()].map(([province, e]) => ({ province, ...e })).sort((a, b) => b.sumXaf - a.sumXaf),
    },
    sp03: declaredAvailability(),
    sp05: { flag: 'DECLARE', label: 'Passerelle poste ↔ mobile money', ...activity.MM_POSTAL },
    sp06: {
      flag: 'CONTROLE',
      label: 'Localités où le point postal est le seul accès financier',
      localites: points.filter((p) => p.exclusif && p.actif).map((p) => ({ localite: p.city, province: p.province, pointId: p.id })),
    },
    points: points.slice(0, 60),
  };
}

module.exports = { SERVICES, tick, report, points };

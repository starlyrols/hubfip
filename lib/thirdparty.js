'use strict';

// =============================================================================
// Module M14/P2 — Accès des tiers (PSP/fintechs) et concurrence (volet L8).
// Référentiel fonctionnel : « couverture élargie » (Vanrise) réduite au mandat
// régulateur : registre des demandes de raccordement aux canaux (USSD/API/SMS)
// avec jalons datés J0→J3, indicateurs AT-01 (délais), AT-02 (stock en
// attente), AT-03 (tarifs de gros), AT-04 (qualité comparée wallet maison vs
// canal PSP — mesures N3, module probes) et plaintes pour discrimination
// (workflow L8.3). PROTOTYPE : registre et plaintes ensemencés (simulation).
// =============================================================================

const ref = require('./referentiel');
const probes = require('./probes');

// Jalons réglementaires (HYP-10) : J1 ≤ 5 j ouvrés, J2 ≤ 30 j, J3 ≤ 90 j.
const DELAIS = { j1JoursOuvres: 5, j2Jours: 30, j3Jours: 90 };
const DAY = 86_400_000;

const PSPS = ['PayGabon', 'FlashPay Fintech', 'MobiCash Services', 'GabPay', 'Okoumé Pay', 'TransFin CEMAC'];
const CANAUX = ['USSD_MUTUALISE', 'USSD_DEDIE', 'API_GROS', 'SMS'];

// Registre ensemencé au démarrage : demandes réparties sur les opérateurs
// hôtes avec des situations variées (servies dans les délais, en retard, en
// stock, refusée) pour matérialiser AT-01/AT-02.
let requests = [];
let complaints = [];
let seeded = false;

function seed(now = Date.now()) {
  requests = [];
  let n = 0;
  for (const op of ref.OPERATORS) {
    for (let i = 0; i < 3; i++) {
      n++;
      const psp = PSPS[(n - 1) % PSPS.length];
      const canal = CANAUX[n % CANAUX.length];
      const j0 = now - (30 + Math.floor(Math.random() * 150)) * DAY;
      // Situations : 0 = servie dans les délais, 1 = servie en retard, 2 = en stock
      const situation = i;
      const j1 = j0 + (situation === 1 ? 9 : 2) * DAY;
      const j2 = situation === 2 ? null : j0 + (situation === 1 ? 41 : 21) * DAY;
      const j3 = situation === 2 ? null : j0 + (situation === 1 ? 116 : 74) * DAY;
      const refused = n === 5; // une demande refusée pour matérialiser le motif
      requests.push({
        id: `RAC-2026-${String(n).padStart(3, '0')}`,
        psp, hostOperatorId: op.id, canal,
        j0, j1, j2: refused ? j0 + 28 * DAY : j2, j3: refused ? null : j3,
        statut: refused ? 'REFUSEE' : (situation === 2 ? 'EN_COURS' : 'EN_SERVICE'),
        motifRefus: refused ? 'Capacité USSD déclarée insuffisante (contesté par le PSP)' : null,
      });
    }
  }
  complaints = [{
    id: 'DISC-2026-001', psp: PSPS[0], hostOperatorId: ref.OPERATORS[1].id,
    objet: 'Qualité du canal USSD mutualisé dégradée par rapport au wallet de l\'opérateur',
    recueLe: now - 21 * DAY, statut: 'INSTRUCTION',
    echeance: now + 24 * DAY, // borne des 45 j d'instruction (L8.3)
  }];
  seeded = true;
}

const ensure = () => { if (!seeded) seed(); };

function withDelays(r, now = Date.now()) {
  const dJ1 = r.j1 ? Math.round((r.j1 - r.j0) / DAY) : null;
  const dJ2 = r.j2 ? Math.round((r.j2 - r.j0) / DAY) : null;
  const dJ3 = r.j3 ? Math.round((r.j3 - r.j0) / DAY) : null;
  const age = Math.round((now - r.j0) / DAY);
  const overdue = (r.statut === 'EN_COURS' && age > DELAIS.j3Jours)
    || (dJ1 != null && dJ1 > DELAIS.j1JoursOuvres + 2) // approximation ouvrés → calendaires
    || (dJ2 != null && dJ2 > DELAIS.j2Jours)
    || (dJ3 != null && dJ3 > DELAIS.j3Jours);
  return { ...r, delaiJ1: dJ1, delaiJ2: dJ2, delaiJ3: dJ3, ageJours: age, depassement: overdue };
}

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

// Tarifs de gros déclarés (AT-03) — grille standard + une condition
// différenciée pour matérialiser le contrôle de non-discrimination tarifaire.
function wholesaleTariffs() {
  return [
    { canal: 'USSD_MUTUALISE', unite: 'Session USSD ≤ 90 s', tarifXaf: 12, psp: 'Standard', flag: 'DECLARE' },
    { canal: 'USSD_DEDIE', unite: 'Code dédié / mois', tarifXaf: 850_000, psp: 'Standard', flag: 'DECLARE' },
    { canal: 'API_GROS', unite: 'Requête API', tarifXaf: 3, psp: 'Standard', flag: 'DECLARE' },
    { canal: 'API_GROS', unite: 'Requête API', tarifXaf: 5, psp: PSPS[0], flag: 'DECLARE', signalement: 'Condition différenciée à justifier (non-discrimination)' },
    { canal: 'SMS', unite: 'SMS émis', tarifXaf: 8, psp: 'Standard', flag: 'DECLARE' },
  ];
}

// Rapport du volet tiers. Scope opérateur : un opérateur hôte ne voit que les
// demandes qui le concernent ; les PSP et l'ARCEP voient tout (démo).
function report(opts = {}) {
  ensure();
  const now = Date.now();
  const list = requests
    .filter((r) => !opts.operatorId || r.hostOperatorId === opts.operatorId)
    .map((r) => withDelays(r, now))
    .sort((a, b) => b.j0 - a.j0);

  const served = list.filter((r) => r.statut === 'EN_SERVICE' && r.delaiJ3 != null);
  const enCours = list.filter((r) => r.statut === 'EN_COURS');
  return {
    flag: 'CONTROLE', // valeurs recalculées depuis le registre horodaté
    delaisReglementaires: DELAIS,
    at01: {
      demandes: list.length,
      enService: served.length,
      delaiMedianJ3: median(served.map((r) => r.delaiJ3)),
      delaiMaxJ3: served.length ? Math.max(...served.map((r) => r.delaiJ3)) : null,
    },
    at02: {
      enCours: enCours.length,
      enAttentePlus30j: enCours.filter((r) => r.ageJours > 30).length,
      enAttentePlus90j: enCours.filter((r) => r.ageJours > 90).length,
      depassements: list.filter((r) => r.depassement).length,
    },
    at03: wholesaleTariffs(),
    at04: probes.channelComparison(opts.operatorId ? { operatorId: opts.operatorId } : {}),
    at04ParOperateur: opts.operatorId ? null : probes.comparisonByOperator(),
    demandes: list,
    plaintes: complaints
      .filter((p) => !opts.operatorId || p.hostOperatorId === opts.operatorId)
      .map((p) => ({ ...p, joursRestants: Math.round((p.echeance - now) / DAY) })),
  };
}

module.exports = { report, seed, DELAIS };

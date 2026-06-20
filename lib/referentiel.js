'use strict';

// =============================================================================
// SOURCE UNIQUE DE VÉRITÉ — Référentiel métier « régulateur télécom / Mobile Money »
// (cahier des charges §3). Remplace le cadrage bancaire par le cadrage télécom :
// opérateurs Mobile Money + moteurs (Comviva/Ericsson/Huawei/maison), canaux
// USSD/SMS/STK/app, types de TDR, codes d'erreur, devises & taux de change,
// grilles tarifaires, cellules/stations de base, réseau d'agents, abonnés/wallets.
//
// NOTE : référentiel de DÉMONSTRATION. Le statut réglementaire réel (licences,
// agréments) proviendrait d'un registre officiel sourcé ; rien n'est affirmé ici.
// =============================================================================

// --- Générateur pseudo-aléatoire DÉTERMINISTE (mulberry32) ---------------------
// Seedé par constante : les pools (abonnés, agents, cellules) sont reproductibles
// d'un démarrage à l'autre → indispensable au traçage de chaînes et à la vélocité.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260620); // seed fixe → pools reproductibles
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const randInt = (min, max) => min + Math.floor(rng() * (max - min + 1));

// --- Moteurs (agnosticisme opérateur, cahier §1/§5) ---------------------------
const ENGINES = Object.freeze([
  { id: 'comviva', name: 'Comviva Mobiquity' },
  { id: 'ericsson', name: 'Ericsson Wallet Platform' },
  { id: 'huawei', name: 'Huawei Mobile Money' },
  { id: 'maison', name: 'Solution interne (maison)' },
]);

// --- Opérateurs Mobile Money ---------------------------------------------------
// Contexte Gabon + un acteur régional pour illustrer l'interopérabilité / corridors.
const OPERATORS = [
  { id: 'airtel', name: 'Airtel Money Gabon', engine: 'comviva', color: 'text-red-400', bg: 'bg-red-600', prefixes: ['074', '077', '076'], marketWeight: 52 },
  { id: 'moov', name: 'Moov Money Gabon', engine: 'ericsson', color: 'text-blue-400', bg: 'bg-blue-600', prefixes: ['062', '065', '066'], marketWeight: 41 },
  { id: 'gimac', name: 'GIMAC Pay (switch régional)', engine: 'huawei', color: 'text-amber-400', bg: 'bg-amber-600', prefixes: ['011'], marketWeight: 7 },
];

// --- Canaux (cahier §3/§5 : USSD/SMS/STK dominants, pas que l'app) -------------
const CHANNELS = Object.freeze([
  { id: 'USSD', label: 'USSD' },
  { id: 'STK', label: 'STK (SIM Toolkit)' },
  { id: 'APP', label: 'Application smartphone' },
  { id: 'SMS', label: 'SMS' },
]);

// --- Types de TDR (cahier §3) --------------------------------------------------
// direction : sens de l'écriture principale pour la partie double.
const TX_TYPES = Object.freeze([
  { id: 'P2P', label: 'Transfert P2P', processingCode: '400000' },
  { id: 'CASHIN', label: 'Dépôt (cash-in)', processingCode: '210000' },
  { id: 'CASHOUT', label: 'Retrait (cash-out)', processingCode: '010000' },
  { id: 'MERCHANT', label: 'Paiement marchand', processingCode: '000000' },
  { id: 'AIRTIME', label: 'Achat airtime / forfait', processingCode: '170000' },
  { id: 'BILL', label: 'Paiement de facture', processingCode: '500000' },
  { id: 'XBORDER', label: 'Transfert transfrontalier', processingCode: '260000' },
]);

// --- Codes d'erreur (échecs) ---------------------------------------------------
const ERROR_CODES = Object.freeze([
  { code: '51', label: 'Solde insuffisant' },
  { code: '91', label: 'Émetteur indisponible (timeout réseau)' },
  { code: '14', label: 'Wallet bénéficiaire invalide' },
  { code: '61', label: 'Plafond de transaction dépassé' },
  { code: '75', label: 'Code PIN erroné (max essais)' },
  { code: '13', label: 'Montant invalide' },
  { code: '94', label: 'Transaction dupliquée' },
]);

// --- Devises & taux de change vers XAF (cahier §5 : multidevise / corridors) ---
// Taux indicatifs de démonstration (XAF base). XOF↔XAF = parité (zones franc CFA).
const CURRENCIES = Object.freeze({
  XAF: { code: 'XAF', num: '950', rateToXaf: 1, label: 'Franc CFA (CEMAC)' },
  XOF: { code: 'XOF', num: '952', rateToXaf: 1, label: 'Franc CFA (UEMOA)' },
  EUR: { code: 'EUR', num: '978', rateToXaf: 655.957, label: 'Euro' },
  USD: { code: 'USD', num: '840', rateToXaf: 605, label: 'Dollar US' },
});

// --- Grille tarifaire PAR DÉFAUT (cahier §5 : assurance revenus/redevances) -----
// fee = clamp(min, pct% * montant + flat, cap). Configurable via le module Admin.
const DEFAULT_FEES = Object.freeze({
  P2P: { pct: 1.0, flat: 0, min: 50, cap: 5000 },
  CASHIN: { pct: 0, flat: 0, min: 0, cap: 0 },
  CASHOUT: { pct: 1.5, flat: 0, min: 100, cap: 7000 },
  MERCHANT: { pct: 0.8, flat: 0, min: 25, cap: 4000 },
  AIRTIME: { pct: 0, flat: 0, min: 0, cap: 0 },
  BILL: { pct: 0.5, flat: 100, min: 100, cap: 3000 },
  XBORDER: { pct: 2.5, flat: 0, min: 500, cap: 25000 },
});

// Redevance réglementaire : assiette = revenu (frais perçus) ; taux indicatif.
const CONTRIBUTION_RATE = 0.015; // 1,5 % du revenu des frais (configurable)

// --- Maillage territorial (Gabon) ---------------------------------------------
const CITIES = [
  { name: 'Libreville', province: 'Estuaire', lat: 0.4162, lng: 9.4673 },
  { name: 'Akanda', province: 'Estuaire', lat: 0.5050, lng: 9.4850 },
  { name: 'Owendo', province: 'Estuaire', lat: 0.2942, lng: 9.5028 },
  { name: 'Port-Gentil', province: 'Ogooué-Maritime', lat: -0.7193, lng: 8.7815 },
  { name: 'Franceville', province: 'Haut-Ogooué', lat: -1.6333, lng: 13.5836 },
  { name: 'Moanda', province: 'Haut-Ogooué', lat: -1.5665, lng: 13.1997 },
  { name: 'Oyem', province: 'Woleu-Ntem', lat: 1.5996, lng: 11.5733 },
  { name: 'Bitam', province: 'Woleu-Ntem', lat: 2.0833, lng: 11.5000 },
  { name: 'Lambaréné', province: 'Moyen-Ogooué', lat: -0.7050, lng: 10.2406 },
  { name: 'Mouila', province: 'Ngounié', lat: -1.8667, lng: 11.0500 },
  { name: 'Tchibanga', province: 'Nyanga', lat: -2.8500, lng: 11.0167 },
  { name: 'Koulamoutou', province: 'Ogooué-Lolo', lat: -1.1303, lng: 12.4244 },
  { name: 'Makokou', province: 'Ogooué-Ivindo', lat: 0.5667, lng: 12.8667 },
];

const SITE_TYPES = ['macro', 'micro', 'rural'];

// --- Cellules / stations de base (cahier §3/§9 : corrélation cellule ↔ TDR) ----
const CELLS = [];
CITIES.forEach((c, ci) => {
  const n = c.province === 'Estuaire' ? 4 : 2; // densité urbaine plus élevée
  for (let k = 0; k < n; k++) {
    CELLS.push({
      id: `GA-${String(ci + 1).padStart(2, '0')}-${String(k + 1).padStart(3, '0')}`,
      city: c.name,
      province: c.province,
      lat: c.lat + (rng() - 0.5) * 0.05,
      lng: c.lng + (rng() - 0.5) * 0.05,
      siteType: SITE_TYPES[k % SITE_TYPES.length],
    });
  }
});

// --- Réseau d'agents cash-in / cash-out (cahier §5 : volet central) ------------
const AGENT_FIRST = ['Ngoma', 'Mba', 'Obame', 'Ndong', 'Bouanga', 'Moussavou', 'Nzé', 'Ondo', 'Ivanga', 'Mintsa', 'Boussougou', 'Nguema'];
const AGENT_KIND = ['Boutique', 'Kiosque', 'Station', 'Superette', 'Pharmacie'];
const AGENTS = [];
OPERATORS.forEach((op) => {
  const count = Math.round((op.marketWeight / 100) * 120) + 8;
  for (let i = 0; i < count; i++) {
    const city = pick(CITIES);
    AGENTS.push({
      id: `AG-${op.id.toUpperCase()}-${String(i + 1).padStart(4, '0')}`,
      name: `${pick(AGENT_KIND)} ${pick(AGENT_FIRST)}`,
      operatorId: op.id,
      city: city.name,
      province: city.province,
      lat: city.lat + (rng() - 0.5) * 0.06,
      lng: city.lng + (rng() - 0.5) * 0.06,
    });
  }
});

// --- Abonnés / wallets (cahier §3 entités de référence) ------------------------
// Pool stable par opérateur → récurrence des MSISDN (vélocité, structuring, chaînes).
const KYC_LEVELS = ['NON_VERIFIE', 'BASIQUE', 'COMPLET'];
const ACCOUNT_LEVELS = ['Niveau 1', 'Niveau 2', 'Niveau 3'];
const SUBSCRIBERS = [];
OPERATORS.forEach((op) => {
  const count = 140;
  for (let i = 0; i < count; i++) {
    const prefix = pick(op.prefixes);
    const msisdn = `+241${prefix}${String(randInt(0, 999999)).padStart(6, '0')}`;
    // Quelques abonnés « à risque » (réutilisés par le simulateur de fraude).
    const riskSeed = rng();
    SUBSCRIBERS.push({
      msisdn,
      operatorId: op.id,
      walletId: `W-${op.id.toUpperCase()}-${String(i + 1).padStart(5, '0')}`,
      kyc: riskSeed > 0.85 ? 'NON_VERIFIE' : pick(KYC_LEVELS),
      accountLevel: pick(ACCOUNT_LEVELS),
      registeredAt: new Date(Date.UTC(2021 + randInt(0, 4), randInt(0, 11), randInt(1, 28))).toISOString().slice(0, 10),
      riskSeed,
    });
  }
});

// --- Index ---------------------------------------------------------------------
const byId = new Map(OPERATORS.map((o) => [o.id, o]));
const engineById = new Map(ENGINES.map((e) => [e.id, e]));
const cityByName = new Map(CITIES.map((c) => [c.name, c]));
const cellById = new Map(CELLS.map((c) => [c.id, c]));
const agentById = new Map(AGENTS.map((a) => [a.id, a]));
const subByMsisdn = new Map(SUBSCRIBERS.map((s) => [s.msisdn, s]));
const txTypeById = new Map(TX_TYPES.map((t) => [t.id, t]));
const errorByCode = new Map(ERROR_CODES.map((e) => [e.code, e]));

function cellsOf(cityName) { return CELLS.filter((c) => c.city === cityName); }
function agentsOf(operatorId) { return AGENTS.filter((a) => a.operatorId === operatorId); }
function subscribersOf(operatorId) { return SUBSCRIBERS.filter((s) => s.operatorId === operatorId); }

// Minimisation des données (loi 001/2011) : masque le MSISDN par défaut.
// Conserve indicatif + préfixe + 2 derniers chiffres ; le reste est masqué.
function maskMsisdn(msisdn) {
  if (!msisdn) return '—';
  const s = String(msisdn);
  if (s.length < 6) return s;
  return s.slice(0, 7) + '****' + s.slice(-2);
}

function toXaf(amount, currency) {
  const c = CURRENCIES[currency] || CURRENCIES.XAF;
  return Math.round(amount * c.rateToXaf);
}

// Validation de schéma du référentiel : échoue tôt si une entrée est malformée.
function validate() {
  const engines = new Set(ENGINES.map((e) => e.id));
  for (const o of OPERATORS) {
    if (!o.id || !o.name) throw new Error(`Opérateur sans id/name: ${JSON.stringify(o)}`);
    if (!engines.has(o.engine)) throw new Error(`Moteur inconnu pour ${o.id}: ${o.engine}`);
    if (!o.color || !o.bg) throw new Error(`Couleurs manquantes pour ${o.id}`);
    if (!Array.isArray(o.prefixes) || !o.prefixes.length) throw new Error(`Préfixes MSISDN manquants pour ${o.id}`);
  }
  if (!CELLS.length || !AGENTS.length || !SUBSCRIBERS.length) throw new Error('Pools (cellules/agents/abonnés) vides');
  return true;
}

module.exports = {
  ENGINES, OPERATORS, CHANNELS, TX_TYPES, ERROR_CODES, CURRENCIES,
  DEFAULT_FEES, CONTRIBUTION_RATE, CITIES, CELLS, AGENTS, SUBSCRIBERS,
  KYC_LEVELS, ACCOUNT_LEVELS,
  byId, engineById, cityByName, cellById, agentById, subByMsisdn, txTypeById, errorByCode,
  cellsOf, agentsOf, subscribersOf, maskMsisdn, toXaf, validate,
};

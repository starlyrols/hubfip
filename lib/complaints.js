'use strict';

// =============================================================================
// Module M14/P4 — Réclamations consommateurs et corrélation aux incidents.
// Référentiel fonctionnel : « engagement utilisateur » (RX-MFS) reformulé dans
// le mandat régulateur : suivi agrégé des réclamations (RC-01..05) et
// CORRÉLATION avec les incidents techniques — une réclamation née d'une
// transaction échouée porte l'identifiant du TDR et le code d'erreur, jamais
// le MSISDN en clair (minimisation, loi 001/2011).
// PROTOTYPE : réclamations générées par le pipeline sur les échecs réels du
// flux (simulé ou injecté) + bruit ambiant (frais contestés, agents).
// =============================================================================

const crypto = require('crypto');
const ref = require('./referentiel');

const MOTIFS = [
  { id: 'TRANSACTION_NON_REMBOURSEE', label: 'Transaction échouée non remboursée' },
  { id: 'FRAIS_CONTESTES', label: 'Frais contestés' },
  { id: 'ACCES_COMPTE', label: 'Accès au compte / fraude alléguée' },
  { id: 'AGENT_POINT_SERVICE', label: 'Agent / point de service' },
  { id: 'QUALITE_CANAL', label: 'Qualité du canal (USSD, application)' },
];
const MAX = 2000;
const list = [];

// Probabilités de génération (démo) : un échec technique produit souvent une
// réclamation ; le bruit ambiant reste rare.
const P_FAILED = 0.25;
const P_AMBIENT = 0.01;

function push(c) {
  list.push(c);
  if (list.length > MAX) list.shift();
  return c;
}

function motifForError(errorCode) {
  if (errorCode === '91') return 'QUALITE_CANAL';        // timeout réseau
  if (errorCode === '51') return 'TRANSACTION_NON_REMBOURSEE';
  return 'TRANSACTION_NON_REMBOURSEE';
}

// Appelé par le pipeline pour CHAQUE TDR (simulateur comme connecteur) —
// même traitement de toutes les sources.
function maybeFromTdr(tdr) {
  if (tdr.status === 'FAILED' && Math.random() < P_FAILED) {
    return push({
      id: 'RC-' + crypto.randomUUID().slice(0, 8).toUpperCase(),
      epoch: tdr.epoch,
      operatorId: tdr.operator.id,
      canal: tdr.channel,
      province: tdr.cellOrigin ? tdr.cellOrigin.province : null,
      motif: motifForError(tdr.errorCode),
      lieAIncident: true,
      tdrId: tdr.id,
      errorCode: tdr.errorCode,
      msisdnMasked: ref.maskMsisdn(tdr.sender.msisdn),
      delaiTraitementJours: +(0.5 + Math.random() * 6).toFixed(1),
      statut: Math.random() < 0.85 ? 'CLOSE' : 'EN_COURS',
    });
  }
  if (Math.random() < P_AMBIENT) {
    const motif = Math.random() < 0.5 ? 'FRAIS_CONTESTES' : (Math.random() < 0.5 ? 'AGENT_POINT_SERVICE' : 'ACCES_COMPTE');
    return push({
      id: 'RC-' + crypto.randomUUID().slice(0, 8).toUpperCase(),
      epoch: tdr.epoch,
      operatorId: tdr.operator.id,
      canal: tdr.channel,
      province: tdr.cellOrigin ? tdr.cellOrigin.province : null,
      motif, lieAIncident: false, tdrId: null, errorCode: null,
      msisdnMasked: ref.maskMsisdn(tdr.sender.msisdn),
      delaiTraitementJours: +(1 + Math.random() * 12).toFixed(1),
      statut: Math.random() < 0.7 ? 'CLOSE' : 'EN_COURS',
    });
  }
  return null;
}

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

// Rapport RC — scoping opérateur appliqué (un opérateur ne voit que les siennes).
function report(opts = {}) {
  const scoped = opts.operatorId ? list.filter((c) => c.operatorId === opts.operatorId) : list;
  const closes = scoped.filter((c) => c.statut === 'CLOSE');
  const liees = scoped.filter((c) => c.lieAIncident);

  const byMotif = MOTIFS.map((m) => {
    const sub = scoped.filter((c) => c.motif === m.id);
    return { motif: m.id, label: m.label, recues: sub.length, closes: sub.filter((c) => c.statut === 'CLOSE').length };
  }).sort((a, b) => b.recues - a.recues);

  const byOperator = ref.OPERATORS
    .filter((op) => !opts.operatorId || op.id === opts.operatorId)
    .map((op) => {
      const sub = scoped.filter((c) => c.operatorId === op.id);
      return {
        operatorId: op.id, name: op.name, color: op.color,
        recues: sub.length,
        liees: sub.filter((c) => c.lieAIncident).length,
        delaiMedianJours: median(sub.map((c) => c.delaiTraitementJours)),
      };
    });

  // Corrélation incidents : ventilation des réclamations liées par code d'erreur.
  const byError = {};
  for (const c of liees) {
    if (!c.errorCode) continue;
    byError[c.errorCode] = (byError[c.errorCode] || 0) + 1;
  }
  const correlation = Object.entries(byError)
    .map(([code, count]) => ({ code, label: (ref.errorByCode.get(code) || {}).label || code, count }))
    .sort((a, b) => b.count - a.count);

  return {
    flag: 'CONTROLE', // agrégats recalculés depuis le flux (RC opérateur = N1 déclaré à terme)
    totals: {
      recues: scoped.length,
      closes: closes.length,
      enCours: scoped.length - closes.length,
      tauxLieesIncidentPct: scoped.length ? +(100 * liees.length / scoped.length).toFixed(1) : 0,
      delaiMedianJours: median(scoped.map((c) => c.delaiTraitementJours)),
    },
    byMotif, byOperator, correlation,
    recent: scoped.slice(-80).reverse(),
  };
}

const size = () => list.length;

module.exports = { MOTIFS, maybeFromTdr, report, size };

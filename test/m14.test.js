'use strict';

// Tests du module M14 — services financiers numériques (probes/N3, tiers,
// réclamations, postal) : logique métier hors HTTP.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-m14-'));

// Les sondes, les réclamations et l'activité postale sont toutes tirées au sort.
// Sans graine, les assertions portant sur les biais simulés sont des paris :
// sur ~40 mesures USSD, une série intégralement réussie (p ≈ 0,935^40 ≈ 7 %)
// suffit à faire passer l'opérateur biaisé pour CONFORME. On fixe donc la source
// d'aléa pour toute la suite — les tirages restent uniformes, mais reproductibles.
// (crypto.randomUUID n'est pas concerné : les identifiants restent uniques.)
Math.random = (() => {
  let s = 0x2f6e2b1;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();

const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/config').load();
const model = require('../lib/model');
const pipeline = require('../lib/pipeline');
const probes = require('../lib/probes').init();
const thirdparty = require('../lib/thirdparty');
const complaints = require('../lib/complaints');
const postal = require('../lib/postal');
const cases = require('../lib/cases');
require('../lib/ledger').init();
require('../lib/audit').init();
cases.load();

test('probes : une campagne est scellée d\'un bloc dans un journal probant valide', () => {
  const avant = probes.journal.stats().total;
  const c = probes.runCampaign();
  assert.ok(c.measurements > 0, 'des mesures sont produites');
  assert.equal(probes.size() > 0, true);

  // Correctif P1 n°17 : l'unité probante est la CAMPAGNE, pas la mesure isolée.
  // Une seule signature et une seule écriture, au lieu d'une par mesure.
  assert.equal(probes.journal.stats().total, avant + 1, 'un enregistrement par campagne');

  const integrity = probes.journal.verifyChain({ limit: 1000 });
  assert.equal(integrity.valid, true);

  // Le contenu probant reste intégral : toutes les mesures sont dans le bloc.
  const dernier = probes.journal.getRecent(1)[0];
  assert.equal(dernier.payload.kind, 'CAMPAGNE_N3');
  assert.equal(dernier.payload.mesures.length, c.measurements, 'aucune mesure perdue à la compaction');
  for (const champ of ['operatorId', 'canal', 'province', 'success', 'latencyMs', 'feeCharged']) {
    assert.ok(champ in dernier.payload.mesures[0], `la mesure conserve « ${champ} »`);
  }
});

test('probes : le rapport porte les drapeaux de confiance et détecte l\'opérateur en écart', () => {
  for (let i = 0; i < 4; i++) probes.runCampaign(); // volume suffisant (plancher de 30 mesures)
  const r = probes.report();
  assert.equal(r.byOperator.length >= 3, true);
  for (const row of r.byOperator) {
    assert.equal(row.measured.flag, 'MESURE');
    assert.equal(row.declared.flag, 'DECLARE');
  }
  // Le 2e opérateur sur-déclare sa disponibilité USSD (biais simulé) → écart +
  // procédure contradictoire ouverte dans le module Investigation.
  const biased = r.byOperator[1];
  assert.equal(biased.verdict, 'ECART');
  assert.ok(biased.contradictoireId, 'un dossier contradictoire est ouvert');
  const dossier = cases.get(biased.contradictoireId);
  assert.ok(dossier && dossier.title.startsWith('CONTRADICTOIRE'));
  // Le 3e opérateur surfacture les frais P2P → écarts tarifaires constatés.
  assert.ok(r.byOperator[2].tarifEcarts > 0, 'constats tarifaires ≠ grille');
});

test('probes : contradictoire dédupliqué — un seul dossier par (opérateur, type) tant qu\'il est ouvert', () => {
  // NB : compter le TOTAL des dossiers serait instable — une campagne ultérieure
  // peut légitimement révéler un écart sur une AUTRE clé (latence, tarif). La
  // garantie de déduplication porte sur la clé, pas sur le total.
  const idsByKey = () => new Map(probes.report().contradictoires.map((c) => [c.key, c.caseId]));
  const before = idsByKey();
  assert.ok(before.size > 0, 'au moins un écart déjà constaté');
  probes.runCampaign();
  probes.runCampaign();
  const after = idsByKey();
  for (const [key, caseId] of before) assert.equal(after.get(key), caseId, `dossier stable pour ${key}`);
  assert.equal(after.size, new Set(after.values()).size, 'un dossier distinct par clé');
});

test('thirdparty : AT-01/AT-02 calculés depuis le registre, jalons dépassés détectés', () => {
  const r = thirdparty.report();
  assert.ok(r.at01.demandes >= 9, 'registre ensemencé');
  assert.ok(r.at01.delaiMedianJ3 > 0);
  assert.ok(r.at02.depassements > 0, 'les demandes servies en retard sont signalées');
  assert.ok(r.demandes.every((d) => ['EN_COURS', 'EN_SERVICE', 'REFUSEE'].includes(d.statut)));
  const refused = r.demandes.find((d) => d.statut === 'REFUSEE');
  assert.ok(refused && refused.motifRefus, 'un refus porte son motif');
});

test('thirdparty : scope opérateur — un hôte ne voit que ses demandes ; AT-04 mesuré', () => {
  const ref = require('../lib/referentiel');
  const op = ref.OPERATORS[0].id;
  const r = thirdparty.report({ operatorId: op });
  assert.ok(r.demandes.length > 0);
  assert.ok(r.demandes.every((d) => d.hostOperatorId === op));
  assert.ok(Array.isArray(r.at04) && r.at04.length === 2, 'comparaison USSD + API');
  for (const c of r.at04) assert.equal(c.flag, 'MESURE');
});

test('complaints : un échec technique génère une réclamation corrélée (TDR + code erreur, MSISDN masqué)', () => {
  let created = null;
  for (let i = 0; i < 200 && !created; i++) {
    const tdr = model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 5000, senderMsisdn: '+241074123456', status: 'FAILED', errorCode: '91' });
    pipeline.ingest(tdr);
    created = complaints.report().recent.find((c) => c.tdrId === tdr.id) || null;
  }
  assert.ok(created, 'au moins une réclamation liée est née d\'un échec');
  assert.equal(created.lieAIncident, true);
  assert.equal(created.errorCode, '91');
  assert.ok(!/\+241\d{6}/.test(created.msisdnMasked), 'MSISDN jamais en clair');
});

test('complaints : le rejeu (enrich) ne fabrique aucune réclamation — seule l\'entrée (ingest) le fait', () => {
  // Le rejeu au démarrage rappelle `enrich` sur des TDR déjà scellés : s'il
  // produisait des réclamations, les agrégats changeraient à chaque redémarrage
  // et se dupliqueraient. `enrich` doit rester sans effet de bord.
  const before = complaints.size();
  for (let i = 0; i < 300; i++) {
    const tdr = model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 5000, senderMsisdn: '+241074123456', status: 'FAILED', errorCode: '91' });
    pipeline.enrich(tdr);
  }
  assert.equal(complaints.size(), before, 'enrich n\'écrit pas dans le registre des réclamations');
  // …mais l'enrichissement lui-même reste bien appliqué.
  const tdr = model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 5000, senderMsisdn: '+241074123456', status: 'FAILED', errorCode: '91' });
  assert.ok(Array.isArray(pipeline.enrich(tdr).alerts) && tdr.anomaly, 'enrich enrichit toujours le TDR');
});

test('complaints : rapport scopé par opérateur et corrélation par code d\'erreur', () => {
  const r = complaints.report({ operatorId: 'airtel' });
  assert.ok(r.byOperator.every((o) => o.operatorId === 'airtel'));
  assert.ok(r.totals.recues > 0);
  const full = complaints.report();
  assert.ok(full.correlation.length > 0, 'la corrélation aux incidents est ventilée par code');
});

test('postal : le rapport SP couvre réseau, activité, qualité et exclusivité (SP-06)', () => {
  postal.tick(100);
  const r = postal.report();
  assert.ok(r.sp01.points > 10, 'réseau ensemencé');
  assert.equal(r.sp01.flag, 'CONTROLE');
  assert.ok(r.sp02.parService.reduce((s, x) => s + x.count, 0) >= 100, 'activité alimentée par tick');
  assert.ok(r.sp06.localites.length >= 3, 'localités à accès financier exclusif identifiées');
  assert.ok(r.sp03.every((p) => p.dispoSiPct > 0 && p.dispoSiPct <= 1));
});

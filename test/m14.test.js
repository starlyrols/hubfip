'use strict';

// Tests du module M14 — services financiers numériques (probes/N3, tiers,
// réclamations, postal) : logique métier hors HTTP.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-m14-'));

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

test('probes : une campagne produit des mesures scellées dans un journal probant valide', () => {
  const c = probes.runCampaign();
  assert.ok(c.measurements > 0, 'des mesures sont produites');
  assert.equal(probes.size() > 0, true);
  const integrity = probes.journal.verifyChain({ limit: 1000 });
  assert.equal(integrity.valid, true);
  assert.ok(integrity.checked >= c.measurements, 'chaque mesure est scellée');
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

test('probes : contradictoire dédupliqué — pas de nouveau dossier tant que le précédent est ouvert', () => {
  const before = cases.list({ limit: 100 }).filter((c) => c.title.startsWith('CONTRADICTOIRE')).length;
  probes.runCampaign();
  probes.runCampaign();
  const after = cases.list({ limit: 100 }).filter((c) => c.title.startsWith('CONTRADICTOIRE')).length;
  assert.equal(after, before, 'aucun doublon de dossier contradictoire');
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
    pipeline.enrich(tdr);
    created = complaints.report().recent.find((c) => c.tdrId === tdr.id) || null;
  }
  assert.ok(created, 'au moins une réclamation liée est née d\'un échec');
  assert.equal(created.lieAIncident, true);
  assert.equal(created.errorCode, '91');
  assert.ok(!/\+241\d{6}/.test(created.msisdnMasked), 'MSISDN jamais en clair');
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

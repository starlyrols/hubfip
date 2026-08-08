'use strict';

// Tests du module M15 — moteur de workflow (standard BPM) : machine à états,
// gardes de rôles, SLA avec suspension, corbeilles et cloisonnement.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-m15-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/config').load();
require('../lib/audit').init();
const wf = require('../lib/workflow');
wf.load(); // ensemence les dossiers de démonstration

const SE = { username: 'se', role: 'SE', direction: 'SE', displayName: 'SE' };
const CR = { username: 'pcr', role: 'PRESIDENT', direction: 'PCR' };
const DM = { username: 'dm', role: 'DIRECTEUR', direction: 'DM' };
const DJ = { username: 'dj', role: 'DIRECTEUR', direction: 'DJ' };
const DFC = { username: 'dfc', role: 'DIRECTEUR', direction: 'DFC' };
const DRH = { username: 'drh', role: 'DIRECTEUR', direction: 'DRH' };
const OPERATEUR = { username: 'airtel', role: 'OPERATEUR', operatorId: 'airtel', displayName: 'Airtel' };

test('workflow : l\'ensemencement crée des dossiers dans des états variés, numérotés sans doublon', () => {
  const all = wf.list(SE);
  assert.ok(all.length >= 6, 'dossiers de démonstration présents');
  const nums = all.map((d) => d.numero);
  assert.equal(new Set(nums).size, nums.length, 'numéros uniques');
  assert.ok(nums.every((n) => /^ARCEP-\d{4}-\d{6}$/.test(n)), 'format ARCEP-AAAA-NNNNNN');
  assert.ok(all.some((d) => d.statut === 'CLOS'), 'un parcours complet est clos');
  assert.ok(all.some((d) => d.statut === 'EN_ARBITRAGE_SE'), 'un dossier attend le SE');
});

test('workflow : parcours complet TARIF — avis, visa, décision SE, notification et clôture automatiques', () => {
  const d = wf.deposer({ typeId: 'TARIF', objet: 'Test — révision tarifaire de bout en bout', demandeur: { categorie: 'OPERATEUR', nom: 'Moov', operatorId: 'moov' } }, 'test');
  assert.equal(d.statut, 'ENREGISTRE', 'accusé + enregistrement immédiats (RG-01)');
  wf.executer(d.id, 'COMPLETUDE_OK', {}, SE);
  wf.executer(d.id, 'QUALIFIER', { instructeur: 'ag-dm' }, SE);
  assert.equal(wf.get(d.id).statut, 'EN_INSTRUCTION');
  wf.executer(d.id, 'TRANSMETTRE_AVIS', { rapport: 'Rapport de test' }, DM);
  assert.equal(wf.get(d.id).statut, 'EN_AVIS');
  wf.executer(d.id, 'RENDRE_AVIS', { sens: 'FAVORABLE', motivation: 'ok' }, DJ);
  wf.executer(d.id, 'RENDRE_AVIS', { sens: 'FAVORABLE', motivation: 'ok' }, DFC);
  assert.equal(wf.get(d.id).statut, 'EN_VALIDATION', 'tous avis favorables → visa attendu');
  wf.executer(d.id, 'VISER', {}, DM);
  assert.equal(wf.get(d.id).statut, 'EN_ARBITRAGE_SE');
  wf.executer(d.id, 'DECIDER_SE', { sens: 'ADOPTE', motivation: 'ok' }, SE);
  const done = wf.get(d.id);
  assert.equal(done.statut, 'CLOS', 'décision → notification → publication → clôture en un enchaînement');
  assert.equal(done.decision.sens, 'ADOPTE');
  assert.ok(done.decision.signature.startsWith('ECDSA-SIM:'), 'acte signé');
  assert.ok(done.suivi.some((s) => s.action === 'PUBLICATION'), 'type publiable → publication tracée');
});

test('workflow : un avis avec réserves renvoie en instruction ; un type CR exige la délibération', () => {
  const d = wf.deposer({ typeId: 'DIFFEREND', objet: 'Test — différend interconnexion', demandeur: { categorie: 'OPERATEUR', nom: 'Moov', operatorId: 'moov' } }, 'test');
  wf.executer(d.id, 'COMPLETUDE_OK', {}, SE);
  wf.executer(d.id, 'QUALIFIER', {}, SE);
  wf.executer(d.id, 'TRANSMETTRE_AVIS', { rapport: 'r1' }, DM);
  wf.executer(d.id, 'RENDRE_AVIS', { sens: 'FAVORABLE_AVEC_RESERVES', motivation: 'à compléter' }, DJ);
  assert.equal(wf.get(d.id).statut, 'EN_INSTRUCTION', 'réserves → retour instruction (§7)');
  wf.executer(d.id, 'TRANSMETTRE_AVIS', { rapport: 'r2 corrigé' }, DM);
  wf.executer(d.id, 'RENDRE_AVIS', { sens: 'FAVORABLE', motivation: 'ok' }, DJ);
  wf.executer(d.id, 'VISER', {}, DM);
  wf.executer(d.id, 'DECIDER_SE', { sens: 'ADOPTE' }, SE);
  assert.equal(wf.get(d.id).statut, 'EN_DELIBERATION_CR', 'type à décision CR : le SE ne peut pas conclure seul');
  assert.throws(() => wf.executer(d.id, 'DELIBERER_CR', { sens: 'ADOPTE' }, SE), /Conseil de Régulation/);
  wf.executer(d.id, 'DELIBERER_CR', { sens: 'REJETE', motivation: 'non fondé' }, CR);
  assert.equal(wf.get(d.id).statut, 'CLOS');
  assert.equal(wf.get(d.id).decision.sens, 'REJETE');
});

test('workflow : gardes de rôles — avis réservé à la direction sollicitée, qualification au SE', () => {
  const d = wf.deposer({ typeId: 'TARIF', objet: 'Test — gardes de rôles', demandeur: { categorie: 'OPERATEUR', nom: 'x' } }, 'test');
  wf.executer(d.id, 'COMPLETUDE_OK', {}, SE);
  assert.throws(() => wf.executer(d.id, 'QUALIFIER', {}, DRH), /Secrétariat Exécutif/);
  wf.executer(d.id, 'QUALIFIER', {}, SE);
  wf.executer(d.id, 'TRANSMETTRE_AVIS', { rapport: 'r' }, DM);
  assert.throws(() => wf.executer(d.id, 'RENDRE_AVIS', { sens: 'FAVORABLE' }, DRH), /Aucun avis attendu de la direction/);
});

test('workflow : la suspension pour complément arrête l\'horloge SLA (RG-10)', () => {
  const d = wf.deposer({ typeId: 'HOMOLOGATION', objet: 'Test — suspension SLA', demandeur: { categorie: 'OPERATEUR', nom: 'x' } }, 'test');
  wf.executer(d.id, 'COMPLETUDE_OK', {}, SE);
  wf.executer(d.id, 'QUALIFIER', {}, SE);
  const before = wf.slaInfo(wf.get(d.id)).echeance;
  wf.executer(d.id, 'DEMANDER_COMPLEMENT', { note: 'pièce manquante' }, { username: 'dhqr', role: 'DIRECTEUR', direction: 'DHQR' });
  const raw = wf.get(d.id);
  raw.suspenduDepuis -= 5 * 86_400_000; // simule 5 jours d'attente demandeur
  wf.executer(d.id, 'COMPLEMENT_RECU', { note: 'pièce reçue' }, { username: 'dhqr', role: 'DIRECTEUR', direction: 'DHQR' });
  const after = wf.slaInfo(wf.get(d.id)).echeance;
  assert.ok(after - before >= 5 * 86_400_000 - 1000, 'l\'échéance est décalée du temps suspendu');
});

test('workflow : cloisonnement RG-16 — un opérateur ne voit que ses dossiers, une direction son périmètre', () => {
  const mineOp = wf.list(OPERATEUR);
  assert.ok(mineOp.length >= 1, 'l\'opérateur voit son dossier tarifaire');
  assert.ok(mineOp.every((d) => (d.demandeur || {}).operatorId === 'airtel'));
  const dj = wf.list(DJ);
  assert.ok(dj.every((d) => d.directionPilote === 'DJ' || (d.avis || []).some((a) => a.direction === 'DJ') || (d.demandeur || {}).direction === 'DJ'));
  const drh = wf.list(DRH);
  assert.equal(drh.length, 0, 'DRH sans dossier : rien à voir');
});

test('workflow : corbeilles — le SE voit l\'arbitrage en attente, la DJ voit ses avis attendus', () => {
  const corbSE = wf.corbeille(SE);
  assert.ok(corbSE.some((d) => d.actions.includes('DECIDER_SE')), 'corbeille SE : décision attendue');
  const corbDJ = wf.corbeille(DJ);
  assert.ok(corbDJ.some((d) => d.actions.includes('RENDRE_AVIS')), 'corbeille DJ : avis attendu (dossier tarifaire ensemencé)');
});

test('workflow : SLA — le dossier ensemencé en retard porte le drapeau EN_RETARD et les stats le comptent', () => {
  const all = wf.list(SE);
  const late = all.filter((d) => d.sla.enRetard);
  assert.ok(late.length >= 1, 'au moins un dossier en retard (ensemencement)');
  assert.equal(wf.stats(SE).enRetard, late.length);
});

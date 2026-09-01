'use strict';

// =============================================================================
// Module M15 — Moteur de workflow de gestion des dossiers (standard BPM ARCEP).
// Implémente le « Standard BPM de gestion des dossiers » (document rapatrié dans
// le projet ARCEP-Administration-digital, docs/03-processus/) sur le socle existant :
//   - RÉFÉRENTIEL des types de dossiers (couloir, direction pilote, avis requis,
//     niveau de décision, SLA, pièces exigées) — §3 du standard ;
//   - MACHINE À ÉTATS des statuts (§7) avec transitions gardées par rôle ;
//   - CORBEILLES par acteur (à qualifier, à instruire, avis attendus, arbitrage
//     SE, délibération CR) ;
//   - SLA avec suspension d'horloge pendant les compléments (RG-10), alertes à
//     80 % et escalade à 100 % (RG-11) ;
//   - SUIVI : chaque transition est journalisée dans le dossier ET au journal
//     d'audit chaîné de la plateforme (RG-15).
// PROTOTYPE : dossiers persistés dans data/dossiers.json ; ensemencement de
// démonstration au premier démarrage.
// =============================================================================

const path = require('path');
const fs = require('fs');
const store = require('./store');
const audit = require('./audit');
const logger = require('./logger');

const FILE = path.join(store.DATA_DIR, 'dossiers.json');
// Dépôt de pièces : un répertoire par dossier, des fichiers nommés par leur
// identifiant — jamais par le nom fourni (le nom d'un fichier téléversé est une
// donnée, pas un chemin).
const PIECES_DIR = path.join(store.DATA_DIR, 'pieces');
const PIECE_MAX_OCTETS = Number(process.env.SUMO_PIECE_MAX_OCTETS) || 4 * 1024 * 1024;
const PIECES_MAX_PAR_DOSSIER = 40;
const PIECE_MIMES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Référentiel des types (§3 du standard) — paramétrage, pas du code.
// ---------------------------------------------------------------------------
const TYPES = [
  { id: 'LICENCE', label: 'Demande de licence / autorisation', couloir: 'OPERATEUR', pilote: 'DRRRS', avis: ['DJ', 'DFC', 'DM'], decision: 'CR', slaJours: 60, publication: true,
    pieces: ['Statuts de la société', 'Plan d\'affaires', 'Descriptif technique du réseau', 'Justificatif des frais de dossier'] },
  { id: 'FREQUENCES', label: 'Assignation / renouvellement de fréquences', couloir: 'OPERATEUR', pilote: 'DRRRS', avis: ['DJ', 'DFC'], decision: 'SE', slaJours: 45, publication: true,
    pieces: ['Licence en cours de validité', 'Plan de fréquences demandé', 'Étude de compatibilité'] },
  { id: 'HOMOLOGATION', label: 'Homologation d\'équipement', couloir: 'OPERATEUR', pilote: 'DHQR', avis: [], decision: 'SE', slaJours: 30, publication: true,
    pieces: ['Fiche technique constructeur', 'Certificats de conformité', 'Échantillon ou rapport d\'essai'] },
  { id: 'TARIF', label: 'Approbation tarifaire / offre de référence', couloir: 'OPERATEUR', pilote: 'DM', avis: ['DJ', 'DFC'], decision: 'SE', slaJours: 30, publication: true,
    pieces: ['Grille tarifaire proposée', 'Note de justification économique'] },
  { id: 'DIFFEREND', label: 'Différend entre opérateurs', couloir: 'OPERATEUR', pilote: 'DM', avis: ['DJ'], decision: 'CR', slaJours: 90, publication: true,
    pieces: ['Saisine motivée', 'Pièces contractuelles', 'Correspondances préalables'] },
  { id: 'RECLAMATION', label: 'Réclamation consommateur', couloir: 'PUBLIC', pilote: 'DDSU', avis: [], decision: 'SE', slaJours: 30, publication: false,
    pieces: ['Description du litige', 'Références client (factures, échanges)'] },
  { id: 'SANCTION', label: 'Procédure de sanction (constat d\'infraction)', couloir: 'INTERNE', pilote: 'DCTLF', avis: ['DJ'], decision: 'CR', slaJours: 60, publication: true,
    pieces: ['Constat / rapport de contrôle', 'Mise en demeure préalable'] },
  { id: 'SAISINE_INTERNE', label: 'Saisine inter-directions', couloir: 'INTERNE', pilote: null, avis: [], decision: 'DIRECTION', slaJours: 15, publication: false,
    pieces: ['Note de saisine'] },
  { id: 'ENGAGEMENT_DEPENSE', label: 'Engagement de dépense', couloir: 'INTERNE', pilote: 'DFC', avis: ['DCBA'], decision: 'SE', slaJours: 20, publication: false,
    pieces: ['Expression de besoin', 'Devis / projet de marché', 'Disponibilité budgétaire'] },
];
const typeById = new Map(TYPES.map((t) => [t.id, t]));

const STATUTS = ['DEPOSE', 'ENREGISTRE', 'INCOMPLET', 'CLASSE_SANS_SUITE', 'RECEVABLE', 'EN_INSTRUCTION',
  'SUSPENDU_COMPLEMENT', 'EN_AVIS', 'EN_VALIDATION', 'EN_ARBITRAGE_SE', 'EN_DELIBERATION_CR',
  'ADOPTE', 'REJETE', 'NOTIFIE', 'PUBLIE', 'CLOS', 'RETIRE'];
const PRIORITES = ['NORMALE', 'HAUTE', 'URGENTE'];
const FINALS = new Set(['CLASSE_SANS_SUITE', 'CLOS', 'RETIRE']);

// ---------------------------------------------------------------------------
// Rôles (gardes de transitions) — calculés sur la session de la plateforme.
// ---------------------------------------------------------------------------
const isSE = (u) => !!u && (['SE', 'SE_ADJOINT'].includes(u.role) || ['SE', 'SEA1', 'SEA2'].includes(u.direction));
const isCR = (u) => !!u && (['PRESIDENT', 'CONSEILLER'].includes(u.role) || ['CR', 'PCR'].includes(u.direction));
const isGouvernance = (u) => !!u && (isSE(u) || isCR(u) || ['CABINET', 'SECRETARIAT_CABINET'].includes(u.role) || ['CAB'].includes(u.direction));
const inDirection = (u, dir) => !!u && !!dir && u.direction === dir;

// ---------------------------------------------------------------------------
// État persisté
// ---------------------------------------------------------------------------
let state = { seq: 0, dossiers: [] };
const persist = () => store.writeJson(FILE, state, 'workflow');

function numero() {
  state.seq += 1;
  return `ARCEP-${new Date().getFullYear()}-${String(state.seq).padStart(6, '0')}`;
}

function get(id) { return state.dossiers.find((d) => d.id === id || d.numero === id) || null; }

function trace(d, action, acteur, de, vers, note) {
  d.suivi.push({ epoch: Date.now(), action, acteur: acteur || 'systeme', de, vers, note: note || null });
  d.statut = vers || d.statut;
  d.majLe = new Date().toISOString();
  audit.record({ action: `WF_${action}`, actor: acteur || 'systeme', target: d.numero, meta: { de, vers } });
}

// Échéance SLA : point de départ = recevabilité (à défaut dépôt), décalée des
// suspensions imputables au demandeur (RG-10).
function echeance(d) {
  const t = typeById.get(d.typeId);
  const start = d.dates.recevabilite || d.dates.depot;
  if (!start || !t) return null;
  return start + t.slaJours * DAY + (d.suspenduMs || 0);
}
function slaInfo(d) {
  const due = echeance(d);
  if (!due || FINALS.has(d.statut) || ['ADOPTE', 'REJETE', 'NOTIFIE', 'PUBLIE'].includes(d.statut)) {
    return { echeance: due, enRetard: false, alerte80: false, restantJours: null };
  }
  const now = Date.now();
  const t = typeById.get(d.typeId);
  const total = t.slaJours * DAY + (d.suspenduMs || 0);
  const consomme = now - (d.dates.recevabilite || d.dates.depot) - (d.statut === 'SUSPENDU_COMPLEMENT' ? 0 : 0);
  return {
    echeance: due,
    enRetard: now > due && d.statut !== 'SUSPENDU_COMPLEMENT',
    alerte80: now <= due && consomme > 0.8 * total,
    restantJours: Math.ceil((due - now) / DAY),
  };
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------
function deposer({ typeId, objet, demandeur, couloir, directionSaisie, priorite }, acteur) {
  const t = typeById.get(typeId);
  if (!t) throw new Error(`Type de dossier inconnu : ${typeId}`);
  if (!objet || String(objet).trim().length < 5) throw new Error('Objet du dossier requis (5 caractères minimum).');
  const now = Date.now();
  const d = {
    id: 'D' + now.toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    numero: numero(),
    typeId, couloir: couloir || t.couloir,
    objet: String(objet).slice(0, 300),
    demandeur: demandeur || { categorie: 'INTERNE', nom: acteur || 'inconnu' },
    priorite: PRIORITES.includes(priorite) ? priorite : 'NORMALE',
    directionPilote: t.pilote || directionSaisie || null,
    instructeur: null,
    statut: 'DEPOSE',
    piecesAttendues: t.pieces.slice(),
    piecesFournies: [],
    avis: [], // { direction, statut: ATTENDU|FAVORABLE|FAVORABLE_AVEC_RESERVES|DEFAVORABLE, motivation, par, epoch }
    decision: null,
    suspenduMs: 0,
    suspenduDepuis: null,
    dates: { depot: now, recevabilite: null, decision: null, cloture: null },
    creeLe: new Date().toISOString(), majLe: new Date().toISOString(),
    suivi: [],
    drapeaux: [],
  };
  state.dossiers.unshift(d);
  trace(d, 'DEPOT', acteur, null, 'DEPOSE', `${t.label} — accusé de réception ${d.numero}`);
  trace(d, 'ENREGISTREMENT', 'guichet-numerique', 'DEPOSE', 'ENREGISTRE', 'Numéro attribué, accusé transmis');
  persist();
  return d;
}

function completude(id, { complet, piecesManquantes }, acteur) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (d.statut !== 'ENREGISTRE' && d.statut !== 'INCOMPLET') throw new Error(`Complétude impossible au statut ${d.statut}`);
  if (complet) {
    d.dates.recevabilite = Date.now();
    trace(d, 'RECEVABILITE', acteur, d.statut, 'RECEVABLE', 'Dossier complet — recevabilité prononcée');
  } else {
    trace(d, 'COMPLEMENT_DEMANDE', acteur, d.statut, 'INCOMPLET',
      `Demande de complément unique (RG-02) : ${(piecesManquantes || []).join(' ; ') || 'pièces à préciser'} — délai 15 j`);
  }
  persist(); return d;
}

function recevoirComplement(id, note, acteur) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (d.statut === 'INCOMPLET') { trace(d, 'COMPLEMENT_RECU', acteur, 'INCOMPLET', 'ENREGISTRE', note); }
  else if (d.statut === 'SUSPENDU_COMPLEMENT') {
    d.suspenduMs += Date.now() - (d.suspenduDepuis || Date.now());
    d.suspenduDepuis = null;
    trace(d, 'COMPLEMENT_RECU', acteur, 'SUSPENDU_COMPLEMENT', 'EN_INSTRUCTION', note);
  } else throw new Error(`Aucun complément attendu au statut ${d.statut}`);
  persist(); return d;
}

function classerSansSuite(id, motif, acteur) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (d.statut !== 'INCOMPLET') throw new Error('Le classement sans suite ne vise que les dossiers incomplets à échéance (RG-03)');
  d.dates.cloture = Date.now();
  trace(d, 'CLASSEMENT', acteur, d.statut, 'CLASSE_SANS_SUITE', motif || 'Délai de complément échu sans réponse');
  archiver(d);
  persist(); return d;
}

function qualifier(id, { typeId, directionPilote, instructeur, priorite }, user) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (d.statut !== 'RECEVABLE') throw new Error(`Qualification impossible au statut ${d.statut}`);
  if (!isSE(user) && !isGouvernance(user)) throw new Error('La confirmation de qualification relève du Secrétariat Exécutif (RG-04)');
  if (typeId && typeById.has(typeId)) d.typeId = typeId;
  if (directionPilote) d.directionPilote = directionPilote;
  if (!d.directionPilote) throw new Error('Une direction pilote doit être désignée (RG-05)');
  if (priorite && PRIORITES.includes(priorite)) d.priorite = priorite;
  d.instructeur = instructeur || d.instructeur || null;
  trace(d, 'QUALIFICATION', user.username, 'RECEVABLE', 'EN_INSTRUCTION',
    `Type ${d.typeId} · pilote ${d.directionPilote} · priorité ${d.priorite}`);
  persist(); return d;
}

function demanderComplementInstruction(id, note, user) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (d.statut !== 'EN_INSTRUCTION') throw new Error(`Suspension impossible au statut ${d.statut}`);
  if (!inDirection(user, d.directionPilote) && !isSE(user)) throw new Error('Réservé à la direction pilote');
  d.suspenduDepuis = Date.now();
  trace(d, 'SUSPENSION', user.username, 'EN_INSTRUCTION', 'SUSPENDU_COMPLEMENT', note || 'Complément demandé — horloge SLA suspendue (RG-10)');
  persist(); return d;
}

function transmettrePourAvis(id, rapport, user) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (d.statut !== 'EN_INSTRUCTION') throw new Error(`Transmission impossible au statut ${d.statut}`);
  if (!inDirection(user, d.directionPilote) && !isSE(user)) throw new Error('Réservé à la direction pilote');
  const t = typeById.get(d.typeId);
  d.rapport = String(rapport || '').slice(0, 2000) || 'Rapport d\'instruction versé au dossier';
  if (t.avis.length === 0) {
    trace(d, 'TRANSMISSION', user.username, 'EN_INSTRUCTION', 'EN_VALIDATION', 'Aucun avis requis — visa direction attendu');
  } else {
    d.avis = t.avis.map((dir) => ({ direction: dir, statut: 'ATTENDU', motivation: null, par: null, epoch: null }));
    trace(d, 'TRANSMISSION', user.username, 'EN_INSTRUCTION', 'EN_AVIS', `Avis sollicités en parallèle (RG-09) : ${t.avis.join(', ')}`);
  }
  persist(); return d;
}

function rendreAvis(id, { sens, motivation }, user) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (d.statut !== 'EN_AVIS') throw new Error(`Aucun avis attendu au statut ${d.statut}`);
  const mine = d.avis.find((a) => a.direction === user.direction && a.statut === 'ATTENDU');
  if (!mine) throw new Error(`Aucun avis attendu de la direction ${user.direction || '—'} sur ce dossier`);
  if (!['FAVORABLE', 'FAVORABLE_AVEC_RESERVES', 'DEFAVORABLE'].includes(sens)) throw new Error('Sens d\'avis invalide');
  mine.statut = sens; mine.motivation = String(motivation || '').slice(0, 1000); mine.par = user.username; mine.epoch = Date.now();
  trace(d, 'AVIS', user.username, 'EN_AVIS', 'EN_AVIS', `${user.direction} : ${sens}`);
  const pending = d.avis.some((a) => a.statut === 'ATTENDU');
  if (!pending) {
    const blocking = d.avis.some((a) => a.statut !== 'FAVORABLE');
    if (blocking) trace(d, 'RETOUR_INSTRUCTION', 'systeme', 'EN_AVIS', 'EN_INSTRUCTION', 'Réserves ou avis défavorable — retour en instruction (§7)');
    else trace(d, 'AVIS_COMPLETS', 'systeme', 'EN_AVIS', 'EN_VALIDATION', 'Tous les avis favorables — visa direction attendu');
  }
  persist(); return d;
}

function viser(id, user) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (d.statut !== 'EN_VALIDATION') throw new Error(`Visa impossible au statut ${d.statut}`);
  if (!inDirection(user, d.directionPilote) && !isSE(user)) throw new Error('Le visa relève du directeur de la direction pilote');
  trace(d, 'VISA', user.username, 'EN_VALIDATION', 'EN_ARBITRAGE_SE', 'Projet d\'acte visé — transmis au Secrétariat Exécutif');
  persist(); return d;
}

function deciderSE(id, { sens, motivation }, user) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (d.statut !== 'EN_ARBITRAGE_SE') throw new Error(`Décision impossible au statut ${d.statut}`);
  if (!isSE(user)) throw new Error('La décision à ce stade relève du Secrétariat Exécutif');
  const t = typeById.get(d.typeId);
  if (sens === 'RENVOI') { trace(d, 'RENVOI', user.username, d.statut, 'EN_INSTRUCTION', motivation || 'Complément d\'instruction demandé'); }
  else if (t.decision === 'CR' || sens === 'TRANSMISSION_CR') {
    trace(d, 'INSCRIPTION_CR', user.username, d.statut, 'EN_DELIBERATION_CR', 'Inscription à l\'ordre du jour du Conseil de Régulation (via CAB)');
  } else if (sens === 'ADOPTE' || sens === 'REJETE') {
    conclure(d, sens, motivation, user.username, 'SE');
  } else throw new Error('Sens de décision invalide (ADOPTE, REJETE, RENVOI, TRANSMISSION_CR)');
  persist(); return d;
}

function delibererCR(id, { sens, motivation }, user) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (d.statut !== 'EN_DELIBERATION_CR') throw new Error(`Délibération impossible au statut ${d.statut}`);
  if (!isCR(user)) throw new Error('La délibération relève du Conseil de Régulation');
  if (sens === 'AJOURNE') { trace(d, 'AJOURNEMENT', user.username, d.statut, 'EN_INSTRUCTION', motivation || 'Ajournement — complément demandé'); }
  else if (sens === 'ADOPTE' || sens === 'REJETE') conclure(d, sens, motivation, user.username, 'CR');
  else throw new Error('Sens de délibération invalide (ADOPTE, REJETE, AJOURNE)');
  persist(); return d;
}

// Décision → signature électronique simulée → notification → publication →
// clôture : enchaînement unique et automatique (principe 7 du standard).
function conclure(d, sens, motivation, acteur, niveau) {
  const t = typeById.get(d.typeId);
  d.dates.decision = Date.now();
  d.decision = {
    niveau, sens, motivation: String(motivation || '').slice(0, 1000),
    signature: `ECDSA-SIM:${d.numero}:${sens}:${Date.now().toString(36)}`,
    signataire: acteur,
  };
  trace(d, 'DECISION', acteur, d.statut, sens, `${niveau} — ${sens}${motivation ? ' : ' + motivation : ''}`);
  trace(d, 'NOTIFICATION', 'guichet-numerique', sens, 'NOTIFIE', 'Notification transmise au demandeur (preuve conservée)');
  if (t.publication) trace(d, 'PUBLICATION', 'guichet-numerique', 'NOTIFIE', 'PUBLIE', 'Publié au registre public');
  d.dates.cloture = Date.now();
  trace(d, 'CLOTURE', 'systeme', t.publication ? 'PUBLIE' : 'NOTIFIE', 'CLOS', 'Archivage légal');
  archiver(d);
}

// ARCHIVAGE ÉLECTRONIQUE : à toute entrée dans un statut terminal, l'instantané
// intégral du dossier (suivi complet, avis, décision, empreintes des pièces) est
// scellé au registre des archives — chaîné et signé comme les TDR. La ligne
// « Archivage légal » cesse d'être une formule : elle désigne un enregistrement
// cryptographique vérifiable, référencé dans le suivi lui-même.
function archiver(d) {
  try {
    const t = typeById.get(d.typeId) || {};
    const scelle = require('./archives').seal(d, t.label);
    if (scelle) {
      trace(d, 'ARCHIVE_SCELLEE', 'systeme', d.statut, d.statut,
        `Archive électronique n°${scelle.seq} — ${scelle.hash.slice(0, 16)}… (ECDSA P-256)`);
    }
  } catch (e) { logger.error('workflow.archive.failed', { numero: d.numero, error: e.message }); }
}

// ---------------------------------------------------------------------------
// Pièces du dossier — le versement ÉLECTRONIQUE qui rend le processus
// intégralement numérique : le document entre au guichet AVEC le dossier, pas
// par un canal parallèle (courriel, papier) qui échapperait au suivi.
// Chaque versement est haché (SHA-256), horodaté, imputé, tracé au dossier ET au
// journal d'audit ; l'empreinte rejoint l'archive scellée à la clôture.
// ---------------------------------------------------------------------------
const PIECE_STATUTS = new Set(['DEPOSE', 'ENREGISTRE', 'INCOMPLET', 'RECEVABLE', 'EN_INSTRUCTION', 'SUSPENDU_COMPLEMENT', 'EN_AVIS', 'EN_VALIDATION']);

// Qui verse : le DEMANDEUR (la charge de la preuve est la sienne), la direction
// pilote et le SE (pièces d'instruction : rapports, constats).
function peutVerser(d, user) {
  if (!user) return false;
  if (user.operatorId) return d.demandeur && d.demandeur.operatorId === user.operatorId;
  return inDirection(user, d.directionPilote) || isSE(user)
    || (d.demandeur && d.demandeur.direction && user.direction === d.demandeur.direction);
}

function verserPiece(id, { nom, mime, base64 }, user) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (!visible(d, user)) throw new Error('Dossier introuvable');
  if (!PIECE_STATUTS.has(d.statut)) throw new Error(`Versement impossible au statut ${d.statut} : le dossier n'accepte plus de pièces.`);
  if (!peutVerser(d, user)) throw new Error('Versement réservé au demandeur, à la direction pilote et au Secrétariat Exécutif.');

  const nomPropre = String(nom || '').trim().slice(0, 120);
  if (nomPropre.length < 3) throw new Error('Nom de la pièce requis (3 caractères minimum).');
  const type = String(mime || 'application/pdf');
  if (!PIECE_MIMES.has(type)) throw new Error(`Format non admis : ${type}. Formats acceptés : PDF, PNG, JPEG, DOCX, XLSX, TXT, CSV.`);

  const contenu = Buffer.from(String(base64 || ''), 'base64');
  if (!contenu.length) throw new Error('Pièce vide ou contenu illisible (base64 attendu).');
  if (contenu.length > PIECE_MAX_OCTETS) throw new Error(`Pièce trop volumineuse (${Math.round(contenu.length / 1024)} Ko > ${Math.round(PIECE_MAX_OCTETS / 1024)} Ko).`);
  if ((d.piecesFournies || []).length >= PIECES_MAX_PAR_DOSSIER) throw new Error(`Plafond de ${PIECES_MAX_PAR_DOSSIER} pièces atteint.`);

  const pieceId = 'P' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const sha256 = require('crypto').createHash('sha256').update(contenu).digest('hex');
  fs.mkdirSync(path.join(PIECES_DIR, d.id), { recursive: true });
  fs.writeFileSync(path.join(PIECES_DIR, d.id, pieceId), contenu, { mode: 0o600 });

  const meta = {
    id: pieceId, nom: nomPropre, mime: type, octets: contenu.length, sha256,
    versePar: user.username, categorie: user.operatorId ? 'DEMANDEUR' : 'INSTRUCTION',
    epoch: Date.now(),
  };
  d.piecesFournies = d.piecesFournies || [];
  d.piecesFournies.push(meta);
  trace(d, 'VERSEMENT_PIECE', user.username, d.statut, d.statut,
    `« ${nomPropre} » (${Math.round(contenu.length / 1024)} Ko, SHA-256 ${sha256.slice(0, 12)}…)`);
  persist();
  return { dossier: d, piece: meta };
}

// Restitue une pièce en revérifiant son empreinte : un fichier qui ne correspond
// plus au versement est une altération — on refuse de le servir plutôt que de
// livrer un faux sous un nom authentique.
function lirePiece(id, pieceId, user) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (!visible(d, user)) throw new Error('Dossier introuvable');
  const meta = (d.piecesFournies || []).find((p) => p.id === pieceId);
  if (!meta) throw new Error('Pièce introuvable.');
  const contenu = fs.readFileSync(path.join(PIECES_DIR, d.id, meta.id));
  const empreinte = require('crypto').createHash('sha256').update(contenu).digest('hex');
  if (empreinte !== meta.sha256) {
    throw new Error(`ALTÉRATION DÉTECTÉE : l'empreinte de « ${meta.nom} » ne correspond plus au versement (attendu ${meta.sha256.slice(0, 12)}…, constaté ${empreinte.slice(0, 12)}…).`);
  }
  return { meta, contenu };
}

function retirer(id, user) {
  const d = get(id); if (!d) throw new Error('Dossier introuvable');
  if (!['ENREGISTRE', 'RECEVABLE', 'INCOMPLET', 'EN_INSTRUCTION'].includes(d.statut)) throw new Error(`Retrait impossible au statut ${d.statut}`);
  d.dates.cloture = Date.now();
  trace(d, 'RETRAIT', user.username, d.statut, 'RETIRE', 'Retrait à la demande du demandeur');
  archiver(d);
  persist(); return d;
}

// ---------------------------------------------------------------------------
// Visibilité (RG-16) & corbeilles
// ---------------------------------------------------------------------------
function visible(d, user) {
  if (!user) return false;
  if (isGouvernance(user) || user.role === 'ADMIN_SYSTEME') return true;
  if (user.operatorId) return d.demandeur && d.demandeur.operatorId === user.operatorId;
  if (user.direction) {
    return d.directionPilote === user.direction
      || (d.avis || []).some((a) => a.direction === user.direction)
      || (d.demandeur && d.demandeur.direction === user.direction);
  }
  return false;
}

// Actions offertes à CETTE session sur CE dossier — l'interface ne devine rien.
function allowedActions(d, user) {
  const out = [];
  const pilote = inDirection(user, d.directionPilote) || isSE(user);
  if ((d.statut === 'ENREGISTRE' || d.statut === 'INCOMPLET') && (pilote || isGouvernance(user))) {
    if (d.statut === 'ENREGISTRE') out.push('COMPLETUDE_OK', 'COMPLETUDE_KO');
    if (d.statut === 'INCOMPLET') out.push('COMPLEMENT_RECU', 'CLASSER_SANS_SUITE');
  }
  if (d.statut === 'RECEVABLE' && (isSE(user) || isGouvernance(user))) out.push('QUALIFIER');
  if (d.statut === 'EN_INSTRUCTION' && pilote) out.push('TRANSMETTRE_AVIS', 'DEMANDER_COMPLEMENT');
  if (d.statut === 'SUSPENDU_COMPLEMENT' && pilote) out.push('COMPLEMENT_RECU');
  if (d.statut === 'EN_AVIS' && (d.avis || []).some((a) => a.direction === user.direction && a.statut === 'ATTENDU')) out.push('RENDRE_AVIS');
  if (d.statut === 'EN_VALIDATION' && pilote) out.push('VISER');
  if (d.statut === 'EN_ARBITRAGE_SE' && isSE(user)) out.push('DECIDER_SE');
  if (d.statut === 'EN_DELIBERATION_CR' && isCR(user)) out.push('DELIBERER_CR');
  if (['ENREGISTRE', 'RECEVABLE', 'INCOMPLET', 'EN_INSTRUCTION'].includes(d.statut)
    && user.operatorId && d.demandeur && d.demandeur.operatorId === user.operatorId) out.push('RETIRER');
  return out;
}

function toPublicDossier(d, user) {
  const t = typeById.get(d.typeId) || {};
  const sla = slaInfo(d);
  return {
    id: d.id, numero: d.numero, typeId: d.typeId, typeLabel: t.label, couloir: d.couloir,
    objet: d.objet, statut: d.statut, priorite: d.priorite,
    directionPilote: d.directionPilote, instructeur: d.instructeur,
    demandeur: d.demandeur, decision: d.decision, avis: d.avis, rapport: d.rapport || null,
    piecesAttendues: d.piecesAttendues || [],
    piecesFournies: (d.piecesFournies || []).map((p) => ({ id: p.id, nom: p.nom, mime: p.mime, octets: p.octets, sha256: p.sha256, versePar: p.versePar, categorie: p.categorie, epoch: p.epoch })),
    archive: require('./archives').isArchived(d.numero),
    dates: d.dates, sla, drapeaux: sla.enRetard ? ['EN_RETARD'] : (sla.alerte80 ? ['ALERTE_80'] : []),
    suivi: d.suivi.slice(-40),
    actions: user ? allowedActions(d, user) : [],
  };
}

function list(user, { statut, typeId } = {}) {
  return state.dossiers
    .filter((d) => visible(d, user))
    .filter((d) => !statut || d.statut === statut)
    .filter((d) => !typeId || d.typeId === typeId)
    .map((d) => toPublicDossier(d, user));
}

// Corbeille = dossiers où CETTE session a au moins une action à faire.
function corbeille(user) {
  return state.dossiers
    .filter((d) => visible(d, user))
    .map((d) => toPublicDossier(d, user))
    .filter((d) => d.actions.length > 0);
}

function stats(user) {
  const mine = state.dossiers.filter((d) => visible(d, user));
  const open = mine.filter((d) => !FINALS.has(d.statut));
  const closed = mine.filter((d) => d.dates.cloture && d.dates.recevabilite);
  const delais = closed.map((d) => Math.round((d.dates.cloture - d.dates.recevabilite - (d.suspenduMs || 0)) / DAY)).sort((a, b) => a - b);
  return {
    total: mine.length,
    encours: open.length,
    enRetard: open.filter((d) => slaInfo(d).enRetard).length,
    alerte80: open.filter((d) => slaInfo(d).alerte80).length,
    clos: closed.length,
    delaiMedianJours: delais.length ? delais[Math.floor((delais.length - 1) / 2)] : null,
    parStatut: STATUTS.map((s) => ({ statut: s, n: mine.filter((d) => d.statut === s).length })).filter((x) => x.n > 0),
  };
}

// ---------------------------------------------------------------------------
// Dispatch des actions (une seule route côté API)
// ---------------------------------------------------------------------------
// Point d'entrée UNIQUE des transitions. Correctif B4 : `allowedActions` était
// calculé pour l'interface mais JAMAIS appliqué côté serveur — quatre transitions
// (COMPLETUDE_*, COMPLEMENT_RECU, CLASSER_SANS_SUITE, RETIRER) ne vérifiaient que
// le statut, si bien qu'un assujetti pouvait prononcer la recevabilité de sa
// propre demande ou la classer sans suite par simple appel HTTP. La matrice
// statut × rôle fait désormais autorité, en un seul endroit.
function executer(id, action, params, user) {
  const d = get(id);
  if (!d) throw new Error('Dossier introuvable');
  if (!visible(d, user)) throw new Error('Dossier introuvable');
  const allowed = allowedActions(d, user);
  if (!allowed.includes(action)) {
    throw new Error(`Action « ${action} » non autorisée pour votre profil au statut ${d.statut}.`);
  }
  switch (action) {
    case 'COMPLETUDE_OK': return completude(id, { complet: true }, user.username);
    case 'COMPLETUDE_KO': return completude(id, { complet: false, piecesManquantes: params.piecesManquantes }, user.username);
    case 'COMPLEMENT_RECU': return recevoirComplement(id, params.note || 'Complément reçu du demandeur', user.username);
    case 'CLASSER_SANS_SUITE': return classerSansSuite(id, params.motif, user.username);
    case 'QUALIFIER': return qualifier(id, params, user);
    case 'DEMANDER_COMPLEMENT': return demanderComplementInstruction(id, params.note, user);
    case 'TRANSMETTRE_AVIS': return transmettrePourAvis(id, params.rapport, user);
    case 'RENDRE_AVIS': return rendreAvis(id, params, user);
    case 'VISER': return viser(id, user);
    case 'DECIDER_SE': return deciderSE(id, params, user);
    case 'DELIBERER_CR': return delibererCR(id, params, user);
    case 'RETIRER': return retirer(id, user);
    default: throw new Error(`Action inconnue : ${action}`);
  }
}

// ---------------------------------------------------------------------------
// Chargement + ensemencement de démonstration
// ---------------------------------------------------------------------------
function backdate(d, jours) {
  d.dates.depot -= jours * DAY;
  if (d.dates.recevabilite) d.dates.recevabilite -= jours * DAY;
  d.suivi.forEach((s) => { s.epoch -= jours * DAY; });
}

function seed() {
  const se = { username: 'se', role: 'SE', direction: 'SE' };
  const cr = { username: 'pcr', role: 'PRESIDENT', direction: 'PCR' };
  const drrrs = { username: 'drrrs', role: 'DIRECTEUR', direction: 'DRRRS' };
  const dm = { username: 'dm', role: 'DIRECTEUR', direction: 'DM' };
  const dj = { username: 'dj', role: 'DIRECTEUR', direction: 'DJ' };
  const dfc = { username: 'dfc', role: 'DIRECTEUR', direction: 'DFC' };

  // 1. Licence adoptée (parcours complet, sert d'exemple de bout en bout).
  let d = deposer({ typeId: 'LICENCE', objet: 'Licence de fournisseur d\'accès internet — Ogooué Télécom SA', demandeur: { categorie: 'OPERATEUR', nom: 'Ogooué Télécom SA' } }, 'extranet');
  completude(d.id, { complet: true }, 'guichet-numerique');
  qualifier(d.id, { instructeur: 'ag-drrrs' }, se);
  transmettrePourAvis(d.id, 'Dossier conforme au cahier des charges FAI ; couverture initiale Estuaire + Haut-Ogooué.', drrrs);
  rendreAvis(d.id, { sens: 'FAVORABLE', motivation: 'Conforme au cadre des autorisations' }, dj);
  rendreAvis(d.id, { sens: 'FAVORABLE', motivation: 'Frais et redevances provisionnés' }, dfc);
  rendreAvis(d.id, { sens: 'FAVORABLE', motivation: 'Pas d\'effet anticoncurrentiel' }, dm);
  viser(d.id, drrrs);
  deciderSE(d.id, { sens: 'TRANSMISSION_CR' }, se);
  delibererCR(d.id, { sens: 'ADOPTE', motivation: 'Délibération n°2026-014' }, cr);
  backdate(get(d.id), 40);

  // 2. Homologation en instruction (dans les délais).
  d = deposer({ typeId: 'HOMOLOGATION', objet: 'Homologation routeur LTE — modèle RX-4400', demandeur: { categorie: 'OPERATEUR', nom: 'ImportTech SARL' } }, 'extranet');
  completude(d.id, { complet: true }, 'guichet-numerique');
  qualifier(d.id, { instructeur: 'ag-dhqr' }, se);
  backdate(get(d.id), 8);

  // 3. Réclamation incomplète (attente demandeur).
  d = deposer({ typeId: 'RECLAMATION', objet: 'Prélèvements multiples non remboursés après échec de transfert', demandeur: { categorie: 'CITOYEN', nom: 'Usager portail (anonymisé)' } }, 'portail');
  completude(d.id, { complet: false, piecesManquantes: ['Référence de la transaction', 'Relevé du compte mobile money'] }, 'guichet-numerique');
  backdate(get(d.id), 10);

  // 4. Approbation tarifaire en avis — l'avis DJ est encore attendu.
  d = deposer({ typeId: 'TARIF', objet: 'Révision de l\'offre de référence interconnexion 2026', demandeur: { categorie: 'OPERATEUR', nom: 'Airtel Gabon', operatorId: 'airtel' } }, 'extranet');
  completude(d.id, { complet: true }, 'guichet-numerique');
  qualifier(d.id, { instructeur: 'ag-dm' }, se);
  transmettrePourAvis(d.id, 'Baisse de 12 % de la terminaison d\'appel ; impact concurrentiel favorable.', dm);
  rendreAvis(d.id, { sens: 'FAVORABLE', motivation: 'Cohérent avec la trajectoire tarifaire' }, dfc);
  backdate(get(d.id), 22);

  // 5. Sanction en arbitrage SE (corbeille du SE alimentée).
  d = deposer({ typeId: 'SANCTION', objet: 'Non-respect des obligations de couverture — mise en demeure n°2026-007', demandeur: { categorie: 'INTERNE', nom: 'DCTLF', direction: 'DCTLF' } }, 'dctlf');
  completude(d.id, { complet: true }, 'guichet-numerique');
  qualifier(d.id, { instructeur: 'ag-dctlf' }, se);
  transmettrePourAvis(d.id, 'Constats de carence sur 14 localités ; procédure contradictoire close.', { username: 'dctlf', role: 'DIRECTEUR', direction: 'DCTLF' });
  rendreAvis(d.id, { sens: 'FAVORABLE', motivation: 'Procédure régulière, sanction proportionnée' }, dj);
  viser(d.id, { username: 'dctlf', role: 'DIRECTEUR', direction: 'DCTLF' });
  backdate(get(d.id), 30);

  // 6. Engagement de dépense recevable, en retard (échéance dépassée — démontre l'escalade).
  d = deposer({ typeId: 'ENGAGEMENT_DEPENSE', objet: 'Acquisition de sondes de mesure QoS (phase 2 M14)', demandeur: { categorie: 'INTERNE', nom: 'DSIN', direction: 'DSIN' } }, 'intranet');
  completude(d.id, { complet: true }, 'guichet-numerique');
  backdate(get(d.id), 28);

  persist();
  logger.info('workflow.seed', { dossiers: state.dossiers.length });
}

function load() {
  const disk = store.readJson(FILE, null, 'workflow');
  if (disk && Array.isArray(disk.dossiers)) { state = { seq: disk.seq || disk.dossiers.length, dossiers: disk.dossiers }; }
  else { state = { seq: 0, dossiers: [] }; seed(); }
  return state.dossiers.length;
}

module.exports = {
  TYPES, STATUTS, PRIORITES, load, deposer, executer, get, list, corbeille, stats,
  verserPiece, lirePiece, peutVerser, PIECE_MAX_OCTETS,
  toPublicDossier, visible, allowedActions, slaInfo,
  _test: { completude, qualifier, transmettrePourAvis, rendreAvis, viser, deciderSE, delibererCR, recevoirComplement, demanderComplementInstruction, isSE, isCR },
};

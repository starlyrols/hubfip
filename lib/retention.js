'use strict';

// =============================================================================
// Conservation et EFFACEMENT (correctif P1 n°16 — constats D4 et F3).
//
// L'AIPD déposée à la CNPDCP annonce des durées de conservation (10 ans pour la
// donnée de transaction, 2 ans pour le nominatif) et des données « supprimées ou
// anonymisées » à l'échéance. Or le registre est APPEND-ONLY et chaîné : en
// retirer une ligne romprait la chaîne, donc la valeur probante de tout ce qui
// suit. L'engagement et l'architecture étaient structurellement incompatibles.
//
// La sortie n'est pas de renoncer à l'un ou à l'autre, mais l'EFFACEMENT
// CRYPTOGRAPHIQUE : chaque palier de chaque mois est chiffré par sa propre clé.
// À l'échéance, on détruit la clé. Les octets restent — la chaîne, les
// signatures et les reçus d'ancrage demeurent vérifiables — mais plus personne,
// exploitant compris, ne peut lire les identifiants. L'oubli devient possible
// sur un support qui ne sait pas oublier.
//
// Ce que la purge laisse subsister, et qu'il faut assumer devant l'autorité :
//   * les données de PALIER P1 (montant, type, canal, horodatage, opérateur),
//     qui ne portent aucun identifiant et relèvent de l'échéance longue ;
//   * la ville et la province, granularité déjà publiée dans les statistiques ;
//   * l'EMPREINTE HMAC du numéro, nécessaire au dédoublonnage — pseudonymisation
//     et non anonymisation. L'AIPD doit le formuler ainsi.
// =============================================================================

const logger = require('./logger');
const vault = require('./crypto-store');

const MOIS_MS = 30.44 * 86_400_000;

// Échéances, alignées sur l'AIPD et surchargeables par l'exploitation.
const POLITIQUE = Object.freeze({
  P2: {
    libelle: 'Identifiants nominatifs (MSISDN, portefeuilles, écritures, message ISO)',
    moisConservation: Number(process.env.SUMO_RETENTION_P2_MOIS) || 24,
    fondement: 'AIPD §7 — 2 ans pour les données nominatives',
  },
  P3: {
    libelle: 'Localisation précise (cellule, coordonnées)',
    moisConservation: Number(process.env.SUMO_RETENTION_P3_MOIS) || 24,
    fondement: 'AIPD §7 — la localisation suit le régime du nominatif',
  },
});

// Palier P1 : conservé, jamais chiffré par segment. Sa suppression physique
// suppose la segmentation du fichier de registre — étape d'industrialisation
// documentée, pas encore livrée. On l'énonce plutôt que de le laisser croire.
const P1_MOIS = Number(process.env.SUMO_RETENTION_P1_MOIS) || 120;

// La conservation court à partir de la FIN du mois : un enregistrement du 31 août
// ne doit pas être purgé plus tôt qu'un du 1er août.
const segmentFin = (segment) => {
  const [a, m] = String(segment).split('-').map(Number);
  return Date.UTC(a, m || 1, 1) - 1;
};

const echeance = (tier, segment) => segmentFin(segment) + POLITIQUE[tier].moisConservation * MOIS_MS;

// Segments dont l'échéance est atteinte et dont la clé vit encore.
function duePurges(now = Date.now()) {
  return vault.ringState()
    .filter((e) => e.active && POLITIQUE[e.tier])
    .map((e) => ({ ...e, echeance: echeance(e.tier, e.segment) }))
    .filter((e) => e.echeance <= now)
    .sort((a, b) => a.echeance - b.echeance);
}

// Exécute les purges dues. `dryRun` permet de présenter ce qui SERAIT détruit —
// une destruction irréversible mérite d'être annoncée avant d'être exécutée.
// `record` reçoit chaque destruction pour journalisation d'audit.
function runPurge({ now = Date.now(), dryRun = false, record = null, actor = 'systeme' } = {}) {
  const dues = duePurges(now);
  const resultats = [];
  for (const d of dues) {
    if (dryRun) { resultats.push({ ...d, statut: 'A_DETRUIRE' }); continue; }
    const r = vault.destroySegment(d.tier, d.segment);
    resultats.push({ ...d, ...r });
    if (r.statut === 'DETRUITE' && typeof record === 'function') {
      // La destruction est elle-même un acte à prouver : c'est ce qui permettra
      // de démontrer à la CNPDCP que l'échéance a bien été honorée.
      record({
        action: 'PURGE_SEGMENT', actor, role: 'SYSTEME', target: `${d.tier}:${d.segment}`,
        meta: { echeance: new Date(d.echeance).toISOString(), fondement: POLITIQUE[d.tier].fondement, destroyedAt: r.destroyedAt },
      });
    }
  }
  if (resultats.length && !dryRun) {
    logger.warn('retention.purge.done', { segments: resultats.length });
  }
  return { executeeLe: new Date(now).toISOString(), dryRun, segments: resultats };
}

// État présentable : politique, trousseau, prochaines échéances.
function state(now = Date.now()) {
  const anneaux = vault.ringState();
  const parPalier = {};
  for (const [tier, p] of Object.entries(POLITIQUE)) {
    const segs = anneaux.filter((e) => e.tier === tier);
    const prochaine = segs.filter((e) => e.active)
      .map((e) => ({ segment: e.segment, echeance: echeance(tier, e.segment) }))
      .sort((a, b) => a.echeance - b.echeance)[0] || null;
    parPalier[tier] = {
      ...p,
      segments: segs.length,
      actifs: segs.filter((e) => e.active).length,
      purges: segs.filter((e) => !e.active).length,
      prochaineEcheance: prochaine ? { segment: prochaine.segment, le: new Date(prochaine.echeance).toISOString() } : null,
    };
  }
  return {
    mecanisme: 'Effacement cryptographique par clé de segment (mois × palier)',
    politique: parPalier,
    palierP1: {
      libelle: 'Données de transaction (montant, type, canal, horodatage, opérateur)',
      moisConservation: P1_MOIS,
      mecanisme: 'Conservées en clair, non purgeables par clé.',
      limite: 'La suppression physique du palier P1 exige la segmentation du fichier de registre — étape d\'industrialisation non livrée.',
    },
    subsisteApresPurge: [
      'Palier P1 (aucun identifiant)',
      'Ville et province (granularité déjà publiée dans les statistiques)',
      'Empreinte HMAC du numéro — pseudonymisation, nécessaire au dédoublonnage',
    ],
    aPurger: duePurges(now).map((d) => ({ tier: d.tier, segment: d.segment, echeanceDepassee: new Date(d.echeance).toISOString() })),
    trousseau: anneaux,
  };
}

module.exports = { POLITIQUE, P1_MOIS, duePurges, runPurge, state, echeance };

'use strict';

// =============================================================================
// Registre des modules de la plateforme. Chaque volet du menu est un MODULE,
// sous-module du module parent « monitoring » (le SUMo historique). Le registre
// ne décrit que l'arbre : QUI voit QUOI est porté par les affectations
// (assignments.js), dispatchées par l'admin système. Un futur module hors
// Monitoring = une entrée { parent: null, assignable: true } + ses enfants.
// « aide » reste hors registre (volet universel, accessible à tous les profils).
// =============================================================================

const MODULES = [
  { id: 'monitoring', label: 'Monitoring', description: 'Supervision Unifiée du Mobile Money (SUMo) — l\'affecter équivaut à affecter tous ses sous-modules', parent: null, assignable: true },
  // Sous-modules : ids INCHANGÉS (les routes, renderers et tests en dépendent).
  // L'ordre reprend l'ancien ALL_MODULES — il fixe l'ordre des onglets côté client.
  { id: 'observatoire', label: 'Observatoire', section: 'Observatoire & marché', parent: 'monitoring', assignable: true },
  { id: 'operators', label: 'Opérateurs & moteurs', section: 'Observatoire & marché', parent: 'monitoring', assignable: true },
  { id: 'revenus', label: 'Revenus & redevances', section: 'Économie & qualité', parent: 'monitoring', assignable: true },
  { id: 'qos', label: 'Qualité de service', section: 'Économie & qualité', parent: 'monitoring', assignable: true },
  { id: 'antifraude', label: 'Antifraude / AML', section: 'Antifraude & enquête', parent: 'monitoring', assignable: true },
  { id: 'investigation', label: 'Investigation', section: 'Antifraude & enquête', parent: 'monitoring', assignable: true },
  { id: 'geo', label: 'Géolocalisation', section: 'Observatoire & marché', parent: 'monitoring', assignable: true },
  { id: 'analytics', label: 'Analytics / Risque', section: 'Antifraude & enquête', parent: 'monitoring', assignable: true },
  { id: 'connecteurs', label: 'Connecteurs / Collecte', section: 'Système', parent: 'monitoring', assignable: true },
  { id: 'registre', label: 'Registre (TDR)', section: 'Observatoire & marché', parent: 'monitoring', assignable: true },
  { id: 'reporting', label: 'Reporting réglementaire', section: 'Économie & qualité', parent: 'monitoring', assignable: true },
  { id: 'securite', label: 'Sécurité & audit', section: 'Système', parent: 'monitoring', assignable: true },
  { id: 'admin', label: 'Administration (config métier)', section: 'Système', parent: 'monitoring', assignable: true },
  // Extension M14 — supervision des services financiers numériques (couche
  // communications électroniques et postale ; périmètre P1–P7).
  { id: 'mesures', label: 'Mesure indépendante (N3)', section: 'Services financiers (M14)', parent: 'monitoring', assignable: true },
  { id: 'tiers', label: 'Accès des tiers (PSP)', section: 'Services financiers (M14)', parent: 'monitoring', assignable: true },
  { id: 'reclamations', label: 'Réclamations consommateurs', section: 'Services financiers (M14)', parent: 'monitoring', assignable: true },
  { id: 'postal', label: 'Services financiers postaux', section: 'Services financiers (M14)', parent: 'monitoring', assignable: true },
  // Module système : dérivé du rôle ADMIN_SYSTEME, jamais dispatchable — l'admin
  // ne peut donc ni le perdre ni le donner.
  { id: 'dispatch', label: 'Dispatch des modules', description: 'Affectation des modules aux directions et aux comptes', parent: null, assignable: false, system: true },
];

const byId = new Map(MODULES.map((m) => [m.id, m]));
const LEAF_MODULE_IDS = MODULES.filter((m) => m.parent === 'monitoring').map((m) => m.id);

const childrenOf = (id) => MODULES.filter((m) => m.parent === id).map((m) => m.id);
const isKnown = (id) => byId.has(id);
const isAssignable = (id) => !!(byId.get(id) && byId.get(id).assignable);

// Étend une liste d'affectations en ensemble de modules feuilles : un parent
// vaut tous ses enfants ; les ids inconnus sont ignorés (tolérance aux fichiers
// d'affectations obsolètes).
function expand(ids) {
  const out = new Set();
  for (const id of ids || []) {
    const m = byId.get(id);
    if (!m) continue;
    const kids = childrenOf(id);
    if (kids.length) kids.forEach((k) => out.add(k));
    else out.add(id);
  }
  return out;
}

// Forme sérialisable pour l'API de dispatch : les modules top-level affectables
// avec leurs enfants.
function tree() {
  return MODULES.filter((m) => m.parent === null && m.assignable).map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description || '',
    children: MODULES.filter((c) => c.parent === m.id).map((c) => ({ id: c.id, label: c.label, section: c.section || '' })),
  }));
}

module.exports = { MODULES, byId, LEAF_MODULE_IDS, childrenOf, isKnown, isAssignable, expand, tree };

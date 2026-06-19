'use strict';

// SOURCE UNIQUE DE VÉRITÉ du référentiel (corrige la divergence serveur/client
// relevée à l'audit : ARCH-4, REF-1/REF-2). Types normalisés sur une énumération
// fermée. UBA corrigée (type 'Banque' + color). vol24 retiré (calculé côté serveur).
//
// NOTE : ce référentiel sert UNIQUEMENT à la démonstration. Le statut réglementaire
// (agrément COBAC, etc.) n'est PAS représenté ici car il devrait provenir d'un
// registre officiel sourcé. Aucune affirmation d'agrément n'est faite dans le code.

const TYPES = Object.freeze({
  BANK: 'Banque',
  MOMO: 'MoMo',
  EMF: 'Microfinance',
  GATEWAY: 'Passerelle',
});

const OPERATORS = [
  { id: 'bgfi', name: 'BGFIBank Gabon', type: TYPES.BANK, color: 'text-blue-400', bg: 'bg-blue-600' },
  { id: 'bicig', name: 'BICIG', type: TYPES.BANK, color: 'text-sky-400', bg: 'bg-sky-500' },
  { id: 'ugb', name: 'Union Gabonaise de Banque', type: TYPES.BANK, color: 'text-red-400', bg: 'bg-red-600' },
  { id: 'orabank', name: 'Orabank Gabon', type: TYPES.BANK, color: 'text-purple-400', bg: 'bg-purple-600' },
  { id: 'ecobank', name: 'Ecobank Gabon', type: TYPES.BANK, color: 'text-teal-400', bg: 'bg-teal-600' },
  { id: 'citibank', name: 'Citibank Gabon', type: TYPES.BANK, color: 'text-blue-300', bg: 'bg-blue-800' },
  { id: 'uba', name: 'UBA Gabon', type: TYPES.BANK, color: 'text-red-500', bg: 'bg-red-700' },

  { id: 'airtel', name: 'Airtel Money Gabon', type: TYPES.MOMO, color: 'text-red-400', bg: 'bg-red-500' },
  { id: 'moov', name: 'Moov Money Gabon', type: TYPES.MOMO, color: 'text-blue-400', bg: 'bg-blue-500' },

  { id: 'finam', name: 'FINAM SA', type: TYPES.EMF, color: 'text-green-400', bg: 'bg-green-600' },
  { id: 'loxia', name: 'LOXIA EMF', type: TYPES.EMF, color: 'text-amber-400', bg: 'bg-amber-500' },
  { id: 'cofina', name: 'COFINA Gabon', type: TYPES.EMF, color: 'text-orange-400', bg: 'bg-orange-600' },
  { id: 'edg', name: 'EDG SA', type: TYPES.EMF, color: 'text-yellow-400', bg: 'bg-yellow-600' },
  { id: 'expressunion', name: 'Express Union Gabon', type: TYPES.EMF, color: 'text-rose-400', bg: 'bg-rose-600' },

  { id: 'gimac', name: 'GIMAC (passerelle CEMAC)', type: TYPES.GATEWAY, color: 'text-gray-300', bg: 'bg-gray-600' },
];

// Maillage territorial (corrige l'incohérence ARCH-8 : une seule liste).
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

const byId = new Map(OPERATORS.map((o) => [o.id, o]));
const cityByName = new Map(CITIES.map((c) => [c.name, c]));

// Validation de schéma du référentiel (REF-1) : échoue tôt si une entrée est malformée.
function validate() {
  const allowed = new Set(Object.values(TYPES));
  for (const o of OPERATORS) {
    if (!o.id || !o.name) throw new Error(`Opérateur sans id/name: ${JSON.stringify(o)}`);
    if (!allowed.has(o.type)) throw new Error(`Type invalide pour ${o.id}: ${o.type}`);
    if (!o.color || !o.bg) throw new Error(`Couleurs manquantes pour ${o.id}`);
  }
  return true;
}

module.exports = { TYPES, OPERATORS, CITIES, byId, cityByName, validate };

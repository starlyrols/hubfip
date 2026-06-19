'use strict';

// Générateur de données de DÉMONSTRATION — clairement étiqueté source 'SIMULATION'.
// Il alimente la MÊME chaîne réelle (modèle partie double -> ISO 8583 -> registre
// signé -> diffusion) que les injections externes, afin que toute la plomberie
// cryptographique soit réellement exercée. NE PRODUIT AUCUNE donnée financière réelle.

const crypto = require('crypto');
const { OPERATORS, CITIES, TYPES } = require('./referentiel');
const model = require('./model');

const REJECT_RATE = 0.01; // 1% de transactions rejetées (échec de vérification simulé)

function randInt(min, max) {
  // entier uniforme dans [min, max] via crypto (évite Math.random pour le réalisme)
  return min + Math.floor((crypto.randomInt(0, 1_000_000) / 1_000_000) * (max - min + 1));
}

function amountFor(type) {
  switch (type) {
    case TYPES.BANK: return randInt(500_000, 45_000_000);
    case TYPES.MOMO: return randInt(2_000, 350_000);
    case TYPES.EMF: return randInt(10_000, 4_500_000);
    case TYPES.GATEWAY: return randInt(1_000_000, 80_000_000);
    default: return randInt(1_000, 100_000);
  }
}

function generate() {
  const op = OPERATORS[crypto.randomInt(0, OPERATORS.length)];
  const city = CITIES[crypto.randomInt(0, CITIES.length)];
  const rejected = crypto.randomInt(0, 1000) < REJECT_RATE * 1000;
  return model.buildTransaction({
    operatorId: op.id,
    amount: amountFor(op.type),
    cityName: city.name,
    status: rejected ? 'REJECTED' : 'AUTHORIZED',
    source: 'SIMULATION',
    anomalyReason: rejected ? 'Signature ISO 8583 non vérifiée (simulation)' : undefined,
  });
}

module.exports = { generate, REJECT_RATE };

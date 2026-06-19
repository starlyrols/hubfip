'use strict';

// Vérifie l'intégrité cryptographique complète du registre (chaînage + signatures).
const ledger = require('../lib/ledger');

ledger.init();
const result = ledger.verifyChain();
const s = ledger.stats();

console.log('Vérification du registre HuBFIP');
console.log('  Algorithme    :', s.algorithm);
console.log('  Enregistrements:', result.total);
console.log('  Dernier hash  :', s.lastHash);
console.log('  Chaîne valide :', result.valid ? 'OUI' : `NON (rupture au seq ${result.brokenAt})`);
process.exit(result.valid ? 0 : 2);

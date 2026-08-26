'use strict';

// Vérifie l'intégrité cryptographique complète du registre : chaînage et
// continuité de séquence sur 100 % des enregistrements, signatures sur la
// totalité (--full, défaut) ou par échantillon (--sample, contrôle rapide).
//
// Ouverture en LECTURE SEULE : le contrôle ne prend pas le verrou d'écrivain et
// peut donc s'exécuter pendant que le service tourne.
const ledger = require('../lib/ledger');

const signatures = process.argv.includes('--sample') ? 'sample' : 'all';

ledger.openReadOnly();
const t0 = Date.now();
const result = ledger.verifyChain({ signatures });
const s = ledger.stats();

console.log('Vérification du registre SUMo (TDR)');
console.log('  Algorithme     :', s.algorithm);
console.log('  Enregistrements:', result.total);
console.log('  Portée         :', result.scope === 'full' ? 'intégrale, ancrée à la genèse' : 'fenêtre récente (non ancrée)');
console.log('  Signatures     :', `${result.signaturesChecked} vérifiées (${signatures === 'all' ? 'toutes' : 'échantillon'})`);
console.log('  Dernier hash   :', s.lastHash);
console.log('  Durée          :', `${Date.now() - t0} ms`);
console.log('  Chaîne valide  :', result.valid ? 'OUI' : `NON — ${result.reason} au seq ${result.brokenAt}`);
process.exit(result.valid ? 0 : 2);

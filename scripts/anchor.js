'use strict';

// Émet un REÇU D'ANCRAGE de la racine du registre, destiné à un dépôt chez un
// tiers de confiance (greffe, autre autorité, publication officielle).
//
// À partir du dépôt, toute réécriture d'un enregistrement antérieur devient
// détectable par ce tiers — sans qu'il ait accès aux données : il lui suffit de
// comparer le hash de tête au rang ancré. C'est la seule parade au risque
// résiduel de C2 : l'exploitant qui détient la clé de signature.
//
// Ouverture en LECTURE SEULE : peut s'exécuter pendant que le service tourne.

const ledger = require('../lib/ledger');
const anchor = require('../lib/anchor');

const note = process.argv.slice(2).join(' ') || null;

ledger.openReadOnly();
const receipt = anchor.emit(ledger, { note });

console.log('Reçu d\'ancrage — registre SUMo (TDR)');
console.log('  Rang ancré     :', receipt.seq);
console.log('  Hash de tête   :', receipt.headHash);
console.log('  Algorithme     :', receipt.algorithm);
console.log('  Clé publique   :', receipt.publicKeyFingerprint);
console.log('  Émis le        :', receipt.emittedAt);
if (receipt.note) console.log('  Mention        :', receipt.note);
console.log('  Signature      :', receipt.signature);
console.log('');
console.log('  Conservé dans  :', anchor.FILE);
console.log('  À DÉPOSER auprès d\'un tiers : c\'est le dépôt, et lui seul, qui donne');
console.log('  au reçu sa valeur probante contre une réécriture par l\'exploitant.');

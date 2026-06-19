'use strict';

// Génère un certificat TLS auto-signé pour le développement local (active HTTPS/WSS).
// Utilise openssl (présent sur macOS/Linux). En PRODUCTION : remplacer par un
// certificat émis par une autorité de confiance.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TLS_DIR = path.join(__dirname, '..', 'data', 'tls');
fs.mkdirSync(TLS_DIR, { recursive: true });

const key = path.join(TLS_DIR, 'server.key');
const cert = path.join(TLS_DIR, 'server.crt');

try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert,
    '-days', '365',
    '-subj', '/C=GA/O=HuBFIP (DEMO)/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'inherit' });
  console.log(`\nCertificat TLS de démo généré :\n  ${key}\n  ${cert}\nRelancez le serveur : il détectera automatiquement ces fichiers et activera HTTPS/WSS.`);
} catch (e) {
  console.error('Échec de la génération (openssl introuvable ?). Le serveur restera en HTTP.', e.message);
  process.exit(1);
}

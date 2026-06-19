# HuBFIP — Prototype de monitoring financier

> ⚠️ **PROTOTYPE / DÉMONSTRATION.** Toutes les données affichées sont **simulées**
> (générées côté serveur). Le projet **ne reflète aucun flux financier réel**, n'est
> lié à **aucune autorité publique** (ni République Gabonaise, ni BEAC, ni COBAC) et
> **ne doit pas être mis en production** en l'état. Voir [LICENSE](LICENSE).

Cette version 2 est une refonte de la maquette d'origine (voir [AUDIT.md](AUDIT.md))
visant à rendre l'architecture **cohérente et techniquement honnête** : le serveur est
la source unique de vérité, la plomberie de sécurité est réellement implémentée, et
l'interface n'affiche plus que des informations vérifiables.

## Démarrage

```bash
npm install
npm start                 # http://localhost:3000 (HTTP en clair)
# Pour activer HTTPS/WSS en local :
npm run gen-certs         # génère un certificat auto-signé (openssl)
npm start                 # détecte le certificat et bascule en HTTPS/WSS
```

Variables d'environnement (toutes optionnelles) :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `HOST` | `0.0.0.0` | Interface d'écoute (mettre `127.0.0.1` derrière un reverse proxy) |
| `STREAM_MS` | `1500` | Cadence du générateur de démo |
| `CORS_ORIGINS` | _(vide)_ | Origines autorisées supplémentaires (CSV) |
| `HUBFIP_API_KEY` / `HUBFIP_API_SECRET` | _(auto-générés)_ | Identifiants d'injection ISO 8583 |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

## Architecture

```
server.js              Express durci (helmet/CSP, CORS, rate-limit, /healthz,
                       arrêt gracieux) + WebSocket (diffuseur unique, heartbeat)
lib/referentiel.js     Source unique de vérité (opérateurs, villes) + validation
lib/iso8583.js         Encodeur/décodeur ISO 8583 réel (MTI + bitmap + data elements)
lib/model.js           Transaction en partie double (débit/crédit), devise, cycle de vie
lib/ledger.js          Registre append-only persistant, chaîné SHA-256, signé ECDSA P-256
lib/simulator.js       Générateur de données de DÉMO (étiqueté source=SIMULATION)
lib/auth.js            Sessions (cookie HttpOnly) + mots de passe scrypt (sans dépendance)
lib/users.js           Comptes des intervenants (rôles) dérivés du référentiel
lib/logger.js          Logs structurés JSON
public/login.html      Page de connexion publique + accès démo « un clic »
public/                Frontend : modules app.js / charts.js / map.js (libs auto-hébergées)
scripts/               gen-certs (TLS dev), verify-ledger (vérif. d'intégrité)
```

## Sécurité réellement implémentée

- **Transport** : HTTPS/WSS si un certificat est présent (`data/tls/`), sinon HTTP avec avertissement.
- **En-têtes** : helmet + Content-Security-Policy, `x-powered-by` désactivé, HSTS si TLS.
- **CORS** : allowlist d'origines.
- **Anti-DoS** : `express-rate-limit`, corps JSON plafonné (32 ko), **diffuseur WS unique**
  (pas un timer par client), heartbeat ping/pong, backpressure (`bufferedAmount`).
- **Injection authentifiée** : `POST /api/v1/iso8583` exige clé + signature **HMAC-SHA256**
  et une **validation de schéma** ; le message ISO 8583 est réellement parsé.
- **Registre non-répudiable** : chaque transaction est hachée (SHA-256), **chaînée** au hash
  précédent et **signée (ECDSA P-256)** ; persistance sur disque ⇒ survit au redémarrage.
  Vérification : `npm run verify-ledger` ou `GET /api/v1/ledger/verify`.
- **Exports signés** : `GET /api/v1/export` renvoie un fichier (CSV/JSON) + en-têtes
  `X-Content-SHA256` et `X-Signature-ECDSA-P256`.
- **Authentification & sessions** : connexion par identifiant/mot de passe (haché **scrypt**,
  comparaison à temps constant), sessions serveur via cookie **HttpOnly · SameSite=Strict**
  (`Secure` si TLS), expiration 8 h. Le flux WebSocket exige une session valide.

## Authentification & espaces par rôle

Une page de connexion publique (`/login.html`) donne accès à l'espace correspondant à chaque
**intervenant**. Quatre rôles, avec **cloisonnement des données appliqué côté serveur** :

| Rôle | Périmètre | Onglets |
|---|---|---|
| **Régulateur** (BEAC / ARCEP) | Supervision nationale — **tous** les flux | Tous |
| **Opérateur** (banque / MoMo / EMF / passerelle) | **Restreint à ses propres transactions** (REST + WebSocket filtrés) | Monitoring, GPS, Registre, Rapports |
| **Administrateur** | Système, intégrité du registre, PKI | Monitoring, Connecteurs, Registre, Sécurité, PKI |
| **Auditeur** | Vérification & exports en lecture seule | Monitoring, Registre, Rapports, Sécurité, PKI |

Un compte est généré pour chaque institution du référentiel (7 banques, 2 MoMo, 5 EMF,
1 passerelle GIMAC) en plus du régulateur, de l'admin et de l'auditeur.

**Accès démo « un clic » (DEV).** En dehors de la production, la page de connexion propose un
bouton par compte pour entrer directement dans l'espace correspondant, sans mot de passe.
C'est un **contournement volontaire réservé à la démonstration** : il est **désactivé**
automatiquement avec `NODE_ENV=production` (ou `HUBFIP_DEMO_LOGIN=0`). Mot de passe commun
pour la connexion classique : `HUBFIP_DEMO_PASSWORD` (défaut `demo123`).

## API

| Méthode | Route | Auth | Description |
|---|---|---|---|
| GET | `/healthz` | — | Santé du service |
| POST | `/api/v1/auth/login` | — | Connexion (identifiant + mot de passe) → cookie de session |
| POST | `/api/v1/auth/demo` | démo | Connexion « un clic » (désactivée en production) |
| POST | `/api/v1/auth/logout` | — | Déconnexion (détruit la session) |
| GET | `/api/v1/auth/me` | session | Intervenant connecté (rôle, périmètre) |
| GET | `/api/v1/auth/accounts` | — | Catalogue des comptes démo (si activé) |
| GET | `/api/v1/operators` | session | Référentiel (opérateurs, villes, types) |
| GET | `/api/v1/ledger?limit=N` | session | Enregistrements du registre (**filtrés selon le rôle**) |
| GET | `/api/v1/ledger/verify` | session | Vérifie l'intégrité de toute la chaîne |
| GET | `/api/v1/pubkey` | — | Clé publique de signature (PEM) |
| GET | `/api/v1/export?format=csv\|json&type=` | session | Export signé (**filtré selon le rôle**) |
| POST | `/api/v1/iso8583` | HMAC | Injection d'une transaction (objet JSON ou message ISO 8583) |

Exemple d'injection signée :

```bash
SECRET=...; KEY=...
BODY='{"operatorId":"bgfi","amount":1500000,"cityName":"Libreville"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -X POST http://localhost:3000/api/v1/iso8583 \
  -H "content-type: application/json" -H "x-hubfip-key: $KEY" -H "x-hubfip-signature: $SIG" \
  -d "$BODY"
```

## Ce qui reste hors périmètre (nécessite des ressources externes)

Ces points sont **documentés mais volontairement non implémentés**, car ils exigent des
ressources réelles (et ne doivent pas être feints) :

- Connexion réelle aux opérateurs (banques, MoMo, EMF) — il n'existe aucune source réelle.
- **mTLS mutuel** avec une PKI émise par une autorité de confiance (ex. BEAC).
- **Horodatage qualifié RFC 3161** (autorité d'horodatage externe).
- **Certification ISO 27001** et **conformité loi gabonaise n° 001/2011 / CNPDCP**
  (registre de traitement, base légale, rétention, minimisation des données personnelles).
- Persistance distribuée (PostgreSQL), redondance multi-instance, plan de reprise (RTO/RPO).
- Compilation Tailwind en build statique (le CDN Play est conservé, à remplacer).
- Tests automatisés et pipeline CI/CD (placeholders dans `package.json`).

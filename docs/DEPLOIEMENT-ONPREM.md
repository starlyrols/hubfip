# Déploiement on-prem (serveur souverain) — SUMo

> ⚠️ **PROTOTYPE / DÉMONSTRATION** : données simulées, sans mandat officiel. Ce guide
> décrit un déploiement **technique** ; la mise en production réelle suppose en outre
> le cadre légal, l'ingestion réelle des opérateurs et les briques listées au §9.

Runbook pas-à-pas pour exploiter SUMo sur un serveur sous contrôle du régulateur
(hébergement national, maîtrise des clés). Pile : application Node + reverse proxy
**Caddy** (terminaison TLS), via Docker Compose.

---

## 1. Prérequis

- Serveur Linux souverain (ex. Debian/Ubuntu LTS), 2 vCPU / 4 Go RAM suffisants pour le prototype.
- **Docker Engine** + **Docker Compose v2** (`docker compose version`).
- Accès réseau entrant **443** (HTTPS/WSS) et **80** (redirection). Tout le reste fermé.
- Un nom de domaine interne ou public (ex. `momo.arcep.ga`) pointant vers le serveur, ou simplement `localhost` pour une recette.

## 2. Récupération du code

```bash
git clone <votre-dépôt> sumo-platform && cd sumo-platform
# ou copie du dossier sumo-platform/ sur le serveur
```

## 3. Configuration

Créez un fichier `.env` (à partir de `.env.example`) :

```ini
SUMO_DOMAIN=momo.arcep.ga        # ou localhost
```

Variables d'application utiles (à passer au service `app` dans `docker-compose.yml`
ou via un gestionnaire de secrets) :

| Variable | Rôle |
|---|---|
| `NODE_ENV=production` | Désactive l'accès démo « un clic » (déjà par défaut dans l'image) |
| `SUMO_TRUST_PROXY=1` | Cookies `Secure` + HSTS derrière le proxy (déjà activé en compose) |
| `CORS_ORIGINS=https://momo.arcep.ga` | Origine(s) WebSocket autorisée(s) si vrai domaine |
| `SUMO_API_KEY` / `SUMO_API_SECRET` | Identifiants HMAC des connecteurs (sinon auto-générés et persistés) |
| `SUMO_DEMO_PASSWORD` | Mot de passe des comptes (prototype — **à remplacer** par une vraie gestion d'identités) |

## 4. Certificats TLS — 3 options

Le bloc `tls` du fichier `Caddyfile` :

1. **CA interne de Caddy (par défaut, souverain/hors-ligne)** — recommandé en intranet.
   Aucune action ; importez la racine de Caddy sur les postes des agents :
   ```bash
   make certs > sumo-root-ca.crt   # puis importer dans le magasin de confiance
   ```
2. **Votre PKI souveraine** — montez vos certificats et activez la ligne dédiée :
   ```yaml
   # docker-compose.yml (service proxy) :
   #   - ./certs:/certs:ro
   ```
   ```caddyfile
   # Caddyfile : commentez `tls internal` et activez :
   tls /certs/fullchain.pem /certs/privkey.pem
   ```
3. **Domaine public (Let's Encrypt automatique)** — `SUMO_DOMAIN` = vrai domaine,
   commentez `tls internal`, ajoutez un email dans le bloc global du Caddyfile.

## 5. Lancement

```bash
make up           # = docker compose -f docker-compose.yml up -d --build
# → https://<SUMO_DOMAIN>   (connexion : regulateur / <SUMO_DEMO_PASSWORD>)
```

## 6. Vérifications

```bash
make ps                                   # conteneurs « healthy »
make logs                                 # logs app + proxy
curl -sk https://localhost/healthz        # {"status":"ok",...}
docker compose exec app npm run verify-ledger   # intégrité du registre TDR
```
Dans l'interface, l'onglet **Sécurité & audit** doit indiquer : registre VALIDE,
journal d'audit VALIDE, transport « TLS terminé au reverse proxy ».

## 7. Persistance & sauvegardes

Le volume `sumo-data` contient l'État critique : **registre signé** (`tdr-ledger.jsonl`),
**journal d'audit**, **clés de signature** (`data/keys/`), configuration, dossiers.

```bash
# Sauvegarde chiffrée du volume (exemple)
docker run --rm -v sumo_sumo-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/sumo-data-$(date +%F).tgz -C /data .
# Chiffrez l'archive (ex. age/gpg) et stockez-la hors site.
```
> Ne perdez JAMAIS `data/keys/` : la continuité de la chaîne de signature en dépend.
> Restauration : recréez le volume et décompressez l'archive avant `make up`.

## 8. Sécurité & durcissement

- `NODE_ENV=production` (démo « un clic » désactivée) — **vérifié** sur la page de connexion.
- Pare-feu : n'exposez que **80/443** ; l'app n'est jamais publiée directement (réseau interne Compose).
- Conteneurs en **utilisateur non privilégié** (déjà le cas dans le Dockerfile).
- Secrets (`SUMO_API_SECRET`, mots de passe) via variables d'environnement / coffre, jamais en clair dans le dépôt.
- Mettez à jour régulièrement les images de base (`docker compose pull` / rebuild) et surveillez `npm audit` (job CI dédié).
- Sauvegarde du `Caddyfile` / des certificats de la PKI souveraine.

## 9. Mises à jour

```bash
git pull
make up            # reconstruit l'image et redéploie ; le volume sumo-data (registre) persiste
```

## 10. Souveraineté & conformité

- **Hébergement national**, **maîtrise des clés** (volume local), aucune dépendance d'exécution à un service tiers.
- **Minimisation des données** : MSISDN masqués par défaut ; révélation réservée à l'antifraude/juridique et **journalisée** (loi gabonaise n° 001/2011, CNPDCP).
- **Traçabilité** : journal d'audit chaîné/signé, inviolable.

## 11. Limites du prototype (à traiter avant une vraie production)

Documenté, jamais feint — visible dans l'onglet *Sécurité* :

- **Ingestion réelle** des opérateurs (les flux sont ici **simulés**) et obligation réglementaire de raccordement.
- **mTLS mutuel** avec une PKI émise par une autorité de confiance.
- **Horodatage qualifié RFC 3161** (autorité d'horodatage externe).
- **Certification ISO 27001** ; conformité formelle loi 001/2011 (registre de traitement, base légale, rétention).
- **Persistance distribuée & haute disponibilité** (PostgreSQL, multi-instances, DRP/BCP avec RTO/RPO) — le nœud unique est un SPOF.
- Pile à l'échelle (Kafka/Flink/ClickHouse/Kubernetes) pour les volumétries massives (cf. §4 du cahier).

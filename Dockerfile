# =============================================================================
# SUMo — image de conteneur.
#
# CORRECTIF P2 n°24 — durcissement de la chaîne de construction :
#   * base épinglée à une VERSION EXACTE (et non `node:20`, qui bouge sous vos
#     pieds : une reconstruction six mois plus tard produirait une autre image) ;
#   * construction en DEUX ÉTAGES — les outils de compilation et les dépendances
#     de développement ne franchissent pas la frontière de l'image finale ;
#   * `npm ci --ignore-scripts` : un paquet compromis ne s'exécute pas à
#     l'installation, qui est le vecteur le plus commun des attaques de chaîne
#     d'approvisionnement npm ;
#   * système de fichiers applicatif en LECTURE SEULE à l'exécution (cf.
#     docker-compose.yml) ; seul le volume de données est inscriptible.
#
# ÉPINGLAGE PAR EMPREINTE — à faire au moment de figer une version :
#   docker pull node:20.19.5-alpine3.21
#   docker inspect --format='{{index .RepoDigests 0}}' node:20.19.5-alpine3.21
# puis remplacer le tag ci-dessous par `node@sha256:<empreinte>`. C'est la seule
# forme qui garantisse le bit-à-bit ; le tag de version, lui, peut être republié.
# =============================================================================

# ---- Étage 1 : dépendances -------------------------------------------------
FROM node:20.19.5-alpine3.21 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts : aucune exécution de code de paquet à l'installation.
RUN npm ci --omit=dev --ignore-scripts

# ---- Étage 2 : image d'exécution -------------------------------------------
FROM node:20.19.5-alpine3.21

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=1024

WORKDIR /app

# Utilisateur non privilégié, créé avant la copie pour que les droits soient
# posés d'emblée plutôt que par un `chown -R` sur toute l'arborescence.
RUN addgroup -S sumo -g 10001 && adduser -S sumo -G sumo -u 10001

COPY --from=deps --chown=sumo:sumo /app/node_modules ./node_modules
COPY --chown=sumo:sumo . .

# Le volume de données est le SEUL emplacement inscriptible attendu.
RUN mkdir -p /app/data && chown sumo:sumo /app/data
USER 10001:10001

VOLUME ["/app/data"]
EXPOSE 3000

# Sonde de vivacité. `--start-period` couvre le contrôle d'intégrité intégral du
# registre au démarrage, qui peut durer sur un gros historique.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

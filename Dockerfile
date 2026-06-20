# SUMo — image de conteneur (PROTOTYPE / DÉMONSTRATION).
# Node 20 Alpine, dépendances de production uniquement, exécution en utilisateur non privilégié.
FROM node:20-alpine

# NODE_ENV=production : désactive l'accès démo « un clic » (sécurité par défaut).
# Pour explorer avec la connexion « un clic », lancer avec -e NODE_ENV=development.
ENV NODE_ENV=production
WORKDIR /app

# Couche de dépendances (cache) — n'installe que les dépendances de production.
COPY package*.json ./
RUN npm ci --omit=dev

# Code applicatif.
COPY . .

# Utilisateur non privilégié + dossier de données persistable (registre, clés, config).
RUN addgroup -S sumo && adduser -S sumo -G sumo \
  && mkdir -p /app/data && chown -R sumo:sumo /app
USER sumo

# Persistance recommandée : monter un volume sur /app/data.
VOLUME ["/app/data"]
EXPOSE 3000

# Sonde de vivacité sur l'endpoint /healthz.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

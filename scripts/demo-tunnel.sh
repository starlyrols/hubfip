#!/usr/bin/env bash
# =============================================================================
# Démo publique SUMo — tunnel Cloudflare éphémère (aucun compte requis).
# Ouvre un tunnel HTTPS public vers un serveur SUMo local (port 3001), affiche
# le lien de démo, puis démarre le serveur avec :
#   - CORS_ORIGINS=<url du tunnel>  → le WebSocket accepte l'origine publique ;
#   - SUMO_TRUST_PROXY=1            → cookies Secure + HSTS derrière le TLS Cloudflare.
# Ctrl+C arrête serveur ET tunnel. Le lien change à chaque lancement.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

command -v cloudflared >/dev/null || { echo "cloudflared manquant : brew install cloudflared"; exit 1; }

# Choisit un port libre (3001 par défaut, surchargeable par PORT=xxxx).
PORT="${PORT:-3001}"
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  echo "Port $PORT occupé — essai du port $((PORT + 1))."
  PORT=$((PORT + 1))
done

LOG="$(mktemp -t sumo-tunnel.XXXXXX)"
cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate >"$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill "$TUNNEL_PID" 2>/dev/null || true' EXIT

URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "Tunnel non établi — journal : $LOG"; exit 1; }

echo "=============================================================="
echo "  LIEN DE DÉMO PUBLIC : $URL"
echo "  Page de connexion   : $URL/login.html"
echo "  Actif tant que cette fenêtre reste ouverte (Ctrl+C pour tout arrêter)."
echo "  PROTOTYPE — données simulées ; toute personne ayant le lien y accède."
echo "=============================================================="

# Répertoire de données DÉDIÉ : la démo ne partage jamais le registre chaîné
# avec une instance locale (deux écrivains simultanés rompraient la chaîne).
PORT="$PORT" SUMO_DATA_DIR="${SUMO_DATA_DIR:-$PWD/data-demo}" SUMO_TRUST_PROXY=1 CORS_ORIGINS="$URL" npm start

#!/usr/bin/env bash
# =============================================================================
# Démo publique SUMo — tunnel Cloudflare éphémère.
#
# CORRECTIF P0 n°10. Ce script publiait auparavant sur Internet une instance en
# mode DÉVELOPPEMENT : connexion « un clic » sans mot de passe sur les 31 comptes
# de l'organigramme — Président et administrateur système compris — organigramme
# nominatif complet servi sans authentification, et mot de passe commun renvoyé
# en clair par l'API. Quiconque avait le lien disposait de tout.
#
# Désormais :
#   * NODE_ENV=production est IMPOSÉ — chaque compte a son propre secret, la
#     connexion « un clic » est désactivée ;
#   * le serveur ne sert le catalogue de démonstration qu'aux appels LOCAUX, donc
#     jamais au travers du tunnel ;
#   * le répertoire de données est dédié et distinct du registre d'exploitation ;
#   * un seul compte de présentation est ouvert, et son mot de passe est affiché
#     ici, dans le terminal du présentateur — pas sur la page de connexion.
#
# Usage : npm run demo [-- --reset]   (--reset repart d'un registre vierge)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

COMPTE_DEMO="${SUMO_DEMO_ACCOUNT:-pcr}"
DATA_DIR="${SUMO_DATA_DIR:-$PWD/data-demo}"
RESET=0
[ "${1:-}" = "--reset" ] && RESET=1

# Garde-fou : la démonstration ne touche JAMAIS le registre d'exploitation.
if [ "$(cd "$DATA_DIR" 2>/dev/null && pwd || echo "$DATA_DIR")" = "$PWD/data" ]; then
  echo "REFUS : la démonstration ne peut pas s'exécuter sur le registre d'exploitation ($PWD/data)." >&2
  echo "        Utilisez un SUMO_DATA_DIR dédié (défaut : $PWD/data-demo)." >&2
  exit 1
fi

command -v cloudflared >/dev/null || { echo "cloudflared manquant : brew install cloudflared"; exit 1; }

[ "$RESET" = "1" ] && { echo "Réinitialisation du jeu de démonstration…"; rm -rf "$DATA_DIR"; }

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

REMISE="$DATA_DIR/keys/mots-de-passe-initiaux.txt"
NOUVELLE_INSTALLATION=0
[ -f "$DATA_DIR/credentials.json" ] || NOUVELLE_INSTALLATION=1

echo "=============================================================="
echo "  LIEN DE DÉMO PUBLIC : $URL"
echo "  Page de connexion   : $URL/login.html"
echo "  Mode                : PRODUCTION (connexion « un clic » désactivée)"
echo "  Données             : $DATA_DIR — simulées, sans valeur probante"
echo "=============================================================="

# Le mot de passe est affiché ICI, dans le terminal du présentateur. Il n'est
# jamais servi par l'API à un appelant distant.
(
  for _ in $(seq 1 40); do
    if [ -f "$REMISE" ] && [ "$NOUVELLE_INSTALLATION" = "1" ]; then
      MDP=$(awk -v c="$COMPTE_DEMO" '$1==c {print $2}' "$REMISE" | head -1 || true)
      if [ -n "${MDP:-}" ]; then
        echo ""
        echo "  --------------------------------------------------------"
        echo "  Compte de présentation : $COMPTE_DEMO"
        echo "  Mot de passe initial   : $MDP"
        echo "  (changement imposé à la première connexion)"
        echo "  --------------------------------------------------------"
        echo ""
      fi
      break
    fi
    sleep 1
  done
) &

echo "  Toute personne ayant le lien atteint la page de connexion : ne diffusez"
echo "  ce lien qu'à l'audience visée, et arrêtez le tunnel après la séance."
echo "  Ctrl+C arrête le serveur ET le tunnel."
echo ""

NODE_ENV=production PORT="$PORT" SUMO_DATA_DIR="$DATA_DIR" SUMO_TRUST_PROXY=1 CORS_ORIGINS="$URL" npm start

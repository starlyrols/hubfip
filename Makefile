# SUMo — raccourcis de développement et d'exploitation (PROTOTYPE / DÉMONSTRATION).
# `make help` pour la liste. Pile Docker = app + reverse proxy TLS (Caddy).
#   make up      → PRODUCTION (uniquement docker-compose.yml)
#   make dev-up  → DÉVELOPPEMENT (fusionne docker-compose.override.yml : hot-reload)
#   make up-db   → PRODUCTION + entrepôt PostgreSQL (docker-compose.db.yml)
COMPOSE ?= docker compose
PROD = docker compose -f docker-compose.yml
PRODDB = docker compose -f docker-compose.yml -f docker-compose.db.yml

.PHONY: help install start dev test lint verify up dev-up up-db down restart logs ps build certs clean

help: ## Affiche cette aide
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Installe les dépendances Node
	npm install

start: ## Lance l'app en local (Node, sans Docker)
	npm start

dev: ## Lance l'app en local en mode watch (Node)
	npm run dev

test: ## Tests unitaires & d'intégration
	npm test

lint: ## ESLint
	npm run lint

verify: ## Vérifie l'intégrité cryptographique du registre TDR
	npm run verify-ledger

up: ## Démarre la pile en PRODUCTION (app + reverse proxy TLS) → https://localhost
	$(PROD) up -d --build

dev-up: ## Démarre la pile en DÉV (hot-reload + port 3000 direct) → http://localhost:3000
	$(COMPOSE) up -d --build

up-db: ## Démarre la pile + entrepôt PostgreSQL (persistance relationnelle) → https://localhost
	$(PRODDB) up -d --build

down: ## Arrête la pile Docker
	$(COMPOSE) down

restart: ## Redémarre la pile Docker
	$(COMPOSE) restart

logs: ## Suit les logs (app + proxy)
	$(COMPOSE) logs -f

ps: ## État des conteneurs
	$(COMPOSE) ps

build: ## Construit l'image Docker
	docker build -t sumo-platform:latest .

certs: ## Exporte la CA racine interne de Caddy (à importer dans le navigateur)
	$(COMPOSE) exec proxy cat /data/caddy/pki/authorities/local/root.crt

clean: ## Arrête la pile et SUPPRIME les volumes (registre, clés, config — DONNÉES PERDUES)
	$(COMPOSE) down -v

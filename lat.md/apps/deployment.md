# Images de déploiement

Deux images construites depuis la racine du monorepo : le backend (`@apps/backend/Dockerfile`) et le front servi par Caddy (`@apps/front/Dockerfile`). Le compose de production les lance ; SOPS, `deploy.sh` et la CI viennent ensuite.

```bash
docker build -f @apps/backend/Dockerfile .
docker build -f @apps/front/Dockerfile --build-arg APP_VERSION=v1.2.3 .
```

Les deux suivent les mêmes étapes : `turbo prune <app> --docker`, installation complète, `turbo build`, puis une étape finale qui ne garde que le nécessaire. La configuration et les secrets du backend arrivent à l'exécution : voir [[backend-bootstrap#Configuration de production]].

## Bases épinglées par digest

Chaque `FROM` porte une version exacte et le digest de l'index multi-architecture, pour qu'un rebuild ou un rollback reprenne la même base sur Mac comme sur la VM amd64.

Les digests viennent de `docker buildx imagetools inspect <image:tag>`. Monter de version, c'est changer le tag et le digest ensemble, dans les deux Dockerfiles. pnpm est fixé sur `packageManager` du `package.json` racine, turbo sur la version résolue dans le lockfile.

Le node est en Debian (`bookworm-slim`), jamais en Alpine : `sodium-native`, tiré par `@fastify/secure-session`, ne livre de binaires précompilés que pour glibc. Sur Alpine, le backend ne démarre pas.

## Image backend

L'app tourne en TypeScript via vite-node, avec les `@libs` résolues depuis leur `dist/`, d'où le `turbo build --filter=@apps/backend^...` au build.

Les libs sont construites avec l'installation complète, puis `node_modules` est supprimé et réinstallé en `--prod`, hors ligne depuis le store de l'étape. L'image passe ainsi de 1,32 Go à 682 Mo. Un simple `pnpm install --prod` ne suffit pas : il retire les liens mais laisse les paquets dans `node_modules/.pnpm`.

`git` (dépendances git du lockfile) reste dans l'étape d'installation, et l'étape runtime repart de l'image node nue. Aucun compilateur n'est installé : `argon2` et `sodium-native` livrent des binaires précompilés glibc, et seuls `cpu-features` et le binding optionnel de `ssh2` (dépendances facultatives de testcontainers, pour les tests) échouent sans conséquence. Aucun navigateur Playwright n'est installé : le backend n'utilise pas `playwright`.

### Dépendances de production du backend

Tout ce que le conteneur exécute doit être en `dependencies`, sinon l'installation `--prod` le retire et l'image ne démarre plus.

Côté `@apps/backend`, cela comprend ce que `vite.config.mts` importe (`vite`, `vite-plugin-node`, `vite-tsconfig-paths`), le moteur `vite-node`, la CLI et le driver MikroORM, `@fastify/secure-session` et `@fastify/static`, et `@ngneat/falso`, importé par `mikro-orm.config.ts` et les seeders. À l'inverse, `vitest` et `playwright` sont en `devDependencies` partout : déclarés en `dependencies`, ils tiraient `msw` et `playwright-core` dans l'image. La CLI MikroORM charge sa configuration TypeScript via jiti, sans `ts-node`.

### Utilisateur node et pas de pnpm

Le conteneur tourne en `node`, et le `CMD` appelle `./node_modules/.bin/vite-node` directement : en non-root, pnpm et corepack veulent écrire dans des dossiers appartenant à root.

Toute commande lancée dans le conteneur (migrations, CLI MikroORM) doit donc passer par `./node_modules/.bin/…`. Le seul dossier inscriptible est `@apps/backend/node_modules/.vite-temp`, où vite-node transpile `vite.config.mts` à chaque démarrage.

L'image pose `HOST=0.0.0.0` et `PORT=8000` par défaut. L'image crée aussi `dist/uploads`, vide et à root : c'est la racine du `@fastify/static` monté sur `/public/`, qui sinon émet un avertissement au démarrage, mais rien n'y écrit.

## Image front

Le build Ember est servi par Caddy (Alpine), qui proxifie aussi `/api/*` vers `backend:8000`, le nom du service dans le compose. Caddy tourne en `1000:1000` sur le port 80.

Le binaire `caddy` de l'image amont porte déjà `cap_net_bind_service`, d'où le port 80 sans root. `admin off` et `auto_https off` : le TLS se termine chez Cloudflare.

### Jamais de mocks MSW en production

Le front démarre MSW sauf si `VITE_MOCK_API` vaut `false`. L'image pose cette variable, puis refuse un bundle qui démarre encore MSW.

Un front de production qui répondrait avec des données fictives serait le pire incident possible pour un registre de conformité. Le contrôle cherche `mockServiceWorker.js` dans le JS de `dist/`, hors du fichier `public/mockServiceWorker.js` lui-même.

Ce marqueur a été retenu en comparant deux builds : avec le mock actif, le bundle principal contient l'URL d'enregistrement du worker, une chaîne que la minification ne peut pas renommer ; avec `VITE_MOCK_API=false`, la branche de [[@apps/front/app/routes/application.ts#ApplicationRoute]] est éliminée et la chaîne disparaît. `setupWorker` et `serviceWorker.register` disparaissent aussi, mais un nom de fonction peut être minifié et un service worker légitime pourrait un jour s'enregistrer.

### Variables déclarées à turbo

turbo 2 filtre les variables d'environnement non déclarées. `VITE_MOCK_API` et `APP_VERSION` sont donc listées dans `tasks.build.env` de `turbo.json`, sinon elles n'atteignent jamais `vite build`.

Le contrôle MSW couvre l'oubli pour `VITE_MOCK_API`. Pour `APP_VERSION`, l'oubli se verrait au filigrane, qui disparaîtrait.

### Filigrane de version

Le front affiche en bas à droite la version du build, pour voir d'un coup d'œil quel tag tourne. Elle vient de `APP_VERSION` au build, `dev` si absente.

`vite.config.mts` l'injecte par un `define` (`__APP_VERSION__`), [[@apps/front/app/config/environment.ts#environmentConfig]] la range dans `APP.version` sauf en mode test, et le template `application` l'affiche. La valeur `dev` est masquée : le filigrane n'apparaît que dans une image.

### Cache et en-têtes

Seuls les fichiers dont le nom porte un hash sont `immutable` ; `index.html`, le repli SPA et les fichiers copiés tels quels depuis `public/` sont `no-cache`.

Vite émet les fichiers hashés à plat dans `dist/assets/`, sous la forme `<nom>-<hash de 8 caractères>.<ext>`. Le Caddyfile les reconnaît par expression régulière, sans sous-dossier, et seulement s'ils existent : un hash disparu après un déploiement retombe sur le repli SPA plutôt que d'être servi en `immutable`. `public/` produit `assets/img/*`, `mockServiceWorker.js` et `robots.txt`, tous sans hash. Un fichier de `public/assets/` nommé comme un fichier hashé serait mal classé.

Toutes les réponses portent `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` et `Referrer-Policy: strict-origin-when-cross-origin`, compressées en `gzip` ou `zstd`.

## Contexte de build

Le `.dockerignore` exclut `**/.env` et `**/.env.*` à tous les niveaux : le `@apps/backend/.env` déchiffré en dev n'entre jamais dans le contexte, donc dans aucune couche.

Il exclut aussi ce qu'aucune image n'utilise ou qu'elle reconstruit : `node_modules`, `dist`, `.turbo` à tous les niveaux, `.git`, `lat.md`, `specs`, `tuto`, `.claude`, `.agentsroom`. `turbo prune` ne copie ni `.npmrc` ni `patches/`, que le lockfile exige : les Dockerfiles les copient à part.

## Compose de production

`deploy/docker-compose.prod.yaml` (projet `registries`) lance `postgres`, `backend`, `caddy` et `cloudflared`. Aucun port n'est publié : le tunnel Cloudflare est la seule entrée.

```
Internet → Access → tunnel → cloudflared → caddy:80
                                             ├── /api/*  → backend:8000 → postgres:5432
                                             └── le reste → le front dans /srv
```

Les images de l'app sont `${REGISTRY}/backend` et `${REGISTRY}/front` au tag `${IMAGE_TAG}`, en `:?` : sans ces variables (ni `TUNNEL_TOKEN`), `docker compose config` échoue en nommant `deploy.sh` plutôt que de tirer une image par défaut. Ni secret chiffré, ni script de déploiement, ni migration dans ce fichier : ce sont les étapes suivantes.

Pour tous les services : `restart: unless-stopped` et logs `json-file` tournants (`10m` × 3, ancre `x-logging`), sinon les logs remplissent le disque de la VM. `postgres` et `cloudflared` sont épinglés par version exacte et digest d'index, comme les `FROM` : voir [[deployment#Bases épinglées par digest]].

### Services

Postgres 18 sans port, le backend en `service_healthy` derrière lui, Caddy et cloudflared en `service_started`.

- `postgres` : même majeure que le compose de dev. L'image 18 pose `PGDATA=/var/lib/postgresql/18/docker` et déclare le volume sur `/var/lib/postgresql` : le volume `postgres-data` y est monté, pas sur `.../data`, qui laisserait les données hors du volume. `POSTGRES_USER` et `POSTGRES_DB` valent `registries` en clair, le mot de passe arrive par `POSTGRES_PASSWORD_FILE`. Healthcheck `pg_isready`.
- `backend` : configuration non secrète en clair (`HOST=0.0.0.0`, URLs `https://registries.triptyk.be`, drapeaux de [[backend-bootstrap#Drapeaux de fonctionnalité par domaine]], SMTP Mailgun EU en STARTTLS sur 587). Aucun code n'envoie encore de mail : le SMTP ne sert qu'à passer la validation, région et adresse d'envoi sont à confirmer. Healthcheck `fetch` sur `http://127.0.0.1:8000/api/v1/status` — pas `localhost`, qui peut se résoudre en `::1` alors que le backend n'écoute qu'en IPv4 — avec `start_period: 60s` pour vite-node, et `init: true`.
- `caddy` : attend seulement que le backend soit démarré. Il sert le front pendant que l'API démarre, et un backend malade ne fait pas tomber tout le hostname.
- `cloudflared` : `tunnel --no-autoupdate run`, jeton en variable d'environnement.

### Secrets du compose

Huit secrets Compose de source `environment:`, chacune au nom de la clé qu'elle alimente : `DATABASE_URI`, `SESSION_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `EXPORT_SIGNING_KEY`, `SMTP_USER`, `SMTP_PASSWORD`, `POSTGRES_PASSWORD`.

Ils sont montés en `/run/secrets/<clé en minuscules>` et relus via `*_FILE` ([[backend-bootstrap#Configuration de production#Secrets livrés en fichier]]) : `docker inspect` du backend ne montre que les chemins. Seule exception, `TUNNEL_TOKEN` : `cloudflared tunnel run` ne lit que la variable, sans `*_FILE`, et sa valeur est visible dans `docker inspect` de `cloudflared`.

Formats attendus, pour que l'étape SOPS les construise justes :

- `POSTGRES_PASSWORD` : généré en hexadécimal (`openssl rand -hex 32`), donc sans `@`, `:` ni `/`, car il est recopié tel quel dans l'URI ;
- `DATABASE_URI` : `postgresql://registries:<POSTGRES_PASSWORD>@postgres:5432/registries`, avec le même mot de passe que le secret `POSTGRES_PASSWORD` ;
- `SESSION_KEY` : 64 caractères hexadécimaux (`openssl rand -hex 32`). Le backend la décode en hex et exige 32 octets ; toute autre valeur l'empêche de démarrer (`key must be 32 bytes`).

### Secrets vides et deploy.sh

Compose ne crée aucun fichier pour un secret dont la valeur est vide, et le backend refuse un `*_FILE` absent : `deploy.sh` devra matérialiser les secrets optionnels vides, comme `SMTP_PASSWORD`.

Vérifié : avec `SMTP_PASSWORD=` dans le shell, `/run/secrets/smtp_password` n'existe pas et le backend redémarre en boucle sur `SMTP_PASSWORD_FILE : impossible de lire le fichier`.

### Côté Cloudflare

La configuration Cloudflare est hors du repo, faite dans le tableau de bord Zero Trust.

- un tunnel géré à distance, dont le jeton devient `TUNNEL_TOKEN` ;
- un hostname public `registries.triptyk.be` routé vers le service `http://caddy:80` — cloudflared résout `caddy` sur le réseau du projet ;
- une application Access sur ce hostname, avec la politique qui fixe qui peut l'atteindre. Le TLS se termine chez Cloudflare, d'où `auto_https off` dans Caddy.

### Valider le compose en local

Sans tunnel : construire les images en `registries/*:local`, puis un override jetable hors du repo publie Caddy sur un port local et met `cloudflared` dans un profil jamais activé.

`/api/v1/status` répond sans schéma en base : aucune migration n'est nécessaire pour cette validation.

## Secrets de production (SOPS)

Les secrets de production sont chiffrés par SOPS + age dans `deploy/envs/prod.secrets.env.enc`, versionné. Aucune copie en clair n'existe, ni sur le poste ni sur la VM.

### Règle de production

Dans `.sops.yaml`, la règle de `deploy/envs/prod.secrets.env.enc` précède celle de dev : SOPS prend la première qui correspond, et `\.env(\.\w+)?\.enc$` attraperait aussi ce fichier.

Elle ne chiffre que pour la clé de l'opérateur. Les clés de dev, dont celle de la CI (secret `SOPS_AGE_KEY` de `playwright.yml`), n'y figurent pas : la CI ne doit jamais pouvoir déchiffrer la production.

Ajouter ou retirer un opérateur : éditer la liste `age:` de la règle, puis, avec une clé déjà autorisée, rechiffrer la clé de données et commiter le fichier (voir `tuto/2_sops.md`) :

```bash
sops updatekeys --input-type dotenv deploy/envs/prod.secrets.env.enc
```

### Générer les secrets

`deploy/new-prod-secrets.sh` produit le fichier chiffré en une fois, sans fichier en clair ni valeur affichée : le clair ne passe que par un pipe vers `sops encrypt`.

Il respecte les formats de [[deployment#Compose de production#Secrets du compose]] : `POSTGRES_PASSWORD`, `SESSION_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET` et `EXPORT_SIGNING_KEY` en `openssl rand -hex 32`, `DATABASE_URI` construite avec le même mot de passe. `SMTP_USER`, `SMTP_PASSWORD` et `TUNNEL_TOKEN` sortent vides.

Il refuse d'écraser un fichier existant : le volume Postgres garde le premier mot de passe qu'il a vu, et `EXPORT_SIGNING_KEY` signe les exports du registre. Régénérer l'un ou l'autre casserait la production.

La règle se choisit d'après `--filename-override deploy/envs/prod.secrets.env.enc`, quel que soit le chemin de sortie. Un `SOPS_AGE_RECIPIENTS` hérité du shell est ignoré : il remplacerait la règle en silence. Pour les essais, `--out` et `--age` chiffrent un autre fichier pour une clé jetable, avec `sops --config /dev/null` pour ne pas exiger de règle.

### Éditer un secret

Les valeurs vides se remplissent plus tard, sans jamais écrire le clair sur disque hors de l'éditeur de `sops` :

```bash
sops edit --input-type dotenv --output-type dotenv deploy/envs/prod.secrets.env.enc
```

`TUNNEL_TOKEN` est requis avant le premier déploiement (voir [[deployment#Compose de production#Côté Cloudflare]]). `SMTP_USER` et `SMTP_PASSWORD` peuvent rester vides tant qu'aucun mail n'est envoyé.

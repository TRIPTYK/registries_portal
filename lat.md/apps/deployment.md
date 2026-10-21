# Images de déploiement

Deux images construites depuis la racine du monorepo : le backend (`@apps/backend/Dockerfile`) et le front servi par Caddy (`@apps/front/Dockerfile`). Le compose, SOPS et la CI viennent ensuite.

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

L'installation est complète, sans `--prod` : vite-node et `@mikro-orm/cli` sont en `devDependencies`. `git` (dépendances git du lockfile) reste dans l'étape d'installation, et l'étape runtime repart de l'image node nue. Aucun compilateur n'est installé : `argon2` et `sodium-native` livrent des binaires précompilés glibc, et seuls `cpu-features` et le binding optionnel de `ssh2` (dépendances facultatives de testcontainers, pour les tests) échouent sans conséquence. Aucun navigateur Playwright n'est installé : le backend n'utilise pas `playwright`.

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

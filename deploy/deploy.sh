#!/usr/bin/env bash
# Déploiement de registries_portal, depuis le poste de l'opérateur vers la VM, par
# un contexte Docker distant. La VM ne construit rien et ne détient aucun secret
# en clair : elle tire les images depuis Harbor, et les secrets sont déchiffrés
# ici, en mémoire, puis injectés dans les sources `secrets:` du compose.
# Voir lat.md/apps/deployment.md.
#
# Usage :
#   ./deploy.sh [--context NAME] [--ps] [IMAGE_TAG] [service ...]
#
#   IMAGE_TAG       tag des images. Défaut : le dernier tag git v*.
#   service ...     ne déploie que ces services. Défaut : toute la stack.
#   --context NAME  contexte Docker cible (défaut : registries-prod).
#   --ps            affiche l'état de la stack et s'arrête.
#
# Environnement :
#   REGISTRY              projet Harbor des images
#                         (défaut : 17p4mt20.gra7.container-registry.ovh.net/registries).
#   DEPLOY_SECRETS_FILE   fichier de secrets chiffré (défaut : deploy/envs/prod.secrets.env.enc).
#
# Exemples :
#   ./deploy.sh                        # dernier tag, toute la stack
#   ./deploy.sh v1.2.0 backend caddy   # deux services seulement
#   ./deploy.sh --ps
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTEXT="registries-prod"
REGISTRY="${REGISTRY:-17p4mt20.gra7.container-registry.ovh.net/registries}"
SECRETS_FILE="${DEPLOY_SECRETS_FILE:-$HERE/envs/prod.secrets.env.enc}"
PS_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ps) PS_ONLY=1; shift ;;
    --context) CONTEXT="${2:?--context attend un nom}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) echo "✗ option inconnue : $1" >&2; exit 1 ;;
    *) break ;;
  esac
done

IMAGE_TAG="${1:-}"
if [ -n "$IMAGE_TAG" ]; then shift; fi
if [ -z "$IMAGE_TAG" ]; then
  IMAGE_TAG="$(git -C "$HERE" describe --tags --match 'v*' --abbrev=0 2>/dev/null || true)"
fi
[ -n "$IMAGE_TAG" ] || { echo "✗ aucun IMAGE_TAG : passe-le en premier argument (ex. v1.0.0)" >&2; exit 1; }

[ -f "$SECRETS_FILE" ] || { echo "✗ secrets chiffrés introuvables : $SECRETS_FILE" >&2; exit 1; }

# 1. Le contexte : le nom du contexte et l'alias SSH sont indépendants, l'alias
# est dans l'URL de l'endpoint.
if ! docker context inspect "$CONTEXT" >/dev/null 2>&1; then
  {
    echo "✗ aucun contexte Docker nommé '$CONTEXT'"
    echo "  crée-le :  docker context create $CONTEXT --docker \"host=ssh://<alias-ssh>\""
    echo "  ou choisis-en un autre avec --context. Disponibles :"
    docker context ls --format '{{.Name}}  →  {{.DockerEndpoint}}' | sed 's/^/    /'
  } >&2
  exit 1
fi

# 2. La clé age, aux emplacements par défaut de sops sur macOS et Linux si elle
# n'est pas déjà désignée.
if [ -z "${SOPS_AGE_KEY:-}" ] && [ -z "${SOPS_AGE_KEY_FILE:-}" ]; then
  for k in "$HOME/Library/Application Support/sops/age/keys.txt" "${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt"; do
    [ -f "$k" ] && { export SOPS_AGE_KEY_FILE="$k"; break; }
  done
fi
if [ -z "${SOPS_AGE_KEY:-}" ] && [ ! -f "${SOPS_AGE_KEY_FILE:-}" ]; then
  {
    echo "✗ clé age introuvable"
    echo "  attendue dans ~/Library/Application Support/sops/age/keys.txt (macOS)"
    echo "  ou ~/.config/sops/age/keys.txt (Linux), ou désignée par SOPS_AGE_KEY_FILE."
  } >&2
  exit 1
fi

# 3. Les images, lues depuis ce poste et volontairement sans --context : le client
# Docker transmet les identifiants Harbor de l'opérateur au démon distant à chaque
# pull, la VM n'en a aucun. Ce contrôle distingue « pas connecté à Harbor » de
# « tag non publié » avant de toucher la VM. --ps ne tire rien et s'en passe.
if [ "$PS_ONLY" -eq 0 ]; then
  manifest_args=()
  # Réservé aux essais contre un registre local en HTTP, jamais en production.
  if [ "${DEPLOY_TEST_INSECURE_REGISTRY:-0}" = 1 ]; then manifest_args=(--insecure); fi
  # `docker manifest inspect` répond « no such manifest » aussi bien sans
  # identifiants que pour un tag absent : la cause se lit dans la config Docker
  # locale, où `docker login` inscrit l'hôte.
  registry_host="${REGISTRY%%/*}"
  logged_in=0
  if grep -qF "\"$registry_host\"" "${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null; then logged_in=1; fi
  for image in backend front; do
    if ! out="$(docker manifest inspect ${manifest_args[@]+"${manifest_args[@]}"} "$REGISTRY/$image:$IMAGE_TAG" 2>&1 >/dev/null)"; then
      {
        echo "✗ impossible de lire $REGISTRY/$image:$IMAGE_TAG"
        case "$out" in
          *unauthorized*|*denied*|*authentication*)
            echo "  accès refusé par $registry_host : docker login $registry_host, avec un compte qui lit ce projet" ;;
          *"no such manifest"*|*"manifest unknown"*)
            if [ "$logged_in" -eq 1 ]; then
              echo "  le tag $IMAGE_TAG n'est pas publié pour $image."
            else
              echo "  pas connecté à $registry_host : docker login $registry_host"
            fi ;;
          *)
            echo "  $out" ;;
        esac
      } >&2
      exit 1
    fi
  done
fi

export IMAGE_TAG REGISTRY

# Déchiffrement dans l'environnement de ce processus : ni fichier temporaire, ni
# `eval` (un secret avec un ` ou un $ doit rester littéral), ni `env VAR=…` sur
# une ligne de commande, que tout `ps` local afficherait.
secret_count=0
empty_secrets=()
tunnel_token_set=0
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  key="${line%%=*}"
  value="${line#*=}"

  if [ "$key" = TUNNEL_TOKEN ] && [ -n "$value" ]; then tunnel_token_set=1; fi

  # Compose ne crée aucun fichier pour un secret vide, et le backend refuse un
  # *_FILE absent : un secret vide devient un simple retour à la ligne, que le
  # backend relit comme "".
  if [ -z "$value" ]; then
    empty_secrets+=("$key")
    value=$'\n'
  fi

  export "$key=$value"
  secret_count=$((secret_count + 1))
done < <(sops decrypt --input-type dotenv --output-type dotenv "$SECRETS_FILE")

[ "$secret_count" -gt 0 ] || { echo "✗ aucun secret lu dans $SECRETS_FILE" >&2; exit 1; }

compose() { docker --context "$CONTEXT" compose -f "$HERE/docker-compose.prod.yaml" "$@"; }

if [ "$PS_ONLY" -eq 1 ]; then
  compose ps
  exit 0
fi

# Sans jeton, cloudflared redémarrerait en boucle et le site resterait injoignable.
if [ "$tunnel_token_set" -eq 0 ]; then
  {
    echo "✗ TUNNEL_TOKEN est vide dans $SECRETS_FILE"
    echo "  crée le tunnel dans Cloudflare Zero Trust, puis renseigne son jeton :"
    echo "    sops edit --input-type dotenv --output-type dotenv $SECRETS_FILE"
  } >&2
  exit 1
fi

echo "▶ registries — $REGISTRY  tag=$IMAGE_TAG  contexte=$CONTEXT  secrets=$secret_count"
if [ "${#empty_secrets[@]}" -gt 0 ]; then
  echo "  ⚠ secrets vides : ${empty_secrets[*]}"
fi

compose up -d --pull always "$@"

echo
compose ps
echo
echo "✓ déployé. Logs :"
echo "    docker --context $CONTEXT compose -f $HERE/docker-compose.prod.yaml logs -f backend"

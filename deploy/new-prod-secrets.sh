#!/usr/bin/env bash
# Génère les secrets de production de registries_portal, directement chiffrés
# par SOPS + age : aucune valeur n'est écrite en clair sur le disque ni affichée.
# À lancer une seule fois, par un opérateur. Voir lat.md/apps/deployment.md.
#
# Usage :
#   ./new-prod-secrets.sh [--out PATH] [--age RECIPIENT]
#
#   --out PATH        fichier chiffré à produire
#                     (défaut : deploy/envs/prod.secrets.env.enc).
#   --age RECIPIENT   chiffre pour ce seul destinataire age au lieu de la règle
#                     de production de .sops.yaml. Réservé aux essais, avec une
#                     clé jetable.
#
# Refuse d'écraser un fichier existant : le volume Postgres garde le premier mot
# de passe qu'il a vu, et EXPORT_SIGNING_KEY signe les exports du registre.
# Régénérer l'un ou l'autre casserait la production. Pour changer une valeur :
#   sops edit --input-type dotenv --output-type dotenv <fichier>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEFAULT_OUT="deploy/envs/prod.secrets.env.enc"
OUT="$ROOT/$DEFAULT_OUT"
RECIPIENT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out attend un chemin}"; shift 2 ;;
    --age) RECIPIENT="${2:?--age attend une clé publique age}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "✗ argument inconnu : $1" >&2; exit 1 ;;
  esac
done

if [ -e "$OUT" ]; then
  {
    echo "✗ $OUT existe déjà : refus de l'écraser."
    echo "  Régénérer POSTGRES_PASSWORD ou EXPORT_SIGNING_KEY casserait la production."
    echo "  Pour modifier une valeur : sops edit --input-type dotenv --output-type dotenv $OUT"
  } >&2
  exit 1
fi

# Un SOPS_AGE_RECIPIENTS hérité du shell remplacerait la règle de .sops.yaml en
# silence : seuls les destinataires choisis ici comptent.
unset SOPS_AGE_RECIPIENTS
if [ -n "$RECIPIENT" ]; then
  # Sans --config /dev/null, sops chercherait quand même une règle de .sops.yaml
  # pour /dev/stdin et échouerait.
  sops_args=(--config /dev/null encrypt --age "$RECIPIENT")
else
  # La règle se choisit d'après le nom du fichier : on présente le chemin
  # relatif à la racine, celui que la règle de production reconnaît.
  sops_args=(encrypt --filename-override "$DEFAULT_OUT")
fi
sops_args+=(--input-type dotenv --output-type dotenv)

hex() { openssl rand -hex 32; }

# Le clair ne vit que dans ce pipe ; seul le chiffré sort de sops.
pw="$(hex)"
encrypted="$(
  cd "$ROOT"
  {
    echo "POSTGRES_PASSWORD=$pw"
    echo "DATABASE_URI=postgresql://registries:$pw@postgres:5432/registries"
    echo "SESSION_KEY=$(hex)"
    echo "JWT_SECRET=$(hex)"
    echo "JWT_REFRESH_SECRET=$(hex)"
    echo "EXPORT_SIGNING_KEY=$(hex)"
    echo "SMTP_USER="
    echo "SMTP_PASSWORD="
    echo "TUNNEL_TOKEN="
  } | sops "${sops_args[@]}" /dev/stdin
)"
unset pw

mkdir -p "$(dirname "$OUT")"
# noclobber : si le fichier est apparu entre-temps, on échoue plutôt que d'écraser.
( set -o noclobber; printf '%s\n' "$encrypted" > "$OUT" )

echo "✓ secrets chiffrés dans $OUT"
echo "  À renseigner avant le premier déploiement : TUNNEL_TOKEN (puis SMTP_USER, SMTP_PASSWORD)"
echo "    sops edit --input-type dotenv --output-type dotenv $OUT"

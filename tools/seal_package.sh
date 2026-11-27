#!/usr/bin/env bash
# Versleutelt een buildpakket (APK, Xcode-zip) voor een artefact in deze openbare repo.
# Gebruik: tools/seal_package.sh <bestand> <uitvoermap> [publieke-sleutel.pem]
# Resultaat: <naam>.enc (AES-256-CBC, pbkdf2) en <naam>.key.enc (de AES-sleutel, RSA-OAEP met de publieke sleutel).
# Zonder de private sleutel (staat NIET in deze repo) is het resultaat onleesbaar.
set -euo pipefail
file="${1:?bestand}"; out="${2:?uitvoermap}"; pub="${3:-$(dirname "$0")/track-builds.pub.pem}"
[ -f "$file" ] && [ -f "$pub" ] || { echo "bestand of sleutel ontbreekt" >&2; exit 1; }
mkdir -p "$out"
name=$(basename "$file")
key=$(mktemp); trap 'rm -f "$key"' EXIT
openssl rand -out "$key" 32
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$file" -out "$out/$name.enc" -pass file:"$key"
openssl pkeyutl -encrypt -pubin -inkey "$pub" -pkeyopt rsa_padding_mode:oaep -in "$key" -out "$out/$name.key.enc"

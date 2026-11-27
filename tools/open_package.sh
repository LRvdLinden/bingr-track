#!/usr/bin/env bash
# Ontsleutelt een met seal_package.sh versleuteld pakket.
# Gebruik: tools/open_package.sh <private-sleutel.pem> <naam.enc> <uitvoerbestand>   (naam.key.enc staat ernaast)
set -euo pipefail
priv="${1:?private sleutel}"; enc="${2:?naam.enc}"; out="${3:?uitvoerbestand}"
key=$(mktemp); trap 'rm -f "$key"' EXIT
openssl pkeyutl -decrypt -inkey "$priv" -pkeyopt rsa_padding_mode:oaep -in "${enc%.enc}.key.enc" -out "$key"
openssl enc -d -aes-256-cbc -pbkdf2 -in "$enc" -out "$out" -pass file:"$key"

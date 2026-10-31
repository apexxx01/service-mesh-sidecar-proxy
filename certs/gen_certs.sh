#!/usr/bin/env bash
# Creates a private mesh CA + one identity cert per service, plus a ROGUE CA/cert for attack tests.
set -euo pipefail
cd "$(dirname "$0")"
rm -f *.pem *.srl *.csr *.cnf

mkca() {  # name
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 365 \
    -keyout "$1-key.pem" -out "$1.pem" -subj "/CN=$1" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
}
mkcert() {  # cn ca
  printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n" > "$1.cnf"
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$1-key.pem" -out "$1.csr" -subj "/CN=$1" 2>/dev/null
  openssl x509 -req -in "$1.csr" -CA "$2.pem" -CAkey "$2-key.pem" -CAcreateserial \
    -days 30 -out "$1.pem" -extfile "$1.cnf" 2>/dev/null
  rm -f "$1.csr" "$1.cnf"
}

mkca mesh-ca
mkcert service-a mesh-ca      # allowed caller
mkcert service-b mesh-ca      # the protected service
mkcert service-c mesh-ca      # valid mesh identity, but NOT on service-b's allowlist
mkca rogue-ca
mkcert attacker rogue-ca      # cert signed by an untrusted CA
rm -f *.srl
echo "certs generated: $(ls *.pem | tr '\n' ' ')"

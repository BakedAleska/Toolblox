#!/bin/sh
# Creates the self-signed "Toolblox Development" code signing certificate in the login keychain,
# once per Mac. `scripts/cargo-macos.sh` signs debug builds with it, so Keychain recognizes each
# rebuild as the same app. The certificate only signs local builds and isn't trusted for anything.
set -eu
name="Toolblox Development"
keychain="$HOME/Library/Keychains/login.keychain-db"
if security find-certificate -c "$name" "$keychain" >/dev/null 2>&1; then
  echo "$name already exists."
  exit 0
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/certificate.cnf" <<CONFIG
[req]
distinguished_name = name
x509_extensions = extensions
prompt = no
[name]
CN = $name
[extensions]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CONFIG
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/certificate.cnf" \
  -keyout "$work/key.pem" -out "$work/certificate.pem" 2>/dev/null
password=$(/usr/bin/openssl rand -hex 16)
/usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/certificate.pem" -name "$name" \
  -passout "pass:$password" -out "$work/certificate.p12"
security import "$work/certificate.p12" -k "$keychain" -P "$password" -T /usr/bin/codesign
echo "Created $name. The next debug build is signed with it."

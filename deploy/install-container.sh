#!/bin/bash
# Zet Kijkbox neer in een (nieuwe) Debian-container. Wordt door het installatiescript aangeroepen,
# vanuit de broncode in /opt/kijkbox-src (op een versie met geldige handtekening).
set -euo pipefail

SRC=/opt/kijkbox-src
APP=/opt/kijkbox
DATA=/var/lib/kijkbox
ETC=/etc/kijkbox
NODE_MAJOR_MIN=24

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

say "Onderdelen installeren (FFmpeg)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ffmpeg curl ca-certificates gnupg >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR_MIN" ]; then
  say "Node.js installeren"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node.js $(node --version), $(ffmpeg -version | head -1 | cut -d' ' -f1-3)"

say "Kijkbox neerzetten"
id kijkbox >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin kijkbox
install -d -o kijkbox -g kijkbox -m 0750 "$DATA"
install -d -m 0755 "$ETC"
rm -rf "$APP"
mkdir -p "$APP"
cp -a "$SRC/server" "$SRC/public" "$SRC/deploy" "$SRC/package.json" "$SRC/package-lock.json" "$APP/"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$APP"

if [ ! -f "$ETC/kijkbox.env" ]; then
  cat > "$ETC/kijkbox.env" <<'EOF'
# Instellingen van Kijkbox. Na wijzigen: systemctl restart kijkbox
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
DATA_DIR=/var/lib/kijkbox
# Achter een reverse proxy kan dit ook in de website (Instellingen > Netwerk). Hier ingevuld gaat voor.
#TRUST_PROXY=192.168.1.5
EOF
fi

say "Service en automatische updates instellen"
install -m 0644 "$APP"/deploy/systemd/*.service "$APP"/deploy/systemd/*.timer "$APP"/deploy/systemd/*.path /etc/systemd/system/
install -m 0755 "$APP/deploy/kijkbox-update" /usr/local/bin/kijkbox-update
systemctl daemon-reload
systemctl enable --now kijkbox.service kijkbox-update.timer kijkbox-update-request.path >/dev/null 2>&1
/usr/local/bin/kijkbox-update check >/dev/null 2>&1 || true

say "Wachten tot Kijkbox draait"
for _ in $(seq 1 30); do
  curl -fs -o /dev/null "http://127.0.0.1:3000/api/state" && break
  sleep 1
done
systemctl is-active --quiet kijkbox || { echo "Kijkbox start niet. Zie: journalctl -u kijkbox"; exit 1; }
CODE="$(journalctl -u kijkbox --no-pager -o cat | grep -o 'Installatiecode voor het eerste account: *[A-F0-9]*' | tail -1 | grep -o '[A-F0-9]*$' || true)"
echo "KIJKBOX_SETUP_CODE=${CODE}"

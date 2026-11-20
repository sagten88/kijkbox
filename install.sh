#!/usr/bin/env bash
# Kijkbox installeren op Proxmox VE.
# Uitvoeren in de shell van de Proxmox-host (als root):
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/sagten88/kijkbox/main/install.sh)"
#
# Maakt een Debian 13-container, zet Kijkbox erin en stelt automatische updates in.
# De code komt uit de openbare repository; alleen versies met een geldige handtekening van de
# uitgever worden geïnstalleerd, nu en bij elke update.
set -euo pipefail

REPO="https://github.com/sagten88/kijkbox.git"

# Alleen versies met deze handtekening worden geïnstalleerd.
ALLOWED_SIGNERS='release@kijkbox namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ/JQkEyguheAlzgd1t9/UpeSjQliolmtkJmL64alr8D'

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mFout: %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { local answer; read -r -p "$1 [$2]: " answer </dev/tty; echo "${answer:-$2}"; }
in_ct() { pct exec "$CTID" -- "$@"; }

[ "$(id -u)" -eq 0 ] || fail "voer dit uit als root op de Proxmox-host."
command -v pct >/dev/null && command -v pveam >/dev/null || fail "dit is geen Proxmox VE-host."

cat <<'EOF'

  Kijkbox installeren
  -------------------
  Dit maakt een nieuwe container met Kijkbox. Druk bij elke vraag op Enter voor de standaardwaarde.

EOF

CTID="$(ask 'Containernummer' "$(pvesh get /cluster/nextid)")"
pct status "$CTID" >/dev/null 2>&1 && fail "container $CTID bestaat al."
NAME="$(ask 'Naam' 'kijkbox')"
CORES="$(ask 'Processorkernen' '4')"
MEMORY="$(ask 'Geheugen in MB' '4096')"
DISK="$(ask 'Schijfruimte in GB' '8')"
STORAGES="$(pvesm status -content rootdir -enabled 2>/dev/null | awk 'NR > 1 { print $1 }' | xargs)"
[ -n "$STORAGES" ] || fail "geen opslag gevonden waar containers op kunnen."
STORAGE="$(ask "Opslag voor de container ($STORAGES)" "$(echo "$STORAGES" | cut -d' ' -f1)")"
BRIDGE="$(ask 'Netwerkbrug' 'vmbr0')"
IP="$(ask 'IP-adres (dhcp, of bijvoorbeeld 192.168.1.50/24)' 'dhcp')"
NET="name=eth0,bridge=$BRIDGE,ip=$IP"
if [ "$IP" != "dhcp" ]; then
  GATEWAY="$(ask 'Gateway (router)' "$(ip route | awk '/^default/ { print $3; exit }')")"
  NET="$NET,gw=$GATEWAY"
fi
GPU=n
if [ -e /dev/dri/renderD128 ]; then
  GPU="$(ask 'Videochip (Intel QuickSync) doorgeven aan de container? (j/n)' 'n')"
fi

say "Debian 13-sjabloon ophalen"
pveam update >/dev/null
# Het sjabloon moet bij de processor van de host passen (amd64 of arm64); er staan er meerdere in de lijst.
ARCH="$(dpkg --print-architecture)"
TEMPLATE="$(pveam available --section system | awk -v arch="$ARCH" '$2 ~ ("^debian-13-standard_.*_" arch "\\.tar") { print $2 }' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || fail "geen Debian 13-sjabloon voor $ARCH gevonden."
echo "Sjabloon: $TEMPLATE"
TSTORE="$(pvesm status -content vztmpl -enabled | awk 'NR > 1 { print $1; exit }')"
pveam list "$TSTORE" | grep -q "$TEMPLATE" || pveam download "$TSTORE" "$TEMPLATE" >/dev/null

say "Container $CTID aanmaken"
pct create "$CTID" "$TSTORE:vztmpl/$TEMPLATE" \
  --hostname "$NAME" --cores "$CORES" --memory "$MEMORY" --swap 512 \
  --rootfs "$STORAGE:$DISK" --net0 "$NET" \
  --unprivileged 1 --features nesting=1 --onboot 1 --ostype debian --arch "$ARCH" --timezone host \
  --description "Kijkbox IPTV-website" >/dev/null
case "$GPU" in j|J|ja|y|yes) pct set "$CTID" --dev0 /dev/dri/renderD128,mode=0666 >/dev/null ;; esac
pct start "$CTID"

say "Wachten op internet in de container"
for _ in $(seq 1 60); do in_ct getent hosts github.com >/dev/null 2>&1 && break; sleep 2; done
in_ct getent hosts github.com >/dev/null 2>&1 || fail "de container heeft geen internet. Controleer het netwerk en probeer opnieuw."

say "Basisonderdelen installeren"
# openssh-client is nodig voor ssh-keygen: daarmee controleert git de handtekening van een versie.
in_ct bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git openssh-client ca-certificates locales >/dev/null'

say "Sleutel van de uitgever klaarzetten"
in_ct install -d -m 0755 /etc/kijkbox
printf '%s\n' "$ALLOWED_SIGNERS" | in_ct bash -c 'cat > /etc/kijkbox/allowed_signers'

say "Kijkbox ophalen (alleen versies met een geldige handtekening)"
in_ct env GIT_TERMINAL_PROMPT=0 git clone --quiet "$REPO" /opt/kijkbox-src \
  || fail "Kijkbox ophalen van GitHub lukte niet. Controleer de internetverbinding en probeer opnieuw (container $CTID blijft bestaan; verwijderen: pct destroy $CTID --purge)."
in_ct bash -c '
  cd /opt/kijkbox-src
  for tag in $(git tag -l "v[0-9]*" --sort=-v:refname); do
    if git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=/etc/kijkbox/allowed_signers verify-tag "$tag" >/dev/null 2>&1; then
      git -c advice.detachedHead=false checkout --quiet "$tag" && echo "Versie ${tag#v}" && exit 0
    fi
  done
  echo "Geen versie met een geldige handtekening gevonden." >&2
  exit 1
'

say "Kijkbox installeren"
OUTPUT="$(in_ct bash /opt/kijkbox-src/deploy/install-container.sh | tee /dev/tty)"
CODE="$(printf '%s\n' "$OUTPUT" | sed -n 's/^KIJKBOX_SETUP_CODE=//p' | tail -1)"
ADDRESS="$(in_ct hostname -I | awk '{ print $1 }')"

cat <<EOF

  ✔ Kijkbox is geïnstalleerd in container $CTID.

  Open:              http://$ADDRESS:3000
  Installatiecode:   ${CODE:-zie: pct exec $CTID -- journalctl -u kijkbox | grep Installatiecode}

  Maak met die code het eerste (beheerders)account aan en voeg bij Instellingen > Bronnen
  je eigen IPTV-provider toe.

  Kijkbox werkt eerst alleen op je thuisnetwerk. Wil je hem ook buiten huis gebruiken, zet
  hem dan achter een reverse proxy met https en vul bij Instellingen > Netwerk het IP-adres
  van die proxy in.

  Updates: bij Instellingen > Updates, of in de container:  kijkbox-update install

EOF

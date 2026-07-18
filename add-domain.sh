#!/usr/bin/env bash
# add-domain.sh — Tambah domain baru ke catch-all yang sudah ada (via catchall.sh).
# Semua email ke domain baru ikut masuk ke mailbox sink yang sama.
#
# Usage: sudo bash add-domain.sh <domain-baru>
#        sudo bash add-domain.sh --remove <domain>   (hapus domain)
set -euo pipefail

CFG=/etc/catchall/config
[[ -f "$CFG" ]] || { echo "config tidak ada — jalankan catchall.sh dulu"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "harus root (sudo)"; exit 1; }
# shellcheck disable=SC1090
source "$CFG"

REMOVE=0
if [[ "${1:-}" == "--remove" ]]; then REMOVE=1; shift; fi
DOMAIN="$(echo "${1:-}" | xargs)"
[[ -z "$DOMAIN" ]] && { echo "usage: sudo bash add-domain.sh [--remove] <domain>"; exit 1; }

# Susun ulang daftar domain
IFS=',' read -ra LIST <<< "$DOMAINS"
NEW=()
for d in "${LIST[@]}"; do d="$(echo "$d" | xargs)"; [[ -z "$d" ]] && continue
  [[ "$d" == "$DOMAIN" ]] && continue   # buang dulu (biar tidak dobel)
  NEW+=("$d")
done
if [[ "$REMOVE" == "0" ]]; then NEW+=("$DOMAIN"); fi

# Tulis ulang vdomains + valiases dari daftar
: > /etc/postfix/vdomains
: > /etc/postfix/valiases
for d in "${NEW[@]}"; do
  echo -e "${d}\tOK"       >> /etc/postfix/vdomains
  echo -e "@${d}\t${SINK}" >> /etc/postfix/valiases
done
postmap /etc/postfix/vdomains
postmap /etc/postfix/valiases
systemctl reload postfix

# Simpan daftar baru ke config
NEW_CSV="$(IFS=,; echo "${NEW[*]}")"
sed -i "s|^DOMAINS=.*|DOMAINS=${NEW_CSV}|" "$CFG"

echo "OK. Domain aktif sekarang: ${NEW_CSV}"
[[ "$REMOVE" == "0" ]] && echo "Jangan lupa set DNS MX untuk ${DOMAIN} -> ${MAIL_HOST} (priority 10)"

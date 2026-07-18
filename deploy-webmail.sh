#!/usr/bin/env bash
# deploy-webmail.sh — Deploy webmail-custom (Bun) + nginx + TLS.
# Jalankan SETELAH catchall.sh (butuh /etc/catchall/config).
#
# Webmail bisa dibuka di domain utama atau subdomain, mis:
#   sudo bash deploy-webmail.sh domainmu.com            (domain utama)
#   sudo bash deploy-webmail.sh mail.domainmu.com       (subdomain)
#   sudo bash deploy-webmail.sh domainmu.com 'PasswordLogin'
#
# CATATAN KEAMANAN: service jalan sebagai root supaya bisa kelola domain
# (edit Postfix). Wajib HTTPS + password kuat.
set -euo pipefail

WEB_HOST="${1:-}"
LOGIN_PW="${2:-}"
[[ -z "$WEB_HOST" ]] && { echo "usage: sudo bash deploy-webmail.sh <web-hostname> [password]"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "harus root (sudo)"; exit 1; }

CFG=/etc/catchall/config
[[ -f "$CFG" ]] || { echo "/etc/catchall/config tidak ada — jalankan catchall.sh dulu"; exit 1; }
# shellcheck disable=SC1090
source "$CFG"
[[ -n "${MAIL_DIR:-}" ]] || { echo "MAIL_DIR kosong di config"; exit 1; }

SRC="$(dirname "$0")/webmail-custom"
[[ -d "$SRC" ]] || { echo "folder webmail-custom tidak ketemu di sebelah script ini"; exit 1; }

# Password login: pakai arg, atau generate
if [[ -z "$LOGIN_PW" ]]; then
  LOGIN_PW="$(head -c 15 /dev/urandom | base64 | tr -d '/+=' | cut -c1-16)"
  GENERATED=1
fi

echo "==> Install prasyarat (unzip & curl dibutuhkan bun installer)"
apt-get update -y
apt-get install -y --no-install-recommends nginx certbot python3-certbot-nginx curl unzip

echo "==> Install bun (kalau belum)"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
fi

echo "==> Copy app ke /opt/webmail-custom & install deps"
install -d /opt/webmail-custom/src
install -m 0644 "$SRC/package.json" /opt/webmail-custom/package.json
install -m 0644 "$SRC/src/server.ts" /opt/webmail-custom/src/server.ts
( cd /opt/webmail-custom && bun install --production )

echo "==> systemd service"
cat > /etc/systemd/system/webmail-custom.service <<EOF
[Unit]
Description=webmail-custom
After=network.target dovecot.service postfix.service

[Service]
Type=simple
WorkingDirectory=/opt/webmail-custom
Environment=WEBMAIL_PORT=8080
Environment=WEBMAIL_PASSWORD=${LOGIN_PW}
Environment=MAIL_DIR=${MAIL_DIR}
Environment=CATCHALL_CONFIG=/etc/catchall/config
Environment=WEBMAIL_TITLE=Webmail
ExecStart=/usr/local/bin/bun src/server.ts
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now webmail-custom.service

echo "==> nginx reverse proxy untuk $WEB_HOST"
cat > /etc/nginx/sites-available/webmail-custom <<EOF
server {
    listen 80;
    server_name $WEB_HOST;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/webmail-custom /etc/nginx/sites-enabled/webmail-custom
nginx -t && systemctl reload nginx

echo "==> HTTPS (Let's Encrypt via nginx)"
TLS_OK=0
if certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d "$WEB_HOST"; then
  TLS_OK=1
else
  echo "!! certbot gagal — cek DNS A ($WEB_HOST -> IP VPS) + port 80 terbuka. Webmail sementara HTTP."
fi
systemctl enable nginx >/dev/null 2>&1 || true

echo
echo "======================================================================"
echo " Webmail custom siap."
echo "----------------------------------------------------------------------"
[[ "$TLS_OK" == "1" ]] && echo " URL      : https://$WEB_HOST" || echo " URL      : http://$WEB_HOST  (HTTPS belum aktif — login butuh HTTPS!)"
echo " Password : ${LOGIN_PW}"
[[ "${GENERATED:-0}" == "1" ]] && echo "            (auto-generate — SIMPAN!)"
echo
echo " Di dalam webmail:"
echo "  • Inbox   : baca / hapus email (semua domain jadi satu)"
echo "  • ⚙ Domain: tambah / hapus domain langsung dari browser"
echo
echo " Buka port firewall: 80, 443"
echo "======================================================================"

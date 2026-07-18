#!/usr/bin/env bash
# webmail.sh — Tambah webmail Roundcube (akses inbox lewat browser) di atas
# mail server catch-all yang sudah dibuat oleh catchall.sh.
#
# Jalankan SETELAH catchall.sh sukses (Postfix + Dovecot + IMAP sudah hidup).
# Hasil: buka https://<mail-hostname> di browser -> login pakai email + password
# mailbox catch-all.
#
# Usage:
#   sudo bash webmail.sh <mail-hostname>
#
# Contoh:
#   sudo bash webmail.sh mail.example.com
set -euo pipefail

HOST="${1:-}"
if [[ -z "$HOST" ]]; then
  echo "usage: sudo bash webmail.sh <mail-hostname>   (mis. mail.example.com)"
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "harus dijalankan sebagai root (pakai sudo)"; exit 1
fi

echo "==> Preseed Roundcube (SQLite, auto-config DB, tanpa prompt)"
export DEBIAN_FRONTEND=noninteractive
echo "roundcube-core roundcube/dbconfig-install boolean true"      | debconf-set-selections
echo "roundcube-core roundcube/database-type select sqlite3"        | debconf-set-selections

echo "==> Install nginx + PHP + Roundcube"
apt-get update -y
apt-get install -y --no-install-recommends \
  nginx certbot python3-certbot-nginx \
  php-fpm php-cli php-json php-mbstring php-xml php-intl php-zip php-gd php-sqlite3 \
  roundcube-core roundcube-sqlite3 roundcube-plugins

# ---- Docroot Roundcube (beda antar versi 1.5 vs 1.6) ----
if [[ -f /var/lib/roundcube/public_html/index.php ]]; then
  RC_ROOT=/var/lib/roundcube/public_html
else
  RC_ROOT=/var/lib/roundcube
fi
echo "==> Roundcube docroot: $RC_ROOT"

# ---- Arahkan Roundcube ke IMAP/SMTP lokal ----
RC_CONF=/etc/roundcube/config.inc.php
echo "==> Konfigurasi IMAP/SMTP di $RC_CONF"
cat >> "$RC_CONF" <<'PHPEOF'

// --- Ditambahkan oleh webmail.sh: sambung ke Dovecot/Postfix lokal ---
$config['imap_host'] = 'ssl://localhost:993';
$config['imap_conn_options'] = [
  'ssl' => ['verify_peer' => false, 'verify_peer_name' => false],
];
// Kirim email lewat Postfix lokal. Server ini INBOUND-ONLY, jadi reply ke
// alamat luar akan ditolak — wajar. Untuk sekadar baca email, abaikan.
$config['smtp_host'] = 'localhost:25';
$config['smtp_user'] = '';
$config['smtp_pass'] = '';
$config['product_name'] = 'Webmail';
PHPEOF

# ---- Socket PHP-FPM (versi PHP beda-beda) ----
PHP_SOCK="$(ls /run/php/php*-fpm.sock 2>/dev/null | head -1 || true)"
if [[ -z "$PHP_SOCK" ]]; then
  echo "!! socket PHP-FPM tidak ketemu — cek: systemctl status php*-fpm"; exit 1
fi
echo "==> PHP-FPM socket: $PHP_SOCK"

# ---- Sertifikat: pakai punya catchall.sh kalau ada, kalau tidak ambil baru ----
CERT_DIR="/etc/letsencrypt/live/$HOST"
HAVE_CERT=0
[[ -f "$CERT_DIR/fullchain.pem" ]] && HAVE_CERT=1

write_vhost_ssl() {
cat > /etc/nginx/sites-available/webmail <<EOF
server {
    listen 80;
    server_name $HOST;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    server_name $HOST;

    ssl_certificate     $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;

    root $RC_ROOT;
    index index.php;
    client_max_body_size 25M;

    location / { try_files \$uri \$uri/ /index.php?\$query_string; }
    location ~ \.php\$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:$PHP_SOCK;
    }
    location ~ ^/(config|temp|logs)/ { deny all; }
    location ~ /\. { deny all; }
}
EOF
}

write_vhost_http() {
cat > /etc/nginx/sites-available/webmail <<EOF
server {
    listen 80;
    server_name $HOST;

    root $RC_ROOT;
    index index.php;
    client_max_body_size 25M;

    location / { try_files \$uri \$uri/ /index.php?\$query_string; }
    location ~ \.php\$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:$PHP_SOCK;
    }
    location ~ ^/(config|temp|logs)/ { deny all; }
    location ~ /\. { deny all; }
}
EOF
}

echo "==> Setup nginx vhost untuk $HOST"
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/webmail /etc/nginx/sites-enabled/webmail

if [[ "$HAVE_CERT" == "1" ]]; then
  write_vhost_ssl
  nginx -t && systemctl reload nginx
else
  # Belum ada cert: pasang HTTP dulu, lalu certbot --nginx untuk nambah HTTPS
  write_vhost_http
  nginx -t && systemctl reload nginx
  echo "==> Minta sertifikat Let's Encrypt via nginx"
  if certbot --nginx --non-interactive --agree-tos \
       --register-unsafely-without-email --redirect -d "$HOST"; then
    HAVE_CERT=1
  else
    echo "!! certbot gagal — webmail sementara jalan di HTTP (http://$HOST). Cek DNS A + port 80."
  fi
fi

systemctl enable nginx >/dev/null 2>&1 || true

echo
echo "======================================================================"
echo " Webmail Roundcube siap."
echo "----------------------------------------------------------------------"
if [[ "$HAVE_CERT" == "1" ]]; then
  echo " Buka di browser : https://$HOST"
else
  echo " Buka di browser : http://$HOST   (HTTPS belum aktif — lihat pesan di atas)"
fi
echo " Login           : email lengkap  (mis. catchall@domainmu.com)"
echo " Password        : password mailbox dari catchall.sh"
echo
echo " Catatan:"
echo " - Ini INBOUND-ONLY: baca email jalan; kirim/reply ke luar akan ditolak."
echo " - IMAP di tmail tetap jalan seperti biasa (port 993)."
echo " - Pastikan port 80 & 443 terbuka di firewall VPS/provider."
echo "======================================================================"

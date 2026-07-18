#!/usr/bin/env bash
# catchall.sh — Minimal catch-all mail server (Postfix + Dovecot IMAP) on Ubuntu 22.04/24.04
#
# Nangkap SEMUA email masuk ke SATU/BANYAK domain, semua dikumpulkan ke satu
# mailbox (unified inbox), dibaca via IMAP atau webmail-custom.
# TANPA panel web, TANPA Supabase, TANPA agent. Inbound-only (bukan SMTP relay).
#
# Usage:
#   sudo bash catchall.sh <mail-hostname> <domain1[,domain2,...]> [mailbox-local] [password]
#
# Contoh:
#   sudo bash catchall.sh mail.example.com example.com
#   sudo bash catchall.sh mail.example.com example.com,foo.com,bar.net inbox 'PasswordKu'
#     -> semua email ke ketiga domain masuk ke inbox@example.com
set -euo pipefail

MAIL_HOST="${1:-}"
DOMAINS_CSV="${2:-}"
LOCAL="${3:-catchall}"
PASSWORD="${4:-}"

if [[ -z "$MAIL_HOST" || -z "$DOMAINS_CSV" ]]; then
  echo "usage: sudo bash catchall.sh <mail-hostname> <domain1[,domain2,...]> [mailbox-local] [password]"
  echo "  e.g. sudo bash catchall.sh mail.example.com example.com,foo.com"
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "harus dijalankan sebagai root (pakai sudo)"; exit 1
fi

# Pisah domain (comma-separated) -> array
IFS=',' read -ra DOMAINS <<< "$DOMAINS_CSV"
PRIMARY="${DOMAINS[0]}"
SINK="${LOCAL}@${PRIMARY}"          # semua email dikumpulkan ke sini
MAIL_DIR="/var/mail/vhosts/${PRIMARY}/${LOCAL}"

echo "==> Update apt & install paket"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  postfix postfix-pcre dovecot-imapd dovecot-lmtpd \
  certbot ca-certificates

# ---- User & direktori mail ----
id -u vmail >/dev/null 2>&1 || useradd -r -u 5000 -M -d /var/mail/vhosts -s /usr/sbin/nologin vmail
install -d -o vmail -g vmail /var/mail/vhosts

# ---- Password: generate kalau kosong ----
if [[ -z "$PASSWORD" ]]; then
  PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)"
  GENERATED=1
fi
HASH="$(doveadm pw -s SHA512-CRYPT -p "$PASSWORD")"

# ---- Let's Encrypt (best-effort; butuh DNS A + port 80 terbuka) ----
CERT_DIR="/etc/letsencrypt/live/$MAIL_HOST"
if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
  echo "==> Minta sertifikat Let's Encrypt untuk $MAIL_HOST (butuh port 80 + DNS A sudah benar)"
  certbot certonly --standalone --non-interactive --agree-tos \
    --register-unsafely-without-email -d "$MAIL_HOST" || \
    echo "!! certbot gagal — lanjut pakai self-signed (client mungkin minta 'accept invalid cert')"
fi
if [[ -f "$CERT_DIR/fullchain.pem" ]]; then
  SSL_CERT="$CERT_DIR/fullchain.pem"; SSL_KEY="$CERT_DIR/privkey.pem"; TLS_REAL=1
else
  SSL_CERT="/etc/ssl/certs/ssl-cert-snakeoil.pem"; SSL_KEY="/etc/ssl/private/ssl-cert-snakeoil.key"; TLS_REAL=0
fi

# ---- Postfix: inbound-only, no relay ----
echo "==> Konfigurasi Postfix"
postconf -e "myhostname = $MAIL_HOST"
postconf -e "mydestination = localhost"
postconf -e "virtual_mailbox_domains = hash:/etc/postfix/vdomains"
postconf -e "virtual_mailbox_maps = hash:/etc/postfix/vmailbox"
postconf -e "virtual_alias_maps = hash:/etc/postfix/valiases"
postconf -e "virtual_transport = lmtp:unix:private/dovecot-lmtp"
postconf -e "smtpd_relay_restrictions = permit_mynetworks reject_unauth_destination"
# Saringan spam dasar (murah, tanpa software tambahan): tolak pengirim/penerima
# yang tidak valid & domain pengirim yang tidak ada DNS-nya.
postconf -e "smtpd_recipient_restrictions = permit_mynetworks, reject_non_fqdn_recipient, reject_unauth_destination, reject_non_fqdn_sender, reject_unknown_sender_domain"
postconf -e "message_size_limit = 26214400"
postconf -e "smtpd_tls_cert_file = $SSL_CERT"
postconf -e "smtpd_tls_key_file = $SSL_KEY"
postconf -e "smtpd_use_tls = yes"
postconf -e "smtpd_tls_security_level = may"

# Virtual maps — SEMUA domain -> satu mailbox (sink)
: > /etc/postfix/vdomains
: > /etc/postfix/valiases
echo -e "${SINK}\t${PRIMARY}/${LOCAL}/" > /etc/postfix/vmailbox
for d in "${DOMAINS[@]}"; do
  d="$(echo "$d" | xargs)"   # trim spasi
  [[ -z "$d" ]] && continue
  echo -e "${d}\tOK"        >> /etc/postfix/vdomains
  echo -e "@${d}\t${SINK}"  >> /etc/postfix/valiases   # catch-all: *@domain -> sink
done
postmap /etc/postfix/vdomains
postmap /etc/postfix/vmailbox
postmap /etc/postfix/valiases

# ---- Dovecot ----
echo "==> Konfigurasi Dovecot"
cat > /etc/dovecot/conf.d/99-catchall.conf <<EOF
protocols = imap lmtp
mail_location = maildir:/var/mail/vhosts/%d/%n
mail_uid = vmail
mail_gid = vmail
first_valid_uid = 5000
last_valid_uid = 5000

disable_plaintext_auth = no
auth_mechanisms = plain login

passdb {
  driver = passwd-file
  args = scheme=SHA512-CRYPT username_format=%u /etc/dovecot/users
}
userdb {
  driver = static
  args = uid=vmail gid=vmail home=/var/mail/vhosts/%d/%n
}

service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}

service imap-login {
  inet_listener imap {
    port = 143
  }
  inet_listener imaps {
    port = 993
    ssl = yes
  }
}

ssl = yes
ssl_cert = <$SSL_CERT
ssl_key = <$SSL_KEY
ssl_min_protocol = TLSv1.2
EOF

echo "${SINK}:${HASH}" > /etc/dovecot/users
chmod 640 /etc/dovecot/users
chown root:dovecot /etc/dovecot/users || true

# ---- Simpan config (dipakai add-domain.sh & deploy-webmail.sh) ----
install -d /etc/catchall
cat > /etc/catchall/config <<EOF
MAIL_HOST=$MAIL_HOST
PRIMARY=$PRIMARY
LOCAL=$LOCAL
SINK=$SINK
MAIL_DIR=$MAIL_DIR
DOMAINS=$DOMAINS_CSV
MAILBOX_PW=$PASSWORD
EOF
chmod 600 /etc/catchall/config

# ---- Restart ----
echo "==> Restart Postfix & Dovecot"
systemctl restart postfix
systemctl restart dovecot
systemctl enable postfix dovecot >/dev/null 2>&1 || true

IP="$(hostname -I | awk '{print $1}')"
echo
echo "======================================================================"
echo " Catch-all mail server siap. Semua domain -> satu mailbox."
echo "----------------------------------------------------------------------"
echo " Domain aktif : $DOMAINS_CSV"
echo " Mailbox (sink): ${SINK}"
echo " Maildir       : ${MAIL_DIR}"
echo
echo " Setelan IMAP (tmail / email client):"
echo "   Host: ${MAIL_HOST}   Port: 993   Encryption: SSL/TLS"
echo "   Username: ${SINK}"
echo "   Password: ${PASSWORD}"
[[ "${GENERATED:-0}" == "1" ]] && echo "            (auto-generate — SIMPAN sekarang!)"
echo
[[ "$TLS_REAL" == "1" ]] && echo "   TLS: Let's Encrypt (valid) ✅" || \
  echo "   TLS: self-signed ⚠️  (aktifkan 'accept invalid cert' di client, atau jalankan certbot ulang)"
echo "----------------------------------------------------------------------"
echo " DNS untuk SETIAP domain (di provider DNS):"
echo "   A    mail    ${IP}                (sekali saja untuk ${MAIL_HOST})"
for d in "${DOMAINS[@]}"; do d="$(echo "$d" | xargs)"; [[ -z "$d" ]] && continue
  echo "   MX   @  ->  ${MAIL_HOST}  (priority 10)   untuk domain: ${d}"
done
echo
echo " Buka port firewall: 25, 80, 143, 993   (+ 443 kalau pakai webmail)"
echo
echo " Tambah domain lain nanti : sudo bash add-domain.sh <domain-baru>"
echo " Pasang webmail browser   : sudo bash deploy-webmail.sh"
echo "======================================================================"

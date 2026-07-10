#!/usr/bin/env bash
# MailCatch VPS installer — Ubuntu 22.04/24.04
# Installs Postfix (SMTP inbound only) + Dovecot (IMAP) + MailCatch agent.
# NO outbound SMTP. Optionally provisions Let's Encrypt TLS for IMAPS + STARTTLS.
#
# Usage:  sudo bash install.sh <mail-hostname> <panel-url>
#   e.g.  sudo bash install.sh mail.imapku.web.id https://panel.example.com
set -euo pipefail

HOSTNAME="${1:-}"
PANEL_URL="${2:-}"
if [[ -z "$HOSTNAME" || -z "$PANEL_URL" ]]; then
  echo "usage: sudo bash install.sh <mail-hostname> <panel-url>"
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "must run as root"; exit 1
fi

echo "==> Updating apt"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  postfix postfix-pcre dovecot-imapd dovecot-lmtpd \
  curl unzip ca-certificates jq certbot

# ---- Bun ----
if ! command -v bun >/dev/null 2>&1; then
  echo "==> Installing bun"
  curl -fsSL https://bun.sh/install | bash
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
fi

# ---- Users & dirs ----
id -u vmail >/dev/null 2>&1 || useradd -r -u 5000 -M -d /var/mail/vhosts -s /usr/sbin/nologin vmail
install -d -o vmail -g vmail /var/mail/vhosts
install -d /etc/mailcatch /opt/mailcatch /var/log/mailcatch
chmod 700 /etc/mailcatch

# ---- Shared secret ----
SECRET_FILE=/etc/mailcatch/secret
if [[ ! -s "$SECRET_FILE" ]]; then
  head -c 32 /dev/urandom | xxd -p -c 64 > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
fi
SECRET="$(cat "$SECRET_FILE")"

# ---- Agent env ----
cat > /etc/mailcatch/agent.env <<EOF
PANEL_URL=$PANEL_URL
AGENT_PORT=8787
MAIL_HOSTNAME=$HOSTNAME
SHARED_SECRET=$SECRET
POSTFIX_VDOMAINS=/etc/postfix/vdomains
POSTFIX_VMAILBOX=/etc/postfix/vmailbox
POSTFIX_VALIASES=/etc/postfix/valiases
DOVECOT_PASSWD=/etc/dovecot/users
MAIL_ROOT=/var/mail/vhosts
EOF
chmod 600 /etc/mailcatch/agent.env

# ---- Let's Encrypt (best-effort; port 80 must be open + DNS pointing here) ----
CERT_DIR="/etc/letsencrypt/live/$HOSTNAME"
if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
  echo "==> Requesting Let's Encrypt cert for $HOSTNAME (needs port 80 open + DNS)"
  certbot certonly --standalone --non-interactive --agree-tos \
    --register-unsafely-without-email -d "$HOSTNAME" || \
    echo "!! certbot failed — continuing without TLS (IMAPS/STARTTLS disabled)"
fi

# ---- Postfix: inbound-only, no relay ----
postconf -e "myhostname = $HOSTNAME"
postconf -e "mydestination = localhost"
postconf -e "virtual_mailbox_domains = hash:/etc/postfix/vdomains"
postconf -e "virtual_mailbox_maps = hash:/etc/postfix/vmailbox"
postconf -e "virtual_alias_maps = hash:/etc/postfix/valiases"
postconf -e "virtual_transport = lmtp:unix:private/dovecot-lmtp"
postconf -e "smtpd_relay_restrictions = permit_mynetworks reject_unauth_destination"
postconf -e "smtpd_recipient_restrictions = permit_mynetworks reject_unauth_destination"
# Message size limit (25MB)
postconf -e "message_size_limit = 26214400"

# STARTTLS on port 25 (opportunistic) when cert exists
if [[ -f "$CERT_DIR/fullchain.pem" ]]; then
  postconf -e "smtpd_tls_cert_file = $CERT_DIR/fullchain.pem"
  postconf -e "smtpd_tls_key_file = $CERT_DIR/privkey.pem"
  postconf -e "smtpd_use_tls = yes"
  postconf -e "smtpd_tls_security_level = may"
  postconf -e "smtpd_tls_loglevel = 1"
fi

touch /etc/postfix/vdomains /etc/postfix/vmailbox /etc/postfix/valiases
postmap /etc/postfix/vdomains
postmap /etc/postfix/vmailbox
postmap /etc/postfix/valiases

# ---- Dovecot ----
if [[ -f "$CERT_DIR/fullchain.pem" ]]; then
  SSL_BLOCK=$(cat <<EOF
ssl = yes
ssl_cert = <$CERT_DIR/fullchain.pem
ssl_key = <$CERT_DIR/privkey.pem
ssl_min_protocol = TLSv1.2
EOF
)
else
  SSL_BLOCK="ssl = no"
fi

cat > /etc/dovecot/conf.d/99-mailcatch.conf <<EOF
protocols = imap lmtp
mail_location = maildir:/var/mail/vhosts/%d/%n
mail_uid = vmail
mail_gid = vmail
first_valid_uid = 5000
last_valid_uid = 5000

disable_plaintext_auth = no
auth_mechanisms = plain login

passdb { driver = passwd-file
  args = scheme=SHA512-CRYPT username_format=%u /etc/dovecot/users
}
userdb { driver = static
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
  inet_listener imap  { port = 143 }
  inet_listener imaps { port = 993; ssl = yes }
}

$SSL_BLOCK
EOF

touch /etc/dovecot/users
chmod 640 /etc/dovecot/users
chown root:dovecot /etc/dovecot/users || true

# ---- Agent files ----
install -m 0644 -T "$(dirname "$0")/agent/package.json" /opt/mailcatch/package.json
mkdir -p /opt/mailcatch/src
install -m 0644 "$(dirname "$0")/agent/src/"*.ts /opt/mailcatch/src/
( cd /opt/mailcatch && bun install --production )

# ---- systemd ----
install -m 0644 -T "$(dirname "$0")/agent/systemd/mailcatch-agent.service" /etc/systemd/system/mailcatch-agent.service
systemctl daemon-reload
systemctl enable --now mailcatch-agent.service

# ---- Postfix pipe -> push inbound to panel ----
cat > /etc/postfix/master.cf.append <<'EOF'
mailcatch  unix  -       n       n       -       -       pipe
  flags=DRhu user=vmail argv=/usr/local/bin/mailcatch-pipe ${recipient} ${sender}
EOF
grep -q '^mailcatch' /etc/postfix/master.cf || cat /etc/postfix/master.cf.append >> /etc/postfix/master.cf
rm -f /etc/postfix/master.cf.append

cat > /usr/local/bin/mailcatch-pipe <<'EOF'
#!/usr/bin/env bash
set -e
RECIPIENT="$1"; SENDER="$2"
BODY="$(cat)"
curl -fsS --max-time 15 -X POST "http://127.0.0.1:8787/ingest" \
  -H "Content-Type: application/json" \
  --data "$(jq -Rn --arg to "$RECIPIENT" --arg from "$SENDER" --arg raw "$BODY" \
    '{to:$to,from:$from,raw:$raw}')" >/dev/null || true
EOF
chmod +x /usr/local/bin/mailcatch-pipe

systemctl restart postfix
systemctl restart dovecot

echo
echo "======================================================================"
echo " MailCatch agent installed."
echo " Agent URL   : http://$(hostname -I | awk '{print $1}'):8787"
echo " Mail host   : $HOSTNAME"
echo " Panel URL   : $PANEL_URL"
echo " Shared key  : $SECRET"
if [[ -f "$CERT_DIR/fullchain.pem" ]]; then
  echo " TLS         : enabled (IMAPS :993, STARTTLS :25)"
else
  echo " TLS         : DISABLED — run certbot manually after DNS is ready:"
  echo "               certbot certonly --standalone -d $HOSTNAME"
fi
echo "----------------------------------------------------------------------"
echo " Paste the shared key into Panel -> Settings -> VPS Agent."
echo "======================================================================"

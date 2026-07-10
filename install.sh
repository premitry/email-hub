#!/usr/bin/env bash
# MailCatch VPS installer — Ubuntu 22.04/24.04
# Installs Postfix + Dovecot + the MailCatch agent, and prints the shared secret.
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
  curl unzip ca-certificates jq

# ---- Bun (runtime for agent) ----
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

# ---- Config file ----
cat > /etc/mailcatch/agent.env <<EOF
PANEL_URL=$PANEL_URL
AGENT_PORT=8787
MAIL_HOSTNAME=$HOSTNAME
SHARED_SECRET=$SECRET
POSTFIX_VDOMAINS=/etc/postfix/vdomains
POSTFIX_VMAILBOX=/etc/postfix/vmailbox
DOVECOT_PASSWD=/etc/dovecot/users
MAIL_ROOT=/var/mail/vhosts
EOF
chmod 600 /etc/mailcatch/agent.env

# ---- Postfix minimal config ----
postconf -e "myhostname = $HOSTNAME"
postconf -e "mydestination = localhost"
postconf -e "virtual_mailbox_domains = hash:/etc/postfix/vdomains"
postconf -e "virtual_mailbox_maps = hash:/etc/postfix/vmailbox"
postconf -e "virtual_transport = lmtp:unix:private/dovecot-lmtp"
postconf -e "smtpd_relay_restrictions = permit_mynetworks reject_unauth_destination"
postconf -e "smtpd_recipient_restrictions = permit_mynetworks reject_unauth_destination"
touch /etc/postfix/vdomains /etc/postfix/vmailbox
postmap /etc/postfix/vdomains
postmap /etc/postfix/vmailbox

# ---- Dovecot minimal config ----
cat > /etc/dovecot/conf.d/99-mailcatch.conf <<'EOF'
protocols = imap lmtp
mail_location = maildir:/var/mail/vhosts/%d/%n
mail_uid = vmail
mail_gid = vmail
first_valid_uid = 5000
last_valid_uid = 5000

passdb { driver = passwd-file; args = scheme=SHA512-CRYPT username_format=%u /etc/dovecot/users }
userdb { driver = static; args = uid=vmail gid=vmail home=/var/mail/vhosts/%d/%n }

service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}

ssl = yes
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

# ---- Postfix pipe for pushing inbound mail to panel ----
# A transport that forwards each recipient to the agent's local /ingest endpoint.
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

# also LMTP to dovecot for delivery so IMAP has it too — done by virtual_transport.

systemctl restart postfix
systemctl restart dovecot

echo
echo "======================================================================"
echo " MailCatch agent installed."
echo " Agent URL   : http://$(hostname -I | awk '{print $1}'):8787"
echo " Mail host   : $HOSTNAME"
echo " Panel URL   : $PANEL_URL"
echo " Shared key  : $SECRET"
echo "----------------------------------------------------------------------"
echo " Copy the shared key into Panel -> Settings -> VPS Agent."
echo "======================================================================"

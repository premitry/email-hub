# MailCatch VPS Agent — Fase 2 spec

Dokumen ini adalah **kontrak** antara web panel (Fase 1) dan agent kecil yang bakal jalan di VPS Postfix/Dovecot (Fase 2). Belum diimplementasi — cuma referensi biar Fase 2 tinggal ngoding.

## Arsitektur

```
[Web Panel (Lovable / TanStack Start)]
              │  HTTPS + shared secret
              ▼
[Agent (Node/Bun) di VPS] ──┬── Postfix (SMTP inbound :25)
                             ├── Dovecot (IMAP :993)
                             └── Cron cleanup (retensi)
```

## Install script (rencana)

`install.sh` (Ubuntu 22.04/24.04):

```bash
apt-get update && apt-get install -y postfix dovecot-imapd nginx certbot
# Provisi Postfix (main.cf, virtual_mailbox_domains via file yang di-manage agent)
# Provisi Dovecot (auth via passwd-file yang di-manage agent)
# Provisi Let's Encrypt untuk mail.<domain>
# Install agent (bun) sebagai systemd service
# Cetak: agent URL + shared secret (satu kali) → paste ke Settings di panel
```

## API antara panel ↔ agent

Semua request pakai header `Authorization: Bearer <shared-secret>`.

### `GET /health`
Ping. Response `{ ok: true, uptime, version }`.

### `POST /domains/sync`
Sync daftar domain dari panel ke Postfix `virtual_mailbox_domains`.
Body: `{ domains: [{ name, catchall_mailbox }] }`

### `POST /mailboxes/sync`
Sync IMAP user ke Dovecot `passwd` file.
Body: `{ mailboxes: [{ email, password_hash, is_catchall, domain }] }`

### `POST /mailboxes/reset-password`
Body: `{ email, new_password }` → agent hash pakai `doveadm pw` dan update passwd file.

### `POST /retention/apply`
Body: `{ policies: [{ domain, max_age_days, max_count }] }`
Agent jalanin di cron: hapus email > N hari atau di luar N terbaru per mailbox.

### Push dari agent → panel

Ketika email baru masuk (via Postfix pipe transport), agent forward metadata + body ke panel:

`POST <panel-url>/api/public/agent/emails` (bearer = shared secret)

Body:
```json
{ "to": "any@example.com", "from": "sender@x.com", "subject": "...", "body_text": "...", "body_html": "...", "size": 1234, "received_at": "..." }
```

Panel resolve → mailbox_id → insert ke `emails` table.

## Postfix config sketch

```
# /etc/postfix/main.cf
virtual_mailbox_domains = hash:/etc/postfix/vdomains
virtual_transport = lmtp:unix:private/dovecot-lmtp
smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination
# tolak outbound relay
smtpd_relay_restrictions = permit_mynetworks, reject_unauth_destination
```

## Dovecot config sketch

```
# /etc/dovecot/conf.d/10-auth.conf
passdb { driver = passwd-file; args = /etc/dovecot/users }
userdb { driver = static; args = uid=vmail gid=vmail home=/var/mail/vhosts/%d/%n }

# /etc/dovecot/conf.d/10-mail.conf
mail_location = maildir:/var/mail/vhosts/%d/%n
```

## Retention cron (contoh)

```bash
# tiap jam
find /var/mail/vhosts/<domain>/<user>/new -mtime +<max_age_days> -delete
# per mailbox, keep max N (via doveadm expunge)
doveadm expunge -u <email> mailbox INBOX savedbefore <threshold>
```

## Security notes

- Agent bind ke localhost + reverse proxy via nginx dengan TLS
- Shared secret ≥ 32 byte, disimpan di `/etc/mailcatch/secret` mode 0600
- Rate limit endpoint push email (misal 200 req/min)
- Verify HMAC signature di setiap push email

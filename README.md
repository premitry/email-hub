# MailCatch

Self-hosted **catch-all mail server** untuk domain sendiri. Panel web buat manage
domain/mailbox + retensi, mail server (Postfix + Dovecot) jalan di VPS Ubuntu,
akses email pakai IMAP client apa aja (Outlook, Thunderbird, Apple Mail, n8n, dst).

```text
┌──────────────────────────────┐         ┌────────────────────────────┐
│  Web Panel (TanStack Start)  │  HTTPS  │   VPS Ubuntu               │
│  Lovable Cloud (default) or  │◄───────►│   Postfix + Dovecot        │
│  self-hosted di VPS          │  bearer │   mailcatch-agent (Bun)    │
└──────────────────────────────┘         └────────────────────────────┘
        ▲                                          │
        │       POST /api/public/agent/emails      │
        └──────────────  push inbound  ────────────┘
```

**Status: siap dipakai.** Install script sudah include Postfix inbound-only,
Dovecot IMAP/IMAPS, Let's Encrypt otomatis, agent systemd service, catch-all
via `virtual_alias_maps`, MIME parsing pakai `mailparser`, retention cleanup.

---

## Daftar isi

1. [Prasyarat VPS](#1-prasyarat-vps)
2. [Setup DNS](#2-setup-dns)
3. [Install mail server + agent](#3-install-mail-server--agent-di-vps)
4. [Hubungkan panel ke VPS](#4-hubungkan-panel-ke-vps)
5. [Tambah domain + mailbox](#5-tambah-domain--mailbox)
6. [Pakai IMAP di client](#6-pakai-imap-di-email-client)
7. [Panel di VPS (opsional)](#7-jalanin-panel-di-vps-yang-sama-opsional)
8. [Operasional](#8-operasional--troubleshooting)

---

## 1. Prasyarat VPS

**Rekomendasi provider: DigitalOcean** (port 25 tidak diblok, PTR bisa di-set
dari panel). Vendor lain (Linode, Hetzner, Vultr) juga OK. **Hindari** GCP/AWS/
Azure default — port 25 outbound diblok, tapi untuk MailCatch (inbound only)
sebenarnya masih bisa jalan; PTR biasanya perlu ticket.

Spek minimum:

- Ubuntu **22.04 LTS** atau **24.04 LTS**, fresh install
- 1 GB RAM, 25 GB disk ($6/mo cukup buat pemakaian pribadi)
- IPv4 publik statis
- Port yang harus **open di firewall**:
  - `25/tcp`   — SMTP inbound
  - `80/tcp`   — HTTP (dipakai certbot buat issue SSL)
  - `143/tcp`  — IMAP (STARTTLS)
  - `993/tcp`  — IMAPS (TLS)
  - `8787/tcp` — agent (bisa dibatasi ke IP panel aja, atau taruh di belakang nginx/caddy)

Cek port 25 nggak diblok:

```bash
nc -zv gmail-smtp-in.l.google.com 25
# harus keluar "succeeded"
```

---

## 2. Setup DNS

Anggap domainnya `imapku.web.id`, hostname mail server `mail.imapku.web.id`,
IP VPS `203.0.113.10`.

Di **DNS registrar** (Cloudflare / Namecheap / registrar apapun):

| Type | Name / Host        | Value                       | Notes                          |
| ---- | ------------------ | --------------------------- | ------------------------------ |
| A    | `mail`             | `203.0.113.10`              | proxy Cloudflare **OFF (grey)** |
| MX   | `@` (root)         | `mail.imapku.web.id.` prio 10 |                              |
| TXT  | `@`                | `v=spf1 mx ~all`            | SPF                            |

**PTR / Reverse DNS** — di panel VPS provider (DigitalOcean: Droplets →
Networking → PTR), set PTR untuk `203.0.113.10` ke `mail.imapku.web.id`.
PTR yang benar wajib biar email nggak masuk spam.

Verify sebelum lanjut:

```bash
dig +short mail.imapku.web.id           # harus 203.0.113.10
dig +short MX imapku.web.id             # harus mail.imapku.web.id
dig +short -x 203.0.113.10              # harus mail.imapku.web.id.
```

---

## 3. Install mail server + agent di VPS

SSH ke VPS sebagai root:

```bash
ssh root@203.0.113.10
```

Clone repo dan jalanin installer:

```bash
apt-get update && apt-get install -y git
git clone <repo-url> mailcatch && cd mailcatch

# usage: bash install.sh <mail-hostname> <panel-url>
bash install.sh mail.imapku.web.id https://your-panel.lovable.app
```

Yang dilakuin installer:

1. Install Postfix (inbound only, no relay), Dovecot (IMAP + LMTP), Bun, jq, certbot
2. Bikin user `vmail`, direktori `/var/mail/vhosts`
3. Generate **shared secret** (32-byte hex) di `/etc/mailcatch/secret`
4. Request cert **Let's Encrypt** untuk `$HOSTNAME` (butuh port 80 open + DNS udah propagate)
5. Konfig Postfix: `virtual_mailbox_maps`, `virtual_alias_maps` (catch-all),
   LMTP ke Dovecot, STARTTLS di port 25, size limit 25 MB
6. Konfig Dovecot: Maildir per user, passwd-file (SHA512-CRYPT), IMAPS :993
7. Install agent di `/opt/mailcatch`, enable `mailcatch-agent.service`
8. Pasang `mailcatch-pipe` di Postfix master.cf buat push email masuk ke panel
9. Print **shared secret** — **salin nilai ini**, dipakai di panel

Cek semuanya jalan:

```bash
systemctl status postfix dovecot mailcatch-agent
curl -s http://127.0.0.1:8787/health   # harus {"ok":true,...}
```

---

## 4. Hubungkan panel ke VPS

Panel default-nya hosted di Lovable Cloud (URL `https://xxx.lovable.app`).
Login pakai email — user pertama otomatis jadi `admin`.

Buka **Settings → VPS Agent**:

1. **Agent base URL** — `http://203.0.113.10:8787` (atau `https://mail.imapku.web.id`
   kalau lu taruh di belakang reverse proxy TLS)
2. **Shared secret** — paste dari output installer
3. **Save**
4. **Test connection** — harus balik `ok`
5. **Register owner** — agent nyimpen `owner_id` di `/etc/mailcatch/owner_id`,
   dipakai buat push email masuk ke akun panel yang bener

---

## 5. Tambah domain + mailbox

**Domains → Add domain** → isi `imapku.web.id`:

- Live DNS checker (MX / A / SPF / PTR) — pastiin ijo semua
- Set retensi: max umur email (default 1 hari) + max jumlah (default 100)
- Klik **Sync to VPS** — panel manggil `POST /domains/sync` ke agent, agent
  nulis `/etc/postfix/vdomains` + `postmap` + reload postfix

**Mailboxes → Add mailbox**:

- Email: `anything@imapku.web.id` (atau centang **catch-all** biar `@domain` route ke sini)
- Panel auto-generate password 24-char (SHA512-CRYPT via `doveadm pw`)
- Klik **Sync to VPS** — agent update `/etc/dovecot/users`, `/etc/postfix/vmailbox`,
  dan `/etc/postfix/valiases` (catch-all), lalu reload postfix + dovecot

---

## 6. Pakai IMAP di email client

| Field          | Value                            |
| -------------- | -------------------------------- |
| IMAP server    | `mail.imapku.web.id`             |
| IMAP port      | `993`                            |
| Encryption     | `SSL/TLS`                        |
| Username       | full email (`user@imapku.web.id`)|
| Password       | dari panel                       |
| SMTP           | **tidak disediakan** — inbox only|

Test dari terminal:

```bash
openssl s_client -connect mail.imapku.web.id:993 -crlf
# > a login user@imapku.web.id "<password>"
# > a list "" "*"
# > a logout
```

---

## 7. Jalanin panel di VPS yang sama (opsional)

Panel default-nya di Lovable Cloud (recommended — gratis, edge, auto-scale).
Kalau **wajib satu VPS**, panel bisa self-host, tapi tetap butuh Postgres
+ Auth (Supabase self-hosted atau external). Contoh minimum pakai
`bun` + reverse proxy:

```bash
# di VPS, di folder repo
apt-get install -y nginx
bun install
bun run build

# jalanin sebagai systemd service
cat > /etc/systemd/system/mailcatch-panel.service <<'EOF'
[Unit]
Description=MailCatch panel
After=network.target
[Service]
WorkingDirectory=/root/mailcatch
Environment=PORT=3000
Environment=SUPABASE_URL=...
Environment=SUPABASE_PUBLISHABLE_KEY=...
Environment=VITE_SUPABASE_URL=...
Environment=VITE_SUPABASE_PUBLISHABLE_KEY=...
ExecStart=/usr/local/bin/bun run .output/server/index.mjs
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now mailcatch-panel
```

Terus reverse proxy nginx di `panel.imapku.web.id` → `127.0.0.1:3000` +
certbot untuk TLS. Detail Postgres/Auth self-host di luar scope README ini —
disarankan tetap pakai Lovable Cloud untuk backend biar simpel.

---

## 8. Operasional & troubleshooting

**Logs:**

```bash
journalctl -u mailcatch-agent -f
journalctl -u postfix -f
journalctl -u dovecot -f
tail -f /var/log/mail.log
```

**Cek email masuk (raw Maildir):**

```bash
ls -la /var/mail/vhosts/imapku.web.id/user/new/
```

**Force retention cleanup manual** — panel: Settings → **Run retention now**,
atau curl langsung ke agent:

```bash
curl -X POST http://127.0.0.1:8787/retention/apply \
  -H "authorization: Bearer $(cat /etc/mailcatch/secret)" \
  -H "content-type: application/json" \
  -d '{"policies":[{"domain":"imapku.web.id","max_age_days":1,"max_count":100}]}'
```

**Reissue TLS cert** (certbot auto-renew tiap 12 jam via systemd timer):

```bash
certbot renew --force-renewal
systemctl reload postfix dovecot
```

**Umum:**

| Gejala                                | Fix                                                            |
| ------------------------------------- | -------------------------------------------------------------- |
| Test connection panel gagal           | firewall block :8787, atau `SHARED_SECRET` salah paste         |
| Email masuk spam                      | PTR belum di-set, atau SPF belum ada                           |
| IMAP client "certificate invalid"     | certbot gagal — cek DNS `mail.<domain>` + port 80 open         |
| `postmap: fatal ... vmailbox`         | jalankan `postmap /etc/postfix/vmailbox` manual, cek permission|
| Email nggak muncul di panel           | `journalctl -u mailcatch-agent` — cek push ke panel error apa  |
| Catch-all nggak nangkep               | pastiin toggle **catch-all** di mailbox aktif, lalu re-sync    |

---

## Struktur repo

```text
├── src/                          Panel (TanStack Start)
│   ├── routes/_authenticated/    Dashboard, domains, mailboxes, inbox, settings
│   ├── routes/api/public/agent/  ping + emails ingest (dari VPS)
│   ├── lib/agent.functions.ts    Panel → agent RPC
│   └── lib/dns.functions.ts      DoH lookup (DNS checker)
├── supabase/migrations/          Schema + RLS
├── agent/                        VPS agent (Bun + Hono)
│   ├── src/index.ts              Endpoints + Postfix/Dovecot writers
│   └── systemd/                  Service unit
├── install.sh                    Installer VPS (Ubuntu 22/24)
└── docs/AGENT.md                 Spec API panel ↔ agent
```

## Endpoint agent

Semua endpoint (kecuali `/ingest` loopback) butuh `Authorization: Bearer <secret>`.

| Method | Path                        | Fungsi                                                   |
| ------ | --------------------------- | -------------------------------------------------------- |
| GET    | `/health`                   | uptime + versi                                           |
| POST   | `/domains/sync`             | tulis `vdomains` + reload postfix                        |
| POST   | `/mailboxes/sync`           | tulis `users` + `vmailbox` + `valiases` + reload         |
| POST   | `/mailboxes/reset-password` | ganti hash 1 user                                        |
| POST   | `/retention/apply`          | delete Maildir tua / lebihi kuota                        |
| POST   | `/register`                 | simpan `owner_id`                                        |
| POST   | `/ingest`                   | loopback: Postfix pipe → parse MIME → push ke panel      |

## Security notes

- RLS aktif semua tabel, scoped ke `auth.uid()` + role terpisah di `user_roles`
- Shared secret di panel disimpan sebagai SHA-256 hash (verifikasi push agent)
  + raw (di-protect RLS per owner, dipakai panel manggil agent)
- Postfix: `smtpd_recipient_restrictions = permit_mynetworks reject_unauth_destination` (no open relay)
- Dovecot: `disable_plaintext_auth = yes` di :143 kalau cert aktif (STARTTLS wajib), :993 selalu TLS
- **Rekomendasi production:** taruh agent :8787 di belakang nginx/caddy + TLS,
  batesin `allowlist` IP ke IP panel doang

## Lisensi

MIT

# MailCatch

Self-hosted mail control panel + VPS agent. Bikin unlimited catch-all mailbox
di domain sendiri, pakai IMAP client apa aja (Outlook, Thunderbird, Apple Mail,
Gmail Import, n8n, dst). Panel jalan di edge (TanStack Start + Lovable Cloud),
mail server (Postfix + Dovecot) jalan di VPS via agent.

```text
┌──────────────────────────────┐         ┌────────────────────────────┐
│  Web Panel (TanStack Start)  │  HTTPS  │   VPS (Postfix + Dovecot)  │
│  Lovable Cloud / Supabase    │◄───────►│   mailcatch-agent (Bun)    │
│  Dashboard · Domains · IMAP  │  bearer │   /health /sync /retention │
└──────────────────────────────┘         └────────────────────────────┘
        ▲                                          │
        │       POST /api/public/agent/emails      │
        └──────────────  push inbound  ────────────┘
```

## Fitur

- **Auth** — email/password, first-user auto-admin, role di tabel terpisah (`user_roles`)
- **Domains** — tambah domain, live DNS checker (MX / A / SPF / DKIM / PTR) via DoH
- **Retention** — per-domain: max umur (default 1 hari) + max jumlah email (default 100)
- **Mailboxes** — bikin IMAP user, generate password 24-char, catch-all toggle, reset password
- **Inbox viewer** — list + preview, filter per domain/user
- **VPS Agent** — install script Ubuntu, sync domain/mailbox ke Postfix/Dovecot, cleanup retensi, push email masuk

## Stack

- **Frontend + server**: TanStack Start v1 (React 19, Vite 7, edge-ready)
- **Backend**: Lovable Cloud (Supabase — Postgres + Auth + RLS)
- **Styling**: Tailwind v4 + shadcn/ui, dark theme
- **Agent**: Bun + Hono di VPS
- **Mail**: Postfix (SMTP inbound) + Dovecot (IMAP/LMTP), Maildir per user

## Setup panel (development)

```bash
bun install
bun run dev
```

Panel di `http://localhost:8080`. Login dengan email — user pertama otomatis jadi `admin`.

## Setup VPS (production mail server)

Prasyarat: VPS Ubuntu 22.04 / 24.04, IP publik, port 25 & 993 open, DNS domain mengarah ke VPS (MX + A `mail.<domain>`).

```bash
# di VPS, sebagai root
git clone <repo-url> mailcatch && cd mailcatch
sudo bash install.sh mail.example.com https://<panel-url>
```

Script akan:

1. install Postfix, Dovecot, Bun
2. tulis config minimal (virtual domains, Maildir, LMTP delivery)
3. pasang agent sebagai `mailcatch-agent.service` (auto-start)
4. print **shared secret** (32-byte hex)

Lalu di panel → **Settings → VPS Agent**:

- Isi **Agent base URL**: `http://<vps-ip>:8787` (atau hostname)
- Paste **Shared secret** → Save
- Klik **Test connection** → harus `ok`
- Klik **Register owner** → agent tau harus push email ke akun mana
- Klik **Sync domains** & **Sync mailboxes** → config Postfix/Dovecot ke-generate dari DB

Setelah itu tambah domain di **Domains**, pantau DNS checker sampai hijau semua, bikin mailbox di **Mailboxes**, copy kredensial IMAP ke email client.

## Struktur repo

```text
├── src/                          Panel (TanStack Start)
│   ├── routes/
│   │   ├── _authenticated/       Dashboard, domains, mailboxes, inbox, settings
│   │   └── api/public/agent/     ping + emails ingest (dari VPS)
│   ├── lib/
│   │   ├── agent.functions.ts    Panel → agent RPC (sync, test, retention)
│   │   └── dns.functions.ts      DoH lookup
│   └── integrations/supabase/    Client + auth middleware (auto-generated)
├── supabase/migrations/          Schema + RLS policies
├── agent/                        VPS agent (Bun + Hono)
│   ├── src/index.ts              Endpoints + Postfix/Dovecot writers
│   ├── systemd/                  Service unit
│   └── README.md
├── install.sh                    Installer VPS
└── docs/AGENT.md                 Spec API panel ↔ agent
```

## Agent endpoints

Semua endpoint (kecuali `/ingest` loopback) butuh header `Authorization: Bearer <shared-secret>`.

| Method | Path                        | Fungsi                                         |
| ------ | --------------------------- | ---------------------------------------------- |
| GET    | `/health`                   | uptime + versi                                 |
| POST   | `/domains/sync`             | tulis `/etc/postfix/vdomains` + reload         |
| POST   | `/mailboxes/sync`           | tulis `/etc/dovecot/users` (SHA512-CRYPT via `doveadm pw`) + vmailbox |
| POST   | `/mailboxes/reset-password` | ganti hash 1 user                              |
| POST   | `/retention/apply`          | delete Maildir tua / lebihi kuota              |
| POST   | `/register`                 | simpan `owner_id` (dipanggil sekali dari panel)|
| POST   | `/ingest`                   | loopback: Postfix pipe → push ke panel         |

Detail payload: `docs/AGENT.md`.

## Environment variables

Panel (auto by Lovable Cloud):

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY   # server-only
```

Agent (`/etc/mailcatch/agent.env`, dibuat install.sh):

```text
PANEL_URL=https://your-panel.example.com
AGENT_PORT=8787
MAIL_HOSTNAME=mail.example.com
SHARED_SECRET=<32-byte hex>
POSTFIX_VDOMAINS=/etc/postfix/vdomains
POSTFIX_VMAILBOX=/etc/postfix/vmailbox
DOVECOT_PASSWD=/etc/dovecot/users
MAIL_ROOT=/var/mail/vhosts
```

## Security

- RLS aktif di semua tabel, di-scope ke `auth.uid()` + `has_role('admin')`
- Role disimpan terpisah di `user_roles` (bukan di profil) — pakai security-definer `has_role()`
- Shared secret disimpan di panel sebagai SHA-256 hash (verifikasi push agent) + raw (buat panel manggil agent, di-protect RLS per owner)
- Agent bind default ke `:8787` — recommend taruh di balik nginx/caddy + TLS untuk production
- Postfix `smtpd_recipient_restrictions = permit_mynetworks reject_unauth_destination` (no open relay)

## Roadmap

- **Fase 1 ✅** — Panel + Lovable Cloud, semua data di DB, mail server di-mock
- **Fase 2 ✅** — Install script + agent VPS + panel integrasi (sync, retention, push)
- **Fase 3** — TLS otomatis via certbot di install.sh, DKIM signing, port ke Cloudflare Worker (opsional)

## Lisensi

MIT

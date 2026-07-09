
# Mail Control Panel — MVP Plan

## Strategi

Kamu mau tampilan dulu di Lovable, nanti port ke Cloudflare Worker. Jadi urutannya:

1. **Fase 1 (sekarang, di Lovable):** Full UI + Lovable Cloud (Supabase) sebagai backend sementara. Semua data (domain, IMAP user, setting retensi, log email masuk) disimpan di database. Bagian "aksi ke mail server" (Postfix/Dovecot) di-**mock** — panel jalan lengkap secara UX, tapi belum benar-benar terhubung ke VPS.
2. **Fase 2 (setelah UI oke):** Install script buat VPS + agent kecil (Node/Bun) yang jalan di VPS. Panel kirim perintah ke agent via HTTPS + shared token. Aku siapin di repo yang sama.
3. **Fase 3 (opsional):** Port panel ke Cloudflare Worker. Karena stack sekarang TanStack Start udah edge-ready, portingnya tinggal ganti adapter + swap Supabase ke D1/KV kalau kamu mau full CF.

Fase 1 dulu — sisanya kita bahas lagi setelah UI kamu approve.

## Fitur di Fase 1

### Auth
- Login admin (email + password) via Lovable Cloud
- Role `admin` disimpan di tabel `user_roles` terpisah (bukan di profil)
- Semua route dashboard di belakang `_authenticated`

### Halaman

```text
/auth              → login
/                  → dashboard overview (jumlah domain, email hari ini, storage)
/domains           → list domain + tombol "Add domain"
/domains/$id       → detail: DNS checker live, MX/A/SPF/DKIM/PTR, retensi
/mailboxes         → list IMAP user (semua domain)
/mailboxes/new     → form buat user baru (email, password auto-generate)
/inbox             → viewer email masuk (list + preview), filter per domain/user
/settings          → global: URL agent VPS, shared secret, koneksi test
```

### DNS Checker Live (fitur unggulan)
Di `/domains/$id`:
- Tampilin tabel record yang harus di-set: `MX @ → mail.domainmu.com` (prio 10), `A mail → <IP VPS>`, `TXT @ → v=spf1 mx -all`, `PTR` (via provider VPS), dst
- Tombol "Cek sekarang" polling tiap 3 detik pakai DNS-over-HTTPS (Cloudflare `1.1.1.1/dns-query`)
- Tiap baris jadi hijau ✓ / merah ✗ realtime, ada tombol "Copy value"
- Ada juga cek konektivitas: apakah port 25 & 993 di IP kamu ke-reach dari luar (via agent VPS)

### Retensi (per domain)
- Setting: max umur (hari) + max jumlah email per mailbox
- Default: **1 hari, 100 email** (sesuai request kamu)
- Di Fase 1 cuma disimpan di DB. Di Fase 2 agent VPS polling setting ini tiap X menit dan eksekusi cleanup.

### Inbox Viewer
- List email masuk (from, subject, mailbox, waktu)
- Klik → preview body (text + HTML), attachment metadata
- Tombol delete manual, star, mark read
- Di Fase 1 pakai seed data. Di Fase 2 agent push email masuk ke panel via webhook.

### IMAP User Management
- Add user: pilih domain, isi local-part (misal `catch`), auto-generate password 24-char
- Kartu kredensial siap copy: `imap.domainmu.com:993 / catch@domainmu.com / <pass>`
- Reset password, disable, delete
- Di Fase 1 cuma DB. Fase 2 agent sync ke Dovecot passwd file.

## Design direction

- Dark theme minimal ala Vercel/Railway — kontras tinggi, banyak whitespace, mono font untuk kredensial & DNS record
- Warna: bg `#0a0a0a`, surface `#111111`, border `#1f1f1f`, primary `#3b82f6`, success `#22c55e`, danger `#ef4444`
- Font: **Geist Sans** untuk UI, **Geist Mono** untuk kredensial / DNS values / IP
- Sidebar collapsible (shadcn sidebar), status pill hijau/kuning/merah di tiap domain

## Struktur teknis

### Database (Lovable Cloud / Supabase)
- `profiles` — id (fk auth.users), email, created_at
- `user_roles` — id, user_id, role (enum: admin)  → pakai has_role() security definer
- `domains` — id, name, verified, mx_target, ip, created_at, owner_id
- `dns_checks` — id, domain_id, record_type, expected, last_result, last_checked_at
- `retention_policies` — id, domain_id, max_age_days (default 1), max_count (default 100)
- `mailboxes` — id, domain_id, local_part, password_hash, disabled, created_at
- `emails` — id, mailbox_id, from_addr, subject, body_text, body_html, size_bytes, received_at
- `agent_config` — id (singleton), base_url, shared_secret_hash

RLS: semua tabel dibatasi ke owner via `owner_id = auth.uid()` + `has_role('admin')`.

### Server functions (TanStack Start)
- `getDashboardStats` — count queries
- `addDomain` / `deleteDomain`
- `checkDnsRecord` — server-side DoH lookup ke `cloudflare-dns.com` (avoid CORS)
- `createMailbox` / `resetMailboxPassword`
- `listInbox` / `getEmail` / `deleteEmail`
- `updateRetentionPolicy`

Semua pakai `.middleware([requireSupabaseAuth])`.

### Placeholder untuk Fase 2
File `docs/AGENT.md` di repo — spec API antara panel ↔ agent VPS (endpoint, auth, payload). Belum di-implement, tapi udah di-design biar Fase 2 tinggal jalan.

## Yang aku butuhin dari kamu untuk mulai

1. Enable Lovable Cloud (aku prompt kamu tombolnya di reply pertama)
2. Konfirmasi design direction dark-minimal Vercel-style oke (atau kamu mau vibe lain)
3. Domain apa yang mau kamu masukin sebagai contoh awal? (bisa placeholder `example.com`)

Kalau kamu approve plan ini, aku langsung:
1. Enable Cloud
2. Bikin migration (semua tabel + RLS + has_role)
3. Bikin auth + layout + semua route dengan seed data
4. Tulis `docs/AGENT.md` sebagai kontrak Fase 2

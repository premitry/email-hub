# MailCatch / Email Hub

MailCatch adalah aplikasi **self-hosted catch-all mail server** untuk domain sendiri. Aplikasi ini cocok untuk menerima email masuk ke domain pribadi, lalu membaca email tersebut lewat panel web atau IMAP client seperti Thunderbird, Outlook, Apple Mail, atau integrasi otomatis seperti n8n.

> Fokus project ini adalah **menerima email / inbox only**. Project ini **bukan SMTP relay** untuk mengirim email massal.

---

## Fitur Utama

- Panel web untuk mengelola domain, mailbox, dan inbox.
- Mail server di VPS menggunakan Postfix dan Dovecot.
- Mendukung catch-all email.
- Bisa dibaca lewat IMAP / IMAPS.
- Agent VPS untuk sinkronisasi domain dan mailbox dari panel.
- TLS / SSL menggunakan Let's Encrypt.
- Retention cleanup untuk membatasi umur dan jumlah email.

---

## Gambaran Cara Kerja

```text
Domain Anda -> DNS MX -> VPS -> Postfix -> Dovecot -> MailCatch Agent -> Panel Web
```

Komponen utama:

1. **Panel Web**: tempat login, menambah domain, membuat mailbox, dan membaca email.
2. **VPS Mail Server**: server Ubuntu yang menjalankan Postfix, Dovecot, dan MailCatch Agent.
3. **DNS Domain**: domain harus diarahkan ke VPS menggunakan record A, MX, SPF, dan PTR / Reverse DNS.

---

## Kebutuhan Sebelum Install

### 1. VPS

Disarankan menggunakan VPS fresh install.

Spesifikasi minimum:

- Ubuntu 22.04 LTS atau Ubuntu 24.04 LTS
- RAM minimal 1 GB
- Disk minimal 25 GB
- IPv4 publik statis
- Akses root / sudo

### 2. Domain

Anda harus punya domain sendiri, misalnya:

```text
example.com
```

Hostname mail server nanti bisa dibuat seperti:

```text
mail.example.com
```

### 3. Port yang Harus Dibuka

Buka port berikut di firewall VPS / cloud provider:

| Port | Protocol | Fungsi |
|---|---|---|
| 25 | TCP | SMTP inbound, untuk menerima email |
| 80 | TCP | HTTP, dibutuhkan Let's Encrypt saat membuat SSL |
| 143 | TCP | IMAP dengan STARTTLS |
| 993 | TCP | IMAPS / IMAP SSL |
| 8787 | TCP | MailCatch Agent API |

Untuk DigitalOcean Firewall, tambahkan inbound rule:

```text
Type     : Custom
Protocol : TCP
Ports    : 25
Sources  : All IPv4, All IPv6
```

Ulangi juga untuk port `80`, `143`, `993`, dan `8787`.

> Catatan: port `8787` sebaiknya tidak dibuka ke semua orang jika sudah production. Lebih aman dibatasi ke IP panel atau dipasang di belakang reverse proxy HTTPS.

---

## Setup DNS Domain

Contoh:

- Domain: `example.com`
- Hostname mail server: `mail.example.com`
- IP VPS: `203.0.113.10`

Tambahkan DNS record berikut di Cloudflare, registrar, atau DNS provider Anda.

| Type | Name / Host | Value | Catatan |
|---|---|---|---|
| A | `mail` | `203.0.113.10` | Arahkan mail hostname ke IP VPS |
| MX | `@` | `mail.example.com` | Priority: `10` |
| TXT | `@` | `v=spf1 mx ~all` | SPF basic |
| PTR / Reverse DNS | IP VPS | `mail.example.com` | Diatur dari panel provider VPS |

Jika memakai Cloudflare:

- Record `A mail` harus **DNS only / grey cloud**.
- Jangan aktifkan proxy orange cloud untuk mail server.

Cek DNS dari terminal:

```bash
dig +short mail.example.com
dig +short MX example.com
dig +short -x 203.0.113.10
```

Hasil yang benar kira-kira:

```text
203.0.113.10
10 mail.example.com.
mail.example.com.
```

---

## Cara Install Mail Server di VPS

Login ke VPS sebagai root:

```bash
ssh root@203.0.113.10
```

Update server dan install Git:

```bash
apt-get update
apt-get install -y git curl
```

Clone repository:

```bash
git clone https://github.com/premitry/email-hub.git mailcatch
cd mailcatch
```

Jalankan installer:

```bash
bash install.sh mail.example.com https://url-panel-anda.com
```

Ganti:

- `mail.example.com` dengan hostname mail server Anda.
- `https://url-panel-anda.com` dengan URL panel web Anda.

Contoh:

```bash
bash install.sh mail.example.com https://panel.example.com
```

Installer akan melakukan beberapa hal otomatis:

- Install Postfix untuk menerima email masuk.
- Install Dovecot untuk IMAP / IMAPS.
- Install Bun runtime.
- Membuat user `vmail`.
- Membuat folder email di `/var/mail/vhosts`.
- Membuat shared secret di `/etc/mailcatch/secret`.
- Request SSL Let's Encrypt untuk hostname mail server.
- Membuat service `mailcatch-agent`.
- Mengaktifkan sinkronisasi domain dan mailbox dari panel.

Setelah selesai, installer akan menampilkan output seperti:

```text
Agent URL  : http://IP-VPS:8787
Mail host  : mail.example.com
Panel URL  : https://panel.example.com
Shared key : xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Simpan **Shared key** tersebut. Nanti akan dimasukkan ke panel web.

---

## Cek Service Setelah Install

Jalankan:

```bash
systemctl status postfix
systemctl status dovecot
systemctl status mailcatch-agent
```

Cek agent:

```bash
curl -s http://127.0.0.1:8787/health
```

Jika normal, hasilnya kurang lebih:

```json
{"ok": true}
```

Cek port aktif:

```bash
ss -tlnp | grep -E ':25|:80|:143|:993|:8787'
```

---

## Hubungkan Panel Web ke VPS

Buka panel web MailCatch, lalu masuk ke menu:

```text
Settings -> VPS Agent
```

Isi data berikut:

```text
Agent base URL : http://IP-VPS:8787
Shared secret  : isi dengan Shared key dari installer
```

Setelah itu:

1. Klik **Save**.
2. Klik **Test connection**.
3. Pastikan statusnya `ok`.
4. Klik **Register owner** jika tersedia.

Jika agent menggunakan reverse proxy HTTPS, Agent base URL bisa berbentuk:

```text
https://mail.example.com
```

---

## Menambahkan Domain

Di panel web:

1. Buka menu **Domains**.
2. Klik **Add domain**.
3. Isi domain, misalnya `example.com`.
4. Cek status DNS checker.
5. Pastikan MX, A, SPF, dan PTR sudah benar.
6. Klik **Sync to VPS**.

Sync ke VPS akan membuat konfigurasi domain di Postfix.

---

## Membuat Mailbox

Di panel web:

1. Buka menu **Mailboxes**.
2. Klik **Add mailbox**.
3. Masukkan email, contoh `inbox@example.com`.
4. Jika ingin semua email ke domain masuk ke mailbox ini, aktifkan **catch-all**.
5. Simpan password yang dibuat panel.
6. Klik **Sync to VPS**.

Contoh catch-all:

```text
sales@example.com      -> masuk ke inbox@example.com
admin@example.com      -> masuk ke inbox@example.com
random123@example.com  -> masuk ke inbox@example.com
```

---

## Setting IMAP di Email Client

Gunakan pengaturan berikut di Thunderbird, Outlook, Apple Mail, atau aplikasi lain:

| Field | Value |
|---|---|
| IMAP Server | `mail.example.com` |
| IMAP Port | `993` |
| Encryption | SSL/TLS |
| Username | email lengkap, contoh `inbox@example.com` |
| Password | password dari panel |

Project ini tidak menyediakan SMTP untuk kirim email. Jadi bagian SMTP boleh dikosongkan atau gunakan SMTP provider lain.

---

## Deploy Panel Web Sendiri

Repository ini memakai TanStack Start, Vite, React, Bun, dan Supabase.

### Install Dependency Lokal

Pastikan Bun sudah terinstall.

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

Clone repo:

```bash
git clone https://github.com/premitry/email-hub.git
cd email-hub
```

Install dependency:

```bash
bun install
```

Jalankan development server:

```bash
bun run dev
```

Build production:

```bash
bun run build
```

Preview build:

```bash
bun run preview
```

---

## Environment Variables

Buat file `.env` jika belum ada.

Contoh:

```env
SUPABASE_URL="https://project-id.supabase.co"
SUPABASE_PUBLISHABLE_KEY="your-supabase-publishable-key"
VITE_SUPABASE_URL="https://project-id.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="your-supabase-publishable-key"
```

Jangan masukkan service role key Supabase ke frontend.

---

## Deploy Panel ke VPS dengan systemd

Contoh jika panel ingin dijalankan di VPS yang sama.

Build dulu:

```bash
bun install
bun run build
```

Buat service systemd:

```bash
cat > /etc/systemd/system/mailcatch-panel.service <<'SERVICEEOF'
[Unit]
Description=MailCatch Panel
After=network.target

[Service]
WorkingDirectory=/root/email-hub
Environment=PORT=3000
Environment=SUPABASE_URL=https://project-id.supabase.co
Environment=SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
Environment=VITE_SUPABASE_URL=https://project-id.supabase.co
Environment=VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
ExecStart=/usr/local/bin/bun run .output/server/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICEEOF
```

Aktifkan service:

```bash
systemctl daemon-reload
systemctl enable --now mailcatch-panel
systemctl status mailcatch-panel
```

Panel akan berjalan di:

```text
http://127.0.0.1:3000
```

---

## Reverse Proxy Nginx untuk Panel

Install Nginx:

```bash
apt-get install -y nginx certbot python3-certbot-nginx
```

Buat konfigurasi:

```bash
cat > /etc/nginx/sites-available/mailcatch-panel <<'NGINXEOF'
server {
    listen 80;
    server_name panel.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINXEOF
```

Aktifkan config:

```bash
ln -s /etc/nginx/sites-available/mailcatch-panel /etc/nginx/sites-enabled/mailcatch-panel
nginx -t
systemctl reload nginx
```

Aktifkan HTTPS:

```bash
certbot --nginx -d panel.example.com
```

---

## Perintah Operasional Penting

Lihat log agent:

```bash
journalctl -u mailcatch-agent -f
```

Lihat log Postfix:

```bash
journalctl -u postfix -f
```

Lihat log Dovecot:

```bash
journalctl -u dovecot -f
```

Lihat log mail umum:

```bash
tail -f /var/log/mail.log
```

Restart service:

```bash
systemctl restart postfix
systemctl restart dovecot
systemctl restart mailcatch-agent
```

Reload service:

```bash
systemctl reload postfix
systemctl reload dovecot
```

Cek konfigurasi Postfix:

```bash
postfix check
postconf -n
```

Cek sertifikat SSL:

```bash
certbot certificates
```

Renew SSL manual:

```bash
certbot renew --force-renewal
systemctl reload postfix dovecot
```

---

## Troubleshooting

### 1. Email tidak masuk

Cek DNS:

```bash
dig +short MX example.com
dig +short mail.example.com
```

Cek port 25 dari luar server:

```bash
nc -zv mail.example.com 25
```

Cek log:

```bash
tail -f /var/log/mail.log
journalctl -u postfix -f
```

Pastikan:

- Port 25 sudah dibuka di firewall provider.
- DNS MX sudah benar.
- Domain sudah di-sync ke VPS dari panel.
- Mailbox sudah dibuat dan di-sync ke VPS.

### 2. Panel gagal connect ke agent

Cek agent:

```bash
systemctl status mailcatch-agent
curl -s http://127.0.0.1:8787/health
```

Pastikan:

- Port 8787 terbuka.
- Agent base URL benar.
- Shared secret benar.
- Tidak salah copy spasi atau karakter.

### 3. SSL gagal dibuat

Pastikan:

- Record `A mail` sudah mengarah ke IP VPS.
- Port 80 terbuka.
- Tidak ada Nginx/Apache lain yang mengganggu proses certbot standalone.

Coba ulang:

```bash
certbot certonly --standalone -d mail.example.com
systemctl restart postfix dovecot
```

### 4. IMAP tidak bisa login

Pastikan:

- Port 993 terbuka.
- Mailbox sudah dibuat di panel.
- Mailbox sudah di-sync ke VPS.
- Username memakai email lengkap.
- Password benar.

Cek Dovecot:

```bash
journalctl -u dovecot -f
```

### 5. Catch-all tidak bekerja

Pastikan:

- Catch-all aktif di mailbox.
- Mailbox sudah di-sync ke VPS.
- File alias Postfix sudah terupdate.

Coba reload:

```bash
postmap /etc/postfix/valiases
systemctl reload postfix
```

---

## Struktur Repository

```text
email-hub/
├── agent/                 # MailCatch Agent untuk VPS
├── docs/                  # Dokumentasi tambahan
├── public/                # Asset public
├── src/                   # Source code panel web
├── supabase/              # Migration dan konfigurasi Supabase
├── install.sh             # Installer VPS
├── package.json           # Dependency dan script project
├── bun.lock               # Lock file Bun
└── README.md              # Dokumentasi project
```

---

## Keamanan

Rekomendasi keamanan:

- Jangan share shared secret agent.
- Batasi akses port 8787 jika memungkinkan.
- Gunakan HTTPS untuk panel.
- Gunakan password mailbox yang kuat.
- Jangan gunakan server ini sebagai open relay.
- Pastikan firewall hanya membuka port yang dibutuhkan.
- Jangan commit file `.env` yang berisi secret sensitif.

---

## Ringkasan Instalasi Cepat

```bash
ssh root@203.0.113.10
apt-get update
apt-get install -y git curl
git clone https://github.com/premitry/email-hub.git mailcatch
cd mailcatch
bash install.sh mail.example.com https://panel.example.com
systemctl status postfix dovecot mailcatch-agent
curl -s http://127.0.0.1:8787/health
```

Setelah itu:

1. Setting DNS domain.
2. Masukkan Agent URL dan Shared Secret ke panel.
3. Tambahkan domain di panel.
4. Buat mailbox.
5. Klik Sync to VPS.
6. Test kirim email ke mailbox domain Anda.

---

## Lisensi

Tambahkan informasi lisensi project di bagian ini jika sudah tersedia.

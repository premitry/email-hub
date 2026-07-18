# MailCatch Lite — Catch-all + Webmail (Mode Cloudflare / Path B)

Setup **catch-all email + webmail** yang jalan di **VPS NAT / port diblok** (mis. Tencent, NAT VPS),
karena email diterima **Cloudflare Email Routing** dan webmail diekspos lewat **Cloudflare Tunnel** —
**tanpa perlu buka port apa pun** di VPS.

## Arsitektur

```
Email ke *@fav.web.id
      │
      ▼
Cloudflare Email Routing (MX = route1/2/3.mx.cloudflare.net)
      │  catch-all
      ▼
Email Worker "mail-ingest"  ── POST raw email (+ bearer) ──►  https://mail.fav.web.id/ingest
                                                                     │ (Cloudflare Tunnel, cert valid)
                                                                     ▼
                                                        webmail-custom (Bun, VPS :8080)
                                                                     │ tulis ke Maildir
                                                                     ▼
                                                        Inbox (baca / hapus / retention)
```

- **Tidak butuh port inbound** di VPS (Tunnel & Worker semua lewat Cloudflare).
- Semua domain yang di-route ke worker/`catchall@fav.web.id` masuk ke **satu inbox**.

## Deployment saat ini (fav.web.id)

| Item | Nilai |
|------|-------|
| VPS | NAT VPS (akses SSH port custom, user `root`) — detail infra disimpan terpisah |
| Webmail | https://mail.fav.web.id |
| Mailbox sink | `catchall@fav.web.id` |
| Maildir | `/var/mail/vhosts/fav.web.id/catchall` |
| Config | `/etc/catchall/config` |
| Tunnel | cloudflared service `webmail` (UUID di `/root/.cloudflared/`) |
| Worker | `mail-ingest` (Cloudflare, akun terkait fav.web.id) |

Secret & password disimpan di `/etc/catchall/config` (`MAILBOX_PW`, `INGEST_SECRET`) dan
`/etc/catchall/webmail_pw` (password login webmail, bisa diganti dari UI).

## Layanan (systemd) di VPS

```bash
systemctl status webmail-custom     # webmail (Bun :8080)
systemctl status cloudflared        # tunnel
# Postfix/Dovecot ada tapi TIDAK dipakai untuk terima email di mode Cloudflare
journalctl -u webmail-custom -f
journalctl -u cloudflared -f
```

## Menambah domain (mode Cloudflare)

Di webmail → **⚙ Domain** → klik **📋 DNS** pada domain untuk panduan. Ringkasnya, untuk domain baru:

1. Tambahkan domain ke Cloudflare.
2. **Email → Email Routing → Enable** (Cloudflare set MX otomatis).
3. **Routing rules → Catch-all**, pilih salah satu:
   - Akun Cloudflare sama → **Send to a Worker** → `mail-ingest`
   - Cara gampang → **Send to an address** → `catchall@fav.web.id`

Semua email domain itu akan masuk ke inbox yang sama. Status MX ke-cek live di halaman Domain.

## Fitur webmail

- Inbox unified, baca email (HTML di-sandbox), hapus (satu / bulk), tandai dibaca
- **Auto-refresh** tiap 12 dtk (reload hanya kalau ada email baru)
- **⚙ Domain**: list domain + status DNS live, tambah/hapus, panduan setup
- **🗑 Auto-hapus (retention)**: simpan maksimal N email / hapus setelah N hari (dropdown)
- **ⓘ Setelan IMAP** + **reset password IMAP**
- **Ganti password webmail**

## Endpoint ingest

`POST /ingest` — dipakai Email Worker. Header `Authorization: Bearer <INGEST_SECRET>`, body = raw RFC822.
Menulis email ke Maildir `new/`. Tidak lewat login.

## Email Worker (Cloudflare)

Kode ada di [cloudflare-email-worker.js](cloudflare-email-worker.js). Deploy via dashboard
(Email Workers) atau API. Set sebagai action **Catch-all**.

## Catatan / batasan

- **IMAP (tmail) tidak aktif** di mode NAT ini (tidak ada port IMAP publik). Baca via webmail.
  Kalau butuh IMAP, forward port publik → `993` di panel VPS + "accept invalid cert" di client.
- Postfix/Dovecot terpasang (dari `catchall.sh`) tapi tidak menerima email di mode Cloudflare.

## Troubleshooting

| Gejala | Cek |
|--------|-----|
| Email nggak masuk | Cloudflare Email Routing aktif? Catch-all → worker/address benar? `journalctl -u webmail-custom` |
| Webmail nggak kebuka | `systemctl status cloudflared`; DNS `mail.fav.web.id` = CNAME tunnel |
| Status MX kuning | Normal saat propagasi; hijau "Aktif (Cloudflare)" kalau MX = `*.mx.cloudflare.net` |
| Worker gagal push | Cek `INGEST_SECRET` di worker cocok dengan `/etc/catchall/config` |

## Keamanan

- Ganti password root VPS berkala (`passwd`).
- Roll Cloudflare API token setelah setup selesai.
- Password login webmail: kuat, dan HTTPS wajib (sudah otomatis via Tunnel).

// webmail-custom — webmail buatan sendiri (Bun + Hono)
// Baca folder Maildir langsung dari filesystem, tampilkan unified inbox untuk
// SEMUA domain (karena semua email di-route ke satu mailbox oleh Postfix).
// Fitur: list, baca, tandai dibaca, hapus (satu / bulk). Login 1 password.
//
// Env yang dibaca:
//   WEBMAIL_PASSWORD  (wajib) password login
//   MAIL_DIR          (wajib) path mailbox, mis. /var/mail/vhosts/example.com/catchall
//   WEBMAIL_PORT      (opsional, default 8080)
//   WEBMAIL_TITLE     (opsional, default "Webmail")
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { simpleParser } from "mailparser";
import { readdirSync, statSync, existsSync, renameSync, unlinkSync, readFileSync, writeFileSync, mkdirSync, chownSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { createHmac, timingSafeEqual, createHash, randomBytes } from "crypto";
import { spawnSync } from "child_process";

const MAIL_DIR = process.env.MAIL_DIR ?? "";
const PORT = Number(process.env.WEBMAIL_PORT ?? 8080);
const TITLE = process.env.WEBMAIL_TITLE ?? "Webmail";
const CONFIG_PATH = process.env.CATCHALL_CONFIG ?? "/etc/catchall/config";
const WEBMAIL_PW_FILE = process.env.WEBMAIL_PW_FILE ?? "/etc/catchall/webmail_pw";
const PAGE_SIZE = 50;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// Password webmail: pakai file (bisa diganti runtime) kalau ada, else env.
function loadWebmailPw(): string {
  try { if (existsSync(WEBMAIL_PW_FILE)) return readFileSync(WEBMAIL_PW_FILE, "utf8").trim(); } catch { /* noop */ }
  return process.env.WEBMAIL_PASSWORD ?? "";
}
let PASSWORD = loadWebmailPw();
if (!PASSWORD || !MAIL_DIR) {
  console.error("WEBMAIL_PASSWORD dan MAIL_DIR wajib di-set");
  process.exit(1);
}
// Token sesi = HMAC dari password. Cookie disetel ke nilai ini; diverifikasi
// dengan timingSafeEqual. Ganti password -> token berubah -> sesi lama invalid.
let SESSION_TOKEN = "";
let PW_HASH: Buffer = Buffer.alloc(0);
function refreshAuth() {
  SESSION_TOKEN = createHmac("sha256", PASSWORD).update("webmail-session-v1").digest("hex");
  PW_HASH = createHash("sha256").update(PASSWORD).digest();
}
refreshAuth();
function genPw(len = 16): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += chars[buf[i] % chars.length];
  return s;
}

const app = new Hono();

// ---------- util ----------
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function authed(c: any): boolean {
  const t = getCookie(c, "sess") ?? "";
  if (t.length !== SESSION_TOKEN.length) return false;
  try { return timingSafeEqual(Buffer.from(t), Buffer.from(SESSION_TOKEN)); } catch { return false; }
}
function addrText(a: any): string {
  if (!a) return "";
  return Array.isArray(a) ? a.map((x) => x.text).join(", ") : (a.text ?? "");
}
// Escape HTML lalu jadikan URL polos sebagai link (buka tab baru).
function linkify(s: string): string {
  return esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

type Sub = "new" | "cur";
type Entry = { sub: Sub; name: string; mtime: number };

function listEntries(): Entry[] {
  const out: Entry[] = [];
  for (const sub of ["new", "cur"] as Sub[]) {
    const dir = join(MAIL_DIR, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      try {
        const s = statSync(join(dir, name));
        if (s.isFile()) out.push({ sub, name, mtime: s.mtimeMs });
      } catch { /* file hilang saat scan — abaikan */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
function idOf(e: Entry): string {
  return Buffer.from(`${e.sub}/${e.name}`).toString("base64url");
}
function resolveId(id: string): { sub: Sub; name: string; full: string } | null {
  let dec: string;
  try { dec = Buffer.from(id, "base64url").toString("utf8"); } catch { return null; }
  const slash = dec.indexOf("/");
  if (slash < 0) return null;
  const sub = dec.slice(0, slash) as Sub;
  const name = dec.slice(slash + 1);
  // cegah path traversal
  if ((sub !== "new" && sub !== "cur") || name.includes("/") || name.includes("..")) return null;
  const full = join(MAIL_DIR, sub, name);
  if (!existsSync(full)) return null;
  return { sub, name, full };
}
// Pindah dari new/ ke cur/ + tandai Seen (konvensi Maildir ":2,S")
function markSeen(sub: Sub, name: string) {
  if (sub !== "new") return;
  const flagged = name.includes(":2,") ? name : `${name}:2,S`;
  try { renameSync(join(MAIL_DIR, "new", name), join(MAIL_DIR, "cur", flagged)); } catch { /* noop */ }
}

// ---------- domain config (Postfix catch-all) ----------
type Cfg = {
  MAIL_HOST: string; PRIMARY: string; LOCAL: string; SINK: string; MAIL_DIR: string; DOMAINS: string;
  RETENTION_DAYS?: string; RETENTION_MAX?: string; MAILBOX_PW?: string; INGEST_SECRET?: string;
};
// Cek DNS live via DNS-over-HTTPS. MX dianggap OK kalau menunjuk ke mail host
// (mode langsung) ATAU ke Cloudflare Email Routing (mode Cloudflare).
// Coba beberapa resolver + header yang benar; hanya terima respons yang ada MX-nya.
async function checkDns(domain: string, mailHost: string): Promise<{ mxOk: boolean; mx: string[]; via: string }> {
  const urls = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
    `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: "application/dns-json" } });
      const j: any = await res.json();
      const mx = (j.Answer ?? []).map((a: any) => String(a.data)).filter((d: string) => /\s/.test(d) || /\./.test(d));
      if (mx.length) {
        const toHost = mailHost && mx.some((d: string) => d.toLowerCase().includes(mailHost.toLowerCase()));
        const toCf = mx.some((d: string) => d.toLowerCase().includes("mx.cloudflare.net"));
        return { mxOk: toHost || toCf, mx, via: toCf ? "cloudflare" : toHost ? "direct" : "none" };
      }
    } catch { /* coba resolver berikutnya */ }
  }
  return { mxOk: false, mx: [], via: "none" };
}
function readCfg(): Cfg {
  const out: any = {};
  if (existsSync(CONFIG_PATH)) {
    for (const line of readFileSync(CONFIG_PATH, "utf8").split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  }
  return out as Cfg;
}
function domainList(cfg: Cfg): string[] {
  return (cfg.DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
// Tulis ulang vdomains + valiases dari daftar domain, lalu postmap + reload postfix.
// Butuh hak root (service dijalankan sebagai root oleh systemd).
function applyDomains(cfg: Cfg, domains: string[]): { ok: boolean; error?: string; list: string[] } {
  const uniq = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (!cfg.SINK) return { ok: false, error: "config catch-all (/etc/catchall/config) tidak ditemukan", list: uniq };
  try {
    writeFileSync("/etc/postfix/vdomains", uniq.map((d) => `${d}\tOK`).join("\n") + "\n");
    writeFileSync("/etc/postfix/valiases", uniq.map((d) => `@${d}\t${cfg.SINK}`).join("\n") + "\n");
    const steps: [string, string[]][] = [
      ["postmap", ["/etc/postfix/vdomains"]],
      ["postmap", ["/etc/postfix/valiases"]],
      ["systemctl", ["reload", "postfix"]],
    ];
    for (const [cmd, args] of steps) {
      const r = spawnSync(cmd, args, { encoding: "utf8" });
      if (r.status !== 0) return { ok: false, error: `${cmd} gagal: ${(r.stderr || "").trim()}`, list: uniq };
    }
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf8");
      writeFileSync(CONFIG_PATH, raw.replace(/^DOMAINS=.*$/m, `DOMAINS=${uniq.join(",")}`));
    }
    return { ok: true, list: uniq };
  } catch (e) {
    return { ok: false, error: (e as Error).message, list: uniq };
  }
}

// Update/insert baris KEY=VALUE di /etc/catchall/config
function setCfgValue(updates: Record<string, string>) {
  let raw = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  if (raw && !raw.endsWith("\n")) raw += "\n";
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(raw)) raw = raw.replace(re, `${k}=${v}`);
    else raw += `${k}=${v}\n`;
  }
  writeFileSync(CONFIG_PATH, raw);
}

// ---------- retention: auto-hapus email lama / berlebih ----------
function retentionSettings(cfg: Cfg): { days: number; max: number } {
  return {
    days: Math.max(0, Math.floor(Number(cfg.RETENTION_DAYS ?? 0) || 0)),
    max: Math.max(0, Math.floor(Number(cfg.RETENTION_MAX ?? 0) || 0)),
  };
}
function applyRetention(): number {
  const { days, max } = retentionSettings(readCfg());
  if (days <= 0 && max <= 0) return 0; // mati
  const files: { full: string; mtime: number }[] = [];
  for (const sub of ["new", "cur"]) {
    const d = join(MAIL_DIR, sub);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      try {
        const s = statSync(join(d, name));
        if (s.isFile()) files.push({ full: join(d, name), mtime: s.mtimeMs });
      } catch { /* noop */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime); // terbaru dulu
  const cutoff = Date.now() - days * 86400_000;
  let removed = 0;
  files.forEach((f, idx) => {
    const tooOld = days > 0 && f.mtime < cutoff;
    const overCount = max > 0 && idx >= max;
    if (tooOld || overCount) { try { unlinkSync(f.full); removed++; } catch { /* noop */ } }
  });
  if (removed) console.log(`retention: hapus ${removed} email (days=${days}, max=${max})`);
  return removed;
}

// ---------- auth routes ----------
app.get("/login", (c) => c.html(loginPage()));
app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const pw = String(form.password ?? "");
  const buf = createHash("sha256").update(pw).digest();
  const ok = buf.length === PW_HASH.length && timingSafeEqual(buf, PW_HASH);
  if (!ok) return c.html(loginPage("Password salah."), 401);
  setCookie(c, "sess", SESSION_TOKEN, {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 7,
  });
  return c.redirect("/");
});
app.get("/logout", (c) => { deleteCookie(c, "sess", { path: "/" }); return c.redirect("/login"); });

// ---------- ingest: terima email yang di-push Cloudflare Email Worker ----------
// Auth via bearer secret (INGEST_SECRET di /etc/catchall/config). Tulis raw email
// ke Maildir new/ supaya muncul di inbox. Tidak lewat gerbang login.
let ingestCounter = 0;
app.post("/ingest", async (c) => {
  const secret = readCfg().INGEST_SECRET ?? "";
  const provided = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!secret || provided.length !== secret.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(secret))) {
    return c.text("unauthorized", 401);
  }
  const raw = await c.req.text();
  if (!raw.trim()) return c.text("empty body", 400);
  try {
    for (const s of ["tmp", "new", "cur"]) mkdirSync(join(MAIL_DIR, s), { recursive: true });
    ingestCounter = (ingestCounter + 1) % 1000000;
    const name = `${Math.floor(Date.now() / 1000)}.M${ingestCounter}P${process.pid}.webmail`;
    const full = join(MAIL_DIR, "new", name);
    writeFileSync(full, raw);
    try { chownSync(full, 5000, 5000); } catch { /* untuk IMAP Dovecot; opsional */ }
    return c.json({ ok: true });
  } catch (e) {
    return c.text("write failed: " + (e as Error).message, 500);
  }
});

// gerbang: semua route di bawah butuh login
app.use("*", async (c, next) => {
  if (c.req.path === "/login") return next();
  if (!authed(c)) return c.redirect("/login");
  return next();
});

// ---------- inbox ----------
type Row = { id: string; unread: boolean; from: string; subject: string; to: string; date: Date };

app.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const ql = q.toLowerCase();
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const all = listEntries();

  let rows: Row[];
  let total: number;
  let unread: number;

  if (ql) {
    // Mode search: parse semua email, cocokkan dari/subjek/tujuan/isi teks.
    const matched: Row[] = [];
    for (const e of all) {
      try {
        const p = await simpleParser(await readFile(join(MAIL_DIR, e.sub, e.name)));
        const from = p.from?.text ?? "";
        const subject = p.subject || "(tanpa subjek)";
        const to = addrText(p.to);
        const hay = `${from} ${subject} ${to} ${p.text ?? ""}`.toLowerCase();
        if (hay.includes(ql)) {
          matched.push({ id: idOf(e), unread: e.sub === "new", from, subject, to, date: p.date ?? new Date(e.mtime) });
        }
      } catch { /* skip file rusak */ }
    }
    total = matched.length;
    unread = matched.filter((r) => r.unread).length;
    rows = matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  } else {
    // Mode normal: cuma parse slice halaman ini (ringan).
    total = all.length;
    unread = all.filter((e) => e.sub === "new").length;
    const slice = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    rows = await Promise.all(slice.map(async (e) => {
      let from = "", subject = "(tanpa subjek)", to = "", date = new Date(e.mtime);
      try {
        const p = await simpleParser(await readFile(join(MAIL_DIR, e.sub, e.name)));
        from = p.from?.text ?? "";
        subject = p.subject || "(tanpa subjek)";
        to = addrText(p.to);
        if (p.date) date = p.date;
      } catch { /* fallback */ }
      return { id: idOf(e), unread: e.sub === "new", from, subject, to, date };
    }));
  }

  return c.html(inboxPage({ rows, page, total, unread, pageSize: PAGE_SIZE, q }));
});

// Hitungan ringan untuk auto-refresh (tanpa parse isi email).
app.get("/count", (c) => {
  const all = listEntries();
  return c.json({ total: all.length, unread: all.filter((e) => e.sub === "new").length });
});

app.get("/m/:id", async (c) => {
  const id = c.req.param("id");
  const r = resolveId(id);
  if (!r) return c.text("Email tidak ditemukan", 404);
  let parsed;
  try {
    const raw = await readFile(r.full);
    parsed = await simpleParser(raw);
  } catch {
    return c.text("Gagal membaca email", 500);
  }
  // tandai sudah dibaca
  markSeen(r.sub, r.name);
  // ?frag=1 -> potongan HTML untuk popup; selain itu halaman penuh (fallback tanpa JS)
  return c.html(c.req.query("frag") ? messageFragment(id, parsed) : messagePage(id, parsed));
});

app.post("/m/:id/delete", (c) => {
  const r = resolveId(c.req.param("id"));
  if (r) { try { unlinkSync(r.full); } catch { /* noop */ } }
  return c.redirect("/");
});

app.post("/delete", async (c) => {
  const form = await c.req.parseBody({ all: true });
  const ids = ([] as string[]).concat((form["id"] as any) ?? []);
  for (const id of ids) {
    const r = resolveId(String(id));
    if (r) { try { unlinkSync(r.full); } catch { /* noop */ } }
  }
  return c.redirect("/");
});

// ---------- settings: kelola domain dari browser ----------
app.get("/settings", (c) => {
  const cfg = readCfg();
  return c.html(settingsPage(cfg, domainList(cfg), c.req.query("err"), c.req.query("ok")));
});
app.post("/settings/add", async (c) => {
  const form = await c.req.parseBody();
  const d = String(form.domain ?? "").trim().toLowerCase();
  const cfg = readCfg();
  if (!DOMAIN_RE.test(d)) return c.redirect("/settings?err=" + encodeURIComponent("Format domain tidak valid"));
  const list = domainList(cfg);
  if (list.includes(d)) return c.redirect("/settings?err=" + encodeURIComponent("Domain sudah ada"));
  const r = applyDomains(cfg, [...list, d]);
  return c.redirect(r.ok ? "/settings" : "/settings?err=" + encodeURIComponent(r.error ?? "gagal"));
});
app.post("/settings/del", async (c) => {
  const form = await c.req.parseBody();
  const d = String(form.domain ?? "").trim().toLowerCase();
  const cfg = readCfg();
  const r = applyDomains(cfg, domainList(cfg).filter((x) => x !== d));
  return c.redirect(r.ok ? "/settings" : "/settings?err=" + encodeURIComponent(r.error ?? "gagal"));
});
app.post("/settings/retention", async (c) => {
  const form = await c.req.parseBody();
  const days = Math.max(0, Math.floor(Number(form.days) || 0));
  const max = Math.max(0, Math.floor(Number(form.max) || 0));
  setCfgValue({ RETENTION_DAYS: String(days), RETENTION_MAX: String(max) });
  applyRetention(); // langsung terapkan sekali
  return c.redirect("/settings");
});
// Cek status DNS/MX sebuah domain (dipanggil live oleh JS di halaman settings)
app.get("/settings/dns", async (c) => {
  const cfg = readCfg();
  const d = (c.req.query("domain") ?? "").trim().toLowerCase();
  if (!DOMAIN_RE.test(d)) return c.json({ ok: false, mxOk: false, mx: [] });
  const r = await checkDns(d, cfg.MAIL_HOST ?? "");
  return c.json({ ok: true, mxOk: r.mxOk, mx: r.mx, via: r.via, mailHost: cfg.MAIL_HOST ?? "" });
});

// Reset password mailbox IMAP (rehash di Dovecot + simpan ke config).
app.post("/settings/reset-imap", async (c) => {
  const cfg = readCfg();
  if (!cfg.SINK) return c.redirect("/settings?err=" + encodeURIComponent("config catch-all tidak ada"));
  const form = await c.req.parseBody();
  let pw = String(form.password ?? "").trim();
  if (!pw) pw = genPw();
  if (pw.length < 6) return c.redirect("/settings?err=" + encodeURIComponent("Password IMAP minimal 6 karakter"));
  const h = spawnSync("doveadm", ["pw", "-s", "SHA512-CRYPT", "-p", pw], { encoding: "utf8" });
  if (h.status !== 0) return c.redirect("/settings?err=" + encodeURIComponent("doveadm gagal: " + (h.stderr || "").trim()));
  try {
    writeFileSync("/etc/dovecot/users", `${cfg.SINK}:${h.stdout.trim()}\n`, { mode: 0o640 });
    spawnSync("chown", ["root:dovecot", "/etc/dovecot/users"]);
    spawnSync("systemctl", ["reload", "dovecot"]);
    setCfgValue({ MAILBOX_PW: pw });
  } catch (e) {
    return c.redirect("/settings?err=" + encodeURIComponent((e as Error).message));
  }
  return c.redirect("/settings?ok=" + encodeURIComponent("Password IMAP direset — buka ⓘ Setelan IMAP untuk lihat"));
});

// Ganti password login webmail (disimpan ke file; sesi lama otomatis invalid).
app.post("/settings/change-webmail-pw", async (c) => {
  const form = await c.req.parseBody();
  const npw = String(form.password ?? "").trim();
  if (npw.length < 6) return c.redirect("/settings?err=" + encodeURIComponent("Password webmail minimal 6 karakter"));
  try {
    writeFileSync(WEBMAIL_PW_FILE, npw + "\n", { mode: 0o600 });
  } catch (e) {
    return c.redirect("/settings?err=" + encodeURIComponent((e as Error).message));
  }
  PASSWORD = npw;
  refreshAuth(); // token sesi berubah -> harus login ulang
  return c.redirect("/login");
});

// ---------- views (server-rendered HTML) ----------
const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:#0e1116;color:#e6e6e6}
a{color:#7cb7ff;text-decoration:none}
header{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#161b22;border-bottom:1px solid #30363d;position:sticky;top:0}
header h1{font-size:16px;margin:0;font-weight:600}
.badge{background:#1f6feb;color:#fff;border-radius:10px;padding:1px 8px;font-size:12px}
.muted{color:#8b949e}
.wrap{max-width:900px;margin:0 auto;padding:0 12px}
.row{display:grid;grid-template-columns:24px 1fr auto;gap:10px;align-items:center;padding:10px 12px;border-bottom:1px solid #21262d}
.row:hover{background:#161b22}
.row .subj{font-weight:600}
.row.unread .subj{color:#fff}
.row.read .subj{color:#c9d1d9;font-weight:500}
.from{font-size:13px}
.to{font-size:12px}
.date{font-size:12px;white-space:nowrap;color:#8b949e}
.btn{background:#21262d;color:#e6e6e6;border:1px solid #30363d;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px}
.btn:hover{background:#30363d}
.btn.danger{background:#8b1a1a;border-color:#b62324}
.btn.danger:hover{background:#b62324}
.bar{display:flex;gap:8px;align-items:center;padding:10px 12px}
.msghead{padding:14px 12px;border-bottom:1px solid #30363d}
.msghead .subj{font-size:18px;font-weight:700;margin:0 0 6px}
iframe{width:100%;min-height:60vh;border:0;background:#fff;border-radius:6px}
pre.body{white-space:pre-wrap;word-wrap:break-word;padding:14px 12px;margin:0}
.login{max-width:320px;margin:12vh auto;padding:24px;background:#161b22;border:1px solid #30363d;border-radius:10px}
.login input{width:100%;padding:10px;margin:8px 0;background:#0e1116;border:1px solid #30363d;border-radius:6px;color:#fff}
.err{color:#ff7b72;font-size:13px}
.empty{text-align:center;color:#8b949e;padding:60px 12px}
.searchform{flex:1;max-width:360px;margin:0}
.searchform input{width:100%;padding:7px 10px;background:#0e1116;border:1px solid #30363d;border-radius:6px;color:#fff;font-size:13px}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50;align-items:flex-start;justify-content:center;padding:24px;overflow:auto}
.modalcard{background:#0e1116;border:1px solid #30363d;border-radius:10px;max-width:820px;width:100%;max-height:90vh;overflow:auto}
.modaltop{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #30363d;position:sticky;top:0;background:#161b22;z-index:1}
.irow{display:grid;grid-template-columns:110px 1fr auto;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #21262d}
.ival{font-family:ui-monospace,monospace;font-size:13px;word-break:break-all;color:#e6e6e6}
.dnsstat{font-size:12px;white-space:nowrap}
`;

function shell(inner: string, headExtra = ""): string {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(TITLE)}</title><style>${STYLE}</style>${headExtra}</head><body>${inner}</body></html>`;
}

function loginPage(err = ""): string {
  return shell(`<form class="login" method="post" action="/login">
    <h1>${esc(TITLE)}</h1>
    ${err ? `<p class="err">${esc(err)}</p>` : ""}
    <input type="password" name="password" placeholder="Password" autofocus>
    <button class="btn" type="submit" style="width:100%">Masuk</button>
  </form>`);
}

function inboxPage(d: {
  rows: Row[];
  page: number; total: number; unread: number; pageSize: number; q: string;
}): string {
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  const qp = d.q ? `&q=${encodeURIComponent(d.q)}` : "";
  const rows = d.rows.map((r) => `
    <label class="row ${r.unread ? "unread" : "read"}">
      <input type="checkbox" name="id" value="${esc(r.id)}">
      <a class="cell" data-mail href="/m/${esc(r.id)}" style="display:grid;gap:2px;min-width:0">
        <span class="from muted">${esc(r.from) || "(tanpa pengirim)"}</span>
        <span class="subj">${esc(r.subject)}</span>
        <span class="to muted">ke: ${esc(r.to) || "-"}</span>
      </a>
      <span class="date">${esc(fmtDate(r.date))}</span>
    </label>`).join("");

  const nav = pages > 1 ? `<div class="bar muted">
      ${d.page > 1 ? `<a class="btn" href="/?page=${d.page - 1}${qp}">‹ Baru</a>` : ""}
      <span>Halaman ${d.page}/${pages}</span>
      ${d.page < pages ? `<a class="btn" href="/?page=${d.page + 1}${qp}">Lama ›</a>` : ""}
    </div>` : "";

  const info = d.q
    ? `<span class="muted">${d.total} hasil untuk "<b>${esc(d.q)}</b>" · <a href="/">✕ reset</a></span>`
    : `<span class="muted">${d.total} email · ${d.unread} belum dibaca</span>`;

  const body = d.total === 0
    ? `<div class="empty">${d.q ? "🔍 Tidak ada email cocok." : "📭 Belum ada email."}</div>`
    : `<form method="post" action="/delete">
        <div class="bar">
          <button class="btn danger" type="submit" onclick="return confirm('Hapus email yang dicentang?')">🗑 Hapus dipilih</button>
          ${info}
        </div>
        ${rows}
        ${nav}
      </form>`;

  const search = `<form method="get" action="/" class="searchform">
      <input name="q" value="${esc(d.q)}" placeholder="🔍 Cari email…" autocomplete="off">
    </form>`;

  const modalScript = `<script>
    function openModal(url){
      fetch(url + (url.includes('?')?'&':'?') + 'frag=1')
        .then(function(r){return r.text();})
        .then(function(html){
          document.getElementById('modalcard').innerHTML = html;
          document.getElementById('modal').style.display = 'flex';
        });
    }
    function closeModal(){
      document.getElementById('modal').style.display = 'none';
      location.reload();
    }
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeModal(); });
    document.querySelectorAll('a[data-mail]').forEach(function(a){
      a.addEventListener('click', function(e){ e.preventDefault(); openModal(a.getAttribute('href')); });
    });

    // Auto-refresh pintar: cek tiap 12 detik, reload HANYA kalau ada email baru
    // dan tidak sedang baca (modal terbuka) / tidak sedang search.
    var lastTotal = ${d.total};
    setInterval(function(){
      var modalOpen = document.getElementById('modal').style.display === 'flex';
      if (modalOpen || location.search.indexOf('q=') >= 0) return;
      fetch('/count').then(function(r){ return r.json(); }).then(function(j){
        if (j && j.total > lastTotal) location.reload();
      }).catch(function(){});
    }, 12000);
  </script>`;

  return shell(`
    <header><h1>${esc(TITLE)}</h1>
      ${d.unread ? `<span class="badge">${d.unread}</span>` : ""}
      ${search}
      <span style="flex:1"></span>
      <a class="btn" href="/">↻</a>
      <a class="btn" href="/settings">⚙ Domain</a>
      <a class="btn" href="/logout">Keluar</a>
    </header>
    <div class="wrap">${body}</div>
    <div id="modal" class="modal" onclick="if(event.target===this)closeModal()">
      <div class="modalcard" id="modalcard"></div>
    </div>
    ${modalScript}`);
}

// Isi email (dipakai halaman penuh & popup). Konten bisa dipilih/disalin,
// link bisa diklik (buka tab baru).
function messageInner(p: any): string {
  const from = p.from?.text ?? "";
  const to = addrText(p.to);
  const subject = p.subject || "(tanpa subjek)";
  const date = p.date ? fmtDate(p.date) : "";

  let bodyHtml: string;
  if (typeof p.html === "string" && p.html.trim()) {
    // HTML email di iframe sandbox: script diblok (anti-XSS), link buka tab baru.
    const safe = '<base target="_blank">' + p.html;
    bodyHtml = `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(safe)}"></iframe>`;
  } else {
    // Teks: escaped + URL jadi link, tetap bisa diselect/copy.
    bodyHtml = `<pre class="body">${linkify(p.text ?? "(kosong)")}</pre>`;
  }

  return `
    <div class="msghead">
      <p class="subj">${esc(subject)}</p>
      <div class="muted">Dari: ${esc(from) || "-"}</div>
      <div class="muted">Ke: ${esc(to) || "-"}</div>
      <div class="muted">${esc(date)}</div>
    </div>
    ${bodyHtml}`;
}

// Potongan untuk popup: toolbar (tutup + hapus) + isi email.
function messageFragment(id: string, p: any): string {
  return `
    <div class="modaltop">
      <button class="btn" type="button" onclick="closeModal()">✕ Tutup</button>
      <span style="flex:1"></span>
      <form method="post" action="/m/${esc(id)}/delete" onsubmit="return confirm('Hapus email ini?')">
        <button class="btn danger" type="submit">🗑 Hapus</button>
      </form>
    </div>
    ${messageInner(p)}`;
}

// Halaman penuh (fallback saat JS mati / buka link langsung).
function messagePage(id: string, p: any): string {
  return shell(`
    <header>
      <a class="btn" href="/">‹ Inbox</a>
      <span style="flex:1"></span>
      <form method="post" action="/m/${esc(id)}/delete" onsubmit="return confirm('Hapus email ini?')">
        <button class="btn danger" type="submit">🗑 Hapus</button>
      </form>
    </header>
    <div class="wrap">${messageInner(p)}</div>`);
}

function settingsPage(cfg: Cfg, domains: string[], err?: string, ok?: string): string {
  const ret = retentionSettings(cfg);
  const mailHost = cfg.MAIL_HOST || "mail.domainmu.com";
  const pw = cfg.MAILBOX_PW || "";
  const cloudflareMode = !!cfg.INGEST_SECRET; // INGEST_SECRET ada = email lewat Cloudflare (Path B)

  // Dropdown retention yang ramah (tanpa "0 = mati" yang membingungkan)
  const buildOpts = (presets: [number, string][], cur: number) => {
    let opts = presets.map(([v, label]) =>
      `<option value="${v}"${v === cur ? " selected" : ""}>${esc(label)}</option>`).join("");
    if (!presets.some(([v]) => v === cur)) opts = `<option value="${cur}" selected>${cur} (custom)</option>` + opts;
    return opts;
  };
  const maxOptions = buildOpts(
    [[0, "Semua (tak dihapus)"], [100, "100 email terbaru"], [500, "500 email terbaru"], [1000, "1000 email terbaru"], [2000, "2000 email terbaru"]],
    ret.max);
  const dayOptions = buildOpts(
    [[0, "Jangan (biarkan selamanya)"], [3, "3 hari"], [7, "7 hari"], [14, "14 hari"], [30, "30 hari"], [90, "90 hari"]],
    ret.days);
  const selStyle = "padding:7px 10px;background:#0e1116;border:1px solid #30363d;border-radius:6px;color:#fff;font-size:14px";

  const rows = domains.length
    ? domains.map((d) => `
      <div class="row" style="grid-template-columns:1fr auto auto auto">
        <span class="subj">${esc(d)}</span>
        <span class="dnsstat muted" data-dnsfor="${esc(d)}">⏳ cek DNS…</span>
        <button class="btn" type="button" onclick="openDns('${esc(d)}')">📋 DNS</button>
        <form method="post" action="/settings/del" onsubmit="return confirm('Hapus domain ${esc(d)}?')">
          <input type="hidden" name="domain" value="${esc(d)}">
          <button class="btn danger" type="submit">Hapus</button>
        </form>
      </div>`).join("")
    : `<div class="empty">Belum ada domain.</div>`;

  const imapRows = [
    ["IMAP Server", mailHost],
    ["Port", "993"],
    ["Security", "SSL/TLS"],
    ["Username", cfg.SINK || "-"],
    ["Password", pw || "(set saat install / reset password)"],
  ].map(([k, v]) => `
    <div class="irow">
      <span class="muted">${esc(k)}</span>
      <span class="ival">${esc(v)}</span>
      <button class="btn" type="button" onclick="cp(this)">salin</button>
    </div>`).join("");

  const script = `<script>
    function showImap(){ document.getElementById('imapinfo').style.display='flex'; }
    function hideImap(){ document.getElementById('imapinfo').style.display='none'; }
    function cp(btn){
      var v = btn.parentNode.querySelector('.ival').textContent;
      navigator.clipboard.writeText(v);
      var t = btn.textContent; btn.textContent='tersalin'; setTimeout(function(){ btn.textContent=t; }, 1200);
    }
    var MAILHOST = ${JSON.stringify(mailHost)};
    var CFMODE = ${cloudflareMode};
    var SINK = ${JSON.stringify(cfg.SINK || "")};
    function checkDns(){
      document.querySelectorAll('[data-dnsfor]').forEach(function(el){
        var d = el.getAttribute('data-dnsfor');
        fetch('/settings/dns?domain=' + encodeURIComponent(d)).then(function(r){return r.json();}).then(function(j){
          if(j.ok && j.mxOk){ el.textContent = j.via==='cloudflare' ? '✅ Aktif (Cloudflare)' : '✅ MX aktif'; el.style.color='#3fb950'; el.title=''; }
          else { el.textContent='⏳ MX belum'; el.style.color='#d29922'; el.title='Set DNS MX ' + d + ' → ' + MAILHOST; }
        }).catch(function(){ el.textContent='· gagal cek'; });
      });
    }
    checkDns(); setInterval(checkDns, 15000);   // live: cek ulang tiap 15 detik

    // Modal DNS per-domain: tampilkan record yang harus ditambahkan + status live
    var curDns = '';
    function openDns(d){ curDns = d; renderDns(); document.getElementById('dnsmodal').style.display='flex'; }
    function hideDns(){ document.getElementById('dnsmodal').style.display='none'; }
    function recheckDns(){ if(curDns) renderDns(); }
    function renderDns(){
      var d = curDns;
      document.getElementById('dnsdomain').textContent = d;
      var html;
      if (CFMODE) {
        html = '<p class="muted" style="margin-top:0">Domain <b>'+d+'</b> diterima lewat <b>Cloudflare Email Routing</b>. Langkah setup domain baru:</p>'
          + '<ol style="margin:0 0 10px 18px;padding:0;line-height:1.9">'
          + '<li>Tambahkan domain <b>'+d+'</b> ke akun Cloudflare (kalau belum)</li>'
          + '<li>Menu <b>Email</b> → <b>Email Routing</b> → <b>Enable</b></li>'
          + '<li><b>Routing rules</b> → <b>Catch-all</b> → pilih salah satu:'
          + '<br>&nbsp;&nbsp;• akun Cloudflare sama → <b>Send to a Worker</b> → <code>mail-ingest</code>'
          + '<br>&nbsp;&nbsp;• cara gampang → <b>Send to an address</b> → <code>'+SINK+'</code></li>'
          + '</ol>';
      } else {
        var recs = [['Type','MX'],['Name / Host','@'],['Value', MAILHOST],['Priority','10']];
        html = '<p class="muted" style="margin-top:0">Tambahkan record ini di penyedia DNS domain <b>'+d+'</b>:</p>';
        recs.forEach(function(r){ html += '<div class="irow"><span class="muted">'+r[0]+'</span><span class="ival">'+r[1]+'</span><span></span></div>'; });
      }
      html += '<div class="irow"><span class="muted">Status MX</span><span class="ival" id="dnsstatbig">⏳ cek…</span><span></span></div>';
      document.getElementById('dnsbody').innerHTML = html;
      fetch('/settings/dns?domain=' + encodeURIComponent(d)).then(function(r){return r.json();}).then(function(j){
        var el = document.getElementById('dnsstatbig');
        if(j && j.ok && j.mxOk){ el.textContent = j.via==='cloudflare' ? '✅ Aktif via Cloudflare Email Routing' : '✅ MX sudah benar'; el.style.color='#3fb950'; }
        else { el.textContent='⏳ MX belum terdeteksi (tunggu propagasi DNS)'; el.style.color='#d29922'; }
      }).catch(function(){});
    }
  </script>`;

  return shell(`
    <header>
      <a class="btn" href="/">‹ Inbox</a>
      <h1>⚙ Pengaturan Domain</h1>
      <span style="flex:1"></span>
      <a class="btn" href="/logout">Keluar</a>
    </header>
    <div class="wrap">
      ${err ? `<div class="bar err">${esc(err)}</div>` : ""}
      ${ok ? `<div class="bar" style="color:#3fb950">✅ ${esc(ok)}</div>` : ""}
      <div class="bar" style="justify-content:space-between">
        <span class="muted">Semua email dikumpulkan ke: <code>${esc(cfg.SINK || "-")}</code></span>
        <button class="btn" type="button" onclick="showImap()">ⓘ Setelan IMAP</button>
      </div>

      <form method="post" action="/settings/add" class="bar">
        <input name="domain" placeholder="contoh.com" autocomplete="off"
          style="flex:1;padding:9px;background:#0e1116;border:1px solid #30363d;border-radius:6px;color:#fff">
        <button class="btn" type="submit">+ Tambah domain</button>
      </form>
      ${rows}
      <div class="bar muted" style="display:block;line-height:1.7">
        ${cloudflareMode
          ? `ℹ️ Mode <b>Cloudflare</b>: email diterima Cloudflare Email Routing lalu dikirim ke webmail (tanpa buka port di VPS). Klik <b>📋 DNS</b> di tiap domain untuk panduan setup-nya.`
          : `⚠️ Tiap domain baru: klik <b>📋 DNS</b> untuk lihat record yang harus ditambahkan.`}
        Status ke-cek otomatis.
      </div>

      <h1 style="padding:16px 12px 4px;font-size:16px">🗑 Auto-hapus email lama</h1>
      <form method="post" action="/settings/retention" class="bar" style="display:block;line-height:2.6">
        <div>📦 <b>Simpan maksimal</b>
          <select name="max" style="${selStyle}">${maxOptions}</select>
          <span class="muted">— kalau lebih, email paling lama dihapus</span>
        </div>
        <div>⏳ <b>Hapus setelah</b>
          <select name="days" style="${selStyle}">${dayOptions}</select>
          <span class="muted">— email lebih tua dari ini dihapus</span>
        </div>
        <button class="btn" type="submit" style="margin-top:10px">Simpan aturan</button>
        <div class="muted" style="margin-top:6px">Berjalan otomatis tiap jam. Dua aturan bisa dipakai bareng.</div>
      </form>

      <h1 style="padding:16px 12px 4px;font-size:16px">🔑 Ganti password webmail</h1>
      <form method="post" action="/settings/change-webmail-pw" class="bar"
        onsubmit="return confirm('Ganti password login webmail? Kamu akan diminta login ulang.')">
        <input name="password" type="password" placeholder="password webmail baru (min 6)" autocomplete="new-password"
          style="flex:1;padding:9px;background:#0e1116;border:1px solid #30363d;border-radius:6px;color:#fff">
        <button class="btn" type="submit">Simpan &amp; login ulang</button>
      </form>
    </div>

    <div id="imapinfo" class="modal" onclick="if(event.target===this)hideImap()">
      <div class="modalcard" style="max-width:520px">
        <div class="modaltop"><b>ⓘ Setelan IMAP</b><span style="flex:1"></span>
          <button class="btn" type="button" onclick="hideImap()">✕ Tutup</button>
        </div>
        <div style="padding:14px 12px">
          <p class="muted" style="margin-top:0">${cloudflareMode
            ? `⚠️ Mode Cloudflare: baca email lewat <b>webmail ini</b>. IMAP untuk tmail <b>belum aktif</b> (VPS NAT tanpa port terbuka) — setelan di bawah hanya berlaku kalau port IMAP di-forward manual.`
            : `Berlaku untuk <b>semua domain</b>. Masukkan ke tmail / email client di bagian <b>Incoming / IMAP</b>.`}</p>
          ${imapRows}
          <form method="post" action="/settings/reset-imap" style="display:flex;gap:8px;margin-top:12px"
            onsubmit="return confirm('Reset password IMAP? Password lama tidak berlaku lagi di tmail/apps.')">
            <input name="password" placeholder="password baru (kosong = acak)" autocomplete="off"
              style="flex:1;padding:7px;background:#0e1116;border:1px solid #30363d;border-radius:6px;color:#fff">
            <button class="btn danger" type="submit">🔄 Reset</button>
          </form>
          <p class="muted" style="font-size:12px;margin-bottom:0">Server ini inbound-only — bagian SMTP / Outgoing boleh dikosongkan.</p>
        </div>
      </div>
    </div>

    <div id="dnsmodal" class="modal" onclick="if(event.target===this)hideDns()">
      <div class="modalcard" style="max-width:600px">
        <div class="modaltop"><b>📋 DNS untuk <span id="dnsdomain"></span></b><span style="flex:1"></span>
          <button class="btn" type="button" onclick="recheckDns()">↻ Cek ulang</button>
          <button class="btn" type="button" onclick="hideDns()">✕ Tutup</button>
        </div>
        <div style="padding:14px 12px" id="dnsbody"></div>
      </div>
    </div>
    ${script}`);
}

function fmtDate(d: Date): string {
  try {
    return d.toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

// Retention otomatis: tiap jam + sekali saat start
setInterval(() => { try { applyRetention(); } catch (e) { console.error("retention", (e as Error).message); } }, 3600_000);
setTimeout(() => { try { applyRetention(); } catch { /* noop */ } }, 10_000);

console.log(`webmail-custom listening on :${PORT} (mailbox: ${MAIL_DIR})`);
export default { port: PORT, fetch: app.fetch };

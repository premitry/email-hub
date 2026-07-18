// catchall-bot — Telegram bot buat kelola catch-all mail server dari chat,
// tanpa perlu SSH ke VPS. Pakai long-polling (tidak butuh port terbuka).
//
// Fitur:
//   /domains            list domain aktif
//   /adddomain <d>      tambah domain (langsung update Postfix)
//   /deldomain <d>      hapus domain
//   /status             cek service postfix & dovecot
//   /count              jumlah email (total & belum dibaca)
//   /recent [n]         n email terakhir (pengirim + subjek)
//
// Env:
//   TELEGRAM_BOT_TOKEN  (wajib) token dari @BotFather
//   ALLOWED_IDS         (wajib) daftar Telegram user id yang boleh, pisah koma
//   CONFIG_PATH         (opsional, default /etc/catchall/config)
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { simpleParser } from "mailparser";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const ALLOWED = new Set((process.env.ALLOWED_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const CONFIG_PATH = process.env.CONFIG_PATH ?? "/etc/catchall/config";
const API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN || ALLOWED.size === 0) {
  console.error("TELEGRAM_BOT_TOKEN dan ALLOWED_IDS wajib di-set");
  process.exit(1);
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// ---------- config ----------
type Cfg = { MAIL_HOST: string; PRIMARY: string; LOCAL: string; SINK: string; MAIL_DIR: string; DOMAINS: string };
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
function writeDomains(cfg: Cfg, domains: string[]) {
  const uniq = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  writeFileSync("/etc/postfix/vdomains", uniq.map((d) => `${d}\tOK`).join("\n") + "\n");
  writeFileSync("/etc/postfix/valiases", uniq.map((d) => `@${d}\t${cfg.SINK}`).join("\n") + "\n");
  run("postmap", ["/etc/postfix/vdomains"]);
  run("postmap", ["/etc/postfix/valiases"]);
  run("systemctl", ["reload", "postfix"]);
  // simpan ke config
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const next = raw.replace(/^DOMAINS=.*$/m, `DOMAINS=${uniq.join(",")}`);
  writeFileSync(CONFIG_PATH, next);
  return uniq;
}
function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}
function domainList(cfg: Cfg): string[] {
  return (cfg.DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------- maildir ----------
function mailEntries(dir: string): { full: string; sub: string; mtime: number }[] {
  const out: { full: string; sub: string; mtime: number }[] = [];
  for (const sub of ["new", "cur"]) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      try {
        const s = statSync(join(d, name));
        if (s.isFile()) out.push({ full: join(d, name), sub, mtime: s.mtimeMs });
      } catch { /* noop */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------- telegram ----------
async function tg(method: string, payload: any) {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    console.error("tg error", (e as Error).message);
    return null;
  }
}
function send(chatId: number, text: string) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
}

const HELP = [
  "<b>Catch-all bot</b>",
  "",
  "/domains — list domain aktif",
  "/adddomain &lt;domain&gt; — tambah domain",
  "/deldomain &lt;domain&gt; — hapus domain",
  "/status — status service",
  "/count — jumlah email",
  "/recent [n] — email terakhir",
].join("\n");

async function handle(chatId: number, text: string) {
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, ""); // buang @botname
  const arg = rest.join(" ").trim();
  const cfg = readCfg();

  switch (cmd) {
    case "/start":
    case "/help":
      return send(chatId, HELP);

    case "/domains": {
      const list = domainList(cfg);
      return send(chatId, list.length
        ? "<b>Domain aktif:</b>\n" + list.map((d) => `• ${d}`).join("\n") + `\n\nSemua masuk ke: <code>${cfg.SINK}</code>`
        : "Belum ada domain.");
    }

    case "/adddomain": {
      const d = arg.toLowerCase();
      if (!DOMAIN_RE.test(d)) return send(chatId, "Format domain tidak valid. Contoh: <code>/adddomain contoh.com</code>");
      const list = domainList(cfg);
      if (list.includes(d)) return send(chatId, `Domain <b>${d}</b> sudah ada.`);
      const next = writeDomains(cfg, [...list, d]);
      return send(chatId, `✅ Domain <b>${d}</b> ditambahkan.\n\n⚠️ Set DNS MX: <code>${d} → ${cfg.MAIL_HOST} (prio 10)</code>\n\nTotal: ${next.length} domain.`);
    }

    case "/deldomain": {
      const d = arg.toLowerCase();
      const list = domainList(cfg);
      if (!list.includes(d)) return send(chatId, `Domain <b>${d}</b> tidak ada.`);
      const next = writeDomains(cfg, list.filter((x) => x !== d));
      return send(chatId, `🗑 Domain <b>${d}</b> dihapus. Sisa: ${next.length} domain.`);
    }

    case "/status": {
      const pf = run("systemctl", ["is-active", "postfix"]).out.trim();
      const dc = run("systemctl", ["is-active", "dovecot"]).out.trim();
      return send(chatId, `Postfix: <b>${pf}</b>\nDovecot: <b>${dc}</b>`);
    }

    case "/count": {
      if (!cfg.MAIL_DIR) return send(chatId, "MAIL_DIR belum di-set di config.");
      const all = mailEntries(cfg.MAIL_DIR);
      const unread = all.filter((e) => e.sub === "new").length;
      return send(chatId, `📬 Total: <b>${all.length}</b>\n🔵 Belum dibaca: <b>${unread}</b>`);
    }

    case "/recent": {
      if (!cfg.MAIL_DIR) return send(chatId, "MAIL_DIR belum di-set di config.");
      const n = Math.min(20, Math.max(1, Number(arg) || 5));
      const all = mailEntries(cfg.MAIL_DIR).slice(0, n);
      if (!all.length) return send(chatId, "📭 Belum ada email.");
      const lines: string[] = [];
      for (const e of all) {
        try {
          const p = await simpleParser(readFileSync(e.full));
          const from = (p.from?.text ?? "?").slice(0, 40);
          const subj = (p.subject || "(tanpa subjek)").slice(0, 60);
          const flag = e.sub === "new" ? "🔵" : "▫️";
          lines.push(`${flag} <b>${escapeHtml(subj)}</b>\n   <i>${escapeHtml(from)}</i>`);
        } catch { /* skip */ }
      }
      return send(chatId, lines.join("\n\n"));
    }

    default:
      return send(chatId, "Perintah tidak dikenal. Ketik /help.");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

// ---------- long-poll loop ----------
async function main() {
  console.log("catchall-bot started (long-polling)");
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
    if (!res?.ok) { await sleep(2000); continue; }
    for (const upd of res.result ?? []) {
      offset = upd.update_id + 1;
      const msg = upd.message;
      if (!msg?.text) continue;
      const fromId = String(msg.from?.id ?? "");
      const chatId = msg.chat?.id;
      if (!ALLOWED.has(fromId)) {
        if (chatId) await send(chatId, "⛔ Kamu tidak diizinkan memakai bot ini.");
        continue;
      }
      try { await handle(chatId, msg.text); }
      catch (e) { await send(chatId, "Error: " + (e as Error).message); }
    }
  }
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

main();

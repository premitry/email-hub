// MailCatch VPS agent — Bun + Hono
// Reads config from /etc/mailcatch/agent.env (populated by install.sh)
import { Hono } from "hono";
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash, timingSafeEqual } from "crypto";
import { simpleParser } from "mailparser";

const env = {
  PANEL_URL: process.env.PANEL_URL ?? "",
  PORT: Number(process.env.AGENT_PORT ?? 8787),
  MAIL_HOSTNAME: process.env.MAIL_HOSTNAME ?? "mail.local",
  SECRET: process.env.SHARED_SECRET ?? "",
  VDOMAINS: process.env.POSTFIX_VDOMAINS ?? "/etc/postfix/vdomains",
  VMAILBOX: process.env.POSTFIX_VMAILBOX ?? "/etc/postfix/vmailbox",
  VALIASES: process.env.POSTFIX_VALIASES ?? "/etc/postfix/valiases",
  DOVECOT_PASSWD: process.env.DOVECOT_PASSWD ?? "/etc/dovecot/users",
  MAIL_ROOT: process.env.MAIL_ROOT ?? "/var/mail/vhosts",
  OWNER_ID: process.env.OWNER_ID ?? "",
};

if (!env.SECRET) {
  console.error("SHARED_SECRET missing"); process.exit(1);
}
const SECRET_HASH = createHash("sha256").update(env.SECRET).digest();

const app = new Hono();

app.use("*", async (c, next) => {
  if (c.req.path === "/ingest") return next(); // loopback pipe only
  const auth = c.req.header("authorization") ?? "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim();
  const buf = createHash("sha256").update(provided).digest();
  if (buf.length !== SECRET_HASH.length || !timingSafeEqual(buf, SECRET_HASH)) {
    return c.text("unauthorized", 401);
  }
  return next();
});

app.get("/health", (c) => c.json({
  ok: true,
  uptime: process.uptime(),
  version: "0.2.0",
  hostname: env.MAIL_HOSTNAME,
}));

// -------- Domains sync ----------
app.post("/domains/sync", async (c) => {
  const body = await c.req.json() as { domains: { name: string; catchall_mailbox?: string | null }[] };
  const lines = (body.domains ?? []).map(d => `${d.name}\tOK`).join("\n") + "\n";
  writeFileSync(env.VDOMAINS, lines);
  runOrThrow("postmap", [env.VDOMAINS]);
  runOrThrow("systemctl", ["reload", "postfix"]);
  return c.json({ ok: true, count: body.domains.length });
});

// -------- Mailboxes sync --------
// Writes:
//   /etc/dovecot/users      -> IMAP auth (SHA512-CRYPT via doveadm)
//   /etc/postfix/vmailbox   -> exact recipients (user@domain -> maildir)
//   /etc/postfix/valiases   -> catch-all (@domain -> user@domain) via virtual_alias_maps
app.post("/mailboxes/sync", async (c) => {
  const body = await c.req.json() as {
    mailboxes: { email: string; domain: string; password: string; is_catchall: boolean; disabled: boolean }[];
  };
  const users: string[] = [];
  const vmail: string[] = [];
  const valiases: string[] = [];
  for (const m of body.mailboxes) {
    if (m.disabled || !m.password) continue;
    const local = m.email.split("@")[0];
    const hashed = dovecotHash(m.password);
    users.push(`${m.email}:${hashed}::::::`);
    vmail.push(`${m.email}\t${m.domain}/${local}/`);
    if (m.is_catchall) valiases.push(`@${m.domain}\t${m.email}`);
  }
  writeFileSync(env.DOVECOT_PASSWD, users.join("\n") + "\n", { mode: 0o640 });
  writeFileSync(env.VMAILBOX, vmail.join("\n") + "\n");
  writeFileSync(env.VALIASES, valiases.join("\n") + "\n");
  runOrThrow("postmap", [env.VMAILBOX]);
  runOrThrow("postmap", [env.VALIASES]);
  runOrThrow("systemctl", ["reload", "postfix"]);
  runOrThrow("systemctl", ["reload", "dovecot"]);
  return c.json({ ok: true, count: body.mailboxes.length });
});

app.post("/mailboxes/reset-password", async (c) => {
  const { email, new_password } = await c.req.json() as { email: string; new_password: string };
  if (!email || !new_password) return c.text("email+new_password required", 400);
  const current = existsSync(env.DOVECOT_PASSWD) ? readFileSync(env.DOVECOT_PASSWD, "utf8") : "";
  const kept = current.split("\n").filter(l => l && !l.startsWith(email + ":"));
  kept.push(`${email}:${dovecotHash(new_password)}::::::`);
  writeFileSync(env.DOVECOT_PASSWD, kept.join("\n") + "\n", { mode: 0o640 });
  runOrThrow("systemctl", ["reload", "dovecot"]);
  return c.json({ ok: true });
});

app.post("/retention/apply", async (c) => {
  const body = await c.req.json() as {
    policies: { domain: string; max_age_days: number; max_count: number }[];
  };
  const report: any[] = [];
  for (const p of body.policies ?? []) {
    const domainDir = join(env.MAIL_ROOT, p.domain);
    if (!existsSync(domainDir)) continue;
    for (const user of readdirSync(domainDir)) {
      const inbox = join(domainDir, user, "new");
      const cur = join(domainDir, user, "cur");
      let removed = 0;
      for (const dir of [inbox, cur]) {
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir)
          .map((f) => ({ f, s: statSync(join(dir, f)) }))
          .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);
        const cutoff = Date.now() - p.max_age_days * 86400_000;
        files.forEach((entry, idx) => {
          const tooOld = entry.s.mtimeMs < cutoff;
          const overCount = idx >= p.max_count;
          if (tooOld || overCount) {
            try { unlinkSync(join(dir, entry.f)); removed++; } catch {}
          }
        });
      }
      report.push({ mailbox: `${user}@${p.domain}`, removed });
    }
  }
  return c.json({ ok: true, report });
});

// -------- Ingest from local Postfix pipe -> push to panel --------
app.post("/ingest", async (c) => {
  const body = await c.req.json() as { to: string; from: string; raw: string };
  if (!env.PANEL_URL) return c.json({ ok: false, error: "panel url not set" });

  const ownerId = readOwnerId();
  if (!ownerId) return c.json({ ok: false, error: "owner_id not registered" });

  let subject = "";
  let text = "";
  let html = "";
  try {
    const parsed = await simpleParser(body.raw);
    subject = parsed.subject ?? "";
    text = parsed.text ?? "";
    html = typeof parsed.html === "string" ? parsed.html : "";
  } catch (e) {
    console.error("mailparser failed", (e as Error).message);
  }

  const res = await fetch(env.PANEL_URL.replace(/\/$/, "") + "/api/public/agent/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${env.SECRET}`,
    },
    body: JSON.stringify({
      owner_id: ownerId,
      to: body.to,
      from: body.from,
      subject,
      body_text: text,
      body_html: html,
      size: body.raw.length,
      received_at: new Date().toISOString(),
    }),
  });
  return c.json({ ok: res.ok, status: res.status });
});

app.post("/register", async (c) => {
  const { owner_id } = await c.req.json() as { owner_id: string };
  if (!owner_id) return c.text("owner_id required", 400);
  writeFileSync("/etc/mailcatch/owner_id", owner_id);
  return c.json({ ok: true });
});

async function ping() {
  const ownerId = readOwnerId();
  if (!env.PANEL_URL || !ownerId) return;
  try {
    await fetch(env.PANEL_URL.replace(/\/$/, "") + "/api/public/agent/ping", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${env.SECRET}` },
      body: JSON.stringify({ owner_id: ownerId, base_url: `http://${env.MAIL_HOSTNAME}:${env.PORT}` }),
    });
  } catch (e) { console.error("ping failed", (e as Error).message); }
}
setInterval(ping, 60_000);
setTimeout(ping, 3_000);

function readOwnerId(): string {
  try { return readFileSync("/etc/mailcatch/owner_id", "utf8").trim(); } catch { return env.OWNER_ID; }
}
function runOrThrow(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: "pipe" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} -> ${r.stderr?.toString()}`);
}
function dovecotHash(pw: string): string {
  const r = spawnSync("doveadm", ["pw", "-s", "SHA512-CRYPT", "-p", pw], { stdio: "pipe" });
  if (r.status !== 0) throw new Error("doveadm pw failed: " + r.stderr?.toString());
  return r.stdout.toString().trim();
}

console.log(`mailcatch-agent listening on :${env.PORT}`);
Bun.serve({ port: env.PORT, fetch: app.fetch });

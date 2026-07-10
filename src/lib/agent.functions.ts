import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Helper: fetch the agent config for the current user (base_url + shared_secret)
async function loadAgent(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("agent_configs")
    .select("base_url, shared_secret")
    .eq("owner_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.base_url) throw new Error("Agent base URL belum di-set. Buka Settings.");
  if (!data?.shared_secret) throw new Error("Agent shared secret belum di-set. Buka Settings.");
  return { baseUrl: data.base_url.replace(/\/$/, ""), secret: data.shared_secret };
}

async function agentFetch(userId: string, path: string, body?: unknown, method: "GET" | "POST" = "POST") {
  const { baseUrl, secret } = await loadAgent(userId);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Agent ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { ok: true, raw: text }; }
}

export const testAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const started = Date.now();
    const r = await agentFetch(context.userId, "/health", undefined, "GET");
    return { ok: true, ms: Date.now() - started, agent: r };
  });

export const syncDomains = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: domains, error } = await context.supabase
      .from("domains")
      .select("id, name, mx_hostname");
    if (error) throw new Error(error.message);
    const { data: catchalls } = await context.supabase
      .from("mailboxes")
      .select("local_part, domain_id, is_catchall")
      .eq("is_catchall", true);
    const payload = {
      domains: (domains ?? []).map((d) => ({
        name: d.name,
        mx_hostname: d.mx_hostname,
        catchall_mailbox:
          catchalls?.find((c) => c.domain_id === d.id)
            ? `${catchalls.find((c) => c.domain_id === d.id)!.local_part}@${d.name}`
            : null,
      })),
    };
    const r = await agentFetch(context.userId, "/domains/sync", payload);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("agent_configs")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("owner_id", context.userId);
    return { synced: payload.domains.length, agent: r };
  });

export const syncMailboxes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("mailboxes")
      .select("id, local_part, password_preview, disabled, is_catchall, domains(name)")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const mailboxes = (rows ?? [])
      .map((m: any) => {
        const domain = m.domains?.name;
        if (!domain || !m.local_part) return null;
        return {
          email: `${m.local_part}@${domain}`,
          domain,
          password: m.password_preview ?? "",
          is_catchall: !!m.is_catchall,
          disabled: !!m.disabled,
        };
      })
      .filter(Boolean);
    const r = await agentFetch(context.userId, "/mailboxes/sync", { mailboxes });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("agent_configs")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("owner_id", context.userId);
    return { synced: mailboxes.length, agent: r };
  });

export const resetAgentMailboxPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { email: string; new_password: string }) => data)
  .handler(async ({ context, data }) => {
    if (!data.email || !data.new_password) throw new Error("email + new_password required");
    return agentFetch(context.userId, "/mailboxes/reset-password", data);
  });

export const applyRetention = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: policies, error } = await context.supabase
      .from("retention_policies")
      .select("max_age_days, max_count, domains(name)");
    if (error) throw new Error(error.message);
    const payload = {
      policies: (policies ?? [])
        .map((p: any) => ({
          domain: p.domains?.name,
          max_age_days: p.max_age_days ?? 1,
          max_count: p.max_count ?? 100,
        }))
        .filter((p) => p.domain),
    };
    return agentFetch(context.userId, "/retention/apply", payload);
  });

import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";

type Payload = {
  owner_id: string;
  to: string;
  from: string;
  subject?: string;
  body_text?: string;
  body_html?: string;
  size?: number;
  received_at?: string;
};

export const Route = createFileRoute("/api/public/agent/emails")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const secret = auth.replace(/^Bearer\s+/i, "").trim();
        if (!secret) return new Response("missing bearer", { status: 401 });

        let body: Payload;
        try { body = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
        if (!body.owner_id || !body.to || !body.from) {
          return new Response("owner_id, to, from required", { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Verify bearer against stored hash for this owner
        const { data: cfg } = await supabaseAdmin
          .from("agent_configs")
          .select("shared_secret_hash")
          .eq("owner_id", body.owner_id)
          .maybeSingle();
        if (!cfg?.shared_secret_hash) return new Response("agent not configured", { status: 403 });
        const provided = createHash("sha256").update(secret).digest();
        const stored = Buffer.from(cfg.shared_secret_hash, "hex");
        if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) {
          return new Response("invalid secret", { status: 401 });
        }

        // Resolve recipient -> mailbox_id (exact match or catch-all on domain)
        const to = body.to.toLowerCase();
        const [local, domain] = to.split("@");
        if (!domain) return new Response("bad recipient", { status: 400 });

        const { data: dom } = await supabaseAdmin
          .from("domains")
          .select("id")
          .eq("owner_id", body.owner_id)
          .eq("name", domain)
          .maybeSingle();
        if (!dom) return new Response("unknown domain", { status: 404 });

        const { data: mailboxes } = await supabaseAdmin
          .from("mailboxes")
          .select("id, local_part, is_catchall")
          .eq("domain_id", dom.id);

        const exact = mailboxes?.find((m) => m.local_part?.toLowerCase() === local);
        const catchall = mailboxes?.find((m) => m.is_catchall);
        const mailbox = exact ?? catchall;
        if (!mailbox) return new Response("no mailbox", { status: 404 });

        const { error } = await supabaseAdmin.from("emails").insert({
          mailbox_id: mailbox.id,
          from_addr: body.from,
          to_addr: body.to,
          subject: body.subject ?? null,
          body_text: body.body_text ?? null,
          body_html: body.body_html ?? null,
          size_bytes: body.size ?? (body.body_text?.length ?? 0),
          received_at: body.received_at ?? new Date().toISOString(),
          is_read: false,
        });
        if (error) return new Response(error.message, { status: 500 });

        return new Response(JSON.stringify({ ok: true, mailbox_id: mailbox.id }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});

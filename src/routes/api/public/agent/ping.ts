import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";

export const Route = createFileRoute("/api/public/agent/ping")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const secret = auth.replace(/^Bearer\s+/i, "").trim();
        if (!secret) return new Response("missing bearer", { status: 401 });

        let body: { owner_id?: string; base_url?: string } = {};
        try { body = await request.json(); } catch {}
        if (!body.owner_id) return new Response("owner_id required", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

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

        // Capture source IP
        const fwd = request.headers.get("x-forwarded-for") ?? "";
        const ip = fwd.split(",")[0]?.trim() || request.headers.get("cf-connecting-ip") || null;

        await supabaseAdmin.from("agent_configs").update({
          detected_ip: ip,
          base_url: body.base_url ?? undefined,
          last_ping_at: new Date().toISOString(),
          last_ping_ok: true,
          updated_at: new Date().toISOString(),
        }).eq("owner_id", body.owner_id);

        return new Response(JSON.stringify({ ok: true, detected_ip: ip }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  testAgent,
  syncDomains,
  syncMailboxes,
  applyRetention,
  registerAgentOwner,
} from "@/lib/agent.functions";
import { RefreshCw, PlugZap, Globe, Users, Trash2, UserCheck } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");

  const { data: cfg } = useQuery({
    queryKey: ["agent-config"],
    queryFn: async () => (await supabase.from("agent_configs").select("*").maybeSingle()).data,
  });

  useEffect(() => {
    if (cfg) setBaseUrl(cfg.base_url ?? "");
  }, [cfg]);

  const save = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const preview = secret ? secret.slice(0, 4) + "…" + secret.slice(-2) : cfg?.shared_secret_preview;
      let secretHash: string | undefined;
      if (secret) {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
        secretHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
      }
      const { error } = await supabase.from("agent_configs").upsert({
        owner_id: u.user.id,
        base_url: baseUrl,
        shared_secret_preview: preview,
        ...(secretHash ? { shared_secret_hash: secretHash } : {}),
        ...(secret ? { shared_secret: secret } : {}),
        updated_at: new Date().toISOString(),
      }, { onConflict: "owner_id" });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Setting disimpan"); setSecret(""); qc.invalidateQueries({ queryKey: ["agent-config"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const test = useServerFn(testAgent);
  const syncD = useServerFn(syncDomains);
  const syncM = useServerFn(syncMailboxes);
  const retention = useServerFn(applyRetention);
  const register = useServerFn(registerAgentOwner);

  const run = (label: string, fn: () => Promise<any>) => async () => {
    const t = toast.loading(label + "…");
    try {
      const r = await fn();
      toast.success(`${label} ok`, { id: t, description: JSON.stringify(r).slice(0, 140) });
    } catch (e: any) {
      toast.error(`${label} gagal`, { id: t, description: e.message });
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Konfigurasi koneksi ke agent VPS.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">VPS Agent</CardTitle>
          <p className="text-xs text-muted-foreground">
            Agent kecil yang jalan di VPS Postfix/Dovecot kamu. Diinstall via script (lihat <span className="font-mono">docs/AGENT.md</span>).
            Status: <Badge variant="secondary">Fase 2 — belum aktif</Badge>
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Agent base URL</Label>
            <Input placeholder="https://mail.example.com:8443" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Shared secret {cfg?.shared_secret_preview && <span className="ml-2 text-xs text-muted-foreground">tersimpan: {cfg.shared_secret_preview}</span>}</Label>
            <Input type="password" placeholder={cfg?.shared_secret_preview ? "(isi ulang untuk ganti)" : "generate di VPS lalu paste di sini"} value={secret} onChange={(e) => setSecret(e.target.value)} />
          </div>
          <Button onClick={() => save.mutate()}>Save</Button>

          {cfg && (
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <div className="text-xs font-semibold">Setup di VPS</div>
              <p className="text-xs text-muted-foreground">
                Agent di VPS harus ping endpoint ini tiap ~1 menit. IP publik VPS akan ke-detect otomatis dari request.
              </p>
              <pre className="overflow-x-auto rounded bg-background p-2 text-[11px] font-mono">
{`# Jalankan di VPS (cron tiap menit):
curl -X POST ${typeof window !== "undefined" ? window.location.origin : ""}/api/public/agent/ping \\
  -H "Authorization: Bearer <SHARED_SECRET>" \\
  -H "Content-Type: application/json" \\
  -d '{"owner_id":"${cfg.owner_id}","base_url":"${cfg.base_url ?? "http://your-vps:8080"}"}'`}
              </pre>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-muted-foreground">Last ping</div>
                  <div className="font-mono">{cfg.last_ping_at ? new Date(cfg.last_ping_at).toLocaleString() : "—"}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Detected IP</div>
                  <div className="font-mono">{(cfg as any).detected_ip ?? "—"}</div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reset password</CardTitle>
          <p className="text-xs text-muted-foreground">Ganti password akun yang sedang login.</p>
        </CardHeader>
        <CardContent>
          <ResetPasswordForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Info</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>• Panel Fase 1: semua data disimpan di database. Belum konek ke mail server sungguhan.</p>
          <p>• Fase 2: install script + agent akan connect panel ini ke Postfix/Dovecot di VPS.</p>
          <p>• Fase 3: port ke Cloudflare Worker jika kamu mau full edge.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function ResetPasswordForm() {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 6) return toast.error("Password minimal 6 karakter");
    if (pw !== pw2) return toast.error("Konfirmasi password tidak cocok");
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Password berhasil diganti");
    setPw(""); setPw2("");
  };

  return (
    <form onSubmit={submit} className="space-y-4 max-w-sm">
      <div className="space-y-2">
        <Label>Password baru</Label>
        <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={6} required />
      </div>
      <div className="space-y-2">
        <Label>Ulangi password</Label>
        <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} minLength={6} required />
      </div>
      <Button type="submit" disabled={loading}>Ganti password</Button>
    </form>
  );
}

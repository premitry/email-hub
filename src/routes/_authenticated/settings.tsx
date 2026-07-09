import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState } from "react";
import { toast } from "sonner";

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
      const { error } = await supabase.from("agent_configs").upsert({
        owner_id: u.user.id,
        base_url: baseUrl,
        shared_secret_preview: preview,
        updated_at: new Date().toISOString(),
      }, { onConflict: "owner_id" });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Setting disimpan"); setSecret(""); qc.invalidateQueries({ queryKey: ["agent-config"] }); },
    onError: (e: any) => toast.error(e.message),
  });

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

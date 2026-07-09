import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { checkDnsRecord } from "@/lib/dns.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useEffect, useRef, useState } from "react";
import { Plus, Globe, ChevronRight, Trash2, Copy, RefreshCw, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/domains/")({
  component: DomainsList,
});

type DnsRow = { host: string; type: string; value: string; priority?: number; note?: string };

function buildRecords(name: string, mx: string, ip: string | null): DnsRow[] {
  return [
    { host: name, type: "MX", value: mx, priority: 10, note: "Arahkan email ke server kamu" },
    { host: mx, type: "A", value: ip ?? "<IP VPS kamu>", note: "Hostname mail server" },
    { host: name, type: "TXT", value: "v=spf1 mx -all", note: "SPF (opsional untuk inbound-only)" },
  ];
}

function DomainsList() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: domains, isLoading } = useQuery({
    queryKey: ["domains"],
    queryFn: async () => {
      const { data, error } = await supabase.from("domains").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const addDomain = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { data: d, error } = await supabase.from("domains").insert({
        owner_id: u.user.id,
        name: name.trim().toLowerCase(),
        mx_hostname: `mail.${name.trim().toLowerCase()}`,
        server_ip: ip.trim() || null,
      }).select().single();
      if (error) throw error;
      await supabase.from("retention_policies").insert({ domain_id: d.id, max_age_days: 1, max_count: 100 });
      return d;
    },
    onSuccess: () => {
      toast.success("Domain ditambahkan");
      setOpen(false);
      setName(""); setIp("");
      qc.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("domains").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Domain dihapus");
      qc.invalidateQueries({ queryKey: ["domains"] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Domains</h1>
          <p className="text-sm text-muted-foreground">Kelola catch-all domain kamu.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4" /> Add domain</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add domain</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="d-name">Domain</Label>
                <Input id="d-name" placeholder="example.com" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="d-ip">Server IP (opsional)</Label>
                <Input id="d-ip" placeholder="1.2.3.4" value={ip} onChange={(e) => setIp(e.target.value)} />
                <p className="text-xs text-muted-foreground">IP VPS kamu. Bisa di-isi belakangan lewat expand panel.</p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => addDomain.mutate()} disabled={!name || addDomain.isPending}>Simpan</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Memuat...</p>
      ) : !domains?.length ? (
        <Card className="p-8 text-center">
          <Globe className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">Belum ada domain. Klik "Add domain" untuk mulai.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {domains.map((d) => {
            const isOpen = expanded === d.id;
            return (
              <Card key={d.id} className="overflow-hidden">
                <div className="flex items-center justify-between p-4">
                  <div className="flex flex-1 items-center gap-3">
                    <Globe className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="font-mono text-sm">{d.name}</div>
                      <div className="text-xs text-muted-foreground">
                        MX: {d.mx_hostname} {d.server_ip && `• ${d.server_ip}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={d.verified ? "default" : "secondary"}>
                      {d.verified ? "Verified" : "Pending"}
                    </Badge>
                    <Button variant="ghost" size="icon" onClick={() => del.mutate(d.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setExpanded(isOpen ? null : d.id)}
                      aria-label={isOpen ? "Tutup detail" : "Buka detail"}
                    >
                      <ChevronRight className={`h-4 w-4 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    </Button>
                  </div>
                </div>
                {isOpen && <DomainDetailInline domain={d} />}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function extractIpFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `http://${url}`);
    const host = u.hostname;
    // IPv4 check
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
    return null;
  } catch { return null; }
}

function DomainDetailInline({ domain }: { domain: any }) {
  const qc = useQueryClient();
  const checkFn = useServerFn(checkDnsRecord);
  const [ip, setIp] = useState(domain.server_ip ?? "");
  const [results, setResults] = useState<Record<string, { ok: boolean; answers: string[] } | undefined>>({});
  const [checking, setChecking] = useState(false);

  useEffect(() => { setIp(domain.server_ip ?? ""); }, [domain.server_ip]);

  const { data: agentCfg } = useQuery({
    queryKey: ["agent_configs"],
    queryFn: async () => (await supabase.from("agent_configs").select("base_url").maybeSingle()).data,
  });
  const agentIp = extractIpFromUrl(agentCfg?.base_url);

  // Auto-fill from agent IP on first load if domain has no IP
  useEffect(() => {
    if (!domain.server_ip && agentIp && !ip) setIp(agentIp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentIp]);

  const records = buildRecords(domain.name, domain.mx_hostname, domain.server_ip);

  const saveIp = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("domains").update({ server_ip: ip.trim() || null }).eq("id", domain.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Server IP disimpan");
      qc.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const runCheck = async () => {
    setChecking(true);
    const out: typeof results = {};
    for (const r of records) {
      try {
        const res = await checkFn({ data: { name: r.host, type: r.type as any } });
        const ok = res.answers.some((a) => a.toLowerCase().includes(r.value.toLowerCase()));
        out[`${r.host}-${r.type}`] = { ok, answers: res.answers };
      } catch {
        out[`${r.host}-${r.type}`] = { ok: false, answers: [] };
      }
    }
    setResults(out);
    setChecking(false);
    const allOk = Object.values(out).every((r) => r?.ok);
    if (allOk && !domain.verified) {
      await supabase.from("domains").update({ verified: true }).eq("id", domain.id);
      qc.invalidateQueries({ queryKey: ["domains"] });
      toast.success("Semua DNS record valid — domain verified");
    }
  };

  // Auto-refresh DNS check every 15s in background (silent)
  const runCheckRef = useRef(runCheck);
  runCheckRef.current = runCheck;
  useEffect(() => {
    const t = setInterval(() => { runCheckRef.current(); }, 15000);
    return () => clearInterval(t);
  }, []);

  const activeCount = records.filter((r) => results[`${r.host}-${r.type}`]?.ok).length;
  const total = records.length;
  const percent = Math.round((activeCount / total) * 100);

  const statusOf = (r: DnsRow): "active" | "waiting" | "error" => {
    const s = results[`${r.host}-${r.type}`];
    if (s === undefined) return "waiting";
    if (s.ok) return "active";
    // error only if the A record is missing IP or DNS returned answers but wrong
    if (r.type === "A" && !domain.server_ip) return "waiting";
    return s.answers.length > 0 ? "error" : "waiting";
  };

  const rowStyles: Record<string, string> = {
    active: "bg-green-500/10 border-green-500/30",
    waiting: "bg-yellow-500/10 border-yellow-500/30",
    error: "bg-red-500/10 border-red-500/30",
  };
  const dotStyles: Record<string, string> = {
    active: "bg-green-500",
    waiting: "bg-yellow-500",
    error: "bg-red-500",
  };
  const labelOf: Record<string, string> = {
    active: "✓ Active",
    waiting: "Waiting...",
    error: "Error",
  };

  return (
    <div className="border-t bg-muted/20 p-4 space-y-4">
      {/* Domain */}
      <div>
        <Label className="text-xs font-semibold text-muted-foreground">Domain</Label>
        <div className="mt-1 font-mono text-sm">{domain.name}</div>
      </div>

      <div className="border-t" />

      <div>
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold text-muted-foreground">VPS IP Address</Label>
          {agentIp && agentIp !== ip && (
            <button
              type="button"
              onClick={() => setIp(agentIp)}
              className="text-xs text-primary hover:underline"
            >
              Use agent IP ({agentIp})
            </button>
          )}
        </div>
        <div className="mt-1 flex gap-2">
          <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="103.xxx.xxx.xxx" className="font-mono" />
          <Button size="sm" onClick={() => saveIp.mutate()} disabled={saveIp.isPending || ip === (domain.server_ip ?? "")}>
            <Save className="h-4 w-4" /> Save
          </Button>
        </div>
        {!agentIp && (
          <p className="mt-1 text-xs text-muted-foreground">
            Tip: isi <span className="font-mono">Agent base URL</span> di Settings (mis. <span className="font-mono">http://103.20.30.40:8080</span>) untuk auto-fill IP di sini.
          </p>
        )}
      </div>


      <div className="border-t" />

      {/* DNS Records */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold text-muted-foreground">DNS Records</Label>
          <span className="text-xs text-muted-foreground">{activeCount}/{total} Active</span>
        </div>
        <div className="flex items-center gap-3">
          <Progress value={percent} className="h-2 flex-1" />
          <span className="text-xs font-mono text-muted-foreground w-10 text-right">{percent}%</span>
        </div>

        <div className="space-y-2">
          {records.map((r) => {
            const val = r.priority !== undefined ? `${r.priority} ${r.value}` : r.value;
            const st = statusOf(r);
            return (
              <div
                key={`${r.host}-${r.type}`}
                className={`flex items-center gap-3 rounded-md border px-3 py-2 text-xs transition-colors duration-500 ${rowStyles[st]}`}
              >
                <span className={`h-2.5 w-2.5 rounded-full ${dotStyles[st]} transition-colors duration-500`} />
                <Badge variant="outline" className="font-mono w-12 justify-center shrink-0">{r.type}</Badge>
                <span className="w-40 truncate font-mono text-muted-foreground shrink-0">{r.host}</span>
                <span className="flex-1 truncate font-mono">{val}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">{labelOf[st]}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => { navigator.clipboard.writeText(val); toast.success(`${r.type} copied`); }}
                  aria-label={`Copy ${r.type} value`}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end">
          <Button size="sm" onClick={runCheck} disabled={checking}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Check DNS
          </Button>
        </div>
      </div>
    </div>
  );
}


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
import { useEffect, useState } from "react";
import { Plus, Globe, ChevronRight, Trash2, Copy, RefreshCw, Loader2, Check, X, Save } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

function DomainDetailInline({ domain }: { domain: any }) {
  const qc = useQueryClient();
  const checkFn = useServerFn(checkDnsRecord);
  const [ip, setIp] = useState(domain.server_ip ?? "");
  const [results, setResults] = useState<Record<string, { ok: boolean; answers: string[] } | undefined>>({});
  const [checking, setChecking] = useState(false);

  useEffect(() => { setIp(domain.server_ip ?? ""); }, [domain.server_ip]);

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

  const markdown = `## DNS records — \`${domain.name}\`

Set record berikut di DNS provider kamu (Cloudflare / Namecheap / dll).

| Status | Type | Host | Value |
| --- | --- | --- | --- |
${records.map((r) => {
  const key = `${r.host}-${r.type}`;
  const status = results[key];
  const icon = status === undefined ? "⏳" : status.ok ? "✅" : "❌";
  const val = r.priority !== undefined ? `\`${r.priority} ${r.value}\`` : `\`${r.value}\``;
  return `| ${icon} | **${r.type}** | \`${r.host}\` | ${val} |`;
}).join("\n")}

${records.filter(r => r.note).map(r => `- **${r.type}** — ${r.note}`).join("\n")}
${!domain.server_ip ? "\n> ⚠️ **Server IP belum di-set.** A record masih placeholder. Isi IP VPS di bawah supaya record valid." : ""}`;

  return (
    <div className="border-t bg-muted/20 p-4 space-y-4">
      {/* Server IP setting */}
      <div className="rounded-lg border bg-background p-3">
        <Label className="text-xs font-semibold">Server IP (VPS)</Label>
        <p className="mb-2 mt-1 text-xs text-muted-foreground">
          Dipakai untuk A record <span className="font-mono">{domain.mx_hostname}</span>. Wajib supaya mailserver bisa di-resolve dari luar.
        </p>
        <div className="flex gap-2">
          <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="1.2.3.4" className="font-mono" />
          <Button size="sm" onClick={() => saveIp.mutate()} disabled={saveIp.isPending || ip === (domain.server_ip ?? "")}>
            <Save className="h-4 w-4" /> Save
          </Button>
        </div>
      </div>

      {/* DNS check controls */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {checking ? "Mengecek DNS..." : Object.keys(results).length ? `Terakhir dicek: ${Object.values(results).filter(r => r?.ok).length}/${records.length} valid` : "Belum dicek"}
        </div>
        <Button size="sm" onClick={runCheck} disabled={checking}>
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Cek DNS
        </Button>
      </div>

      {/* Rendered markdown */}
      <div className="rounded-lg border bg-background p-4 text-sm [&_h2]:mb-3 [&_h2]:text-base [&_h2]:font-semibold [&_p]:mb-3 [&_p]:text-muted-foreground [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-xs [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_td]:text-xs [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:text-xs [&_ul]:text-muted-foreground [&_blockquote]:mt-3 [&_blockquote]:rounded [&_blockquote]:border-l-4 [&_blockquote]:border-yellow-500 [&_blockquote]:bg-yellow-500/10 [&_blockquote]:px-3 [&_blockquote]:py-2 [&_blockquote]:text-xs">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>

      {/* Copy buttons per record */}
      <div className="space-y-1">
        {records.map((r) => {
          const val = r.priority !== undefined ? `${r.priority} ${r.value}` : r.value;
          const key = `${r.host}-${r.type}`;
          const status = results[key];
          return (
            <button
              key={key}
              onClick={() => { navigator.clipboard.writeText(val); toast.success(`${r.type} copied`); }}
              className="flex w-full items-center gap-2 rounded border bg-background px-3 py-2 text-left text-xs hover:bg-muted"
            >
              <span className="w-4">
                {status === undefined ? null : status.ok ? <Check className="h-3.5 w-3.5 text-green-500" /> : <X className="h-3.5 w-3.5 text-destructive" />}
              </span>
              <Badge variant="outline" className="font-mono">{r.type}</Badge>
              <span className="w-40 truncate font-mono text-muted-foreground">{r.host}</span>
              <span className="flex-1 truncate font-mono">{val}</span>
              <Copy className="h-3 w-3 text-muted-foreground" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

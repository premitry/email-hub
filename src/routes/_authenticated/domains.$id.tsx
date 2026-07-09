import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { checkDnsRecord } from "@/lib/dns.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Check, X, Copy, RefreshCw, ArrowLeft, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/domains/$id")({
  component: DomainDetail,
});

type DnsRow = { host: string; type: string; value: string; priority?: number; note?: string };

function buildRecords(name: string, mx: string, ip: string | null): DnsRow[] {
  const rows: DnsRow[] = [
    { host: name, type: "MX", value: mx, priority: 10, note: "Arahkan email ke server kamu" },
    { host: mx, type: "A", value: ip ?? "<IP VPS kamu>", note: "Hostname mail server" },
    { host: name, type: "TXT", value: "v=spf1 mx -all", note: "SPF (opsional untuk inbound-only)" },
  ];
  return rows;
}

function DomainDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const checkFn = useServerFn(checkDnsRecord);

  const { data: domain } = useQuery({
    queryKey: ["domain", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("domains").select("*").eq("id", id).single();
      if (error) throw error;
      return data;
    },
  });

  const { data: policy } = useQuery({
    queryKey: ["policy", id],
    queryFn: async () => {
      const { data } = await supabase.from("retention_policies").select("*").eq("domain_id", id).maybeSingle();
      return data;
    },
  });

  const [results, setResults] = useState<Record<string, { ok: boolean; answers: string[] } | undefined>>({});
  const [checking, setChecking] = useState(false);
  const [auto, setAuto] = useState(false);

  const runCheck = async () => {
    if (!domain) return;
    setChecking(true);
    const records = buildRecords(domain.name, domain.mx_hostname, domain.server_ip);
    const out: typeof results = {};
    for (const r of records) {
      try {
        const res = await checkFn({ data: { name: r.host, type: r.type as any } });
        const expected = r.type === "MX" ? r.value : r.value;
        const ok = res.answers.some((a) => a.toLowerCase().includes(expected.toLowerCase()));
        out[`${r.host}-${r.type}`] = { ok, answers: res.answers };
      } catch {
        out[`${r.host}-${r.type}`] = { ok: false, answers: [] };
      }
    }
    setResults(out);
    setChecking(false);

    // Auto-mark verified if all green
    const allOk = Object.values(out).every((r) => r?.ok);
    if (allOk && !domain.verified) {
      await supabase.from("domains").update({ verified: true }).eq("id", id);
      qc.invalidateQueries({ queryKey: ["domain", id] });
      toast.success("Semua DNS record valid — domain verified");
    }
  };

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(runCheck, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, domain]);

  const savePolicy = useMutation({
    mutationFn: async (v: { max_age_days: number; max_count: number }) => {
      const { error } = await supabase.from("retention_policies").upsert(
        { domain_id: id, ...v, updated_at: new Date().toISOString() },
        { onConflict: "domain_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Retensi disimpan");
      qc.invalidateQueries({ queryKey: ["policy", id] });
    },
  });

  if (!domain) return <p className="text-sm text-muted-foreground">Memuat...</p>;

  const records = buildRecords(domain.name, domain.mx_hostname, domain.server_ip);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/domains"><Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button></Link>
        <div className="flex-1">
          <h1 className="font-mono text-xl">{domain.name}</h1>
          <p className="text-xs text-muted-foreground">Dibuat {new Date(domain.created_at).toLocaleString()}</p>
        </div>
        <Badge variant={domain.verified ? "default" : "secondary"}>
          {domain.verified ? "Verified" : "Pending DNS"}
        </Badge>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">DNS records</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Set record ini di DNS provider kamu (Cloudflare, Namecheap, dll).</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setAuto(!auto)}>
              {auto ? "Stop auto" : "Auto-refresh"}
            </Button>
            <Button size="sm" onClick={runCheck} disabled={checking}>
              {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Cek sekarang
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {!domain.server_ip && (
            <div className="rounded border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs">
              Server IP belum di-set. A record akan pakai placeholder. Edit domain untuk isi IP VPS.
            </div>
          )}
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-4 text-xs leading-relaxed font-mono">
{`# DNS records — ${domain.name}
# Set di DNS provider kamu (Cloudflare / Namecheap / dll)

${records.map((r) => {
  const key = `${r.host}-${r.type}`;
  const status = results[key];
  const icon = status === undefined ? "· " : status.ok ? "✓ " : "✗ ";
  const val = r.priority !== undefined ? `${r.priority} ${r.value}` : r.value;
  return `${icon}${r.type.padEnd(5)} ${r.host.padEnd(28)} ${val}${r.note ? `\n         ↳ ${r.note}` : ""}`;
}).join("\n\n")}
`}
            </pre>
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-2 top-2"
              onClick={() => {
                const text = records.map((r) => {
                  const val = r.priority !== undefined ? `${r.priority} ${r.value}` : r.value;
                  return `${r.type}\t${r.host}\t${val}`;
                }).join("\n");
                navigator.clipboard.writeText(text);
                toast.success("Semua record di-copy");
              }}
            >
              <Copy className="h-3 w-3" /> Copy all
            </Button>
          </div>
          <div className="space-y-1">
            {records.map((r) => {
              const val = r.priority !== undefined ? `${r.priority} ${r.value}` : r.value;
              return (
                <button
                  key={`${r.host}-${r.type}-copy`}
                  onClick={() => { navigator.clipboard.writeText(val); toast.success(`${r.type} value copied`); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted"
                >
                  <Badge variant="outline" className="font-mono">{r.type}</Badge>
                  <span className="flex-1 truncate font-mono text-muted-foreground">{val}</span>
                  <Copy className="h-3 w-3 text-muted-foreground" />
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Retensi otomatis</CardTitle></CardHeader>
        <CardContent>
          <RetentionForm policy={policy} onSave={(v) => savePolicy.mutate(v)} />
        </CardContent>
      </Card>
    </div>
  );
}

function RetentionForm({ policy, onSave }: { policy: any; onSave: (v: { max_age_days: number; max_count: number }) => void }) {
  const [age, setAge] = useState(policy?.max_age_days ?? 1);
  const [count, setCount] = useState(policy?.max_count ?? 100);
  useEffect(() => {
    if (policy) { setAge(policy.max_age_days); setCount(policy.max_count); }
  }, [policy]);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Max umur email (hari)</Label>
          <Input type="number" min={1} value={age} onChange={(e) => setAge(Number(e.target.value))} />
        </div>
        <div className="space-y-2">
          <Label>Max jumlah per mailbox</Label>
          <Input type="number" min={1} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Email yang lebih tua dari X hari atau melebihi Y akan dihapus otomatis oleh agent VPS.</p>
      <Button onClick={() => onSave({ max_age_days: age, max_count: count })}>Simpan</Button>
    </div>
  );
}

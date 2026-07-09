import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Globe, Users, Inbox, HardDrive, TerminalSquare } from "lucide-react";
import { useEffect, useRef } from "react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

type LogLine = { t: Date; level: "info" | "ok" | "warn" | "err"; msg: string };

function Dashboard() {
  const { data } = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: async () => {
      const [{ count: domains }, { count: mailboxes }, { count: emails24 }, { data: totalSize }] = await Promise.all([
        supabase.from("domains").select("*", { count: "exact", head: true }),
        supabase.from("mailboxes").select("*", { count: "exact", head: true }),
        supabase.from("emails").select("*", { count: "exact", head: true }).gte("received_at", new Date(Date.now() - 86400000).toISOString()),
        supabase.from("emails").select("size_bytes"),
      ]);
      const size = (totalSize ?? []).reduce((a, r: any) => a + (r.size_bytes ?? 0), 0);
      return { domains: domains ?? 0, mailboxes: mailboxes ?? 0, emails24: emails24 ?? 0, size };
    },
  });

  // Live activity feed for the terminal-style panel: pull latest emails + agent status
  const { data: recentEmails } = useQuery({
    queryKey: ["recent-emails"],
    queryFn: async () => {
      const { data } = await supabase
        .from("emails")
        .select("id, from_addr, to_addr, subject, size_bytes, received_at")
        .order("received_at", { ascending: false })
        .limit(15);
      return data ?? [];
    },
    refetchInterval: 5000,
  });

  const { data: agent } = useQuery({
    queryKey: ["agent_configs"],
    queryFn: async () => (await supabase.from("agent_configs").select("*").maybeSingle()).data,
    refetchInterval: 10000,
  });

  const stats = [
    { label: "Domains", value: data?.domains ?? "—", icon: Globe },
    { label: "Mailboxes", value: data?.mailboxes ?? "—", icon: Users },
    { label: "Emails (24h)", value: data?.emails24 ?? "—", icon: Inbox },
    { label: "Storage", value: data ? `${(data.size / 1024).toFixed(1)} KB` : "—", icon: HardDrive },
  ];

  const logs: LogLine[] = [];
  if (agent) {
    if (agent.last_ping_at) {
      const secs = Math.round((Date.now() - new Date(agent.last_ping_at).getTime()) / 1000);
      logs.push({
        t: new Date(agent.last_ping_at),
        level: agent.last_ping_ok ? "ok" : "warn",
        msg: `agent ping ${agent.last_ping_ok ? "ok" : "failed"} (${secs}s ago) — ${agent.base_url ?? "no base_url"}`,
      });
    } else {
      logs.push({ t: new Date(), level: "warn", msg: "agent belum pernah ping — cek Settings" });
    }
  } else {
    logs.push({ t: new Date(), level: "warn", msg: "agent belum di-setup — buka Settings" });
  }
  for (const e of recentEmails ?? []) {
    logs.push({
      t: new Date(e.received_at),
      level: "info",
      msg: `mail ${e.from_addr} → ${e.to_addr}  "${(e.subject ?? "(no subject)").slice(0, 60)}"  ${(e.size_bytes / 1024).toFixed(1)}KB`,
    });
  }
  logs.sort((a, b) => b.t.getTime() - a.t.getTime());

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [recentEmails, agent]);

  const levelColor: Record<LogLine["level"], string> = {
    info: "text-sky-400",
    ok: "text-green-400",
    warn: "text-yellow-400",
    err: "text-red-400",
  };
  const levelTag: Record<LogLine["level"], string> = {
    info: "INFO",
    ok: " OK ",
    warn: "WARN",
    err: "ERR ",
  };

  const fmtTime = (d: Date) =>
    d.toLocaleTimeString("en-GB", { hour12: false });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Overview mail server kamu.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm text-muted-foreground">{s.label}</CardTitle>
              <s.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick start</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>1. Tambah domain di <span className="font-mono text-foreground">Domains</span> — panel akan tampilin record DNS yang harus di-set.</p>
            <p>2. Cek DNS live sampai semua hijau.</p>
            <p>3. Bikin IMAP user di <span className="font-mono text-foreground">Mailboxes</span> (bisa catch-all).</p>
            <p>4. Copy kredensial IMAP ke Gmail / n8n / tool lain.</p>
            <p>5. Set retensi per domain (default: 1 hari / 100 email).</p>
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-zinc-800 bg-zinc-950">
          <CardHeader className="flex flex-row items-center justify-between border-b border-zinc-800 bg-zinc-900/50 py-2">
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-green-500/80" />
              </div>
              <span className="ml-2 flex items-center gap-1.5 font-mono text-xs text-zinc-400">
                <TerminalSquare className="h-3.5 w-3.5" /> agent.log
              </span>
            </div>
            <span className="font-mono text-[10px] text-zinc-500">live · 5s</span>
          </CardHeader>
          <CardContent className="p-0">
            <div
              ref={scrollRef}
              className="h-[280px] overflow-y-auto p-3 font-mono text-xs leading-relaxed"
            >
              {logs.length === 0 ? (
                <div className="text-zinc-600">$ waiting for events...</div>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className="flex gap-2 py-0.5">
                    <span className="text-zinc-600">{fmtTime(l.t)}</span>
                    <span className={levelColor[l.level]}>[{levelTag[l.level]}]</span>
                    <span className="flex-1 text-zinc-300 break-all">{l.msg}</span>
                  </div>
                ))
              )}
              <div className="mt-2 flex items-center gap-2 text-zinc-500">
                <span className="text-green-400">$</span>
                <span className="inline-block h-3 w-1.5 animate-pulse bg-zinc-500" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

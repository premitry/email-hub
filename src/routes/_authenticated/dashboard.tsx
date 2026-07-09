import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Globe, Users, Inbox, HardDrive } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

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

  const stats = [
    { label: "Domains", value: data?.domains ?? "—", icon: Globe },
    { label: "Mailboxes", value: data?.mailboxes ?? "—", icon: Users },
    { label: "Emails (24h)", value: data?.emails24 ?? "—", icon: Inbox },
    { label: "Storage", value: data ? `${(data.size / 1024).toFixed(1)} KB` : "—", icon: HardDrive },
  ];

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
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Inbox as InboxIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/inbox")({
  component: InboxPage,
});

function InboxPage() {
  const [selected, setSelected] = useState<string | null>(null);

  const { data: emails } = useQuery({
    queryKey: ["emails"],
    queryFn: async () => (await supabase.from("emails")
      .select("*, mailboxes(local_part, domains(name))")
      .order("received_at", { ascending: false })
      .limit(100)).data ?? [],
  });

  const current = emails?.find((e) => e.id === selected);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <p className="text-sm text-muted-foreground">Email masuk (100 terbaru).</p>
      </div>

      {!emails?.length ? (
        <Card className="p-8 text-center">
          <InboxIcon className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">Belum ada email masuk.</p>
          <p className="mt-1 text-xs text-muted-foreground">Email akan muncul di sini setelah agent VPS aktif (Fase 2).</p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[380px,1fr]">
          <div className="space-y-2">
            {emails.map((e: any) => (
              <button
                key={e.id}
                onClick={() => setSelected(e.id)}
                className={`w-full rounded border p-3 text-left text-sm hover:bg-muted ${selected === e.id ? "border-primary bg-muted" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{e.from_addr}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{new Date(e.received_at).toLocaleTimeString()}</span>
                </div>
                <div className="truncate text-xs">{e.subject ?? "(no subject)"}</div>
                <div className="mt-1 font-mono text-xs text-muted-foreground">→ {e.to_addr}</div>
              </button>
            ))}
          </div>
          <Card className="p-6">
            {current ? (
              <div className="space-y-3">
                <div>
                  <div className="text-lg font-medium">{current.subject ?? "(no subject)"}</div>
                  <div className="mt-1 text-sm text-muted-foreground">Dari {current.from_addr}</div>
                  <div className="text-sm text-muted-foreground">Ke <span className="font-mono">{current.to_addr}</span></div>
                </div>
                <Badge variant="outline">{current.size_bytes} B</Badge>
                <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">{current.body_text ?? "(no text body)"}</pre>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Pilih email untuk lihat preview.</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

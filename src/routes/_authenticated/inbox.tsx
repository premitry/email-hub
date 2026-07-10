import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Inbox as InboxIcon, RefreshCw, Trash2, Mail, MailOpen } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useServerFn } from "@tanstack/react-start";
import { deleteEmail, markEmailRead } from "@/lib/emails.functions";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_authenticated/inbox")({
  component: InboxPage,
});

function formatWhen(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "baru saja";
  if (diffMin < 60) return `${diffMin}m lalu`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}j lalu`;
  return d.toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function InboxPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const delFn = useServerFn(deleteEmail);
  const markFn = useServerFn(markEmailRead);

  const { data: emails, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["emails"],
    queryFn: async () => (await supabase.from("emails")
      .select("*, mailboxes(local_part, domains(name))")
      .order("received_at", { ascending: false })
      .limit(100)).data ?? [],
    refetchInterval: 15000,
  });

  const current = emails?.find((e: any) => e.id === selected) as any;

  const openEmail = async (id: string) => {
    setSelected(id);
    const row = emails?.find((e: any) => e.id === id) as any;
    if (row && !row.is_read) {
      try {
        await markFn({ data: { id, is_read: true } });
        qc.invalidateQueries({ queryKey: ["emails"] });
      } catch {}
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await delFn({ data: { id } });
      toast.success("Email dihapus");
      setConfirmDelete(null);
      setSelected(null);
      qc.invalidateQueries({ queryKey: ["emails"] });
    } catch (e: any) {
      toast.error(e.message ?? "Gagal menghapus");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Inbox</h1>
          <p className="text-sm text-muted-foreground">
            Email masuk (100 terbaru){emails?.length ? ` · ${emails.length} email` : ""}.
            {dataUpdatedAt ? <span className="ml-1 text-xs">Diperbarui {formatWhen(new Date(dataUpdatedAt).toISOString())}.</span> : null}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {!emails?.length ? (
        <Card className="p-8 text-center">
          <InboxIcon className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">Belum ada email masuk.</p>
          <p className="mt-1 text-xs text-muted-foreground">Email akan muncul di sini setelah agent VPS aktif.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {emails.map((e: any) => (
            <button
              key={e.id}
              onClick={() => openEmail(e.id)}
              className="w-full rounded border p-3 text-left text-sm hover:bg-muted transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {e.is_read ? (
                    <MailOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Mail className="h-4 w-4 shrink-0 text-primary" />
                  )}
                  <span className={`truncate ${e.is_read ? "" : "font-semibold"}`}>{e.from_addr}</span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{formatWhen(e.received_at)}</span>
              </div>
              <div className={`truncate mt-1 ${e.is_read ? "text-sm" : "text-sm font-medium"}`}>
                {e.subject ?? "(no subject)"}
              </div>
              <div className="mt-1 font-mono text-xs text-muted-foreground truncate">→ {e.to_addr}</div>
            </button>
          ))}
        </div>
      )}

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          {current && (
            <>
              <DialogHeader>
                <DialogTitle className="pr-8">{current.subject ?? "(no subject)"}</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-1 text-left">
                    <div className="text-sm">Dari <span className="font-medium text-foreground">{current.from_addr}</span></div>
                    <div className="text-sm">Ke <span className="font-mono text-foreground">{current.to_addr}</span></div>
                    <div className="text-xs">{new Date(current.received_at).toLocaleString("id-ID")}</div>
                  </div>
                </DialogDescription>
              </DialogHeader>

              <div className="flex-1 overflow-y-auto">
                <div className="mb-2">
                  <Badge variant="outline">{current.size_bytes} B</Badge>
                </div>
                {current.body_html ? (
                  <iframe
                    title="email-html"
                    sandbox=""
                    className="w-full min-h-[400px] rounded border bg-white"
                    srcDoc={current.body_html}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">
                    {current.body_text ?? "(no text body)"}
                  </pre>
                )}
              </div>

              <DialogFooter className="gap-2 sm:justify-between">
                <Button
                  variant="destructive"
                  onClick={() => setConfirmDelete(current.id)}
                >
                  <Trash2 className="h-4 w-4" />
                  Hapus
                </Button>
                <Button variant="outline" onClick={() => setSelected(null)}>Tutup</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus email ini?</AlertDialogTitle>
            <AlertDialogDescription>
              Email akan dihapus permanen dari database panel. Tindakan ini tidak bisa dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDelete && handleDelete(confirmDelete)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

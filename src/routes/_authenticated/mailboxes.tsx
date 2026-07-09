import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Copy, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/mailboxes")({
  component: MailboxesPage,
});

function genPassword() {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function MailboxesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [domainId, setDomainId] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [password, setPassword] = useState("");
  const [catchall, setCatchall] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string; host: string } | null>(null);

  const { data: domains } = useQuery({
    queryKey: ["domains-list"],
    queryFn: async () => (await supabase.from("domains").select("id, name, mx_hostname")).data ?? [],
  });

  const { data: mailboxes } = useQuery({
    queryKey: ["mailboxes"],
    queryFn: async () => (await supabase.from("mailboxes").select("*, domains(name, mx_hostname)").order("created_at", { ascending: false })).data ?? [],
  });

  const add = useMutation({
    mutationFn: async () => {
      const pass = password.trim() || genPassword();
      if (pass.length < 6) throw new Error("Password minimal 6 karakter");
      const dom = domains?.find((d) => d.id === domainId);
      if (!dom) throw new Error("Pilih domain");
      const lp = catchall ? "*" : localPart.trim();
      if (!catchall && !lp) throw new Error("Username tidak boleh kosong");
      const { error } = await supabase.from("mailboxes").insert({
        domain_id: domainId,
        local_part: lp,
        is_catchall: catchall,
        password_preview: pass,
      });
      if (error) throw error;
      setCreated({
        email: `${lp}@${dom.name}`,
        password: pass,
        host: dom.mx_hostname,
      });
      setLocalPart("");
      setPassword("");
    },
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("mailboxes").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Mailbox dihapus"); qc.invalidateQueries({ queryKey: ["mailboxes"] }); },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Mailboxes</h1>
          <p className="text-sm text-muted-foreground">IMAP user untuk konek dari Gmail / n8n / dll.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="h-4 w-4" /> New mailbox</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New IMAP user</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Domain</Label>
                <Select value={domainId} onValueChange={setDomainId}>
                  <SelectTrigger><SelectValue placeholder="Pilih domain" /></SelectTrigger>
                  <SelectContent>
                    {domains?.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="catch" checked={catchall} onCheckedChange={(v) => setCatchall(!!v)} />
                <Label htmlFor="catch" className="cursor-pointer">Catch-all (semua alamat @domain)</Label>
              </div>
              {!catchall && (
                <div className="space-y-2">
                  <Label>Username</Label>
                  <Input value={localPart} onChange={(e) => setLocalPart(e.target.value)} placeholder="imap" />
                  <p className="text-xs text-muted-foreground">Ini bagian sebelum @domain.</p>
                </div>
              )}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Password</Label>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPassword(genPassword())}>Generate</Button>
                </div>
                <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Kosongkan untuk auto-generate" />
                <p className="text-xs text-muted-foreground">Min. 6 karakter. Password akan ditampilkan setelah dibuat.</p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => add.mutate()} disabled={!domainId || add.isPending}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {created && (
        <Card className="border-primary/50 p-4">
          <div className="mb-3 text-sm font-medium text-primary">✓ Mailbox berhasil dibuat — kredensial di bawah</div>
          <CredBlock title="IMAP (INCOMING MAIL)" rows={[
            { label: "Server", value: created.host },
            { label: "Port", value: "993" },
            { label: "Security", value: "SSL/TLS" },
            { label: "Username", value: created.email },
            { label: "Password", value: created.password },
          ]} />
          <Button size="sm" variant="ghost" className="mt-3" onClick={() => setCreated(null)}>Tutup</Button>
        </Card>
      )}

      {!mailboxes?.length ? (
        <Card className="p-8 text-center">
          <Users className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">Belum ada mailbox.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {mailboxes.map((m: any) => {
            const email = `${m.local_part}@${m.domains?.name}`;
            return (
              <Card key={m.id} className="p-4">
                <div className="mb-3 flex items-start justify-between">
                  <div>
                    <div className="font-mono text-sm">{email}</div>
                    {m.is_catchall && <Badge variant="secondary" className="mt-1">catch-all</Badge>}
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => del.mutate(m.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <CredBlock title="IMAP (INCOMING MAIL)" rows={[
                  { label: "Server", value: m.domains?.mx_hostname ?? "-" },
                  { label: "Port", value: "993" },
                  { label: "Security", value: "SSL/TLS" },
                  { label: "Username", value: email },
                  { label: "Password", value: m.password_preview ?? "—" },
                ]} />
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CredBlock({ title, rows }: { title: string; rows: { label: string; value: string }[] }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="border-b bg-muted/50 px-4 py-2 text-xs font-semibold tracking-wide text-primary">{title}</div>
      <div className="divide-y">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[110px,1fr,auto] items-center gap-3 px-4 py-2.5 text-sm">
            <span className="text-muted-foreground">{r.label}</span>
            <span className="truncate font-mono">{r.value}</span>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { navigator.clipboard.writeText(r.value); toast.success("Copied"); }}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

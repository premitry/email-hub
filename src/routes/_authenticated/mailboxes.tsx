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
import { Plus, Copy, Trash2, Users, RefreshCw, CheckCircle2, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/mailboxes")({
  component: MailboxesPage,
});

function genPassword() {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

type CreatedInfo = { email: string; password: string; host: string; username: string };

function MailboxesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [domainId, setDomainId] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [password, setPassword] = useState("");
  const [catchall, setCatchall] = useState(false);
  const [created, setCreated] = useState<CreatedInfo | null>(null);

  const { data: domains } = useQuery({
    queryKey: ["domains-list"],
    queryFn: async () => (await supabase.from("domains").select("id, name, mx_hostname")).data ?? [],
  });

  const { data: mailboxes } = useQuery({
    queryKey: ["mailboxes"],
    queryFn: async () => (await supabase.from("mailboxes").select("*, domains(name, mx_hostname)").order("created_at", { ascending: false })).data ?? [],
  });

  const resetForm = () => {
    setDomainId("");
    setLocalPart("");
    setPassword("");
    setCatchall(false);
  };

  const add = useMutation({
    mutationFn: async () => {
      const pass = password.trim() || genPassword();
      if (pass.length < 6) throw new Error("Password minimal 6 karakter");
      const dom = domains?.find((d) => d.id === domainId);
      if (!dom) throw new Error("Pilih domain");
      const lp = localPart.trim();
      if (!lp) throw new Error("Username tidak boleh kosong");
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
        username: `${lp}@${dom.name}`,
      });
      resetForm();
    },
    onSuccess: () => {
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
          <p className="text-sm text-muted-foreground">IMAP user untuk konek dari Outlook, Thunderbird, Apple Mail, Gmail, n8n, dll.</p>
        </div>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) {
              resetForm();
              setCreated(null);
            }
          }}
        >
          <DialogTrigger asChild><Button><Plus className="h-4 w-4" /> New mailbox</Button></DialogTrigger>
          <DialogContent className="sm:max-w-md">
            {!created ? (
              <>
                <DialogHeader><DialogTitle>New Mailbox</DialogTitle></DialogHeader>
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
                  <div className="space-y-2">
                    <Label>Username</Label>
                    <div className="flex items-center gap-2">
                      <Input value={localPart} onChange={(e) => setLocalPart(e.target.value)} placeholder="admin" />
                      <span className="whitespace-nowrap text-sm text-muted-foreground">
                        @{domains?.find((d) => d.id === domainId)?.name ?? "domain"}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Password</Label>
                    <div className="flex gap-2">
                      <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Kosongkan untuk auto-generate" />
                      <Button type="button" variant="outline" size="icon" onClick={() => setPassword(genPassword())} title="Generate">
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">Min. 6 karakter. Password hanya ditampilkan sekali setelah dibuat.</p>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <div className="flex items-start gap-2">
                      <Checkbox id="catch" checked={catchall} onCheckedChange={(v) => setCatchall(!!v)} className="mt-0.5" />
                      <div className="space-y-1">
                        <Label htmlFor="catch" className="cursor-pointer">Set this mailbox as Catch-all</Label>
                        <p className="text-xs text-muted-foreground">
                          When enabled, this mailbox will receive emails sent to any unknown address on this domain.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button onClick={() => add.mutate()} disabled={!domainId || add.isPending}>Create mailbox</Button>
                </DialogFooter>
              </>
            ) : (
              <SuccessBody
                info={created}
                onCreateAnother={() => setCreated(null)}
                onDone={() => { setCreated(null); setOpen(false); }}
              />
            )}
          </DialogContent>
        </Dialog>
      </div>




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

function copy(text: string, label = "Copied") {
  navigator.clipboard.writeText(text);
  toast.success(label);
}

function SuccessBody({
  info,
  onCreateAnother,
  onDone,
}: {
  info: CreatedInfo;
  onCreateAnother: () => void;
  onDone: () => void;
}) {
  const [showPw, setShowPw] = useState(false);
  const imapText = `IMAP\nHost: ${info.host}\nPort: 993\nEncryption: SSL/TLS\nUsername: ${info.username}\nPassword: ${info.password}`;

  const rows = [
    { label: "Host", value: info.host },
    { label: "Port", value: "993" },
    { label: "Encryption", value: "SSL/TLS" },
    { label: "Username", value: info.username },
    { label: "Password", value: info.password },
  ];

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Simpan password ini sekarang — hanya ditampilkan sekali.
      </p>

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Email</div>
        <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-1.5">
          <span className="truncate font-mono text-sm">{info.email}</span>
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => copy(info.email, "Email copied")}>
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Password</div>
        <div className="flex items-center gap-1 rounded-md border bg-muted/30 px-3 py-1.5">
          <span className="flex-1 truncate font-mono text-sm">
            {showPw ? info.password : "•".repeat(Math.min(info.password.length, 16))}
          </span>
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => setShowPw((v) => !v)}>
            {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => copy(info.password, "Password copied")}>
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">IMAP Connection</div>
        <div className="overflow-hidden rounded-md border divide-y">
          {rows.map((r) => (
            <div key={r.label} className="grid grid-cols-[92px,1fr,auto] items-center gap-2 px-3 py-1.5 text-sm">
              <span className="text-xs text-muted-foreground">{r.label}</span>
              <span className="truncate font-mono text-xs">{r.value}</span>
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => copy(r.value)}>
                <Copy className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="outline" size="sm" className="flex-1" onClick={() => copy(imapText, "IMAP settings copied")}>
          <Copy className="h-3.5 w-3.5" /> Copy All IMAP Settings
        </Button>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={onCreateAnother}>
          Create Another Mailbox
        </Button>
        <Button size="sm" className="flex-1" onClick={onDone}>
          Done
        </Button>
      </div>
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
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copy(r.value)}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { Plus, Globe, ChevronRight, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/domains/")({
  component: DomainsList,
});

function DomainsList() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");

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
                <p className="text-xs text-muted-foreground">IP VPS kamu. Bisa di-isi belakangan.</p>
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
          {domains.map((d) => (
            <Card key={d.id} className="flex items-center justify-between p-4">
              <Link to="/domains/$id" params={{ id: d.id }} className="flex flex-1 items-center gap-3">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <div>
                  <div className="font-mono text-sm">{d.name}</div>
                  <div className="text-xs text-muted-foreground">MX: {d.mx_hostname} {d.server_ip && `• ${d.server_ip}`}</div>
                </div>
              </Link>
              <div className="flex items-center gap-2">
                <Badge variant={d.verified ? "default" : "secondary"}>
                  {d.verified ? "Verified" : "Pending"}
                </Badge>
                <Button variant="ghost" size="icon" onClick={() => del.mutate(d.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Link to="/domains/$id" params={{ id: d.id }}>
                  <Button variant="ghost" size="icon"><ChevronRight className="h-4 w-4" /></Button>
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

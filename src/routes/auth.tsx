import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Mail } from "lucide-react";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
});

// Username -> synthetic email (no real inbox needed, email confirmation is off)
const USERNAME_DOMAIN = "mailcatch.local";
const toEmail = (u: string) => `${u.trim().toLowerCase()}@${USERNAME_DOMAIN}`;

function AuthPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  const doSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return toast.error("Username wajib diisi");
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: toEmail(username), password });
    setLoading(false);
    if (error) return toast.error("Username atau password salah");
    navigate({ to: "/dashboard" });
  };

  const doSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username.trim())) {
      return toast.error("Username 3-32 karakter, huruf/angka/._- saja");
    }
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email: toEmail(username),
      password,
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    // Auto-confirm is on — session is created immediately.
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      toast.success("Akun dibuat");
      navigate({ to: "/dashboard" });
    } else {
      // Fallback: try sign in
      const { error: sErr } = await supabase.auth.signInWithPassword({ email: toEmail(username), password });
      if (sErr) return toast.error(sErr.message);
      navigate({ to: "/dashboard" });
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
            <Mail className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>MailCatch</CardTitle>
          <CardDescription>Panel catch-all mail server</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="signin">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Sign up</TabsTrigger>
            </TabsList>
            <TabsContent value="signin">
              <form onSubmit={doSignIn} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="user-in">Username</Label>
                  <Input id="user-in" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pass-in">Password</Label>
                  <Input id="pass-in" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>Sign in</Button>
              </form>
            </TabsContent>
            <TabsContent value="signup">
              <form onSubmit={doSignUp} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="user-up">Username</Label>
                  <Input id="user-up" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
                  <p className="text-xs text-muted-foreground">3-32 karakter. Tanpa verifikasi email.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pass-up">Password</Label>
                  <Input id="pass-up" type="password" autoComplete="new-password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>Create account</Button>
              </form>
            </TabsContent>
          </Tabs>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            Lupa password? Login pakai akun lain lalu reset dari <span className="font-mono">Settings</span>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

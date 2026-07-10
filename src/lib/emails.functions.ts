import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const deleteEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ context, data }) => {
    if (!data.id) throw new Error("id required");
    // RLS scopes to owner; still restrict by ownership via join to mailboxes/domains.
    const { error } = await context.supabase.from("emails").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markEmailRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string; is_read: boolean }) => data)
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("emails")
      .update({ is_read: data.is_read })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

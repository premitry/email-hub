import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Query Cloudflare DNS-over-HTTPS from the server (no CORS, no client-side dependency).
export const checkDnsRecord = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({
      name: z.string().min(1).max(253),
      type: z.enum(["A", "AAAA", "MX", "TXT", "CNAME", "NS", "PTR"]),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(data.name)}&type=${data.type}`;
    const res = await fetch(url, { headers: { accept: "application/dns-json" } });
    if (!res.ok) return { ok: false, answers: [] as string[], error: `DoH ${res.status}` };
    const body = (await res.json()) as { Answer?: Array<{ data: string; type: number; TTL: number }> };
    const answers = (body.Answer ?? []).map((a) => a.data);
    return { ok: true, answers };
  });

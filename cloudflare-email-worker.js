// Cloudflare Email Worker — terima email untuk *@fav.web.id, push ke webmail VPS.
// Pasang lewat: Cloudflare Dashboard → fav.web.id → Email → Email Routing → Email Workers.
// Set sebagai action untuk Catch-all address.
export default {
  async email(message, env, ctx) {
    try {
      const raw = await new Response(message.raw).arrayBuffer();
      const res = await fetch("https://mail.fav.web.id/ingest", {
        method: "POST",
        headers: {
          // Ganti dengan nilai INGEST_SECRET dari /etc/catchall/config di VPS
          "authorization": "Bearer <INGEST_SECRET>",
          "content-type": "message/rfc822",
        },
        body: raw,
      });
      if (!res.ok) {
        // webmail bermasalah → minta pengirim retry (jangan drop diam-diam)
        message.setReject("temporary failure, try again later");
      }
    } catch (e) {
      message.setReject("temporary failure: " + e.message);
    }
  },
};

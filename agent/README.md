# MailCatch VPS agent

Small Bun HTTP service that runs on your VPS and bridges the web panel to
Postfix + Dovecot.

## Install (Ubuntu 22.04/24.04)

```bash
# on the VPS
git clone <this repo> mailcatch && cd mailcatch
sudo bash install.sh mail.example.com https://panel.example.com
```

The script:

1. installs Postfix + Dovecot + Bun
2. writes minimal config (virtual domains + Maildir + LMTP delivery)
3. installs the agent as `mailcatch-agent.service`
4. prints a **shared secret** — paste it into panel Settings

Then in the panel Settings, set:

- **Agent base URL** — `http://<vps-ip>:8787` (or your hostname)
- **Shared secret** — the value printed by the installer

Click **Test connection** — should return `ok`. Then **Register owner** so
the agent knows which panel account to push emails to.

## Endpoints

| Method | Path                        | What it does                                  |
| ------ | --------------------------- | --------------------------------------------- |
| GET    | `/health`                   | uptime / version                              |
| POST   | `/domains/sync`             | rewrite `/etc/postfix/vdomains`               |
| POST   | `/mailboxes/sync`           | rewrite `/etc/dovecot/users` + Postfix vmailbox |
| POST   | `/mailboxes/reset-password` | replace hash for one user                     |
| POST   | `/retention/apply`          | delete old / excess mail from Maildirs        |
| POST   | `/register`                 | persist `owner_id` (called once by panel)     |
| POST   | `/ingest`                   | loopback: Postfix pipe forwards mail here     |

## Push to panel

For every mail delivered locally, the Postfix pipe `mailcatch-pipe` calls
`http://127.0.0.1:8787/ingest`, which POSTs to
`<panel>/api/public/agent/emails` with the shared bearer. The panel maps the
recipient to the right mailbox (exact match or catch-all) and stores it.

## Files

- `/etc/mailcatch/agent.env` — env vars (panel URL, secret, paths)
- `/etc/mailcatch/secret` — raw shared secret (mode 0600)
- `/etc/mailcatch/owner_id` — panel owner ID (set via `/register`)
- `/var/log/mailcatch/agent.log` — stdout

# Synthea Simulation on your own always-on server

This puts the platform at an address such as **https://simulation.syntheatech.com**. It runs 24/7 on a rented cloud
server, so your own computer can stay off. Your team opens the address in any browser and signs in with the team
password. It works like COMSOL Server: the calculations run on the server and the browser only shows the interface.

```
browser ──HTTPS──► Caddy (free automatic certificate) ──► Synthea Simulation (Docker) ──► /data (database + PDFs)
```

## What you need

| Item | Recommendation |
|---|---|
| Cloud server | Ubuntu 24.04, **2 vCPU, 4 GB RAM, 40 GB disk** (e.g. OVHcloud, Scaleway or Hetzner; EU data centre) |
| Your domain | syntheatech.com, plus access to where its **DNS** is managed |
| Time | about 30 minutes, once |

## Step 1 — Rent the server
Create the server with **Ubuntu 24.04** and note its **public IPv4 address** (e.g. `51.68.12.34`). Allow incoming
ports **22** (SSH), **80** and **443** in the provider's firewall, if it has one.

## Step 2 — Point the subdomain at the server
At the company that manages syntheatech.com's DNS, add one record:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `simulation` | the server's IPv4 address | 3600 (or default) |

This does not change your existing website. It can take from a few minutes up to a few hours to take effect.

## Step 3 — Install (copy and paste on the server)
Connect with `ssh root@<server-ip>`, then:

```bash
apt-get update && apt-get install -y git
```

```bash
git clone -b development https://github.com/sadhanjyotiduttasynthea/synthea-simulation.git /opt/synthea && cd /opt/synthea/deploy/server
```

```bash
./install.sh
```

It asks for three things: the address (`simulation.syntheatech.com`), an e-mail for certificate notices, and a **team
password** (at least 12 characters). The first build takes about 10 minutes. Then open
**https://simulation.syntheatech.com**.

If the script warns that the address does not point to the server yet, wait for Step 2 to take effect, then run
`./install.sh` again.

## Step 4 — Nightly backups
```bash
crontab -e
```
Add this line, then save:
```
0 3 * * * /opt/synthea/deploy/server/backup.sh >> /var/log/synthea-backup.log 2>&1
```
This keeps the 14 newest backups in `deploy/server/backups/`. Copy them off the server now and then (for example
with `scp`, or with the provider's snapshot feature). To go back to a backup: `./restore.sh backups/<file>.tar.gz`.

## Everyday commands (on the server, in `/opt/synthea/deploy/server`)
| Task | Command |
|---|---|
| Update to the latest code (makes a backup first) | `./update.sh` |
| See what the server is doing | `docker compose logs -f` |
| Stop / start | `docker compose stop` / `docker compose start` |
| Change the team password | edit `SYNTHEA_PASSWORD` in `.env`, then `docker compose up -d` |
| Log everyone out | change `SYNTHEA_SECRET` in `.env`, then `docker compose up -d` |
| Optional Claude assistant | add `ANTHROPIC_API_KEY=...` to `.env`, then `docker compose up -d` |

## Security and good practice
* Only ports 80 and 443 (Caddy) are open to the internet. The platform itself is not exposed directly.
* All traffic is HTTPS. Sign-in cookies are HttpOnly and Secure and last 14 days. Failed sign-ins are slowed down.
* `.env` holds the password and secret. It is readable by root only and never committed to Git or copied into the image.
* **One shared team password, not individual accounts.** Give it only to people who may see all projects and papers.
* **Uploaded research PDFs and data are stored on this server.** Check that this is acceptable for confidential
  partner documents, and choose an EU data centre if that matters to your partners.
* Run **one** copy of the platform per server. The database is a single SQLite file.
* Keep Ubuntu updated: `apt-get update && apt-get upgrade -y` (or enable `unattended-upgrades`).

## Differences from COMSOL Server
Like COMSOL Server, it gives browser access to a central server that does the computing, and the data stays in one
place. Not yet available: individual user accounts and roles, per-user usage limits, and spreading computations over
several machines. Those would be the next steps if more people start using it at the same time.

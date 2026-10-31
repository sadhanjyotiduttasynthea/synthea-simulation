# Hosting Synthea Simulation on Render (team access with a password)

The app runs as one Docker container: FastAPI serves the API and the built React frontend on one port. All data
(SQLite database and uploaded PDFs) lives in `/data`, which is a persistent Render disk.

## One-time setup (about 10 minutes)

1. Sign in at <https://dashboard.render.com> with the GitHub account that can see
   `sadhanjyotiduttasynthea/synthea-simulation` (grant Render access to the repository when asked).
2. **New → Blueprint**, pick the repository and the branch **`ali`**. Render reads [`render.yaml`](../render.yaml)
   and proposes one web service, `synthea-simulation`, with a 1 GB disk mounted at `/data`.
3. Fill in the environment variables it asks for:
   * `SYNTHEA_PASSWORD` — the team password (share it privately; it is never stored in the repository).
   * `ANTHROPIC_API_KEY` — optional; leave empty to keep everything local (Claude features stay disabled).
   * `SYNTHEA_SECRET` is generated automatically (it signs the login cookies).
4. **Apply**. The first build takes a few minutes. When the service is live, open the URL Render shows
   (`https://synthea-simulation-xxxx.onrender.com`) and sign in with the team password.

Cost: a persistent disk requires a paid instance (the blueprint uses `starter`). The free plan has no disk — all data
would be lost on every restart — and it sleeps when idle, so it is not suitable for real work.

## Day to day
* **Updates**: every push to `ali` redeploys automatically (`autoDeploy: true`). Data on the disk is kept.
* **Change the password**: edit `SYNTHEA_PASSWORD` in the service's Environment tab → Save (redeploys; everyone signs in again).
* **Log everyone out**: change `SYNTHEA_SECRET`.
* **Backups**: Render snapshots disks daily; to copy the data yourself use *Shell* → `cp /data/synthea.db /tmp/` or
  export libraries (Libraries → Export library) and projects (File → Save as).
* **Custom domain**: Settings → Custom Domains (HTTPS certificates are automatic).

## Security notes
* One shared password protects every page and API call (signed HttpOnly cookie, 14 days). There are no individual
  accounts or permissions yet: everyone who signs in can edit and delete data.
* Always use the `https://` address (Render redirects HTTP to HTTPS).
* Run a single instance: the SQLite store and the background study jobs live inside one process.

## Run the same container elsewhere
```bash
docker build -t synthea .
docker run -d -p 8000:8000 -v synthea-data:/data \
  -e SYNTHEA_PASSWORD='choose-a-password' -e SYNTHEA_SECRET="$(openssl rand -hex 32)" synthea
```
Put it behind an HTTPS reverse proxy (e.g. Caddy) if it is reachable from the internet. Without `SYNTHEA_PASSWORD`
the app is open to anyone who can reach it — only do that on a trusted local network.

# Free hosting for the team (no payments, no credit card)

## Option A (recommended): Hugging Face Spaces + private dataset backup

* **Space** (free "CPU basic": 2 vCPU, 16 GB RAM, HTTPS address) runs the Docker image.
* Its disk is temporary (lost when the Space restarts or sleeps after ~48 h without visitors), so the app backs up
  the database and uploaded PDFs to a **private Hugging Face dataset** every 5 minutes and on shutdown, and restores
  them automatically on start.
* The site is protected by the shared team password (`SYNTHEA_PASSWORD`).

### Steps (≈ 15 minutes, once)
1. Create a free account at <https://huggingface.co/join> (optionally a free organisation for the team).
2. Create a **write** token: Settings → Access Tokens → New token → type *Write*. Keep it private.
3. Deploy from your computer (Python 3 with `pip install huggingface_hub` and git):
   ```bash
   HF_TOKEN=hf_xxx ./scripts/deploy_hf_space.sh <your-hf-name>/synthea
   ```
   This creates the Space (private by default; `SPACE_PUBLIC=1` for public) and pushes the code. Commit your changes
   first — the script deploys the last commit.
4. In the Space → **Settings → Variables and secrets** add **secrets**:
   * `SYNTHEA_PASSWORD` — the team password
   * `SYNTHEA_SECRET` — any long random text (signs login cookies)
   * `HF_TOKEN` — the same write token (used for the backups)
   * `SYNTHEA_BACKUP_REPO` — e.g. `<your-hf-name>/synthea-data` (a private dataset; created automatically)
   * optional `ANTHROPIC_API_KEY`
   Then **Restart** the Space.
5. Open `https://<your-hf-name>-synthea.hf.space` and sign in.
   *Private Space*: teammates must be logged in to Hugging Face and members of your organisation. For a jury or
   anyone without an account, make the Space **public** (Settings → visibility); the team password still protects
   the app (the source code of a public Space is visible).

### Automatic redeploys (optional)
`.github/workflows/deploy-hf.yml` redeploys on every push. In GitHub → Settings → Secrets and variables → Actions add
the secret `HF_TOKEN` and the variable `HF_SPACE` (`<your-hf-name>/synthea`).

### Good to know
* Data written in the last few minutes before an unexpected crash can be lost (graceful restarts and sleeps make a
  final backup). `Settings`-independent check: `GET /api/backup/status`; force a backup: `POST /api/backup/now`.
* One instance only (SQLite and background jobs live in one process).
* Free-tier limits and terms are set by Hugging Face and can change.

## Option B: one laptop + Cloudflare quick tunnel (no account at all)
Keeps the data on the laptop's disk; the laptop must stay on and awake.
```bash
SYNTHEA_PASSWORD='team-password' ./scripts/serve.sh          # http://localhost:8000
cloudflared tunnel --url http://localhost:8000                # prints https://<random>.trycloudflare.com
```
Install `cloudflared` from Cloudflare's downloads page. The address changes every time the tunnel restarts.

## Option C: same Wi-Fi only
`./scripts/serve.sh` already listens on all interfaces: teammates open `http://<laptop-ip>:8000`.
Set `SYNTHEA_PASSWORD` as above if the network is shared.

# Hosting Synthea on a Mac for everyone on the same Wi-Fi

## Start
1. Download/clone this branch onto the Mac (Docker Desktop installed).
2. Double-click **`Start-Synthea.command`** in Finder.
   (First time macOS may block it: right-click → Open → Open. Or in Terminal: `./Start-Synthea.command`.)
3. First start only: choose the **team password**. The first build takes several minutes (downloads packages).
4. The window prints the addresses, e.g. `http://192.168.1.23:8000` and `http://Your-Mac.local:8000`.
   Send one of them to the team; everyone signs in with the password.
5. Keep the window open (it keeps the Mac awake). **Ctrl+C** or `Stop-Synthea.command` stops Synthea.

Data (database and uploaded PDFs) is kept in the Docker volume `synthea_synthea-data` across restarts and updates.
**`Backup-Synthea.command`** copies it to `backups/synthea-<date>.tar.gz`.

To change the password: delete the file `.env` next to the scripts and start again.
To use another port (if 8000 is taken): edit `SYNTHEA_PORT` in `.env`.
After pulling new code, `Start-Synthea.command` rebuilds automatically.

## Checklist (things that are easy to forget)
- **Wi-Fi that blocks device-to-device traffic.** Guest, hotel, conference and many university networks (e.g.
  eduroam) isolate clients: others cannot reach the Mac even though they are on the same Wi-Fi. Test with one
  teammate before the event; otherwise use a phone hotspot or a router you control.
- **macOS firewall.** If System Settings → Network → Firewall is on, allow incoming connections for Docker when asked
  (or add Docker in "Options…").
- **Sleep.** The script keeps the Mac awake while its window is open; on a MacBook keep it plugged in and the lid open
  (or use an external display), otherwise Wi-Fi turns off.
- **The IP address can change** when the Mac reconnects to the Wi-Fi — the script prints the current one each time;
  the `.local` name usually stays the same.
- **Apple Silicon and Intel** both work (the image is built natively for the Mac's CPU).
- **Plain HTTP on the local network.** The password travels unencrypted over the Wi-Fi; fine on a trusted network,
  but use a password that is not used anywhere else.
- **One host only.** Everyone uses the Mac's address; do not run a second copy elsewhere (data would split).
- **Backups** before the demo/hand-in: run `Backup-Synthea.command` and keep the file somewhere safe.
- **Disk space.** The image needs roughly 2–3 GB; Docker Desktop's disk limit is in its settings.

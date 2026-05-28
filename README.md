# H20B Storage Monitor

Small local service for collecting disk usage from `ssh h20b` once per day and showing the latest data in a browser dashboard.

## What it monitors

- `/home/xiaoqingguo/Rongkun`
- `/home/xiaoqingguo/yuewang`
- `/home/xiaoqingguo/Hxchen`

The service uses your local SSH configuration. If `ssh h20b` works in a terminal, the monitor can use the same alias.

## Run

Create the dedicated conda environment once:

```powershell
cd E:\CODE\Storage-Monitor
conda env create -f environment.yml
```

If the environment already exists, update it with:

```powershell
conda env update -f environment.yml --prune
```

```powershell
cd E:\CODE\Storage-Monitor
conda run -n storage-monitor python .\monitor.py
```

Open:

```text
http://localhost:8090
```

By default the service:

- collects once immediately at startup,
- can run as a scheduled one-shot refresh, currently every 2 hours via Windows Task Scheduler,
- serves the dashboard on `0.0.0.0:8090`,
- shows each folder against a `600 GB` quota,
- shows `xiaoqingguo` total usage and remaining remote disk space,
- shows aggregate GPU utilization, owner status, and recent GPU occupancy trend when `nvidia-smi` is available,
- writes data to `public\data\latest.json` and `public\data\history.json`.

Run a single collection without starting the web server:

```powershell
conda run -n storage-monitor python .\monitor.py --once
```

Serve existing data and wait for the next scheduled run:

```powershell
conda run -n storage-monitor python .\monitor.py --no-initial-run
```

Run one refresh and exit:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\CODE\Storage-Monitor\scripts\refresh_once.ps1
```

## Configure

Edit `config.json`.

Important fields:

- `ssh_host`: SSH alias or host, currently `h20b`.
- `ssh_options`: SSH options. The default prevents password prompts from hanging the service.
- `default_quota_gb`: default quota per monitored folder. It is currently `600`.
- `collect_gpus`: collect per-GPU metrics with `nvidia-smi`. It is currently `true`.
- `exclude_gpu_indices`: GPU indices to hide from monitoring. It currently excludes `7`.
- `owned_process_root`: GPU compute processes whose current working directory is under this path are labeled `OURS`; other/unknown process roots are labeled `OTHER`.
- `run_at`: daily collection time in `HH:MM` local time.
- `history_retention_days`: maximum age of saved trend/history snapshots. It is currently `30`.
- `bind`: use `0.0.0.0` for access from other machines on the same network.
- `port`: dashboard port.
- `publish_command`: optional command that runs after each successful local data write.

## Share the dashboard

GitHub Pages:

1. Create a GitHub repository, for example `storage-monitor`.
2. Push this project to the repository.
3. In the GitHub repository, open `Settings` -> `Pages`.
4. Under `Build and deployment`, set `Source` to `GitHub Actions`.
5. Push to `main`. The workflow in `.github/workflows/pages.yml` deploys the `public` folder.

For this repository, after the first successful deployment, the page should be available at:

```text
https://Zippppo.github.io/UltraVision-Server-Monitor/
```

To publish new daily data automatically after each collection, set this after the GitHub remote works:

```json
{
  "publish_command": "\"{python}\" \"scripts\\publish_github_pages.py\""
}
```

Same network:

1. Keep `bind` as `0.0.0.0`.
2. Allow inbound TCP traffic for port `8090` in Windows Firewall if needed.
3. Share `http://YOUR-LAN-IP:8090`.

Public internet:

- Recommended quick option: run a tunnel in another terminal:

```powershell
cloudflared tunnel --url http://localhost:8090
```

- Stable production option: create a named Cloudflare Tunnel, or sync the `public` folder to a static host such as GitHub Pages, Cloudflare Pages, or a web server.

For static hosting, set `publish_command` to your sync command. The command receives these environment variables:

- `STORAGE_MONITOR_PUBLIC_DIR`
- `STORAGE_MONITOR_LATEST_JSON`
- `STORAGE_MONITOR_HISTORY_JSON`

Example with `rclone`:

```json
{
  "publish_command": "rclone sync \"%STORAGE_MONITOR_PUBLIC_DIR%\" remote:storage-monitor"
}
```

## Keep it running on Windows

For GitHub Pages publishing, a long-running local web server is not required. Use Task Scheduler to run one refresh every 2 hours:

```powershell
schtasks /Create /TN "Storage Monitor Refresh" /SC HOURLY /MO 2 /ST 00:00 /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\CODE\Storage-Monitor\scripts\refresh_once.ps1" /F
```

The task runs:

- `ssh h20b` collection,
- local JSON update,
- Git commit and push to GitHub,
- GitHub Pages redeploy.

Use an account that can run `ssh h20b` without interactive password prompts.

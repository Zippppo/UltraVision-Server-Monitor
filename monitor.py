from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


DEFAULT_CONFIG: dict[str, Any] = {
    "ssh_host": "h20b",
    "run_at": "08:00",
    "bind": "0.0.0.0",
    "port": 8090,
    "ssh_options": ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30"],
    "owner_label": "xiaoqingguo",
    "owned_process_root": "/home/xiaoqingguo/",
    "default_quota_gb": 600,
    "collect_gpus": True,
    "exclude_gpu_indices": [7],
    "command_timeout_seconds": 600,
    "history_limit": 400,
    "publish_command": "",
    "paths": [
        {"label": "Rongkun", "path": "/home/xiaoqingguo/Rongkun"},
        {"label": "yuewang", "path": "/home/xiaoqingguo/yuewang"},
        {"label": "Hxchen", "path": "/home/xiaoqingguo/Hxchen"},
    ],
}


BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DATA_DIR = PUBLIC_DIR / "data"
LATEST_PATH = DATA_DIR / "latest.json"
HISTORY_PATH = DATA_DIR / "history.json"


def log(message: str) -> None:
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    print(f"[{now}] {message}", flush=True)


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        write_json_atomic(path, DEFAULT_CONFIG)
        log(f"Created default config: {path}")

    with path.open("r", encoding="utf-8") as file:
        config = json.load(file)

    merged = DEFAULT_CONFIG | config
    merged["paths"] = config.get("paths", DEFAULT_CONFIG["paths"])
    return merged


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=True, indent=2)
        file.write("\n")
    os.replace(tmp_path, path)


def normalize_ssh_options(options: Any) -> list[str]:
    if isinstance(options, list):
        return [str(item) for item in options]
    if isinstance(options, str) and options.strip():
        return shlex.split(options)
    return []


def run_ssh(host: str, remote_command: str, timeout: int, options: list[str]) -> str:
    completed = subprocess.run(
        ["ssh", *options, host, remote_command],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )

    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        detail = stderr or stdout or f"ssh exited with {completed.returncode}"
        raise RuntimeError(detail)

    return completed.stdout.strip()


def remote_probe_command(path: str) -> str:
    quoted_path = shlex.quote(path)
    return " ".join(
        [
            f"if [ ! -e {quoted_path} ]; then printf 'missing\\n'; exit 0; fi;",
            f"du_bytes=$(du -sb -- {quoted_path} 2>/dev/null | awk '{{print $1}}');",
            "if [ -z \"$du_bytes\" ]; then",
            f"du_kb=$(du -sk -- {quoted_path} 2>/dev/null | awk '{{print $1}}');",
            "if [ -n \"$du_kb\" ]; then du_bytes=$((du_kb * 1024)); fi;",
            "fi;",
            f"du_human=$(du -sh -- {quoted_path} 2>/dev/null | awk '{{print $1}}');",
            f"df_line=$(df -B1 -P -- {quoted_path} 2>/dev/null | awk 'NR==2 {{print $1\"\\t\"$2\"\\t\"$3\"\\t\"$4\"\\t\"$5\"\\t\"$6}}');",
            "printf '%s\\t%s\\t%s\\n' \"$du_bytes\" \"$du_human\" \"$df_line\"",
        ]
    )


def parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def parse_percent(value: str | None) -> float | None:
    if value is None:
        return None
    value = value.strip().removesuffix("%")
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def parse_float(value: str | None) -> float | None:
    if value is None:
        return None
    value = value.strip()
    if not value or value in {"N/A", "[N/A]", "[Not Supported]"}:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def quota_bytes_from_item(item: dict[str, Any]) -> int | None:
    if item.get("quota_bytes") is not None:
        return parse_int(str(item["quota_bytes"]))

    quota_gb = item.get("quota_gb")
    if quota_gb is None:
        return None

    try:
        return int(float(quota_gb) * 1024**3)
    except (TypeError, ValueError):
        return None


def format_bytes(value: int | None) -> str | None:
    if value is None:
        return None
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    amount = float(value)
    unit = units[0]
    for unit in units:
        if abs(amount) < 1024 or unit == units[-1]:
            break
        amount /= 1024
    if unit == "B":
        return f"{int(amount)} {unit}"
    return f"{amount:.2f} {unit}"


def collect_path(host: str, item: dict[str, Any], timeout: int) -> dict[str, Any]:
    label = item.get("label") or Path(item["path"]).name
    path = item["path"]
    quota_bytes = quota_bytes_from_item(item)
    base: dict[str, Any] = {
        "label": label,
        "path": path,
        "status": "ok",
        "quota_status": "unknown" if quota_bytes is None else "ok",
        "quota_bytes": quota_bytes,
        "quota_human": format_bytes(quota_bytes),
        "quota_used_percent": None,
        "quota_remaining_bytes": None,
        "quota_over_bytes": 0,
        "bytes": None,
        "human": None,
        "filesystem": None,
        "filesystem_size_bytes": None,
        "filesystem_used_bytes": None,
        "filesystem_available_bytes": None,
        "filesystem_use_percent": None,
        "mountpoint": None,
        "error": None,
    }

    try:
        options = normalize_ssh_options(item.get("ssh_options"))
        output = run_ssh(host, remote_probe_command(path), timeout, options)
    except subprocess.TimeoutExpired:
        base["status"] = "error"
        base["error"] = f"ssh command timed out after {timeout} seconds"
        return base
    except Exception as exc:
        base["status"] = "error"
        base["error"] = str(exc)
        return base

    if output == "missing":
        base["status"] = "missing"
        base["error"] = "path does not exist on remote host"
        return base

    fields = output.split("\t")
    if len(fields) < 8:
        base["status"] = "error"
        base["error"] = f"unexpected remote output: {output!r}"
        return base

    size_bytes = parse_int(fields[0])
    quota_used_percent = None
    quota_remaining_bytes = None
    quota_over_bytes = 0
    quota_status = "unknown" if quota_bytes is None else "ok"

    if quota_bytes and size_bytes is not None:
        quota_used_percent = round((size_bytes / quota_bytes) * 100, 2)
        quota_remaining_bytes = quota_bytes - size_bytes
        quota_over_bytes = max(0, size_bytes - quota_bytes)
        quota_status = "over_quota" if quota_over_bytes > 0 else "ok"

    base.update(
        {
            "bytes": size_bytes,
            "human": fields[1] or format_bytes(size_bytes),
            "quota_status": quota_status,
            "quota_used_percent": quota_used_percent,
            "quota_remaining_bytes": quota_remaining_bytes,
            "quota_over_bytes": quota_over_bytes,
            "filesystem": fields[2] or None,
            "filesystem_size_bytes": parse_int(fields[3]),
            "filesystem_used_bytes": parse_int(fields[4]),
            "filesystem_available_bytes": parse_int(fields[5]),
            "filesystem_use_percent": parse_percent(fields[6]),
            "mountpoint": fields[7] or None,
        }
    )

    if size_bytes is None:
        base["status"] = "error"
        base["error"] = "du did not return a size"

    return base


def gpu_probe_command(owned_process_root: str) -> str:
    payload = r"""
import csv
import json
import os
import socket
import subprocess

GPU_QUERY_FIELDS = [
    "index",
    "name",
    "uuid",
    "utilization.gpu",
    "utilization.memory",
    "memory.total",
    "memory.used",
    "memory.free",
    "temperature.gpu",
    "power.draw",
    "power.limit",
]
PROC_QUERY_FIELDS = [
    "gpu_uuid",
    "pid",
    "process_name",
    "used_memory",
]


def query(fields, query_type):
    cmd = [
        "nvidia-smi",
        f"--query-{query_type}=" + ",".join(fields),
        "--format=csv,noheader,nounits",
    ]
    completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "nvidia-smi failed").strip())

    rows = []
    for line in completed.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        values = next(csv.reader([line], skipinitialspace=True))
        rows.append({field: value.strip() for field, value in zip(fields, values)})
    return rows


def is_owned_cwd(cwd):
    cwd = str(cwd or "").strip()
    owned_root = OWNED_PROCESS_ROOT.rstrip("/")
    return cwd == owned_root or cwd.startswith(OWNED_PROCESS_ROOT)


def enrich_processes(processes):
    enriched = []
    for proc in processes:
        item = dict(proc)
        pid = str(item.get("pid", "")).strip()
        cwd = ""
        user = ""
        if pid:
            proc_dir = f"/proc/{pid}"
            try:
                cwd = os.readlink(f"{proc_dir}/cwd")
            except OSError:
                cwd = ""
            try:
                import pwd

                user = pwd.getpwuid(os.stat(proc_dir).st_uid).pw_name
            except Exception:
                user = ""

        item["cwd"] = cwd
        item["user"] = user
        item["owned_by_us"] = is_owned_cwd(cwd)
        enriched.append(item)
    return enriched


try:
    gpus = query(GPU_QUERY_FIELDS, "gpu")
    try:
        processes = enrich_processes(query(PROC_QUERY_FIELDS, "compute-apps"))
    except Exception:
        processes = []

    print(json.dumps({
        "host": socket.gethostname(),
        "gpus": gpus,
        "processes": processes,
    }))
except Exception as exc:
    print(json.dumps({
        "host": socket.gethostname(),
        "error": str(exc),
        "gpus": [],
        "processes": [],
    }))
"""
    payload = f"OWNED_PROCESS_ROOT = {owned_process_root!r}\n{payload.strip()}"
    return "\n".join(
        [
            "if ! command -v nvidia-smi >/dev/null 2>&1; then",
            "printf 'nvidia_smi_missing\\n';",
            "exit 0;",
            "fi",
            "if ! command -v python3 >/dev/null 2>&1; then",
            "printf 'python3_missing\\n';",
            "exit 0;",
            "fi",
            f"python3 - <<'PY'\n{payload}\nPY",
        ]
    )


def mib_to_bytes(value: str | None) -> int | None:
    parsed = parse_float(value)
    if parsed is None:
        return None
    return int(parsed * 1024**2)


def collect_gpus(
    host: str,
    timeout: int,
    ssh_options: list[str],
    exclude_indices: set[int],
    owned_process_root: str,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": "ok",
        "items": [],
        "excluded_indices": sorted(exclude_indices),
        "error": None,
    }

    try:
        output = run_ssh(host, gpu_probe_command(owned_process_root), timeout, ssh_options)
    except subprocess.TimeoutExpired:
        result["status"] = "error"
        result["error"] = f"ssh command timed out after {timeout} seconds"
        return result
    except Exception as exc:
        result["status"] = "error"
        result["error"] = str(exc)
        return result

    if output == "nvidia_smi_missing":
        result["status"] = "unavailable"
        result["error"] = "nvidia-smi is not available on the remote host"
        return result

    if output == "python3_missing":
        result["status"] = "unavailable"
        result["error"] = "python3 is not available on the remote host"
        return result

    if not output:
        result["status"] = "unavailable"
        result["error"] = "nvidia-smi returned no GPU rows"
        return result

    try:
        payload = json.loads(output)
    except json.JSONDecodeError as exc:
        result["status"] = "error"
        result["error"] = f"unexpected GPU probe JSON: {exc}"
        return result

    if payload.get("error"):
        result["status"] = "error"
        result["error"] = str(payload["error"])
        return result

    process_rows = payload.get("processes") if isinstance(payload.get("processes"), list) else []
    processes_by_uuid: dict[str, list[dict[str, Any]]] = {}
    for proc in process_rows:
        if not isinstance(proc, dict):
            continue
        gpu_uuid = str(proc.get("gpu_uuid", "")).strip()
        if gpu_uuid:
            processes_by_uuid.setdefault(gpu_uuid, []).append(proc)

    rows = payload.get("gpus") if isinstance(payload.get("gpus"), list) else []
    gpus = []
    for row in rows:
        if not isinstance(row, dict):
            continue

        index = parse_int(row.get("index"))
        if index is not None and index in exclude_indices:
            continue

        uuid = str(row.get("uuid", "")).strip()
        processes = processes_by_uuid.get(uuid, [])
        memory_total = mib_to_bytes(row.get("memory.total"))
        memory_used = mib_to_bytes(row.get("memory.used"))
        memory_free = mib_to_bytes(row.get("memory.free"))
        memory_used_percent = None
        if memory_total and memory_used is not None:
            memory_used_percent = round((memory_used / memory_total) * 100, 2)

        normalized_processes = []
        for proc in processes:
            normalized_processes.append(
                {
                    "pid": parse_int(proc.get("pid")),
                    "process_name": str(proc.get("process_name", "")).strip(),
                    "used_memory_bytes": mib_to_bytes(proc.get("used_memory")),
                    "user": str(proc.get("user", "")).strip(),
                    "cwd": str(proc.get("cwd", "")).strip(),
                    "owned_by_us": bool(proc.get("owned_by_us")),
                }
            )

        if not normalized_processes:
            owner_status = "free"
        elif all(proc["owned_by_us"] for proc in normalized_processes):
            owner_status = "ours"
        else:
            owner_status = "other"

        owner_processes = (
            [proc for proc in normalized_processes if not proc["owned_by_us"]]
            if owner_status == "other"
            else normalized_processes
        )
        owner_user = next(
            (proc["user"] for proc in owner_processes if proc.get("user")),
            "",
        )

        gpus.append(
            {
                "index": index,
                "name": str(row.get("name", "")).strip(),
                "uuid": uuid,
                "gpu_util_percent": parse_float(row.get("utilization.gpu")),
                "memory_util_percent": parse_float(row.get("utilization.memory")),
                "memory_total_bytes": memory_total,
                "memory_used_bytes": memory_used,
                "memory_free_bytes": memory_free,
                "memory_used_percent": memory_used_percent,
                "temperature_c": parse_float(row.get("temperature.gpu")),
                "power_draw_watts": parse_float(row.get("power.draw")),
                "power_limit_watts": parse_float(row.get("power.limit")),
                "process_count": len(normalized_processes),
                "owner_status": owner_status,
                "owner_user": owner_user,
            }
        )

    result["items"] = gpus
    if not gpus:
        result["status"] = "unavailable"
        result["error"] = "nvidia-smi returned no GPU rows"
    return result


def build_filesystem_summary(results: list[dict[str, Any]]) -> dict[str, Any]:
    filesystems: dict[tuple[str, str], dict[str, Any]] = {}

    for item in results:
        filesystem = item.get("filesystem")
        mountpoint = item.get("mountpoint")
        if not filesystem or not mountpoint:
            continue

        key = (str(filesystem), str(mountpoint))
        entry = filesystems.setdefault(
            key,
            {
                "filesystem": filesystem,
                "mountpoint": mountpoint,
                "size_bytes": item.get("filesystem_size_bytes"),
                "used_bytes": item.get("filesystem_used_bytes"),
                "available_bytes": item.get("filesystem_available_bytes"),
                "use_percent": item.get("filesystem_use_percent"),
                "paths": [],
            },
        )
        entry["paths"].append(item.get("label") or item.get("path"))

    unique_filesystems = list(filesystems.values())
    total_size = sum(item.get("size_bytes") or 0 for item in unique_filesystems)
    total_used = sum(item.get("used_bytes") or 0 for item in unique_filesystems)
    total_available = sum(item.get("available_bytes") or 0 for item in unique_filesystems)
    percentages = [
        item.get("use_percent")
        for item in unique_filesystems
        if isinstance(item.get("use_percent"), (int, float))
    ]

    return {
        "total_size_bytes": total_size or None,
        "total_used_bytes": total_used or None,
        "total_available_bytes": total_available or None,
        "max_use_percent": max(percentages) if percentages else None,
        "filesystems": unique_filesystems,
    }


def build_snapshot(config: dict[str, Any]) -> dict[str, Any]:
    host = str(config["ssh_host"])
    timeout = int(config.get("command_timeout_seconds", 600))
    ssh_options = normalize_ssh_options(config.get("ssh_options"))
    default_quota_gb = config.get("default_quota_gb")
    owned_process_root = str(config.get("owned_process_root", "/home/xiaoqingguo/"))
    exclude_gpu_indices = {
        int(index)
        for index in config.get("exclude_gpu_indices", [])
        if str(index).strip()
    }
    path_configs = [
        {
            **item,
            "quota_gb": item.get("quota_gb", default_quota_gb),
            "ssh_options": ssh_options,
        }
        for item in config["paths"]
    ]
    results = [collect_path(host, item, timeout) for item in path_configs]
    gpu_summary = (
        collect_gpus(host, timeout, ssh_options, exclude_gpu_indices, owned_process_root)
        if config.get("collect_gpus", True)
        else {
            "status": "disabled",
            "items": [],
            "excluded_indices": sorted(exclude_gpu_indices),
            "error": None,
        }
    )
    if not all(item["status"] == "ok" for item in results):
        status = "degraded"
    elif any(item.get("quota_status") == "over_quota" for item in results):
        status = "quota_exceeded"
    else:
        status = "ok"

    return {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "host": host,
        "owner_label": config.get("owner_label", "xiaoqingguo"),
        "owned_process_root": owned_process_root,
        "default_quota_gb": default_quota_gb,
        "filesystem_summary": build_filesystem_summary(results),
        "gpu_summary": gpu_summary,
        "status": status,
        "paths": results,
    }


def load_history() -> list[dict[str, Any]]:
    if not HISTORY_PATH.exists():
        return []
    try:
        with HISTORY_PATH.open("r", encoding="utf-8") as file:
            data = json.load(file)
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def append_history(snapshot: dict[str, Any], limit: int) -> None:
    history = load_history()
    history.append(snapshot)
    if limit > 0:
        history = history[-limit:]
    write_json_atomic(HISTORY_PATH, history)


def publish_if_configured(config: dict[str, Any]) -> None:
    command = str(config.get("publish_command") or "").strip()
    if not command:
        return

    env = os.environ.copy()
    env["STORAGE_MONITOR_PUBLIC_DIR"] = str(PUBLIC_DIR)
    env["STORAGE_MONITOR_LATEST_JSON"] = str(LATEST_PATH)
    env["STORAGE_MONITOR_HISTORY_JSON"] = str(HISTORY_PATH)
    env["STORAGE_MONITOR_PYTHON"] = sys.executable

    command = command.format(
        python=sys.executable,
        public_dir=str(PUBLIC_DIR),
        latest_json=str(LATEST_PATH),
        history_json=str(HISTORY_PATH),
    )

    log(f"Running publish command: {command}")
    completed = subprocess.run(
        command,
        shell=True,
        cwd=BASE_DIR,
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"publish command failed: {detail}")


def run_once(config: dict[str, Any]) -> dict[str, Any]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log(f"Collecting storage usage from {config['ssh_host']}")
    snapshot = build_snapshot(config)
    write_json_atomic(LATEST_PATH, snapshot)
    append_history(snapshot, int(config.get("history_limit", 400)))
    publish_if_configured(config)
    log(f"Collection finished with status: {snapshot['status']}")
    return snapshot


def ensure_placeholder_data(config: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not LATEST_PATH.exists():
        placeholder = {
            "generated_at": None,
            "host": config["ssh_host"],
            "owner_label": config.get("owner_label", "xiaoqingguo"),
            "owned_process_root": config.get("owned_process_root", "/home/xiaoqingguo/"),
            "status": "no_data",
            "paths": [],
            "gpu_summary": {
                "status": "no_data",
                "items": [],
                "excluded_indices": config.get("exclude_gpu_indices", []),
                "error": None,
            },
            "message": "No collection has run yet.",
        }
        write_json_atomic(LATEST_PATH, placeholder)
    if not HISTORY_PATH.exists():
        write_json_atomic(HISTORY_PATH, [])


def parse_run_at(value: str) -> tuple[int, int]:
    try:
        hour_raw, minute_raw = value.split(":", 1)
        hour = int(hour_raw)
        minute = int(minute_raw)
    except ValueError as exc:
        raise ValueError("run_at must use HH:MM format") from exc

    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError("run_at must be a valid 24-hour time")
    return hour, minute


def seconds_until_next_run(run_at: str) -> float:
    hour, minute = parse_run_at(run_at)
    now = datetime.now().astimezone()
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return max(1.0, (target - now).total_seconds())


def scheduler_loop(config_path: Path, stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        config = load_config(config_path)
        wait_seconds = seconds_until_next_run(str(config.get("run_at", "08:00")))
        next_run = datetime.now().astimezone() + timedelta(seconds=wait_seconds)
        log(f"Next scheduled collection: {next_run.isoformat(timespec='seconds')}")

        if stop_event.wait(wait_seconds):
            break

        try:
            config = load_config(config_path)
            run_once(config)
        except Exception as exc:
            log(f"Scheduled collection failed: {exc}")


class MonitorRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        log(format % args)


def serve(config: dict[str, Any], config_path: Path, no_initial_run: bool) -> None:
    ensure_placeholder_data(config)

    if not no_initial_run:
        try:
            run_once(config)
        except Exception as exc:
            log(f"Initial collection failed: {exc}")

    bind = str(config.get("bind", "0.0.0.0"))
    port = int(config.get("port", 8090))
    handler = partial(MonitorRequestHandler, directory=str(PUBLIC_DIR))
    server = ThreadingHTTPServer((bind, port), handler)

    stop_event = threading.Event()
    scheduler = threading.Thread(
        target=scheduler_loop,
        args=(config_path, stop_event),
        name="storage-monitor-scheduler",
        daemon=True,
    )
    scheduler.start()

    log(f"Dashboard serving on http://{bind}:{port}")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        log("Stopping")
    finally:
        stop_event.set()
        server.shutdown()
        server.server_close()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Monitor remote storage usage over SSH.")
    parser.add_argument("--config", default=str(BASE_DIR / "config.json"))
    parser.add_argument("--once", action="store_true", help="Collect once and exit.")
    parser.add_argument(
        "--no-initial-run",
        action="store_true",
        help="Serve existing data and wait for the next scheduled run.",
    )
    parser.add_argument("--bind", help="Override the configured bind address.")
    parser.add_argument("--port", type=int, help="Override the configured port.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    config_path = Path(args.config).resolve()
    config = load_config(config_path)

    if args.bind:
        config["bind"] = args.bind
    if args.port is not None:
        config["port"] = args.port

    if args.once:
        run_once(config)
        return 0

    serve(config, config_path, args.no_initial_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

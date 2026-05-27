from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_FILES = [
    ROOT / "public" / "data" / "latest.json",
    ROOT / "public" / "data" / "history.json",
]


def run_git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=check,
    )


def is_git_repo() -> bool:
    completed = run_git("rev-parse", "--is-inside-work-tree", check=False)
    return completed.returncode == 0 and completed.stdout.strip() == "true"


def current_branch() -> str | None:
    completed = run_git("branch", "--show-current", check=False)
    branch = completed.stdout.strip()
    return branch or None


def latest_timestamp() -> str:
    latest_path = DATA_FILES[0]
    if not latest_path.exists():
        return datetime.now().astimezone().isoformat(timespec="minutes")

    try:
        data = json.loads(latest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return datetime.now().astimezone().isoformat(timespec="minutes")

    generated_at = data.get("generated_at")
    return generated_at or datetime.now().astimezone().isoformat(timespec="minutes")


def main() -> int:
    if not is_git_repo():
        print("Not a git repository. Run git init and configure a GitHub remote first.", file=sys.stderr)
        return 1

    missing = [str(path.relative_to(ROOT)) for path in DATA_FILES if not path.exists()]
    if missing:
        print(f"Missing data files: {', '.join(missing)}", file=sys.stderr)
        return 1

    run_git("add", "--", *(str(path.relative_to(ROOT)) for path in DATA_FILES))

    diff = run_git("diff", "--cached", "--quiet", "--", *(str(path.relative_to(ROOT)) for path in DATA_FILES), check=False)
    if diff.returncode == 0:
        print("No storage data changes to publish.")
        return 0

    message = f"Update storage data {latest_timestamp()}"
    run_git("commit", "-m", message)

    branch = current_branch() or "main"
    upstream = run_git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", check=False)
    if upstream.returncode == 0:
        run_git("push")
    else:
        run_git("push", "-u", "origin", branch)

    print("Published storage data to GitHub.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

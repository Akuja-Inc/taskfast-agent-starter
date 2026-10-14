#!/usr/bin/env python3
"""Capture actual OpenTUI output in Zutty/X11, never a reconstructed UI.
Run from the repository root after pnpm build and pnpm tui:test:
  python3 docs/tui/steer-capture.py before|after [source-worktree]
Needs Bun, tmux, Zutty, X11, xwininfo and ImageMagick import.
"""
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

OUTPUT = Path(__file__).resolve().parent
ROOT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else OUTPUT.parents[1]
LABEL = sys.argv[1]
assert LABEL in ("before", "after")
SOURCES = ["src/tui/app.tsx", "src/tui/keys.ts", "src/tui/screen.ts", "src/tui/smoke.test.tsx", "test/tui.test.ts", "test/fixtures/tui-host.mjs"]
subprocess.run(["git", "diff", "HEAD", "--exit-code", "--quiet", "--", *SOURCES], cwd=ROOT, check=True)
provenance = {
    "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
    "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES},
    "captureScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "capture": "Unmodified X11 window pixels from Zutty running tmux and Bun/OpenTUI. ImageMagick import -window.",
}
(OUTPUT / f"steer-{LABEL}-source.json").write_text(json.dumps(provenance, indent=2) + "\n")
host = subprocess.Popen(["node", "test/fixtures/tui-host.mjs"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
terminal = None
session = f"steer-proof-{os.getpid()}"


def tmux(*args):
    return subprocess.check_output(["tmux", *args], text=True)


def until(check):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError("capture condition timed out")


try:
    for line in host.stdout:
        match = re.search(r"console: (\S+)", line)
        if match:
            link = match[1]
            break
    else:
        raise RuntimeError("host did not print a link")
    origin, token = link.split("/#token=")

    def api(action, body):
        req = urllib.request.Request(origin + "/api/agents/shop/" + action, data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        urllib.request.urlopen(req).close()

    time.sleep(2)  # Let the synthetic check-in and scheduled event finish.
    api("paused", {"value": True})
    api("messages", {"requestId": "proof-followup-a", "text": "Check the photo deadline before bidding."})
    api("messages", {"requestId": "proof-followup-b", "text": "Keep new commitments under $15."})
    api("messages", {"requestId": "proof-steer-c", "text": "Prioritize the existing photo edit.", "steer": True})

    for kind, cols, rows, keys in [("normal", 130, 44, []), ("narrow", 90, 44, ["i"]), ("help", 130, 36, ["?"])]:
        command = f"cd {shlex.quote(str(ROOT / 'src/tui'))} && TASKFAST_CONSOLE_URL={shlex.quote(link)} bun main.tsx"
        tmux("new-session", "-d", "-s", session, "-x", str(cols), "-y", str(rows), command)
        tmux("set-option", "-t", session, "status", "off")
        title = f"steer-proof-{LABEL}-{kind}"
        terminal = subprocess.Popen(["zutty", "-quiet", "-title", title, "-geometry", f"{cols}x{rows}", "-font", "DejaVuSansMono", "-fontsize", "14", "-e", "tmux", "attach-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        until(lambda: "paused" in tmux("capture-pane", "-p", "-t", session))
        if LABEL == "after" and kind in ("normal", "narrow"):
            keys = ["Tab", "Tab"]  # Show stable queue focus and narrow auto-opening.
        for key in keys:
            tmux("send-keys", "-t", session, key)
        target = "Keys" if kind == "help" else "Ready to work?"
        until(lambda: target in tmux("capture-pane", "-p", "-t", session))
        time.sleep(.3)  # Wait for the terminal's last paint before X11 capture.
        windows = subprocess.check_output(["xwininfo", "-root", "-tree"], text=True)
        window = re.search(r'(0x[0-9a-f]+) "' + re.escape(title) + '"', windows).group(1)
        name = f"steer-{LABEL}-{kind}"
        subprocess.run(["import", "-window", window, str(OUTPUT / (name + ".png"))], check=True)
        (OUTPUT / (name + ".txt")).write_text(tmux("capture-pane", "-p", "-t", session))
        terminal.terminate()
        terminal.wait(timeout=5)
        terminal = None
        tmux("kill-session", "-t", session)
finally:
    if terminal:
        terminal.terminate()
    subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    host.terminate()
    host.wait(timeout=15)

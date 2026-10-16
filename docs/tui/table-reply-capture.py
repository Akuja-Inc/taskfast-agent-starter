#!/usr/bin/env python3
"""Capture actual OpenTUI output in Zutty/X11 (the docs/tui/reply-markdown-capture.py method).
  python3 table-reply-capture.py <host-root> <label> <outdir>
host-root runs test/fixtures/tui-host.mjs; the TUI client draws from its src/tui."""
import os, re, shlex, subprocess, sys, time
from pathlib import Path

root, label, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
host = subprocess.Popen(["node", "test/fixtures/tui-host.mjs"], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
session, terminal = f"table-proof-{os.getpid()}", None
tmux = lambda *a: subprocess.check_output(["tmux", *a], text=True)
def until(check):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if check(): return
        time.sleep(.1)
    raise RuntimeError("capture condition timed out")
try:
    link = next(m[1] for line in host.stdout if (m := re.search(r"console: (\S+)", line)))
    for kind, cols, rows in [("normal", 130, 52), ("narrow", 90, 52)]:
        tmux("new-session", "-d", "-s", session, "-x", str(cols), "-y", str(rows), f"cd {shlex.quote(str(root / 'src/tui'))} && TASKFAST_CONSOLE_URL={shlex.quote(link)} bun main.tsx")
        tmux("set-option", "-t", session, "status", "off")
        title = f"table-proof-{label}-{kind}"
        terminal = subprocess.Popen(["zutty", "-quiet", "-title", title, "-geometry", f"{cols}x{rows}", "-font", "DejaVuSansMono", "-fontsize", "14", "-e", "tmux", "attach-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        until(lambda: "0.25 USDC" in tmux("capture-pane", "-p", "-t", session))
        time.sleep(.5)
        window = re.search(r'(0x[0-9a-f]+) "' + re.escape(title) + '"', subprocess.check_output(["xwininfo", "-root", "-tree"], text=True)).group(1)
        name = f"table-reply-{label}-{kind}"
        subprocess.run(["import", "-window", window, str(out / (name + ".png"))], check=True)
        (out / (name + ".txt")).write_text(tmux("capture-pane", "-p", "-t", session))
        terminal.terminate(); terminal.wait(timeout=5); terminal = None
        tmux("kill-session", "-t", session)
finally:
    if terminal: terminal.terminate()
    subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    host.terminate(); host.wait(timeout=15)

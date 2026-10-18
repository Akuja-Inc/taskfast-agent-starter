#!/usr/bin/env python3
"""Capture the terminal UI's standing orders panel (#120).
  python3 orders-capture.py <host-root> <label> <outdir>
host-root runs test/fixtures/tui-host.mjs; the TUI client draws from its src/tui.
Actual OpenTUI output in Zutty/X11, the same method as settings-tab-capture.py.
Shots: the empty orders panel, then a new order that names a dollar amount.
"""
import os, re, shlex, subprocess, sys, time
from pathlib import Path

root, label, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
COLS, ROWS = 130, 40
host = subprocess.Popen(["node", "test/fixtures/tui-host.mjs"], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
session, terminal = f"orders-{os.getpid()}", None
tmux = lambda *a: subprocess.check_output(["tmux", *a], text=True)
pane = lambda: tmux("capture-pane", "-p", "-t", session)
def until(check):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if check(): return
        time.sleep(.1)
    raise RuntimeError("capture condition timed out")
def shot(name, window):
    time.sleep(1)
    subprocess.run(["import", "-window", window, str(out / f"orders-{name}-{label}.png")], check=True)
    (out / f"orders-{name}-{label}.txt").write_text(pane())
try:
    link = next(m[1] for line in host.stdout if (m := re.search(r"console: (\S+)", line)))
    tmux("new-session", "-d", "-s", session, "-x", str(COLS), "-y", str(ROWS), f"cd {shlex.quote(str(root / 'src/tui'))} && TASKFAST_CONSOLE_URL={shlex.quote(link)} bun main.tsx")
    tmux("set-option", "-t", session, "status", "off")
    title = f"orders-{label}"
    terminal = subprocess.Popen(["zutty", "-quiet", "-title", title, "-geometry", f"{COLS}x{ROWS}", "-font", "DejaVuSansMono", "-fontsize", "14", "-e", "tmux", "attach-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    until(lambda: "Timeline]" in pane())
    window = re.search(r'(0x[0-9a-f]+) "' + re.escape(title) + '"', subprocess.check_output(["xwininfo", "-root", "-tree"], text=True)).group(1)
    tmux("send-keys", "-t", session, "2")
    until(lambda: "Standing orders" in pane())
    shot("empty", window)
    tmux("send-keys", "-t", session, "a")
    time.sleep(.5)
    tmux("send-keys", "-t", session, "-l", "Never spend more than $5")
    until(lambda: "$5" in pane())
    shot("money", window)
    terminal.terminate(); terminal.wait(timeout=5); terminal = None
    tmux("kill-session", "-t", session)
finally:
    if terminal: terminal.terminate()
    subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    host.terminate(); host.wait(timeout=15)

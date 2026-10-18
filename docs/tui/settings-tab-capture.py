#!/usr/bin/env python3
"""Capture the terminal UI's agent and tab bar (#115).
  python3 settings-tab-capture.py <host-root> <label> <outdir>
host-root runs test/fixtures/tui-host.mjs; the TUI client draws from its src/tui.
Actual OpenTUI output in Zutty/X11, the same method as table-reply-capture.py.
"""
import os, re, shlex, subprocess, sys, time
from pathlib import Path
from PIL import Image

root, label, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
COLS, ROWS = 130, 52
host = subprocess.Popen(["node", "test/fixtures/tui-host.mjs"], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
session, terminal = f"settings-tab-{os.getpid()}", None
tmux = lambda *a: subprocess.check_output(["tmux", *a], text=True)
def until(check):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if check(): return
        time.sleep(.1)
    raise RuntimeError("capture condition timed out")
try:
    link = next(m[1] for line in host.stdout if (m := re.search(r"console: (\S+)", line)))
    tmux("new-session", "-d", "-s", session, "-x", str(COLS), "-y", str(ROWS), f"cd {shlex.quote(str(root / 'src/tui'))} && TASKFAST_CONSOLE_URL={shlex.quote(link)} bun main.tsx")
    tmux("set-option", "-t", session, "status", "off")
    title = f"settings-tab-{label}"
    terminal = subprocess.Popen(["zutty", "-quiet", "-title", title, "-geometry", f"{COLS}x{ROWS}", "-font", "DejaVuSansMono", "-fontsize", "14", "-e", "tmux", "attach-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    until(lambda: "help" in tmux("capture-pane", "-p", "-t", session) and "Timeline]" in tmux("capture-pane", "-p", "-t", session))
    time.sleep(1)
    window = re.search(r'(0x[0-9a-f]+) "' + re.escape(title) + '"', subprocess.check_output(["xwininfo", "-root", "-tree"], text=True)).group(1)
    shot = out / f"settings-tab-{label}.png"
    subprocess.run(["import", "-window", window, str(shot)], check=True)
    # The banner is the first row and the agent and tab bar the second. The rest of the
    # frame is long, so keep the three rows a reviewer needs and drop the rest.
    with Image.open(shot) as image:
        image.crop((0, 0, image.width, round(3 * image.height / ROWS))).save(shot)
    (out / f"settings-tab-{label}.txt").write_text(tmux("capture-pane", "-p", "-t", session))
    terminal.terminate(); terminal.wait(timeout=5); terminal = None
    tmux("kill-session", "-t", session)
finally:
    if terminal: terminal.terminate()
    subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    host.terminate(); host.wait(timeout=15)

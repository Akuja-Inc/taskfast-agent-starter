#!/usr/bin/env python3
"""Capture the real console page and OpenTUI five seconds after a payment (#58).
Run from the repository root after pnpm build and pnpm tui:test:
  python3 docs/console/wallet-capture.py before|after [source-worktree]
The source worktree needs dist/ built, src/tui/ installed and a copy of
docs/console/wallet-capture-host.mjs. Needs Bun, tmux, Zutty, X11, xwininfo,
ImageMagick import and Python Playwright with Chromium.
"""
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

OUTPUT = Path(__file__).resolve().parent
ROOT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else OUTPUT.parents[1]
LABEL = sys.argv[1]
assert LABEL in ("before", "after")
COLS, ROWS = 130, 40
session = f"wallet-proof-{os.getpid()}"
title = f"wallet-proof-{LABEL}"
provenance = {
    "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
    "capture": "Chromium page screenshot through Python Playwright; unmodified X11 window pixels from Zutty running tmux and Bun/OpenTUI (ImageMagick import -window). Both taken 5 s after SIGUSR2 admitted payment_released.",
}
host = subprocess.Popen(["node", "docs/console/wallet-capture-host.mjs"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
terminal = None


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
    command = f"cd {shlex.quote(str(ROOT / 'src/tui'))} && TASKFAST_CONSOLE_URL={shlex.quote(link)} bun main.tsx"
    tmux("new-session", "-d", "-s", session, "-x", str(COLS), "-y", str(ROWS), command)
    tmux("set-option", "-t", session, "status", "off")
    terminal = subprocess.Popen(["zutty", "-quiet", "-title", title, "-geometry", f"{COLS}x{ROWS}", "-font", "DejaVuSansMono", "-fontsize", "14", "-e", "tmux", "attach-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/snap/bin/chromium")
        page = browser.new_page(viewport={"width": 1440, "height": 1000}, locale="en-US", timezone_id="UTC", color_scheme="light")
        page.goto(link)
        page.get_by_text("50.00 USDC").wait_for()
        until(lambda: "50.00 USDC" in tmux("capture-pane", "-p", "-t", session))
        time.sleep(1)
        host.send_signal(signal.SIGUSR2)
        paid = time.monotonic()
        time.sleep(5)
        page.evaluate("scrollTo(0, 0)")  # The timeline follows its newest turn; show the readiness panel whole.
        time.sleep(.3)
        page.screenshot(path=str(OUTPUT / f"wallet-{LABEL}-web.png"))
        windows = subprocess.check_output(["xwininfo", "-root", "-tree"], text=True)
        window = re.search(r'(0x[0-9a-f]+) "' + re.escape(title) + '"', windows).group(1)
        subprocess.run(["import", "-window", window, str(OUTPUT / f"wallet-{LABEL}-tui.png")], check=True)
        pane = tmux("capture-pane", "-p", "-t", session)
        (OUTPUT / f"wallet-{LABEL}-tui.txt").write_text(pane)
        provenance["secondsAfterPayment"] = round(time.monotonic() - paid, 1)
        provenance["shown"] = {
            "web": re.search(r"\d+\.\d\d USDC", page.locator("body").inner_text()).group(0),
            "tui": re.search(r"\d+\.\d\d USDC", pane).group(0),
        }
        browser.close()
    (OUTPUT / f"wallet-{LABEL}-source.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(json.dumps(provenance["shown"]))
finally:
    if terminal:
        terminal.terminate()
    subprocess.run(["tmux", "kill-session", "-t", session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    host.terminate()
    host.wait(timeout=15)

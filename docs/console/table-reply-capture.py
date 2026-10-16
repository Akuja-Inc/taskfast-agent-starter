#!/usr/bin/env python3
"""Capture the console turn card that holds the fixture host's table reply (#85).
Run from the repository root after pnpm build:
  python3 docs/console/table-reply-capture.py before|after [source-worktree]
The source worktree needs dist/ built. Needs Python Playwright with Chromium.
Same fixture host and method as the #59 reply-markdown evidence: temporary agent
folders, a scripted model and a fake CLI; no real agents, credentials, wallets,
model providers or marketplace servers.
"""
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

OUTPUT = Path(__file__).resolve().parent
ROOT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else OUTPUT.parents[1]
LABEL = sys.argv[1]
assert LABEL in ("before", "after")
SHOTS = {"desktop": (1440, 1050), "phone": (390, 844)}
chromium = shutil.which("chromium") or "/snap/bin/chromium"

host = subprocess.Popen(["node", "test/fixtures/tui-host.mjs"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
try:
    link = next(m[1] for line in host.stdout if (m := re.search(r"console: (\S+)", line)))
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=chromium)
        for name, (width, height) in SHOTS.items():
            for theme in ("light", "dark") if name == "desktop" else ("light",):
                page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1, locale="en-US", timezone_id="UTC", color_scheme=theme, bypass_csp=True)
                page.goto(link)
                page.get_by_text("A new bid arrived").first.wait_for(timeout=30000)
                card = page.locator("article.turn").filter(has_text="0.25 USDC").first
                card.scroll_into_view_if_needed()
                time.sleep(.3)
                card.screenshot(path=str(OUTPUT / f"table-reply-{LABEL}-{name}-{theme}.png"))
                page.close()
        browser.close()
finally:
    host.terminate()
    host.wait(timeout=15)

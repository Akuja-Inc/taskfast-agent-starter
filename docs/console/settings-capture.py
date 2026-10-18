#!/usr/bin/env python3
"""Capture the console tab bar and the Settings page (#115).
Run from the repository root after pnpm build:
  python3 docs/console/settings-capture.py before|after [source-worktree]
The source worktree needs dist/ built. Needs Python Playwright with Chromium.
Same fixture host and method as the #85 table-reply evidence: temporary agent
folders, a scripted model and a fake CLI; no real agents, credentials, wallets,
model providers or marketplace servers.
"""
import re
import shutil
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUTPUT = Path(__file__).resolve().parent
ROOT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else OUTPUT.parents[1]
LABEL = sys.argv[1]
assert LABEL in ("before", "after")
chromium = shutil.which("chromium") or "/snap/bin/chromium"

host = subprocess.Popen(["node", "test/fixtures/tui-host.mjs"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
try:
    link = next(m[1] for line in host.stdout if (m := re.search(r"console: (\S+)", line)))
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=chromium)
        page = browser.new_page(viewport={"width": 1440, "height": 1100}, device_scale_factor=1, locale="en-US", timezone_id="UTC", color_scheme="light", bypass_csp=True)
        page.goto(link)
        page.get_by_text("A new bid arrived").first.wait_for(timeout=30000)
        page.locator("nav a").filter(has_text="Capabilities").wait_for(timeout=30000)
        page.locator('nav a[aria-current="page"]').first.wait_for(timeout=30000)
        # The tab bar alone, on every page, so a rename shows without the rest of the console.
        page.locator("nav").first.screenshot(path=str(OUTPUT / f"settings-tab-{LABEL}.png"))
        if LABEL == "after":
            page.locator("nav a").filter(has_text="Settings").first.click()
            page.locator("#poll-interval").wait_for(timeout=30000)
            page.screenshot(path=str(OUTPUT / "settings.png"), full_page=True)
        page.close()
        browser.close()
finally:
    host.terminate()
    host.wait(timeout=15)

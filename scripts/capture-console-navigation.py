#!/usr/bin/env python3
"""Capture local URL-navigation evidence from two built checkouts. Needs Playwright."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import subprocess
import urllib.request
from playwright.async_api import async_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--baseline", type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
baseline = args.baseline.resolve()
out = root / "docs/console-url"
out.mkdir(parents=True, exist_ok=True)
children = []


def host(kit):
    env = dict(os.environ, TASKFAST_KIT_ROOT=str(kit))
    process = subprocess.Popen(
        ["node", str(root / "test/fixtures/console-navigation-host.mjs")],
        cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    children.append(process)
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(process.stderr.read())
    return json.loads(line)["baseUrl"]


async def main():
    before, after = host(baseline), host(root)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            executable_path=os.environ.get("TASKFAST_BROWSER", "/snap/bin/chromium"),
            headless=True, args=["--no-sandbox"],
        )
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900}, bypass_csp=True, reduced_motion="reduce",
        )
        # The fixture uses a public synthetic token, never an agent's credentials.
        await context.add_init_script("sessionStorage.setItem('token','a'.repeat(64));localStorage.setItem('tf-theme','light');")
        page = await context.new_page()
        await page.goto(before + "/agents/beta?tab=briefing")
        await page.screenshot(path=str(out / "before-direct-link.png"))
        await page.goto(after + "/agents/beta?tab=briefing")
        await page.wait_for_selector('nav a[aria-current=page]:text("Briefing")')
        await page.wait_for_function("document.querySelector('textarea')?.value.includes('beta')")
        await page.screenshot(path=str(out / "after-direct-link.png"))
        request = urllib.request.Request(after + "/api/agents/alpha", headers={"Authorization": "Bearer " + "a" * 64})
        with urllib.request.urlopen(request) as response:
            turn = json.load(response)["timeline"][0]["id"]
        await page.goto(after + "/agents/alpha?open=" + turn + "%3Afixture-call&raw=" + turn)
        await page.wait_for_selector(".calls")
        await page.screenshot(path=str(out / "after-expanded-panels.png"))
        await page.set_viewport_size({"width": 390, "height": 844})
        await page.screenshot(path=str(out / "after-phone.png"))
        assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Phone overflow"
        await browser.close()
    print(json.dumps({"baseline": str(baseline), "captures": sorted(p.name for p in out.glob("*.png"))}))


try:
    asyncio.run(main())
finally:
    for process in children:
        process.terminate()
    for process in children:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

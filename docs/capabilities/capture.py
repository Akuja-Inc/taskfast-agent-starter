"""Capture the real loopback console with temporary agents and a faux model.
Run from the kit root after pnpm build. Optional baseline root supplies the before UI.
No private files, account initialization, live models or marketplace calls.
"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
from playwright.async_api import async_playwright

ROOT = Path.cwd()
OUT = ROOT / "docs/capabilities"
KIND = sys.argv[1] if len(sys.argv) > 1 else "after"
BUILD = sys.argv[2] if len(sys.argv) > 2 else str(ROOT)

async def main():
    env = {**os.environ, "KIT_BUILD_ROOT": BUILD}
    host = subprocess.Popen(["node", "docs/capabilities/browser-host.mjs"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        url = await asyncio.wait_for(asyncio.to_thread(host.stdout.readline), timeout=20)
        if not url.startswith("http://127.0.0.1:"):
            raise RuntimeError("synthetic host did not start: " + host.stderr.read())
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(executable_path="/snap/bin/chromium", headless=True, args=["--no-sandbox"])
            for device, width, height in [("desktop", 1440, 1000), ("phone", 390, 844)]:
                for theme in ["light", "dark"]:
                    context = await browser.new_context(viewport={"width": width, "height": height}, color_scheme=theme)
                    page = await context.new_page()
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    await page.goto(url.strip())
                    await page.get_by_role("link", name="Briefing", exact=True).wait_for()
                    if KIND == "after":
                        await page.get_by_role("link", name="Capabilities", exact=True).click()
                        await page.get_by_role("button", name="Add MCP server", exact=True).wait_for()
                    else:
                        await page.get_by_role("link", name="Briefing", exact=True).click()
                    await page.evaluate("document.fonts.ready")
                    await page.evaluate("window.scrollTo(0, 0)")
                    await page.screenshot(path=str(OUT / f"{KIND}-{device}-{theme}.png"), full_page=True)
                    overflow = await page.evaluate("document.documentElement.scrollWidth > innerWidth")
                    if errors or overflow:
                        raise AssertionError({"device": device, "theme": theme, "pageerrors": errors, "overflow": overflow})
                    await context.close()
            await browser.close()
        (OUT / f"{KIND}-source.json").write_text(json.dumps({"source": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=BUILD, text=True).strip(), "buildRoot": "baseline" if KIND == "before" else "working tree", "fixtures": "temporary agent folders, real SQLite stores, faux model; no live marketplace", "viewport": {"desktop": [1440, 1000], "phone": [390, 844]}, "themes": ["light", "dark"]}, indent=2) + "\n")
    finally:
        host.terminate()
        try:
            await asyncio.wait_for(asyncio.to_thread(host.wait), timeout=15)
        except asyncio.TimeoutError:
            host.kill()
            host.wait()

asyncio.run(main())

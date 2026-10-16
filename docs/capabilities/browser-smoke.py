"""Exercise real web management, private staging and one approved local MCP read.
Run from the kit root after pnpm build. Every account/store/key is synthetic.
"""
import asyncio
import json
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlsplit
from playwright.async_api import async_playwright, expect

ROOT = Path.cwd()
OUT = ROOT / "docs/capabilities"
SECRET = "synthetic-browser-only-fixture-token"

async def main():
    host = subprocess.Popen(["node", "docs/capabilities/browser-host.mjs"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        url = (await asyncio.wait_for(asyncio.to_thread(host.stdout.readline), 20)).strip()
        assert url.startswith("http://127.0.0.1:"), "Local fixture did not start"
        token = urlsplit(url).fragment.removeprefix("token=")
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(executable_path="/snap/bin/chromium", args=["--no-sandbox"], headless=True)
            context = await browser.new_context(viewport={"width": 1440, "height": 1000}, color_scheme="light")
            page = await context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            await page.goto(url)
            await page.get_by_role("link", name="Capabilities", exact=True).click()
            await page.get_by_role("button", name="Import folder", exact=True).click()
            with tempfile.TemporaryDirectory(prefix="capability-browser-upload-") as upload:
                folder = Path(upload) / "research"
                folder.mkdir()
                (folder / "SKILL.md").write_text("---\nname: research\ndescription: Read editorial task references carefully.\n---\nUse approved tools. Never override marketplace policy.\n")
                await page.locator('input[type="file"]').set_input_files(str(folder))
                await expect(page.get_by_text("Folder validated locally.", exact=False)).to_be_visible()
                await page.get_by_role("button", name="Stage imported skill", exact=True).click()
            await expect(page.locator('[data-cap-name="research"]')).to_be_visible()
            await page.get_by_role("button", name="Add MCP server", exact=True).click()
            await page.get_by_label("Server name", exact=True).fill("sources")
            await page.get_by_label("Connection type", exact=True).select_option("local")
            executable = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
            await page.get_by_label("Installed executable (absolute path)", exact=True).fill(executable)
            await page.get_by_role("button", name="Add argument", exact=True).click()
            await page.get_by_label("Argument 1", exact=True).fill(str(ROOT / "test/fixtures/mcp/server.mjs"))
            await page.get_by_role("button", name="Add credential binding", exact=True).click()
            await page.get_by_label("Environment variable", exact=True).fill("DOCS_TOKEN")
            await page.get_by_label("Private binding name", exact=True).fill("SOURCE_TOKEN")
            await page.get_by_label("New credential value", exact=True).fill(SECRET)
            await page.get_by_role("button", name="Continue to test and review tools", exact=True).click()
            await expect(page.get_by_role("button", name="Test connection", exact=True)).to_be_disabled()
            assert SECRET not in await page.inner_text("body")
            assert not await page.evaluate("Object.values(localStorage).concat(Object.values(sessionStorage)).some(value=>value.includes('" + SECRET + "'))")
            await page.set_viewport_size({"width": 390, "height": 844})
            assert not await page.evaluate("document.documentElement.scrollWidth > innerWidth")
            await page.screenshot(path=str(OUT / "after-consent-phone-light.png"), full_page=True)
            await page.set_viewport_size({"width": 1440, "height": 1000})
            await page.get_by_role("checkbox", name=re.compile("I consent to starting exactly")).check()
            await page.get_by_role("button", name="Test connection", exact=True).click()
            await expect(page.get_by_text("Test passed; not active", exact=True)).to_be_visible(timeout=15_000)
            await expect(page.get_by_text("Unavailable: known write or unsafe tool. It cannot be approved.", exact=True)).to_be_visible()
            read = page.get_by_role("checkbox", name="I reviewed this contract and approve search as a read", exact=True)
            await expect(read).not_to_be_checked()
            await read.check()
            await page.get_by_role("button", name="Continue to review and save", exact=True).click()
            await page.get_by_role("button", name="Save and enable after apply", exact=True).click()
            await expect(page.get_by_role("button", name="Review changes", exact=True)).to_be_visible()
            response = await page.request.get(url.split("/#")[0] + "/api/agents/editor/capabilities", headers={"authorization": "Bearer " + token})
            staged = await response.json()
            assert staged["pending"] and staged["servers"][0]["approved"][0]["name"] == "search"
            assert staged["credentialChanges"] == [{"name": "SOURCE_TOKEN", "change": "added"}]
            assert SECRET not in json.dumps(staged)
            await page.get_by_role("button", name="Review changes", exact=True).click()
            await expect(page.get_by_role("button", name="Apply when idle", exact=True)).to_be_disabled()
            await page.screenshot(path=str(OUT / "after-review-desktop-light.png"), full_page=True)
            await page.locator('.cap-detail .cap-check input').check()
            await page.get_by_role("button", name="Apply when idle", exact=True).click()
            await expect(page.get_by_text(re.compile("^Applied\\. Active revision:"))).to_be_visible(timeout=15_000)
            await page.get_by_role("button", name="Back to capabilities", exact=True).click()
            await expect(page.get_by_text("Connection: Connected", exact=True)).to_be_visible()
            for _ in range(100):
                response = await page.request.get(url.split("/#")[0] + "/api/agents/editor", headers={"authorization": "Bearer " + token})
                view = await response.json()
                if "results for editorial fixture reference" in json.dumps(view):
                    break
                await asyncio.sleep(.1)
            else:
                raise AssertionError("Approved local MCP read did not appear in real durable transcript")
            assert SECRET not in json.dumps(view)
            assert view["actions"] == {}, "Fixture must not dispatch marketplace writes"
            await page.screenshot(path=str(OUT / "after-connected-desktop-light.png"), full_page=True)
            await page.get_by_label("Agent", exact=True).select_option("researcher")
            await expect(page.get_by_text("Capabilities · researcher", exact=True)).to_be_visible()
            other = await (await page.request.get(url.split("/#")[0] + "/api/agents/researcher/capabilities", headers={"authorization": "Bearer " + token})).json()
            assert other["servers"] == [] and other["credentials"] == [] and not other["pending"]
            assert not errors, errors
            await context.close()
            await browser.close()
        (OUT / "browser-smoke-result.json").write_text(json.dumps({"source": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(), "passed": True, "exercised": ["directory import", "private credential entry", "explicit local execution consent", "discovery only", "explicit search read approval", "blocked write", "shared review", "dormant reopen after commit", "actual durable MCP read", "live connection health", "sibling isolation", "credential redaction", "phone consent layout"], "services": "temporary SQLite stores, faux model, loopback console and local stdio MCP fixture only"}, indent=2) + "\n")
        print("Real browser capability import, consent, approval, apply and durable MCP read passed.")
    finally:
        host.terminate()
        try:
            await asyncio.wait_for(asyncio.to_thread(host.wait), 15)
        except asyncio.TimeoutError:
            host.kill()
            host.wait()

asyncio.run(main())

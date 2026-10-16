#!/usr/bin/env python3
"""pnpm build && python3 docs/startup/capture.py
Uses machine-installed Python Playwright and Chromium; no services or agent files.
Captures working-tree bytes honestly. Rerun after committing to pin the source SHA.
"""
import asyncio
import hashlib
import json
import subprocess
from pathlib import Path
from playwright.async_api import async_playwright, expect

OUT = Path(__file__).resolve().parent
ROOT = OUT.parent.parent
SOURCES = ['src/console-page.ts', 'src/console-live.ts', 'src/console-markdown.ts', 'docs/startup/browser-host.mjs']

async def capture(link):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, color_scheme='light')
        await context.add_init_script("sessionStorage.setItem('agent','slow-worker');localStorage.setItem('tf-theme','light')")
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(link)
        await expect(page.locator('.startup')).to_contain_text('Starting agent')
        composer = page.locator('form.composer textarea')
        await composer.fill('Keep this draft until the worker is ready.')
        await composer.press('Control+s')
        await composer.press('Enter')
        assert not await (await context.request.get(link.split('/#')[0] + '/fixture/requests')).json()
        # Polling must retain the actual editor node and its selection.
        await composer.evaluate('(t) => { window.savedEditor=t; t.setSelectionRange(5, 9); }')
        await page.wait_for_timeout(1200)
        assert await composer.evaluate('(t) => t === window.savedEditor && t.selectionStart === 5 && t.selectionEnd === 9')
        for state, agent in [('starting', 'slow-worker'), ('stopped', 'failed-worker')]:
            await page.get_by_label('Agent', exact=True).select_option(agent)
            await expect(page.locator('.startup')).to_contain_text('agents/' + agent + '/')
            for device, width, height in [('desktop', 1440, 1000), ('phone', 390, 844)]:
                await page.set_viewport_size({'width': width, 'height': height})
                for theme in ['light', 'dark']:
                    await page.evaluate('document.documentElement.dataset.theme=' + json.dumps(theme))
                    await page.evaluate('scrollTo(0,0)')
                    await page.screenshot(path=str(OUT / f'web-{state}-{device}-{theme}.png'), full_page=True)
                    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    assert all(height >= 44 for height in await page.locator('.startup-action, .send, .theme, nav a').evaluate_all('(ns)=>ns.map(n=>n.getBoundingClientRect().height)'))
                    assert await page.locator('#app > :first-child').evaluate('(n)=>n.classList.contains("banner")')
        await page.get_by_role('button', name='Retry startup', exact=True).focus()
        await page.get_by_role('button', name='Retry startup', exact=True).press('Enter')
        await expect(page.locator('.startup-action')).to_have_attribute('aria-disabled', 'true')
        await expect(page.locator('.startup-action')).to_be_focused()
        await expect(page.locator('.startup-feedback')).to_contain_text('Requesting retry')
        await expect(page.locator('.startup')).to_contain_text('Waiting for the previous attempt')
        await page.get_by_label('Agent', exact=True).select_option('healthy-worker')
        await expect(page.get_by_text('Budget', exact=True)).to_be_visible()
        assert await page.locator('.startup').count() == 0
        await page.get_by_label('Message healthy-worker').fill('Healthy draft')
        await page.get_by_label('Agent', exact=True).select_option('slow-worker')
        await expect(composer).to_have_value('Keep this draft until the worker is ready.')
        await page.get_by_role('button', name='Cancel startup', exact=True).click()
        await expect(page.locator('.startup-feedback')).to_contain_text('Requesting cancellation')
        await expect(page.locator('.startup')).to_contain_text('Startup cancelled')
        await expect(composer).to_have_value('Keep this draft until the worker is ready.')
        await page.get_by_role('link', name='Briefing', exact=True).click()
        await expect(page.locator('.startup')).to_contain_text('Agent stopped')
        await page.get_by_role('button', name='Switch to the light theme').click()
        assert await page.locator('html').get_attribute('data-theme') == 'light'
        assert not errors, errors
        await browser.close()

host = subprocess.Popen(['node', 'docs/startup/browser-host.mjs'], cwd=ROOT, stdout=subprocess.PIPE, text=True)
try:
    link = host.stdout.readline().strip()
    assert link.startswith('http://127.0.0.1:')
    asyncio.run(capture(link))
    dirty = subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', *SOURCES], cwd=ROOT).returncode != 0
    (OUT / 'browser-source.json').write_text(json.dumps({
        'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'dirty': dirty,
        'sha256': {source: hashlib.sha256((ROOT / source).read_bytes()).hexdigest() for source in SOURCES},
        'captureScriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'capture': 'Headless Chromium, desktop 1440x1000 and emulated phone 390x844, light and dark; synthetic loopback host only.',
    }, indent=2) + '\n')
    print('8 screenshots; draft, selection, retry/cancel busy feedback, healthy navigation, themes, widths and 44px targets passed.')
finally:
    host.terminate()
    host.wait(timeout=10)

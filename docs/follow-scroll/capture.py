#!/usr/bin/env python3
"""pnpm build && python3 docs/follow-scroll/capture.py
Needs machine-installed Python Playwright and Chromium. Synthetic loopback data only.
"""
import asyncio
import hashlib
import json
import os
import subprocess
from pathlib import Path
from playwright.async_api import async_playwright, expect

OUT = Path(__file__).resolve().parent
ROOT = OUT.parent.parent
BEFORE_REF = '7f0dc44'
TOKEN = 'a' * 64
SOURCES = ['src/console-page.ts', 'docs/follow-scroll/browser-host.mjs', 'docs/follow-scroll/capture.py']


async def capture(link, before):
    mode = 'before' if before else 'after'
    base = link.split('/#')[0]

    async def push():
        response = await context.request.post(base + '/fixture/push', headers={'authorization': 'Bearer ' + TOKEN})
        assert response.status == 204

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, color_scheme='light', bypass_csp=True)
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(link)
        # The timeline opens at its newest turn in both versions.
        await expect(page.get_by_text('Reply to seed-5 line 1')).to_be_in_viewport()
        note = page.locator('.send-note')
        await expect(note).to_be_in_viewport()
        in_viewport = '(n) => { const r = n.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }'

        # At the bottom, a pushed turn follows only after the fix.
        at_bottom = await page.evaluate('scrollY')
        await push()
        pushed = page.get_by_text('Reply to push-6 line 1')
        await expect(pushed).to_be_attached()
        if before:
            await page.wait_for_timeout(1500)
            assert await page.evaluate('scrollY') == at_bottom
            assert not await note.evaluate(in_viewport)
        else:
            await expect(pushed).to_be_in_viewport()
            await expect(note).to_be_in_viewport()
        await page.screenshot(path=str(OUT / f'{mode}-push-bottom.png'))

        # Scrolled up, a pushed turn never moves the page and the jump button shows.
        await page.evaluate('scrollTo(0, 0)')
        assert await page.evaluate('scrollY') == 0
        await push()
        pushed_away = page.get_by_text('Reply to push-7 line 1')
        await expect(pushed_away).to_be_attached()
        await page.wait_for_timeout(1500)
        y_away = await page.evaluate('scrollY')
        assert abs(y_away) <= 8, f'scrolled-up push moved the page to scrollY={y_away}'
        await expect(page.get_by_role('button', name='Jump to the newest turn')).to_be_visible()
        await page.screenshot(path=str(OUT / f'{mode}-push-away.png'))

        # The operator's own send scrolls into view from any position after the fix.
        await page.get_by_label('Message editor').fill('Hello from the operator')
        await page.get_by_role('button', name='Send', exact=True).click()
        sent = page.get_by_text('Hello from the operator')
        await expect(sent.first).to_be_attached()
        if before:
            await page.wait_for_timeout(1500)
            y_sent = await page.evaluate('scrollY')
            assert abs(y_sent) <= 8, f'scrolled-up send moved the page to scrollY={y_sent}'
        else:
            await expect(sent.first).to_be_in_viewport()
            await expect(note).to_be_in_viewport()
        await page.screenshot(path=str(OUT / f'{mode}-send.png'))

        assert not errors, errors
        await browser.close()


for before in [True, False]:
    env = {k: v for k, v in os.environ.items() if k != 'BEFORE_REF'} | ({'BEFORE_REF': BEFORE_REF} if before else {})
    host = subprocess.Popen(['node', 'docs/follow-scroll/browser-host.mjs'], cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True)
    try:
        link = host.stdout.readline().strip()
        assert link.startswith('http://127.0.0.1:')
        asyncio.run(capture(link, before))
    finally:
        host.terminate()
        host.wait(timeout=10)

(OUT / 'browser-source.json').write_text(json.dumps({
    'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'beforeCommit': subprocess.check_output(['git', 'rev-parse', BEFORE_REF], cwd=ROOT, text=True).strip(),
    'dirty': subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', *SOURCES], cwd=ROOT).returncode != 0,
    'sha256': {source: hashlib.sha256((ROOT / source).read_bytes()).hexdigest() for source in SOURCES},
    'capture': 'Headless Chromium; desktop 1440x1000, light theme. Synthetic browser fixture only, no marketplace calls.',
}, indent=2) + '\n')
print('6 screenshots; follow at the bottom, anchor while scrolled up, jump button and send scrolling passed.')

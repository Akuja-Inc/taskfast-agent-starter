#!/usr/bin/env python3
"""pnpm build && python3 docs/polling/capture.py
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
BEFORE_REF = 'f34c49e'
SOURCES = ['src/console-page.ts', 'src/console-live.ts', 'src/console-markdown.ts', 'src/core/spec.ts', 'docs/polling/browser-host.mjs', 'docs/polling/capture.py']

async def capture(link, before):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, color_scheme='light', bypass_csp=True)
        await context.add_init_script("sessionStorage.setItem('agent','editor');localStorage.setItem('tf-theme','light')")
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(link)
        await page.get_by_role('link', name='Briefing', exact=True).click()
        await expect(page.get_by_label('Instructions (INSTRUCTIONS.md)', exact=False)).to_be_visible()
        if before:
            await expect(page.get_by_label('Check for work every (minutes)', exact=True)).to_have_count(0)
            await page.screenshot(path=str(OUT / 'before-desktop-light.png'), full_page=True)
        else:
            field = page.get_by_label('Check for work every (minutes)', exact=True)
            await expect(field).to_have_value('15')
            save = page.get_by_role('button', name='Save & reopen', exact=True)
            for invalid in ['0', '-1', '1.5', '1441', '']:
                await field.fill(invalid)
                await field.press('Tab')
                await save.click()
                await expect(page.get_by_text('Check-for-work interval must be a whole number from 1 to 1440 minutes.', exact=True)).to_be_visible()
                assert not await (await context.request.get(link.split('/#')[0] + '/fixture/requests')).json()
            await field.fill('7')
            await field.press('Tab')
            async with page.expect_response(lambda response: response.request.method == 'PUT' and response.url.endswith('/spec')) as response:
                await save.click()
            assert (await response.value).status == 204
            await page.reload()
            await page.get_by_role('link', name='Briefing', exact=True).click()
            await expect(field).to_have_value('7')
            requests = await (await context.request.get(link.split('/#')[0] + '/fixture/requests')).json()
            assert len(requests) == 1 and requests[0]['body']['pollIntervalMinutes'] == 7
            await page.get_by_label('Agent', exact=True).select_option('sibling')
            await expect(field).to_have_value('2')
            await page.get_by_label('Agent', exact=True).select_option('editor')
            await expect(field).to_have_value('7')
            for device, width, height in [('desktop', 1440, 1000), ('phone', 390, 844)]:
                await page.set_viewport_size({'width': width, 'height': height})
                for theme in ['light', 'dark']:
                    await page.evaluate('document.documentElement.dataset.theme=' + json.dumps(theme))
                    await page.evaluate('scrollTo(0,0)')
                    await page.screenshot(path=str(OUT / f'after-{device}-{theme}.png'), full_page=True)
                    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    assert await field.evaluate('(n) => n.getBoundingClientRect().height >= 44')
                    assert await field.get_attribute('aria-describedby') == 'poll-interval-help'
                    assert await page.locator('#app > :first-child').evaluate('(n) => n.classList.contains("banner")')
        assert not errors, errors
        await browser.close()

for before in [True, False]:
    env = {**os.environ}
    env.pop('BEFORE_REF', None)
    if before:
        env['BEFORE_REF'] = BEFORE_REF
    host = subprocess.Popen(['node', 'docs/polling/browser-host.mjs'], cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True)
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
    'capture': 'Headless Chromium; desktop 1440x1000 and phone 390x844; light and dark. Synthetic browser fixture only, no marketplace calls.',
}, indent=2) + '\n')
print('5 screenshots; default, invalid-input refusal, save/reload, separate agents, themes, widths and 44px input passed.')

#!/usr/bin/env python3
"""pnpm build && python3 docs/poll-folds/capture.py
Synthetic browser integration checks and before/after captures. Requires Python Playwright.
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
BEFORE_REF = '98f4246'
SOURCES = ['src/console-page.ts', 'src/console-polling.ts', 'src/core/timeline.ts',
           'docs/poll-folds/browser-host.mjs', 'docs/poll-folds/capture.py']

async def capture(link, before):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, color_scheme='light', bypass_csp=True)
        await context.add_init_script("sessionStorage.setItem('agent','editor');localStorage.setItem('tf-theme','light')")
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        origin = link.split('/#')[0]
        async def scenario(name):
            response = await context.request.post(origin + '/fixture/scenario/' + name, headers={'authorization': 'Bearer ' + 'a' * 64})
            assert response.ok
        await scenario('evidence')
        await page.goto(link, wait_until='domcontentloaded')
        await expect(page.locator('.turn').first).to_be_visible()
        if before:
            await expect(page.locator('.poll-run')).to_have_count(0)
            await page.evaluate('scrollTo(0,0)')
            await page.screenshot(path=str(OUT / 'before-desktop-light.png'), full_page=True)
        else:
            await expect(page.locator('.poll-run')).to_have_count(1)
            await expect(page.locator('.poll-run > summary')).to_contain_text('3 checks')
            await expect(page.locator('.turns').get_by_text('The check failed. Current open jobs are unknown.', exact=True)).to_be_visible()
            for device, width, height in [('desktop', 1440, 1000), ('phone', 390, 844)]:
                await page.set_viewport_size({'width': width, 'height': height})
                for theme in ['light', 'dark']:
                    await page.evaluate('(t) => document.documentElement.dataset.theme=t', theme)
                    await page.evaluate('scrollTo(0,0)')
                    await page.screenshot(path=str(OUT / f'after-{device}-{theme}.png'), full_page=True)
                    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    assert await page.locator('.poll-run > summary').evaluate('(n) => n.getBoundingClientRect().height >= 44')
                    assert await page.locator('#app > :first-child').evaluate('(n) => n.classList.contains("banner")')
            await page.set_viewport_size({'width': 1440, 'height': 1000})
            await page.evaluate("document.documentElement.dataset.theme='light'")
            await scenario('base')
            group = page.locator('.poll-run')
            await expect(group.locator(':scope > summary')).to_contain_text('3 checks')
            await group.locator(':scope > summary').focus()
            await page.keyboard.press('Enter')
            await expect(group).to_have_attribute('open', '')
            check = group.locator('.poll-check').first
            await check.locator(':scope > summary').click()
            await expect(check).to_have_attribute('open', '')
            await expect(check.get_by_text('No suitable open jobs. No action taken.', exact=True)).to_be_visible()
            await check.get_by_role('button', name='1 tool call', exact=True).click()
            await expect(check.locator('pre')).to_contain_text('"tasks": []')
            await page.screenshot(path=str(OUT / 'after-expanded.png'), full_page=True)
            # The stream must grow the same group without losing summary focus or expansion.
            await check.locator(':scope > summary').focus()
            anchor_before = await check.locator(':scope > summary').evaluate('(n) => n.getBoundingClientRect().top')
            await scenario('grow')
            await expect(group.locator(':scope > summary')).to_contain_text('4 checks')
            await expect(group).to_have_attribute('open', '')
            await expect(group.locator('.poll-check').first).to_have_attribute('open', '')
            await expect(group.locator('.poll-check').first.locator(':scope > summary')).to_be_focused()
            await expect(group.locator('.poll-check').first.locator('pre')).to_be_visible()
            anchor_after = await group.locator('.poll-check').first.locator(':scope > summary').evaluate('(n) => n.getBoundingClientRect().top')
            assert abs(anchor_before - anchor_after) < 3, (anchor_before, anchor_after)
            # No completion, failure, changed response, or changed wording may be hidden.
            for name, expected in [('pending', '(tool calls only)'), ('failed', 'The check failed. Current open jobs are unknown.'), ('changed', 'New editing work is available. I will review it before bidding.'), ('novel', 'No suitable open jobs. Please check my spending limits before tomorrow.')]:
                await scenario(name)
                await expect(group.locator(':scope > summary')).to_contain_text('3 checks')
                await expect(page.locator('.turns').get_by_text(expected, exact=True).last).to_be_visible()
            # A completed read must not swallow the control the operator is using.
            await scenario('pending')
            pending_calls = page.locator('.turn[data-i="4"] .calls-chip')
            await expect(pending_calls).to_be_visible()
            await pending_calls.click()
            await scenario('grow')
            await expect(page.locator('.turn[data-i="4"] .calls-chip')).to_be_focused()
            await expect(page.locator('.turn[data-i="4"]')).to_be_visible()
            # Agent selection resets expansion state; no fold may join two histories.
            await page.get_by_label('Agent', exact=True).select_option('sibling')
            await expect(page.locator('.poll-run > summary')).to_contain_text('1 check')
            await expect(page.locator('.poll-run')).not_to_have_attribute('open', '')
            await page.get_by_label('Agent', exact=True).select_option('editor')
            await scenario('history')
            # A fresh page starts with 12 originals. Streaming growth intentionally
            # preserves the mounted start instead of evicting a check being read.
            await page.reload(wait_until='domcontentloaded')
            await expect(page.locator('.poll-run > summary')).to_contain_text('12 checks')
            await expect(page.get_by_text('18 earlier turns', exact=True)).to_be_visible()
            # A mounted rail tick opens both levels and reveals its original turn.
            await page.locator('.tick[data-i="25"]').focus()
            await page.keyboard.press('Enter')
            await expect(page.locator('.tick[data-i="25"]')).to_be_focused()
            await expect(page.locator('.turn[data-i="25"]')).to_be_visible()
            await expect(page.locator('.poll-run')).to_have_attribute('open', '')
            # Earlier mounting must not claim that the invisible checks were included before.
            await page.get_by_role('button', name='Show 18 more', exact=True).click()
            await expect(page.locator('.poll-run > summary')).to_contain_text('29 checks')
            await expect(page.locator('.turn[data-i="0"]')).to_be_visible()
        assert not errors, errors
        await browser.close()

for before in [True, False]:
    env = {**os.environ}
    env.pop('BEFORE_REF', None)
    if before:
        env['BEFORE_REF'] = BEFORE_REF
    host = subprocess.Popen(['node', 'docs/poll-folds/browser-host.mjs'], cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True)
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
print('Before/after captures and browser folding, details, live update, isolation, pagination and rail checks passed.')

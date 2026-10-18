#!/usr/bin/env python3
"""pnpm build && python3 docs/console/reads-capture.py <scenario>

Captures the console Settings page before and after one change, in light and dark,
at desktop and phone width. Needs machine-installed Python Playwright and Chromium.
Synthetic loopback data only: no agent folder, store, model or marketplace call.
"""
import asyncio
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from playwright.async_api import async_playwright, expect

OUT = Path(__file__).resolve().parent
ROOT = OUT.parent.parent
TOKEN = 'a' * 64
SOURCES = ['src/console-page.ts', 'docs/console/reads-host.mjs', 'docs/console/reads-capture.py']
SIZES = {'desktop': (1440, 1000), 'phone': (390, 844)}

ORDERS = ['Keep every bid under **$20** and read the [style guide](https://example.com/style) first', 'Skip jobs that need a phone call']
NOTES = ['The Halvorsen guide uses Oxford commas', 'Poster 7f3a pays within a day']


async def reads(page, mode):
    """gh#122: the prompt as owned blocks. The after page also opens the raw disclosure."""
    await expect(page.get_by_text('Skip jobs that need a phone call').first).to_be_visible()
    if mode == 'after':
        await expect(page.locator('.reads-block')).to_have_count(3)


async def reads_raw(page):
    await page.get_by_text('Show the exact text the model reads').click()
    await expect(page.locator('details.reads-raw pre')).to_be_visible()


# name: (before ref, fixture state, check run on every shot, extra after-only shots)
SCENARIOS = {
    'reads': ('8d20d20', {'orders': ORDERS, 'notes': NOTES, 'limits': {'perJobUsd': 20, 'dailyUsd': 50}}, reads, {'raw': reads_raw}),
}


async def capture(link, mode, scenario):
    _, state, check, extras = SCENARIOS[scenario]
    base = link.split('/agents/')[0]
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
        for theme in ['light', 'dark']:
            for size, (width, height) in SIZES.items():
                context = await browser.new_context(viewport={'width': width, 'height': height}, color_scheme=theme)
                response = await context.request.post(base + '/fixture/state', headers={'authorization': 'Bearer ' + TOKEN}, data=json.dumps(state))
                assert response.status == 204
                page = await context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                await page.goto(link)
                await expect(page.get_by_text('INSTRUCTIONS.md and agent.json')).to_be_visible()
                await check(page, mode)
                await page.screenshot(path=str(OUT / f'settings-{scenario}-{mode}-{size}-{theme}.png'), full_page=True)
                if mode == 'after' and size == 'desktop':
                    for name, extra in extras.items():
                        await extra(page)
                        await page.screenshot(path=str(OUT / f'settings-{scenario}-{name}-{theme}.png'), full_page=True)
                assert not errors, errors
                await context.close()
        await browser.close()


def main(scenario):
    before_ref = SCENARIOS[scenario][0]
    for mode in ['before', 'after']:
        env = {**os.environ}
        env.pop('BEFORE_REF', None)
        if mode == 'before':
            env['BEFORE_REF'] = before_ref
        host = subprocess.Popen(['node', 'docs/console/reads-host.mjs'], cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True)
        try:
            link = host.stdout.readline().strip()
            assert link.startswith('http://127.0.0.1:'), link
            asyncio.run(capture(link, mode, scenario))
        finally:
            host.terminate()
            host.wait(timeout=10)
    git = lambda *args: subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()
    (OUT / f'settings-{scenario}-source.json').write_text(json.dumps({
        'commit': git('rev-parse', 'HEAD'),
        'beforeCommit': git('rev-parse', before_ref),
        'dirty': subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', *SOURCES], cwd=ROOT).returncode != 0,
        'sha256': {source: hashlib.sha256((ROOT / source).read_bytes()).hexdigest() for source in SOURCES},
        'capture': 'Headless Chromium; desktop 1440x1000 and phone 390x844, light and dark, full page. Synthetic browser fixture only, no marketplace calls.',
    }, indent=2) + '\n')
    print(f'{scenario}: before and after captured.')


if __name__ == '__main__':
    main(sys.argv[1])

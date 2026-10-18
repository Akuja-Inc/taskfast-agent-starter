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


async def money_hint(page):
    """gh#120: a draft order that names a dollar amount points at the limits."""
    await page.locator('#order-input').fill('Never spend more than $5 on a job')
    await expect(page.locator('#order-money')).to_be_visible()


async def timeline(page):
    await page.get_by_role('link', name='Timeline').click()
    await expect(page.get_by_text('Edit in Settings')).to_be_visible()


async def added(page):
    """gh#121: each order change reports beside the list."""
    await page.locator('#order-input').fill('Reply to every message within the hour')
    await page.locator('#order-input').press('Enter')
    # The before page keeps the old list while the input holds focus; the after page shows it.
    await page.wait_for_timeout(300)


async def removed(page):
    await page.get_by_role('button', name='Remove order 2').click()
    await expect(page.get_by_text('Skip jobs that need a phone call')).to_have_count(0)
    await page.wait_for_timeout(300)


async def stale(page):
    base = page.url.split('/agents/')[0]
    response = await page.context.request.post(base + '/fixture/state?quiet', headers={'authorization': 'Bearer ' + TOKEN}, data=json.dumps({'orders': ['Changed in another tab'], 'notes': NOTES}))
    assert response.status == 204
    await page.get_by_role('button', name='Remove order 1').click()
    await expect(page.get_by_text('Changed in another tab').first).to_be_visible()
    await page.wait_for_timeout(300)


async def editing(page):
    """gh#123: the pencil opens an order's row as an input holding its raw markdown."""
    await page.get_by_role('button', name='Edit order 1').click()
    await expect(page.locator('#order-edit')).to_be_focused()


async def saved(page):
    await page.locator('#order-edit').fill('Keep every bid under **$15** and read the [style guide](https://example.com/style) first')
    await page.get_by_role('button', name='Save', exact=True).click()
    await expect(page.get_by_text('Order saved.')).to_be_visible()


async def note_editing(page):
    """gh#125: the agent's notes take the same pencil and X squares as orders."""
    await page.get_by_role('button', name='Edit note 1').click()
    await page.locator('#note-edit').fill('The Halvorsen guide uses Oxford commas and US spelling')


async def note_waiting(page):
    # The fixture holds this one write, as the host does while the agent's turn runs.
    await page.route('**/api/agents/editor/notes/0', lambda route: route.continue_(headers={**route.request.headers, 'x-fixture-hold': '1'}))
    await page.get_by_role('button', name='Save', exact=True).click()
    await expect(page.get_by_text('Saves when the agent finishes its current turn.')).to_be_visible()


async def note_removed(page):
    await expect(page.get_by_text('Note saved.')).to_be_visible(timeout=10000)
    await page.get_by_role('button', name='Remove note 2').click()
    await expect(page.get_by_text('Note removed.')).to_be_visible()


async def limit_edit(page):
    """gh#127: the Limits card's pencil turns a limit into a dollar input and spells out the change."""
    await page.get_by_role('button', name='Edit per job limit').click()
    await page.locator('#limit-perJobUsd').fill('15')
    await expect(page.get_by_text('Per job limit $20.00 → $15.00')).to_be_visible()


async def limit_clear(page):
    await page.get_by_role('button', name='Edit daily limit').click()
    await page.locator('#limit-dailyUsd').fill('')
    await expect(page.get_by_text('Nothing will cap what this agent commits in a day.')).to_be_visible()


LIMITS = {'perJobUsd': 20, 'dailyUsd': 50}
# name: (before ref, fixture state, check run on every shot, extra after-only shots)
SCENARIOS = {
    'reads': ('8d20d20', {'orders': ORDERS, 'notes': NOTES, 'limits': LIMITS}, reads, {'raw': reads_raw}),
    'limits-empty': ('7516c0a', {'notes': NOTES}, None, {'money': money_hint, 'timeline': timeline}),
    'limits-set': ('7516c0a', {'orders': ORDERS, 'notes': NOTES, 'limits': LIMITS}, None, {}),
    'limits-edit': ('bc4ccde', {'orders': ORDERS, 'notes': NOTES, 'limits': LIMITS}, None, {'edit': limit_edit, 'clear': limit_clear}),
    'notes': ('9fb8b16', {'orders': ORDERS, 'notes': NOTES, 'limits': LIMITS}, None, {'editing': note_editing, 'waiting': note_waiting, 'removed': note_removed}),
    'edit': ('6abac54', {'orders': ORDERS, 'notes': NOTES, 'limits': LIMITS}, None, {'editing': editing, 'saved': saved}),
    'feedback': ('5ff0ae9', {'orders': ORDERS, 'notes': NOTES, 'limits': LIMITS}, None, {'added': added, 'removed': removed, 'stale': stale}),
}
# Scenarios whose extra shots are compared before and after, not shown after only.
COMPARED = {'feedback'}
# Scenarios whose extra shots are also taken at phone width.
PHONE_EXTRAS = {'limits-edit'}


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
                if check:
                    await check(page, mode)
                await page.screenshot(path=str(OUT / f'settings-{scenario}-{mode}-{size}-{theme}.png'), full_page=True)
                if (size == 'desktop' or scenario in PHONE_EXTRAS) and (mode == 'after' or scenario in COMPARED):
                    for name, extra in extras.items():
                        await extra(page)
                        shot = f'{name}-{mode}' if scenario in COMPARED else f'{name}-{size}' if scenario in PHONE_EXTRAS else name
                        await page.screenshot(path=str(OUT / f'settings-{scenario}-{shot}-{theme}.png'), full_page=True)
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

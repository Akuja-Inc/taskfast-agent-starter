#!/usr/bin/env python3
"""Capture real browser and terminal pixels. No marketplace or provider access.
Usage: python3 docs/withdraw/capture.py before|after /absolute/source-worktree
Requires built sources, installed TUI pins, Playwright, Chromium, X11, Zutty and tmux.
"""
import asyncio
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from playwright.async_api import async_playwright, expect

OUT = Path(__file__).resolve().parent
LABEL, ROOT = sys.argv[1], Path(sys.argv[2]).resolve()
assert LABEL in ('before', 'after')
SOURCES = ['src/console-page.ts', 'src/console.ts', 'src/core/agent.ts', 'src/core/operator.ts', 'src/tui/app.tsx', 'src/tui/keys.ts', 'test/fixtures/tui-host.mjs']
subprocess.run(['git', 'diff', 'HEAD', '--exit-code', '--quiet', '--', *SOURCES], cwd=ROOT, check=True)
(OUT / f'{LABEL}-source.json').write_text(json.dumps({
    'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'sha256': {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in SOURCES},
    'captureScriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'capture': 'Chromium browser screenshots and ImageMagick import of real Zutty/OpenTUI window pixels. Synthetic local host only.',
}, indent=2) + '\n')
host = subprocess.Popen(['node', 'test/fixtures/tui-host.mjs'], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
terminal = None
session = f'withdraw-proof-{os.getpid()}'

def tmux(*args):
    return subprocess.check_output(['tmux', *args], text=True)

def until(check):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError('capture condition timed out')

async def browser_capture(link):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1440, 'height': 1050}, color_scheme='light', device_scale_factor=1)
        await context.add_init_script("sessionStorage.setItem('agent','worker');localStorage.setItem('tf-theme','light')")
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(link)
        await expect(page.locator('.queue-row')).to_have_count(3)
        textarea = page.locator('form.composer textarea')
        await textarea.fill('Keep this draft while messages arrive.')
        for name, width, height, theme in [('desktop', 1440, 1050, 'light'), ('dark', 1440, 1050, 'dark'), ('phone', 390, 844, 'light')]:
            await page.set_viewport_size({'width': width, 'height': height})
            await page.evaluate('document.documentElement.dataset.theme=' + json.dumps(theme))
            await page.locator('#queued-messages').scroll_into_view_if_needed()
            await textarea.evaluate('(t)=>t.blur()')
            await page.screenshot(path=str(OUT / f'web-{LABEL}-{name}.png'), full_page=True)
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            if LABEL == 'after':
                assert await page.locator('.queue-withdraw').count() == 3
                assert all(h >= 44 for h in await page.locator('.queue-actions button').evaluate_all('(bs)=>bs.map(b=>b.getBoundingClientRect().height)'))
        if LABEL == 'after':
            await page.set_viewport_size({'width': 1440, 'height': 1050})
            # Real DELETE, live row removal, neighbor focus, last-row composer focus.
            await page.locator('.queue-withdraw').first.click()
            await expect(page.locator('.queue-row')).to_have_count(2)
            await expect(page.locator('.queue-withdraw').first).to_be_focused()
            await expect(page.locator('.queue-notice')).to_have_text('Message withdrawn.')
            await page.locator('.queue-withdraw').first.click()
            await expect(page.locator('.queue-row')).to_have_count(1)
            await page.locator('.queue-withdraw').first.click()
            await expect(page.locator('.queue-row')).to_have_count(0)
            await expect(textarea).to_be_focused()
            await expect(textarea).to_have_value('Keep this draft while messages arrive.')
            # A lost reply does not resurrect the ID when the same DELETE is retried.
            origin, token = link.split('/#token=')
            headers = {'authorization': 'Bearer ' + token}
            assert (await context.request.delete(origin + '/api/agents/worker/messages/proof-a', headers=headers)).status == 204
        assert not errors, errors
        await browser.close()

try:
    for line in host.stdout:
        match = re.search(r'console: (\S+)', line)
        if match:
            link = match[1]
            break
    else:
        raise RuntimeError('host did not print a link')
    origin, token = link.split('/#token=')
    def api(action, body):
        req = urllib.request.Request(origin + '/api/agents/shop/' + action, data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        urllib.request.urlopen(req).close()
    time.sleep(2)
    api('paused', {'value': True})
    def seed():
        for rid, text, steer in [('proof-a', 'Check the photo deadline before bidding.', False), ('proof-b', 'Keep new commitments under $15.', False), ('proof-c', 'Prioritize the existing photo edit.', True)]:
            api('messages', {'requestId': rid, 'text': text, **({'steer': True} if steer else {})})
    seed()
    # Capture terminal before the browser exercises withdrawal of the same messages.
    for name, cols, rows in [('normal', 130, 48), ('narrow', 90, 48)]:
        command = f'cd {shlex.quote(str(ROOT / "src/tui"))} && TASKFAST_CONSOLE_URL={shlex.quote(link)} bun main.tsx'
        tmux('new-session', '-d', '-s', session, '-x', str(cols), '-y', str(rows), command)
        tmux('set-option', '-t', session, 'status', 'off')
        title = f'withdraw-{LABEL}-{name}'
        terminal = subprocess.Popen(['zutty', '-quiet', '-title', title, '-geometry', f'{cols}x{rows}', '-font', 'DejaVuSansMono', '-fontsize', '14', '-e', 'tmux', 'attach-session', '-t', session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        until(lambda: 'paused' in tmux('capture-pane', '-p', '-t', session))
        tmux('send-keys', '-t', session, 'Tab', 'Tab')
        until(lambda: '▶ Follow-up' in tmux('capture-pane', '-p', '-t', session))
        time.sleep(.3)
        windows = subprocess.check_output(['xwininfo', '-root', '-tree'], text=True)
        window = re.search(r'(0x[0-9a-f]+) "' + re.escape(title) + '"', windows).group(1)
        subprocess.run(['import', '-window', window, str(OUT / f'tui-{LABEL}-{name}.png')], check=True)
        (OUT / f'tui-{LABEL}-{name}.txt').write_text(tmux('capture-pane', '-p', '-t', session))
        terminal.terminate()
        terminal.wait(timeout=5)
        terminal = None
        tmux('kill-session', '-t', session)
    # Use the worker's clean timeline for web captures, not the shop fixture's
    # unrelated long uncertain-action ID, which overflows the baseline on phones.
    def web_api(action, body):
        req = urllib.request.Request(origin + '/api/agents/worker/' + action, data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        urllib.request.urlopen(req).close()
    web_api('paused', {'value': True})
    for rid, text, steer in [('proof-a', 'Check the photo deadline before bidding.', False), ('proof-b', 'Keep new commitments under $15.', False), ('proof-c', 'Prioritize the existing photo edit.', True)]:
        web_api('messages', {'requestId': rid, 'text': text, **({'steer': True} if steer else {})})
    asyncio.run(browser_capture(link))
    print(f'{LABEL}: 3 browser and 2 terminal captures; browser layout/focus checks passed.')
finally:
    if terminal:
        terminal.terminate()
    subprocess.run(['tmux', 'kill-session', '-t', session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    host.terminate()
    host.wait(timeout=15)

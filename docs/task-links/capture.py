#!/usr/bin/env python3
"""Capture real browser and terminal pixels of task links on staging. No marketplace or provider access.
Usage: python3 docs/task-links/capture.py before|after /absolute/source-worktree
Requires built sources, installed TUI pins, Playwright, Chromium, X11, Zutty and tmux.
The source worktree's test/fixtures/tui-host.mjs must read TUI_HOST_ENV (this PR's fixture).
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
from pathlib import Path
from playwright.async_api import async_playwright, expect

OUT = Path(__file__).resolve().parent
LABEL, ROOT = sys.argv[1], Path(sys.argv[2]).resolve()
assert LABEL in ('before', 'after')
SOURCES = ['src/console-page.ts', 'src/console.ts', 'src/tui/app.tsx', 'src/tui/keys.ts', 'src/tui/screen.ts']
subprocess.run(['git', 'diff', 'HEAD', '--exit-code', '--quiet', '--', *SOURCES], cwd=ROOT, check=True)
FIXTURE = 'test/fixtures/tui-host.mjs'
(OUT / f'{LABEL}-source.json').write_text(json.dumps({
    'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'sha256': {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in [*SOURCES, FIXTURE]},
    'captureScriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'capture': 'Chromium browser screenshot and ImageMagick import of real Zutty/OpenTUI window pixels. Synthetic local host on the staging environment only.',
}, indent=2) + '\n')
host = subprocess.Popen(['node', FIXTURE], cwd=ROOT, env={**os.environ, 'TUI_HOST_ENV': 'staging'}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
terminal = None
session = f'task-links-proof-{os.getpid()}'
STAGING = 'https://staging.taskfast.app/tasks/'

def tmux(*args):
    return subprocess.check_output(['tmux', *args], text=True)

def until(check):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError('capture condition timed out')

async def browser_capture(origin, token):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path='/snap/bin/chromium', headless=True, args=['--no-sandbox'])
        context = await browser.new_context(viewport={'width': 1440, 'height': 1050}, color_scheme='light', device_scale_factor=1)
        await context.add_init_script("localStorage.setItem('tf-theme','light')")
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(origin + '/agents/shop#token=' + token)
        await expect(page.locator('.head-msg', has_text='bid.created')).to_have_count(1)
        await expect(page.locator('.task').first).to_be_visible()
        hrefs = await page.locator('a.task').evaluate_all('(as)=>as.map(a=>a.getAttribute("href"))')
        if LABEL == 'after':
            assert hrefs and all(h.startswith(STAGING) for h in hrefs), hrefs
        else:
            assert not hrefs, hrefs
        await page.screenshot(path=str(OUT / f'web-{LABEL}.png'), full_page=True)
        assert not errors, errors
        await browser.close()
        return len(hrefs)

try:
    for line in host.stdout:
        match = re.search(r'console: (\S+)', line)
        if match:
            link = match[1]
            break
    else:
        raise RuntimeError('host did not print a link')
    origin, token = link.split('/#token=')
    cols, rows = 130, 60
    command = f'cd {shlex.quote(str(ROOT / "src/tui"))} && TASKFAST_CONSOLE_URL={shlex.quote(link)} bun main.tsx'
    tmux('new-session', '-d', '-s', session, '-x', str(cols), '-y', str(rows), command)
    tmux('set-option', '-t', session, 'status', 'off')
    title = f'task-links-{LABEL}'
    terminal = subprocess.Popen(['zutty', '-quiet', '-title', title, '-geometry', f'{cols}x{rows}', '-font', 'DejaVuSansMono', '-fontsize', '14', '-e', 'tmux', 'attach-session', '-t', session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    until(lambda: 'bid.created' in tmux('capture-pane', '-p', '-t', session) and 'A new bid arrived' in tmux('capture-pane', '-p', '-t', session))
    time.sleep(.5)
    pane = tmux('capture-pane', '-p', '-t', session)
    assert ('staging.taskfast.app/tasks/' in pane) == (LABEL == 'after'), pane
    windows = subprocess.check_output(['xwininfo', '-root', '-tree'], text=True)
    window = re.search(r'(0x[0-9a-f]+) "' + re.escape(title) + '"', windows).group(1)
    subprocess.run(['import', '-window', window, str(OUT / f'tui-{LABEL}.png')], check=True)
    (OUT / f'tui-{LABEL}.txt').write_text(pane)
    terminal.terminate()
    terminal.wait(timeout=5)
    terminal = None
    tmux('kill-session', '-t', session)
    links = asyncio.run(browser_capture(origin, token))
    print(f'{LABEL}: 1 browser and 1 terminal capture; {links} staging task links in the console.')
finally:
    if terminal:
        terminal.terminate()
    subprocess.run(['tmux', 'kill-session', '-t', session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    host.terminate()
    host.wait(timeout=15)

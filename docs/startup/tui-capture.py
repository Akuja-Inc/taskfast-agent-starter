import hashlib,json,os,re,shlex,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/startup'
def until(check):
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        result=check()
        if result:return result
        time.sleep(.1)
    raise RuntimeError('capture timed out')
for name,cols,rows in [('normal',130,28),('narrow',90,28)]:
    host=subprocess.Popen(['node','docs/startup/browser-host.mjs'],cwd=ROOT,stdout=subprocess.PIPE,text=True)
    link=host.stdout.readline().strip()
    session=f'gh73-tui-{os.getpid()}'
    terminal=None
    def tmux(*args):return subprocess.check_output(['tmux',*args],text=True)
    try:
        command=f'cd {shlex.quote(str(ROOT/"src/tui"))} && TASKFAST_CONSOLE_URL={shlex.quote(link)} bun main.tsx'
        tmux('new-session','-d','-s',session,'-x',str(cols),'-y',str(rows),command)
        tmux('set-option','-t',session,'status','off')
        title=f'gh73-{name}'
        terminal=subprocess.Popen(['zutty','-quiet','-title',title,'-geometry',f'{cols}x{rows}','-font','DejaVuSansMono','-fontsize','14','-e','tmux','attach-session','-t',session],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for state,target,keys in [('starting','x cancel startup',[]),('failed','MCP reference server',['>']),('waiting','previous attempt to close',['R'])]:
            for key in keys:tmux('send-keys','-t',session,key)
            until(lambda: target in tmux('capture-pane','-p','-t',session))
            time.sleep(.3)
            windows=subprocess.check_output(['xwininfo','-root','-tree'],text=True)
            window=re.search(r'(0x[0-9a-f]+) "'+re.escape(title)+'"',windows).group(1)
            subprocess.run(['import','-window',window,str(OUT/f'tui-{state}-{name}.png')],check=True)
            frame=tmux('capture-pane','-p','-t',session)
            assert link not in frame
            (OUT/f'tui-{state}-{name}.txt').write_text(frame)
    finally:
        if terminal:terminal.terminate();terminal.wait(timeout=5)
        subprocess.run(['tmux','kill-session','-t',session],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        host.terminate();host.wait(timeout=10)
sources=['src/tui/app.tsx','src/tui/keys.ts','src/tui/link.ts','src/tui/screen.ts','docs/startup/browser-host.mjs','docs/startup/tui-capture.py']
(OUT/'tui-source.json').write_text(json.dumps({'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'dirty':subprocess.run(['git','diff','--quiet','HEAD','--',*sources],cwd=ROOT).returncode != 0,'sha256':{p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in sources},'capture':'Unmodified X11 window pixels: Zutty, tmux, Bun/OpenTUI, ImageMagick import. Synthetic loopback fixture; normal 130x28, narrow 90x28.'},indent=2)+'\n')
print('Captured six startup TUI screenshots.')

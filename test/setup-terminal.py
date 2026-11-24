import os
import pathlib
import pty
import select
import subprocess
import sys
import termios
import time

node, setup, root, scenario = sys.argv[1:]
child = pathlib.Path(root) / "taskfast"
child.write_text(
    "#!/usr/bin/env python3\n"
    "import sys, termios\n"
    "state = termios.tcgetattr(0)\n"
    "print('CHILD_CANONICAL=' + str(bool(state[3] & termios.ICANON)), flush=True)\n"
    "print('CHILD_ECHO=' + str(bool(state[3] & termios.ECHO)), flush=True)\n"
    "import os\n"
    "print('CHILD_SHELL_PASSWORD=' + str('TASKFAST_WALLET_PASSWORD' in os.environ), flush=True)\n"
    "print('Child input: ', end='', flush=True)\n"
    "assert sys.stdin.readline().strip() == 'hello'\n"
)
if scenario == "keyless":
    child.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "if sys.argv[1:] == ['--version']:\n"
        "    print('taskfast 0.26.0')\n"
        "    sys.exit(0)\n"
        "link = 'https://staging.taskfast.app/new/claim?claim_token=LINKTOKEN123'\n"
        "sys.stderr.write('Created agent without an account.\\n  Claim link (share it with your owner): ' + link + '\\n')\n"
        "os.makedirs('.taskfast', exist_ok=True)\n"
        "open('.taskfast/config.json', 'w').write(json.dumps({'environment': 'staging', 'api_key': 'KEYVALUE', 'claim_url': link}))\n"
        "print(json.dumps({'ok': True, 'data': {'agent': {'action': 'minted_unclaimed', 'claim_url': link}}}))\n"
    )
    child.chmod(0o755)
child.chmod(0o755)
master, slave = pty.openpty()
initial = termios.tcgetattr(slave)
args = [node, setup, "--env", "staging", "--provider", "anthropic", "--model", "claude-sonnet-4-6",
        "--agent", "check", "--role", "worker", "--name", "Demo", "--business", "Demo",
        "--description", "Demo", "--goals", "Demo"]
if scenario != "secret":
    args += ["--set", "ANTHROPIC_API_KEY=dummy"]
env = {"HOME": os.environ["HOME"], "PATH": root + os.pathsep + os.environ["PATH"], "TERM": "xterm-256color", "TASKFAST_WALLET_PASSWORD": "shell-only"}
if scenario != "keyless":
    env["TASKFAST_HUMAN_API_KEY"] = "dummy-pat"
if scenario == "keyless":
    args += ["--init"]
proc = subprocess.Popen(args, cwd=root, stdin=slave, stdout=slave, stderr=slave, env=env)
transcript = b""


def until(marker, since=0):
    global transcript
    deadline = time.monotonic() + 5
    while marker not in transcript[since:]:
        assert time.monotonic() < deadline, "terminal stopped responding"
        if select.select([master], [], [], 0.05)[0]:
            try:
                transcript += os.read(master, 65536)
            except OSError:
                raise AssertionError("setup exited before the expected prompt")


try:
    if scenario == "keyless":
        assert proc.wait(timeout=10) == 0, "keyless setup did not finish"
        while select.select([master], [], [], 0.2)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            transcript += chunk
        assert transcript.count(b"LINKTOKEN123") == 1, "the claim link must appear exactly once"
        assert b"KEYVALUE" not in transcript, "the agent key appeared on screen"
        assert b"working TaskFast key" in transcript, "setup did not report the unclaimed agent"
        password = (pathlib.Path(root) / "agents" / "check" / ".taskfast" / "wallet-password").read_text()
        assert len(password) >= 12 and password.encode() not in transcript, "generated wallet password appeared on screen"
        final = termios.tcgetattr(slave)
        flags = termios.ICANON | termios.ECHO
        assert (final[3] & flags) == (initial[3] & flags), "terminal mode was not restored"
        sys.exit(0)
    if scenario == "secret":
        until(b"Paste your ANTHROPIC_API_KEY")
        # Feedback must appear before Enter, and backspace must edit the value.
        os.write(master, b"dummy-secret-x")
        until(b"**************")
        assert b"dummy-secret" not in transcript, "secret appeared on screen"
        os.write(master, b"\x7f\r")
    until(b"[Y/n]:")
    if scenario == "secret":
        assert (pathlib.Path(root) / "agents" / "check" / ".env").read_text() == "ANTHROPIC_API_KEY=dummy-secret-\n"
    if scenario == "cancel":
        os.write(master, b"\x03")
        assert proc.wait(timeout=5) == 130, "Ctrl-C must cancel setup"
    else:
        os.write(master, b"\r")
        until(b"Wallet password")
        if scenario == "secret":
            # Anchor at the prompt: the API key entry above already left asterisks on screen.
            prompt = transcript.rindex(b"Wallet password")
            os.write(master, b"s3cret-unlock")
            until(b"***********", prompt)
            assert b"s3cret-unlock" not in transcript, "wallet password appeared on screen"
            os.write(master, b"\r")
            until(b"Confirm the wallet password")
            confirm = transcript.index(b"Confirm the wallet password")
            os.write(master, b"s3cret-unlock")
            until(b"***********", confirm)
            assert b"s3cret-unlock" not in transcript, "wallet password appeared on screen"
        os.write(master, b"\r")
        until(b"Child input:")
        if scenario == "secret":
            assert (pathlib.Path(root) / "agents" / "check" / ".taskfast" / "wallet-password").read_text() == "s3cret-unlock"
        assert b"CHILD_CANONICAL=True" in transcript, "child inherited raw mode"
        assert b"CHILD_ECHO=True" in transcript, "child inherited disabled echo"
        assert b"CHILD_SHELL_PASSWORD=False" in transcript, "taskfast init saw TASKFAST_WALLET_PASSWORD"
        assert b"shell-only" not in transcript, "shell password appeared on screen"
        os.write(master, b"hello\n")
        assert proc.wait(timeout=5) == 0, "child input did not complete"
    final = termios.tcgetattr(slave)
    flags = termios.ICANON | termios.ECHO
    assert (final[3] & flags) == (initial[3] & flags), "terminal mode was not restored"
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    os.close(master)
    os.close(slave)

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
    "print('Child input: ', end='', flush=True)\n"
    "assert sys.stdin.readline().strip() == 'hello'\n"
)
child.chmod(0o755)
master, slave = pty.openpty()
initial = termios.tcgetattr(slave)
args = [node, setup, "--env", "staging", "--provider", "anthropic", "--model", "claude-sonnet-4-6",
        "--agent", "check", "--role", "worker", "--name", "Demo", "--business", "Demo",
        "--description", "Demo", "--goals", "Demo"]
if scenario != "secret":
    args += ["--set", "ANTHROPIC_API_KEY=dummy"]
env = {"HOME": os.environ["HOME"], "PATH": root + os.pathsep + os.environ["PATH"], "TERM": "xterm-256color"}
proc = subprocess.Popen(args, cwd=root, stdin=slave, stdout=slave, stderr=slave, env=env)
transcript = b""


def until(marker):
    global transcript
    deadline = time.monotonic() + 5
    while marker not in transcript:
        assert time.monotonic() < deadline, "terminal stopped responding"
        if select.select([master], [], [], 0.05)[0]:
            try:
                transcript += os.read(master, 65536)
            except OSError:
                raise AssertionError("setup exited before the expected prompt")


try:
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
        until(b"Child input:")
        assert b"CHILD_CANONICAL=True" in transcript, "child inherited raw mode"
        assert b"CHILD_ECHO=True" in transcript, "child inherited disabled echo"
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

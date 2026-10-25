"""Real finite subprocesses exercising pipe backpressure; no models or network."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import vibz_agent as bridge


class InputSupervisionTests(unittest.TestCase):
    def run_child(self, code, *, timeout=0.15, lose_lease=False, succeeds=False, descendant=False):
        task = dict(id='synthetic', title='Input test', brief='\0' * 12000,
                    acceptance='雪' * 4000, reviewNote='\0' * 4000,
                    result='\0' * 20000,
                    evidence=[dict(label='\0' * 1000, url='\0' * 2048)] * 12)
        actual = subprocess.Popen
        children = []
        started = time.monotonic()

        class Client:
            def post(self, payload):
                return {}

        class Lease:
            client = Client()
            def renew(self, *args):
                pass
            def assert_live(self):
                if lose_lease and time.monotonic() - started > 0.12:
                    raise bridge.LeaseLost('synthetic revoked lease')

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = argparse.Namespace(runner='codex', codex_bin='never-run', workspace=root,
                                      sandbox='read-only', job_timeout=timeout)
            def launch(command, **kwargs):
                child = actual([sys.executable, '-c', code], **kwargs)
                fcntl.fcntl(child.stdin.fileno(), fcntl.F_SETPIPE_SZ, 4096)
                children.append(child)
                return child
            try:
                with mock.patch.object(bridge.subprocess, 'Popen', side_effect=launch):
                    if succeeds:
                        bridge.execute(args, task, Lease(), root)
                        received = (root / 'input.bin').read_bytes()
                        data = json.loads(received[received.index(b'{'):])
                        self.assertEqual(data, bridge.task_prompt_data(task))
                        self.assertEqual(received.decode().encode(), received)
                    else:
                        with self.assertRaises(bridge.LeaseLost if lose_lease else bridge.BridgeError):
                            bridge.execute(args, task, Lease(), root)
                if not succeeds:
                    self.assertLess(time.monotonic() - started, 1.2)
                self.assertTrue(children[0].stdin.closed)
                self.assertIsNotNone(children[0].poll())
                if descendant:
                    pid = int((root / 'descendant.pid').read_text())
                    # A killed orphan can remain a zombie until the host reaps it.
                    for _ in range(50):
                        status = Path(f'/proc/{pid}/stat')
                        if not status.exists() or status.read_text().split(') ')[1].startswith('Z'):
                            break
                        time.sleep(.01)
                    else:
                        self.fail('descendant remains runnable after leader exit')
                else:
                    with self.assertRaises(ProcessLookupError):
                        os.killpg(children[0].pid, 0)
            finally:
                for child in children:
                    try:
                        os.killpg(child.pid, 9)
                    except ProcessLookupError:
                        pass
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=5)
                    if not child.stdin.closed:
                        child.stdin.close()

    def test_nonreader_timeout_is_enforced_while_input_pending(self):
        self.run_child('import time; time.sleep(2)')

    def test_lease_loss_stops_child_while_input_pending(self):
        self.run_child('import time; time.sleep(2)', timeout=5, lose_lease=True)

    def test_slow_reader_gets_complete_unicode_and_escaped_context(self):
        self.run_child('''import sys,time
from pathlib import Path
chunks=[]
while True:
 chunk=sys.stdin.buffer.read(2048)
 if not chunk: break
 chunks.append(chunk)
 time.sleep(.001)
Path('input.bin').write_bytes(b''.join(chunks))
Path('result.txt').write_text('synthetic result')
''', timeout=8, succeeds=True)

    def test_zero_exit_with_partial_input_is_not_a_result(self):
        self.run_child("from pathlib import Path; Path('result.txt').write_text('premature')")

    def test_closed_pipe_is_failure_and_child_is_reaped(self):
        self.run_child('import os,time; os.close(0); time.sleep(2)')

    def test_exited_group_leader_does_not_leave_running_descendant(self):
        child = ("import os,signal,time; from pathlib import Path; "
                 "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                 "Path('descendant.pid').write_text(str(os.getpid())); time.sleep(2)")
        self.run_child("import subprocess,sys,time; from pathlib import Path\n"
            f"subprocess.Popen([sys.executable,'-c',{child!r}])\n"
            "while not Path('descendant.pid').exists(): time.sleep(.001)\n", descendant=True)


if __name__ == '__main__':
    unittest.main()

"""Offline contract tests. No service calls, real agents, or model executions."""
import argparse
from datetime import datetime, timezone
from email.message import Message
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error

import vibz_agent as bridge


def response(value):
    return io.BytesIO(json.dumps(value).encode())


class Opener:
    def __init__(self, replies):
        self.replies, self.requests = list(replies), []

    def open(self, request, timeout):
        self.requests.append(request)
        value = self.replies.pop(0)
        if isinstance(value, Exception):
            raise value
        return response(value)


class Client:
    def __init__(self, replies=None):
        self.requests = []
        self.replies = list(replies or [])

    def post(self, payload):
        self.requests.append(dict(payload))
        if self.replies:
            value = self.replies.pop(0)
            if isinstance(value, Exception):
                raise value
            return value
        return {"ok": True, "leaseExpiresAt": "2099-01-01T00:00:00Z"}


class AdapterTests(unittest.TestCase):
    def test_private_gateway_and_agent_headers_are_separate(self):
        opener = Opener([{"ok": True}])
        client = bridge.HubClient("https://studio.example", "agent-secret", "platform-secret", opener=opener)
        client.post({"action": "heartbeat", "status": "idle"})
        request = opener.requests[0]
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["authorization"], "Bearer agent-secret")
        self.assertEqual(headers["oai-sites-authorization"], "Bearer platform-secret")
        self.assertEqual(request.full_url, "https://studio.example/api/agent")
        self.assertNotIn(b"secret", request.data)
        self.assertIsNone(bridge.NoRedirect().redirect_request(request, None, 302, "", {}, "https://elsewhere.example"))

    def test_redirect_and_auth_failures_are_not_retried(self):
        for status in (302, 401, 403, 409):
            error = urllib.error.HTTPError("https://studio.example", status, "", Message(), io.BytesIO(b'{}'))
            opener = Opener([error])
            client = bridge.HubClient("https://studio.example", "agent", "platform", opener=opener, sleep=mock.Mock())
            with self.assertRaises(bridge.HubError):
                client.post({"action": "claim", "requestId": "same-id"})
            self.assertEqual(len(opener.requests), 1)

    def test_idempotent_retry_preserves_identical_body_and_request_id(self):
        error = urllib.error.HTTPError("https://studio.example", 429, "", Message(), io.BytesIO(b'{"code":"rate_limited"}'))
        opener = Opener([error, {"task": None}])
        sleep = mock.Mock()
        client = bridge.HubClient("https://studio.example", "agent", "platform", opener=opener, sleep=sleep)
        payload = {"action": "claim", "requestId": "fixed-operation-id"}
        self.assertEqual(client.post(payload), {"task": None})
        self.assertEqual(opener.requests[0].data, opener.requests[1].data)
        self.assertEqual(json.loads(opener.requests[1].data)["requestId"], "fixed-operation-id")
        sleep.assert_called_once()

    def test_http_200_without_protocol_confirmation_is_not_success(self):
        opener = Opener([{"error": "not_authorized"}])
        client = bridge.HubClient("https://studio.example", "agent", "platform", opener=opener)
        with self.assertRaises(bridge.BridgeError):
            client.post({"action": "heartbeat", "status": "idle"})

    def test_mentions_cli_is_a_read_with_default_and_bounded_limit(self):
        for options, limit in (([], 20), (["--limit", "1"], 1), (["--limit", "20"], 20)):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory:
                opener = Opener([{"mentions": []}])
                client = bridge.HubClient("https://studio.example", "agent", "platform", opener=opener)
                stdout = io.StringIO()
                with mock.patch.object(bridge.HubClient, "from_env", return_value=client), \
                        mock.patch.object(bridge.sys, "stdout", stdout):
                    result = bridge.main(["--state-dir", directory, "mentions", *options])
                self.assertEqual(result, 0)
                self.assertEqual(json.loads(opener.requests[0].data), {"action": "mentions", "limit": limit})
                self.assertEqual(json.loads(stdout.getvalue())["mentions"], [])
                self.assertEqual(list((Path(directory) / "requests").iterdir()), [])
        for value in ("0", "21"):
            with self.subTest(limit=value), mock.patch.object(bridge.sys, "stderr", io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    bridge.parser().parse_args(["mentions", "--limit", value])
                self.assertEqual(error.exception.code, 2)

    def test_reply_to_mention_cli_preserves_retry_and_settled_request(self):
        with tempfile.TemporaryDirectory() as directory:
            body_file = Path(directory) / "reply.txt"
            body_file.write_text("Here is the requested answer.", encoding="utf-8")
            receipt = {"message": {"id": "reply-1", "parentId": "root-1"},
                       "mention": {"id": "mention-1", "status": "replied", "replyMessageId": "reply-1"}}
            error = urllib.error.HTTPError("https://studio.example", 429, "", Message(), io.BytesIO(b'{}'))
            opener = Opener([error, receipt])
            client = bridge.HubClient("https://studio.example", "agent", "platform", opener=opener, sleep=mock.Mock())
            argv = ["--state-dir", str(Path(directory) / "journal"), "reply-to-mention", "mention-1",
                    "--body-file", str(body_file), "--request-id", "stable-reply"]
            with mock.patch.object(bridge.HubClient, "from_env", return_value=client), \
                    mock.patch.object(bridge.sys, "stdout", io.StringIO()) as stdout, \
                    mock.patch.object(bridge.sys, "stderr", io.StringIO()) as stderr:
                self.assertEqual(bridge.main(argv), 0)
                self.assertEqual(bridge.main(argv), 0)
                self.assertEqual(len(opener.requests), 2)
                self.assertEqual(opener.requests[0].data, opener.requests[1].data)
                self.assertEqual(json.loads(opener.requests[0].data), {
                    "action": "reply_mention", "mentionId": "mention-1",
                    "body": "Here is the requested answer.", "requestId": "stable-reply"})
                replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
                self.assertEqual(replies[0], replies[1])
                self.assertEqual(replies[0]["mention"]["status"], "replied")
                body_file.write_text("A different answer.", encoding="utf-8")
                self.assertEqual(bridge.main(argv), 1)
                self.assertIn("changed payload", stderr.getvalue())
                self.assertEqual(len(opener.requests), 2)

    def test_mention_responses_must_confirm_read_or_matching_reply(self):
        cases = (({"action": "mentions", "limit": 20}, {"mentions": "unexpected"}),
                 ({"action": "reply_mention", "mentionId": "one", "body": "Answer", "requestId": "reply"},
                  {"message": {"id": "answer"}, "mention": {"id": "two", "status": "replied"}}))
        for payload, invalid in cases:
            with self.subTest(action=payload["action"]):
                client = bridge.HubClient("https://studio.example", "agent", "platform", opener=Opener([invalid]))
                with self.assertRaises(bridge.BridgeError):
                    client.post(payload)

    def test_journal_retries_pending_payload_and_rejects_changed_request_id(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = bridge.Journal(Path(directory))
            payload = {"action": "message", "channelId": "room", "body": "Hello", "requestId": "stable"}
            client = Client([bridge.BridgeError("Connection lost"), {"message": {"id": "message-1"}}])
            with self.assertRaises(bridge.BridgeError):
                journal.send(client, payload)
            restored = bridge.Journal(Path(directory))
            self.assertEqual(restored.status()["pendingRequests"][0]["requestId"], "stable")
            restored.send(client, restored.read_request("stable")["payload"])
            self.assertEqual(client.requests[0], client.requests[1])
            with self.assertRaises(bridge.BridgeError):
                restored.send(client, {**payload, "body": "Changed"})
            self.assertEqual(len(client.requests), 2)
            if os.name == "posix":
                self.assertEqual(restored.request_path("stable").stat().st_mode & 0o077, 0)

    def test_credentials_are_redacted_from_journal_and_payload(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {
                "VIBZ_AGENT_TOKEN": "do-not-persist-this", "VIBZ_SITE_ACCESS_TOKEN": "platform-private"}):
            journal = bridge.Journal(Path(directory))
            client = Client([{"ok": True}])
            journal.send(client, {"action": "message", "requestId": "one", "channelId": "room",
                                  "body": "do-not-persist-this platform-private"})
            self.assertNotIn("do-not-persist-this", journal.request_path("one").read_text())
            self.assertNotIn("platform-private", json.dumps(client.requests))

    def test_heartbeat_does_not_renew_lease_but_progress_does(self):
        now = [100.0]
        claim = {"task": {"id": "task-1", "state": "running"}, "leaseId": "lease-1",
                 "leaseExpiresAt": datetime.fromtimestamp(200, timezone.utc).isoformat()}
        client = Client()
        lease = bridge.Lease(client, claim, clock=lambda: now[0])
        client.post({"action": "heartbeat", "status": "working"})
        self.assertEqual(lease.expires, 200)
        lease.renew("Actual process still running")
        self.assertGreater(lease.expires, 200)
        self.assertEqual(client.requests[-1]["action"], "progress")
        self.assertEqual(client.requests[-1]["leaseId"], "lease-1")

    def test_expired_or_completed_claim_cannot_start_work(self):
        for task_state, expiry in (("review", 300), ("running", 100)):
            claim = {"task": {"id": "task-1", "state": task_state}, "leaseId": "lease-1",
                     "leaseExpiresAt": datetime.fromtimestamp(expiry, timezone.utc).isoformat()}
            with self.assertRaises(bridge.LeaseLost):
                bridge.Lease(Client(), claim, clock=lambda: 200)

    def test_lease_rejection_is_distinct_from_runner_success(self):
        client = Client([bridge.HubError(409, "lease_lost")])
        lease = bridge.Lease(client, {"task": {"id": "t", "state": "running"},
                                     "leaseId": "l", "leaseExpiresAt": "2099-01-01T00:00:00Z"})
        with self.assertRaises(bridge.LeaseLost):
            lease.renew("renew")

    def test_codex_execution_is_argv_only_and_strips_hub_credentials(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {
                "VIBZ_AGENT_TOKEN": "agent-private", "VIBZ_SITE_ACCESS_TOKEN": "gateway-private"}):
            root = Path(directory)
            args = argparse.Namespace(runner="codex", codex_bin="codex", workspace=root,
                                      sandbox="read-only", job_timeout=60)
            client = Client()
            lease = bridge.Lease(client, {"task": {"id": "t", "state": "running"},
                                         "leaseId": "l", "leaseExpiresAt": "2099-01-01T00:00:00Z"})
            process = mock.Mock()
            process.poll.return_value = 0
            process.returncode = 0
            process.stdin = mock.Mock()

            def launch(command, **kwargs):
                Path(command[command.index("--output-last-message") + 1]).write_text("Actual test runner result")
                self.assertIsInstance(command, list)
                self.assertFalse(kwargs["shell"])
                self.assertNotIn("VIBZ_AGENT_TOKEN", kwargs["env"])
                self.assertNotIn("VIBZ_SITE_ACCESS_TOKEN", kwargs["env"])
                self.assertEqual(command[command.index("--sandbox") + 1], "read-only")
                return process

            with mock.patch.object(bridge.os, "killpg"), mock.patch.object(bridge.os, "set_blocking"), mock.patch.object(bridge.os, "write", side_effect=lambda fd, data: len(data)), mock.patch.object(bridge.subprocess, "Popen", side_effect=launch):
                summary, evidence = bridge.execute(args, {"id": "t", "title": "$(touch unwanted); shell text"}, lease, root)
            self.assertIn("Actual test runner result", summary)
            self.assertIn("SHA-256", evidence["label"])
            self.assertFalse((root / "unwanted").exists())
            self.assertNotIn("deliver", [x["action"] for x in client.requests])

    def test_runner_renews_progress_and_heartbeats_while_running(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = argparse.Namespace(runner="codex", codex_bin="codex", workspace=root,
                                      sandbox="read-only", job_timeout=60)
            client = Client()
            lease = bridge.Lease(client, {"task": {"id": "t", "state": "running"},
                                         "leaseId": "l", "leaseExpiresAt": "2099-01-01T00:00:00Z"})
            process = mock.Mock()
            process.poll.side_effect = [None, 0, 0]
            process.returncode = 0
            (root / "result.txt").write_text("Result")
            with mock.patch.object(bridge.os, "killpg"), mock.patch.object(bridge.os, "set_blocking"), mock.patch.object(bridge.os, "write", side_effect=lambda fd, data: len(data)), mock.patch.object(bridge.subprocess, "Popen", return_value=process), \
                    mock.patch.object(bridge.time, "monotonic", side_effect=[0, 0, 31, 31, 31, 31]), \
                    mock.patch.object(bridge.time, "sleep"):
                bridge.execute(args, {"id": "t"}, lease, root)
            actions = [p["action"] for p in client.requests]
            self.assertEqual(actions.count("progress"), 3)
            self.assertEqual(actions.count("heartbeat"), 2)

    def test_running_child_is_stopped_when_lease_is_lost(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = argparse.Namespace(runner="codex", codex_bin="codex", workspace=root,
                                      sandbox="read-only", job_timeout=60)
            client = Client([{"leaseExpiresAt": "2099-01-01T00:00:00Z"}, {"ok": True}, bridge.HubError(409, "lease_lost")])
            lease = bridge.Lease(client, {"task": {"id": "t", "state": "running"},
                                         "leaseId": "l", "leaseExpiresAt": "2099-01-01T00:00:00Z"})
            process = mock.Mock()
            process.poll.return_value = None
            with mock.patch.object(bridge.os, "killpg"), mock.patch.object(bridge.os, "set_blocking"), mock.patch.object(bridge.os, "write", side_effect=lambda fd, data: len(data)), mock.patch.object(bridge.subprocess, "Popen", return_value=process), \
                    mock.patch.object(bridge.time, "monotonic", side_effect=[0, 0, 31, 31]), \
                    mock.patch.object(bridge, "stop_process") as stop:
                with self.assertRaises(bridge.LeaseLost):
                    bridge.execute(args, {"id": "t"}, lease, root)
            stop.assert_called_once_with(process)
            self.assertNotIn("deliver", [p["action"] for p in client.requests])

    def test_ollama_receives_no_hub_headers_and_only_returns_text(self):
        with tempfile.TemporaryDirectory() as directory:
            opener = Opener([{"response": "Draft only"}])
            args = argparse.Namespace(url="http://127.0.0.1:11434", model="chosen-local-model",
                                      timeout=30, output=str(Path(directory) / "result.txt"))
            with mock.patch.object(bridge.urllib.request, "build_opener", return_value=opener), \
                    mock.patch.object(bridge.sys, "stdin", io.StringIO("Task prompt")):
                bridge.ollama_worker(args)
            self.assertEqual({key.lower() for key, _ in opener.requests[0].header_items()}, {"content-type"})
            self.assertEqual(Path(args.output).read_text(), "Draft only")
            with self.assertRaises(bridge.BridgeError):
                bridge.safe_url("https://remote.example", local_only=True)


if __name__ == "__main__":
    unittest.main()

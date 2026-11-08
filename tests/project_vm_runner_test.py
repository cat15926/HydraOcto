"""Portable unit checks for the guest's protocol. Real namespace checks use verify-project-vm-live.ts."""
import asyncio
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch


spec = importlib.util.spec_from_file_location("guest", Path(__file__).resolve().parents[1] / "scripts/runtime/project-vm-runner.py")
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class GuestInput(unittest.TestCase):
    def test_only_gateway_origin_and_synthetic_credentials_enter_environment(self):
        origin = "http://127.0.0.1:31415"
        with patch.object(guest, "trusted_binary", return_value=Path("/opt/multi-agent/bin/claude")):
            start = {"type": "start", "carrier": "claude", "args": [guest.GATEWAY + "/mcp"],
                     "env": {"ANTHROPIC_AUTH_TOKEN": "project-gateway", "ANTHROPIC_BASE_URL": guest.GATEWAY + "/model"}}
            _, args, env = guest.launch_parameters(start, origin)
            self.assertEqual(args, [origin + "/mcp"])
            self.assertEqual(env["ANTHROPIC_BASE_URL"], origin + "/model")
            for key, value in (("OPENAI_API_KEY", "unexpected"), ("LD_PRELOAD", "/tmp/lib.so"),
                               ("ANTHROPIC_BASE_URL", "https://foreign.invalid")):
                with self.subTest(key=key), self.assertRaises(ValueError):
                    guest.launch_parameters({**start, "env": {key: value}}, origin)

    def test_fuse_caller_and_rss_expose_only_top_cli_counter(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            expected = root / "cli"
            expected.write_text("13")
            thread = root / "17"
            thread.mkdir()
            (thread / "status").write_text("Tgid:\t13\n")
            self.assertEqual(guest.caller_thread(17, root, expected), thread)
            # proc comm can contain parentheses and fields after RSS can contain process addresses.
            (thread / "stat").write_text("99 (weird) name) R" + " 4" * 20 + " 456 0 12345678\n")
            view = guest.rss_stat(thread).split()
            self.assertEqual(view[23], b"456")
            self.assertNotIn(b"12345678", view)
            (thread / "status").write_text("Tgid:\t17\n")
            with self.assertRaises(ValueError):
                guest.caller_thread(17, root, expected)

    def test_paths_allow_project_files_but_refuse_pipes_devices_and_system_files(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
            project = Path(tmp)
            source_file = project / "notes"
            source_file.write_text("sample")
            fd_link = project / "fd"
            with patch.object(guest, "PROJECT", tmp):
                for exposed in (project, source_file):
                    fd_link.symlink_to(exposed)
                    self.assertEqual(guest.allowed_fd_path(fd_link), os.fsencode(exposed))
                    fd_link.unlink()
                named_pipe = project / "pipe"
                os.mkfifo(named_pipe)
                for hidden in (named_pipe, "pipe:[123]", "/dev/null", "/etc/passwd", "/tmp/gone (deleted)"):
                    fd_link.symlink_to(hidden)
                    with self.subTest(hidden=hidden), self.assertRaises(ValueError):
                        guest.allowed_fd_path(fd_link)
                    fd_link.unlink()


class NativeHistory(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.scope = "a" * 64
        self.run, self.session, self.turn = [str(uuid.uuid4()) for _ in range(3)]
        for field in ("HISTORY_STAGE", "HISTORY_STORE"):
            changed = patch.object(guest, field, root / field)
            changed.start()
            self.addCleanup(changed.stop)

    def stage(self, carrier, name, rows):
        self.assertEqual(guest.history_command("begin", self.scope, self.run, carrier, "-", "-", "-"),
                         {"restored": False})
        work, _ = guest.history_dirs(self.scope, self.run)
        path = work / name
        path.parent.mkdir(parents=True)
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))
        return path

    def codex(self):
        name = f"2026/11/08/rollout-2026-11-08T10-00-01-{self.session}.jsonl"
        rows = [{"type": "session_meta", "payload": {"id": self.session, "cwd": guest.PROJECT}},
                {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": self.turn}}]
        return self.stage("codex", name, rows)

    def finish(self, carrier):
        return guest.history_command("finish", self.scope, self.run, carrier, "-", self.session, self.turn)

    def restore(self, carrier, scope=None, previous=None, anchor=None):
        run = str(uuid.uuid4())
        res = guest.history_command("begin", scope or self.scope, run, carrier, previous or self.run,
                                    self.session, anchor or self.turn)
        return res, guest.history_dirs(scope or self.scope, run)[0]

    def test_codex_exact_checkpoint_immutable_and_scoped(self):
        path = self.codex()
        (path.parent / "unrelated.jsonl").write_text("other session")
        (path.parent / "auth.json").write_text("not included")
        self.assertTrue(self.finish("codex")["saved"])
        self.assertTrue(self.finish("codex")["saved"])
        original = path.read_bytes()
        with path.open("a") as stream:
            stream.write('{"type":"response_item","payload":{}}\n')
        self.assertFalse(self.finish("codex")["saved"])
        path.write_bytes(original)
        self.assertFalse(self.restore("codex", scope="c" * 64)[0]["restored"])
        self.assertFalse(self.restore("codex", previous=str(uuid.uuid4()))[0]["restored"])
        self.assertFalse(self.restore("codex", anchor=str(uuid.uuid4()))[0]["restored"])
        self.assertFalse(self.restore("claude")[0]["restored"])
        result, staged = self.restore("codex")
        self.assertTrue(result["restored"])
        self.assertEqual([p for p in staged.rglob("*") if p.is_file()], [staged / result["name"]])
        self.assertEqual((staged / result["name"]).read_bytes(), path.read_bytes())
        _, archive = guest.history_dirs(self.scope, self.run)
        (archive / self.run / "history").write_bytes(b"tampered")
        self.assertFalse(self.restore("codex")[0]["restored"])

    def test_unfinished_codex_rollout_cannot_be_promoted(self):
        path = self.codex()
        with path.open("a") as stream:
            stream.write(json.dumps({"type": "event_msg", "payload": {"type": "turn_aborted", "turn_id": self.turn}}))
        self.assertFalse(self.finish("codex")["saved"])
        self.assertFalse(self.restore("codex")[0]["restored"])

    def test_claude_returns_scoped_chain_and_skips_assistant_content(self):
        user = str(uuid.uuid4())
        base = {"cwd": guest.PROJECT, "sessionId": self.session}
        rows = [{**base, "type": "user", "uuid": user, "message": {"content": "test prompt"}},
                {**base, "type": "assistant", "uuid": self.turn, "parentUuid": user, "message": {"content": "private sample"}}]
        path = self.stage("claude", f"-mnt-project/{self.session}.jsonl", rows)
        saved = self.finish("claude")
        self.assertTrue(saved["saved"])
        self.assertEqual(saved["rows"][0]["message"]["content"], "test prompt")
        self.assertNotIn("private sample", json.dumps(saved))
        restored, _ = self.restore("claude")
        self.assertEqual(restored["rows"], saved["rows"])
        path.write_text(json.dumps({**rows[-1], "sessionId": str(uuid.uuid4())}))
        self.assertFalse(self.finish("claude")["saved"])
        guest.history_command("discard", self.scope, self.run, "claude", "-", "-", "-")
        self.assertFalse(path.exists())
        self.assertTrue(self.restore("claude")[0]["restored"])


class GuestGateway(unittest.IsolatedAsyncioTestCase):
    async def exchange(self, peer, path, emitted):
        proxy = guest.Gateway()
        proxy.peer = lambda _port: peer
        def answer(frame):
            emitted.append(frame)
            proxy.pending[frame["id"]].set_result({"status": 201, "headers": {}, "bodyBase64": "T0s="})
        reader = asyncio.StreamReader()
        reader.feed_data(f"POST {path} HTTP/1.1\r\nContent-Length: 2\r\nAuthorization: synthetic\r\n\r\n".encode() + b"{}")
        reader.feed_eof()
        output = io.BytesIO()
        writer = Mock()
        writer.get_extra_info.return_value = ("127.0.0.1", 31234)
        writer.write.side_effect = output.write
        writer.drain = AsyncMock()
        with patch.object(guest, "emit", answer):
            await proxy.serve(reader, writer)
        self.assertTrue(writer.close.called)
        return output.getvalue()

    async def test_admits_only_verified_caller_and_endpoint(self):
        emitted = []
        self.assertIn(b"403", await self.exchange(False, "/mcp", emitted))
        self.assertIn(b"403", await self.exchange(True, "/unknown", emitted))
        self.assertEqual(emitted, [])
        self.assertIn(b"201", await self.exchange(True, "/model/v1/messages", emitted))
        self.assertEqual(len(emitted), 1)
        self.assertEqual(base64.b64decode(emitted[0]["bodyBase64"]), b"{}")
        self.assertNotIn("authorization", emitted[0]["headers"])


if __name__ == "__main__":
    unittest.main()

import io, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import redirect_stdout, redirect_stderr
sys.path.insert(0, str(Path(__file__).parent))
from test_pai import pai, TOKEN, Response, FakeTransport

def snapshot(lines, source='kubernetes', phase='Running'):
    return {'source': source, 'phase': phase, 'redaction': 'applied', 'truncated': False, 'targets': [], 'lines': [{'ts': ts, 'text': text} for ts, text in lines]}
def sse(events):
    return ''.join(f"id: {i}\nevent: {e}\ndata: {d}\n\n" if i else f"event: {e}\ndata: {d}\n\n" for i, e, d in events).encode()

class LogStreamTests(unittest.TestCase):
    def run_logs(self, responses, extra=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private' / 'credentials.json'
            pai.ConfigStore(path).save('https://dashboard.test', TOKEN, 'project-a')
            output, errors = io.StringIO(), io.StringIO()
            transport = FakeTransport(responses)
            with patch.object(pai, 'HttpTransport', return_value=transport), redirect_stdout(output), redirect_stderr(errors):
                code = pai.main(['--config', str(path), 'workflows', 'logs', 'run', '--task', 'train'] + (extra or []))
            return code, output.getvalue(), errors.getvalue(), transport.requests

    def test_snapshot_prints_text_and_passes_selectors(self):
        code, out, _, requests = self.run_logs([Response(200, snapshot([('t1', 'same'), ('t2', 'same'), ('t3', ''), ('t4', 'https://example.test')]))], ['--attempt', '2', '--member', '1', '--container', 'main', '--tail', '50'])
        self.assertEqual(code, 0)
        self.assertEqual(out, 'same\nsame\n\nhttps://example.test\n')
        self.assertIn('attempt=2&member=1&container=main&tail=50', requests[0][1])

    def test_pod_gone_reports_on_stderr(self):
        code, out, err, _ = self.run_logs([Response(200, {'source': 'none', 'reason': 'pod-gone', 'targets': [], 'lines': [], 'truncated': False, 'redaction': 'none'})])
        self.assertEqual((code, out), (0, ''))
        self.assertIn('Pod', err)

    def test_follow_streams_sse_and_reconnects_with_since_after_timeout(self):
        first = sse([('2026-09-19T00:00:01Z', 'line', '{"ts":"2026-09-19T00:00:01Z","text":"a"}'), ('', 'end', '{"reason":"timeout"}')])
        second = sse([('2026-09-19T00:00:02Z', 'line', '{"ts":"2026-09-19T00:00:02Z","text":"b"}'), ('', 'end', '{"reason":"pod-ended"}')])
        code, out, _, requests = self.run_logs([Response(200, first, {'Content-Type': 'text/event-stream'}), Response(200, second, {'Content-Type': 'text/event-stream'})], ['--follow'])
        self.assertEqual(code, 0)
        self.assertEqual(out, 'a\nb\n')
        self.assertIn('follow=1', requests[0][1]); self.assertNotIn('since=', requests[0][1])
        self.assertIn('since=2026-09-19T00%3A00%3A01Z', requests[1][1])
        self.assertEqual(requests[0][2]['Accept'], 'text/event-stream')

    def test_follow_redacts_the_cli_token_and_stops_on_log_error(self):
        body = sse([('', 'line', '{"ts":"","text":"token ' + TOKEN + '"}'), ('', 'log-error', '{"error":"x","code":"log_forbidden"}')])
        code, out, err, _ = self.run_logs([Response(200, body, {'Content-Type': 'text/event-stream'})], ['--follow'])
        self.assertEqual(out, 'token [REDACTED]\n')
        self.assertNotEqual(code, 0)
        self.assertIn('authorization', err.lower())

    def test_follow_flushes_held_back_bytes_on_a_non_transient_reconnect_error(self):
        partial = sse([('', 'line', '{"ts":"","text":"partial ' + TOKEN[:5] + '"}')])
        with patch.object(pai.time, 'sleep'):
            code, out, _, _ = self.run_logs([Response(200, partial, {'Content-Type': 'text/event-stream'}), Response(400, {})], ['--follow'])
        self.assertNotEqual(code, 0)
        self.assertEqual(out, 'partial ' + TOKEN[:5] + '\n')

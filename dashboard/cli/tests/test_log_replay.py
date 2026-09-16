import base64
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import redirect_stdout, redirect_stderr
sys.path.insert(0, str(Path(__file__).parent))
from test_pai import pai, TOKEN, Response, FakeTransport

def page(sequence, value, cursor, more=False):
    return {'source': 'archive', 'stream': {'id': 'a' * 64, 'state': 'open' if more else 'closed'},
            'records': [{'sequence': sequence, 'kind': 'data', 'data': base64.b64encode(value).decode()}],
            'cursor': cursor, 'hasMore': more, 'coverage': 'captured-only'}

class LogReplayTests(unittest.TestCase):
    def run_logs(self, responses, extra=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private' / 'credentials.json'
            pai.ConfigStore(path).save('https://dashboard.test', TOKEN, 'project-a')
            output, errors = io.StringIO(), io.StringIO()
            transport = FakeTransport(responses)
            with patch.object(pai, 'HttpTransport', return_value=transport), redirect_stdout(output), redirect_stderr(errors):
                code = pai.main(['--config', str(path), 'workflows', 'logs', 'run', '--task', 'train', '--start', 'beginning'] + (extra or []))
            return code, output.getvalue(), errors.getvalue(), transport.requests

    def test_paging_uses_cursor_and_preserves_repeated_blank_url_content(self):
        result = self.run_logs([Response(200, page(1, b'same\nsame\n\n', 'b' * 43, True)),
                                Response(200, page(2, b'https://example.test/results\nlast', 'c' * 43))])
        self.assertEqual(result[0], 0)
        self.assertEqual(result[1], 'same\nsame\n\nhttps://example.test/results\nlast')
        self.assertIn('cursor=' + 'b' * 43, result[3][1][1])
        self.assertNotIn('overlap', result[2])

    def test_known_api_token_is_redacted_even_across_pages_without_masking_other_text(self):
        result = self.run_logs([Response(200, page(1, ('before ' + TOKEN[:20]).encode(), 'b' * 43, True)),
                                Response(200, page(2, (TOKEN[20:] + ' https://example.test').encode(), 'c' * 43))])
        self.assertEqual(result[0], 0)
        self.assertEqual(result[1], 'before [REDACTED] https://example.test')

    def test_cursor_resume_request_and_wrong_sequence_fail_closed(self):
        result = self.run_logs([Response(200, page(3, b'first\n', 'b' * 43, True)),
                                Response(200, page(5, b'skipped\n', 'c' * 43))], ['--cursor', 'd' * 43])
        self.assertEqual(result[0], 1)
        self.assertIn('cursor=' + 'd' * 43, result[3][0][1])
        self.assertNotIn('skipped', result[1])

    def test_revocation_stops_follow_without_retrying_authorization_failure(self):
        result = self.run_logs([Response(403, {})], ['--follow'])
        self.assertEqual(result[0], 1); self.assertEqual(len(result[3]), 1)

    def test_private_cursor_file_is_bound_and_not_a_credentials_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private' / 'cursor.json'
            checkpoint = pai.LogCursorFile(path, 'binding')
            self.assertIsNone(checkpoint.load())
            checkpoint.save('x' * 43)
            self.assertEqual(checkpoint.load(), 'x' * 43)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(pai.CliError): pai.LogCursorFile(path, 'other').load()
            credentials = Path(directory) / 'private' / 'credentials.json'
            pai.ConfigStore(credentials).save('https://dashboard.test', TOKEN, 'project-a')
            with self.assertRaises(pai.CliError): pai.LogCursorFile(credentials, 'binding').save('x' * 43)
            self.assertEqual(pai.ConfigStore(credentials).load()['token'], TOKEN)

if __name__ == '__main__': unittest.main()

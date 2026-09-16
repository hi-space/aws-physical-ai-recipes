import base64
import io
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout, redirect_stderr
from email.message import Message

spec = importlib.util.spec_from_file_location('pai', Path(__file__).parents[1] / 'pai.py')
pai = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pai)
TOKEN = 'pai_' + base64.urlsafe_b64encode(b'X' * 32).decode().rstrip('=')
TICKET = base64.urlsafe_b64encode(b'T' * 32).decode().rstrip('=')
COOKIE = base64.urlsafe_b64encode(b'C' * 32).decode().rstrip('=')

class Response(io.BytesIO):
    def __init__(self, status=200, payload=None, headers=None):
        super().__init__(payload if isinstance(payload, bytes) else json.dumps(payload).encode())
        self.status = status
        self.headers = Message()
        for name, value in (headers or {}).items():
            self.headers[name] = value

class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
    def open(self, method, url, headers, data=None):
        self.requests.append((method, url, dict(headers), data.read() if hasattr(data, 'read') else data))
        return self.responses.pop(0)

class ConfigTests(unittest.TestCase):
    def test_config_is_private_and_rejects_insecure_files_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config' / 'credentials.json'
            store = pai.ConfigStore(path)
            store.save('https://dashboard.test', TOKEN, 'project-a')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(store.load()['token'], TOKEN)
            os.chmod(path, 0o644)
            with self.assertRaises(pai.CliError): store.load()
            path.unlink()
            target = Path(directory) / 'target'
            target.write_text('keep')
            path.symlink_to(target)
            with self.assertRaises(pai.CliError): store.save('https://dashboard.test', TOKEN, 'project-a')
            self.assertEqual(target.read_text(), 'keep')

    def test_invalid_api_origins_are_rejected(self):
        for value in ['http://dashboard.test', 'https://token@dashboard.test', 'https://dashboard.test/?ticket=bad', 'https://dashboard.test/api', 'https://dashboard.test/#fragment']:
            with self.subTest(value=value), self.assertRaises(pai.CliError): pai.api_origin(value)

    def test_login_saves_only_after_project_bound_token_api_is_verified(self):
        for status, identity, expected in [
            (200, {'authMethod': 'token', 'role': 'researcher', 'tokenProjectId': 'project-a'}, 0),
            (200, {'role': 'admin'}, 1),
            (404, {'error': 'missing API'}, 1),
        ]:
            with tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / 'private' / 'credentials.json'
                output = io.StringIO()
                with patch.object(pai, 'HttpTransport', return_value=FakeTransport([Response(status, identity)])), \
                        patch.object(pai.getpass, 'getpass', return_value=TOKEN), redirect_stdout(output), redirect_stderr(output):
                    self.assertEqual(pai.main(['--config', str(config), 'login', '--url', 'https://dashboard.test']), expected)
                self.assertEqual(config.exists(), expected == 0)
                self.assertNotIn(TOKEN, output.getvalue())
                self.assertNotIn('https://', output.getvalue())

class TransportTests(unittest.TestCase):
    def test_api_does_not_follow_redirects_or_expose_bearer_in_errors(self):
        transport = FakeTransport([Response(302, {}, {'Location': 'https://s3.test/?ticket=' + TICKET})])
        api = pai.ApiClient('https://dashboard.test', TOKEN, 'project-a', transport)
        with self.assertRaises(pai.CliError) as result: api.json('GET', '/workflows')
        self.assertNotIn(TOKEN, str(result.exception))
        self.assertNotIn('https://', str(result.exception))
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(transport.requests[0][1], 'https://dashboard.test/api/v1/workflows')
        self.assertEqual(transport.requests[0][2]['Authorization'], 'Bearer ' + TOKEN)

    def test_gateway_exchange_and_file_upload_never_carry_api_bearer(self):
        transport = FakeTransport([
            Response(303, b'', {'Set-Cookie': '__Host-pai-session=' + COOKIE + '; Path=/; Secure; HttpOnly; Max-Age=60', 'Location': '/'}),
            Response(204, b''),
        ])
        gateway = pai.GatewayClient('https://dashboard.test', 'session1', 'https://session1.apps.dashboard.test/?ticket=' + TICKET, transport)
        gateway.exchange()
        gateway.upload('models/file.bin', io.BytesIO(b'weights'), 7)
        for _, _, headers, _ in transport.requests:
            self.assertNotIn('Authorization', headers)
        self.assertNotIn('Cookie', transport.requests[0][2])
        request = transport.requests[1]
        self.assertNotIn('ticket=', request[1])
        self.assertEqual(request[2]['Origin'], 'https://session1.apps.dashboard.test')
        self.assertEqual(request[2]['Cookie'], '__Host-pai-session=' + COOKIE)
        self.assertEqual(request[3], b'weights')

    def test_gateway_rejects_wrong_origin_domain_cookies_and_external_redirects(self):
        with self.assertRaises(pai.CliError):
            pai.GatewayClient('https://dashboard.test', 's', 'https://s3.test/?ticket=' + TICKET, FakeTransport([]))
        for headers in [
            {'Set-Cookie': '__Host-pai-session=' + COOKIE + '; Domain=apps.dashboard.test; Path=/; Secure; HttpOnly', 'Location': '/'},
            {'Set-Cookie': '__Host-pai-session=' + COOKIE + '; Path=/; Secure; HttpOnly', 'Location': 'https://s3.test/'},
        ]:
            gateway = pai.GatewayClient('https://dashboard.test', 's', 'https://s.apps.dashboard.test/?ticket=' + TICKET, FakeTransport([Response(303, b'', headers)]))
            with self.assertRaises(pai.CliError): gateway.exchange()

    def test_log_redaction_removes_tokens_and_ticket_urls(self):
        output = pai.redact('log ' + TOKEN + ' https://host.test/?ticket=' + TICKET)
        self.assertNotIn(TOKEN, output)
        self.assertNotIn(TICKET, output)
        self.assertNotIn('https://', output)

class FileTests(unittest.TestCase):
    def test_relative_path_validation_and_default_ignores(self):
        for value in ['../escape', '/absolute', 'a/../b', 'a\\b', 'a//b', 'a/./b', '.pai-token', 'folder/.env.production']:
            with self.subTest(value=value), self.assertRaises(pai.CliError): pai.safe_relative(value)
        self.assertEqual(pai.safe_relative('models/checkpoint.pt'), 'models/checkpoint.pt')

    def test_local_tree_skips_private_files_symlinks_and_own_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'weights.pt').write_bytes(b'good')
            for name in ['.env', '.env.local', '.git', '.aws', '.ssh', 'node_modules']:
                (root / name).mkdir() if not name.startswith('.env') else (root / name).write_text('secret')
            config = root / 'credentials.json'; config.write_text(TOKEN)
            (root / 'link').symlink_to(config)
            with pai.LocalTree(root, config) as tree:
                self.assertEqual(tree.files(), ['weights.pt'])
                with self.assertRaises(pai.CliError): tree.open_file('link')
                with self.assertRaises(pai.CliError): tree.open_file('credentials.json')

    def test_download_cannot_escape_through_a_parent_symlink_and_commits_atomically(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory); (root / 'outside').symlink_to(outside, target_is_directory=True)
            with pai.LocalTree(root) as tree:
                with self.assertRaises(pai.CliError): tree.save('outside/escape', io.BytesIO(b'secret'))
                tree.save('models/ok.bin', io.BytesIO(b'new'))
            self.assertEqual((root / 'models/ok.bin').read_bytes(), b'new')
            self.assertFalse((Path(outside) / 'escape').exists())
            self.assertFalse(list(root.rglob('.pai-sync-*')))

    def test_truncated_download_keeps_the_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); target = root / 'model'; target.write_bytes(b'old')
            with pai.LocalTree(root) as tree:
                with self.assertRaises(pai.CliError): tree.save('model', io.BytesIO(b'short'), expected_size=10)
            self.assertEqual(target.read_bytes(), b'old')
            self.assertFalse(list(root.rglob('.pai-sync-*')))

    def test_untrusted_listing_paths_are_rejected(self):
        transport = FakeTransport([Response(200, {'path': '', 'entries': [{'name': 'file', 'path': '../escape', 'type': 'file', 'size': 1}], 'maxUploadBytes': 100})])
        gateway = pai.GatewayClient('https://dashboard.test', 's', 'https://s.apps.dashboard.test/?ticket=' + TICKET, transport)
        with self.assertRaises(pai.CliError): gateway.listing('')

    def test_watch_uploads_only_content_changes_and_never_deletes_remote_files(self):
        class Gateway:
            def __init__(self): self.sent = []
            def listing(self, path): return {'path': path, 'entries': [], 'maxUploadBytes': 1000}
            def upload(self, relative, source, size): self.sent.append((relative, source.read()))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / 'file'; source.write_bytes(b'a')
            gateway = Gateway()
            with pai.LocalTree(root) as tree:
                state = pai.upload_tree(gateway, tree, '', {})
                state = pai.upload_tree(gateway, tree, '', state)
                source.write_bytes(b'b'); state = pai.upload_tree(gateway, tree, '', state)
                source.unlink(); pai.upload_tree(gateway, tree, '', state)
            self.assertEqual(gateway.sent, [('file', b'a'), ('file', b'b')])

class SessionTests(unittest.TestCase):
    def test_failed_exchange_closes_only_the_newly_created_session(self):
        class Api:
            origin = 'https://dashboard.test'
            project_id = 'project-a'
            def __init__(self, project='project-a'): self.calls = []; self.project = project
            def json(self, method, path, payload=None):
                self.calls.append((method, path, payload))
                if path == '/sessions':
                    return {'id': 'created', 'kind': 'port-forward', 'projectId': self.project,
                            'workflowId': 'run', 'taskName': 'train', 'status': 'READY', 'canOpen': True, 'canEnd': True}
                if path.endswith('/launch'): return {'url': 'https://created.apps.dashboard.test/?ticket=' + TICKET}
                return {}
        api = Api()
        with self.assertRaises(pai.CliError):
            with pai.file_session(api, 'run', 'train', FakeTransport([Response(404, {})])): pass
        self.assertEqual(api.calls[-1][:2], ('DELETE', '/sessions/created'))
        self.assertEqual(api.calls[0][2]['portName'], 'pai-files')
        other = Api('other')
        with self.assertRaises(pai.CliError):
            with pai.file_session(other, 'run', 'train', FakeTransport([])): pass
        self.assertFalse(any(method == 'DELETE' for method, _, _ in other.calls))

class WorkflowCommandTests(unittest.TestCase):
    def test_workflow_commands_use_versioned_endpoints_and_only_print_selected_metadata(self):
        cases = [
            (['list'], [Response(200, [{'id': 'run', 'name': 'test', 'status': 'RUNNING', 'specYaml': TOKEN}])], 'GET', '/api/v1/workflows'),
            (['status', 'run'], [Response(200, {'workflow': {'id': 'run', 'status': 'RUNNING', 'specYaml': TOKEN}, 'tasks': []})], 'GET', '/api/v1/workflows/run'),
            (['cancel', 'run'], [Response(202, {'id': 'run', 'status': 'CANCELLING'})], 'POST', '/api/v1/workflows/run/cancel'),
            (['logs', 'run', '--task', 'train'], [Response(200, {'lines': ['ok', TOKEN + ' https://host.test/?ticket=' + TICKET]})], 'GET', '/api/v1/workflows/run/tasks/train/logs?tail=1000'),
        ]
        for args, responses, method, path in cases:
            with self.subTest(args=args), tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / 'private' / 'credentials.json'
                pai.ConfigStore(config).save('https://dashboard.test', TOKEN, 'project-a')
                transport = FakeTransport(responses); output = io.StringIO()
                with patch.object(pai, 'HttpTransport', return_value=transport), redirect_stdout(output), redirect_stderr(output):
                    self.assertEqual(pai.main(['--config', str(config), 'workflows'] + args), 0)
                self.assertEqual(transport.requests[0][:2], (method, 'https://dashboard.test' + path))
                self.assertNotIn(TOKEN, output.getvalue())
                self.assertNotIn(TICKET, output.getvalue())
                self.assertNotIn('https://', output.getvalue())

    def test_submission_preserves_yaml_overrides_and_explicit_idempotency_key(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'private' / 'credentials.json'
            pai.ConfigStore(config).save('https://dashboard.test', TOKEN, 'project-a')
            workflow = Path(directory) / 'recipe.yaml'; workflow.write_text('workflow: {name: test}')
            transport = FakeTransport([Response(202, {'runId': 'run', 'status': 'PENDING'})])
            with patch.object(pai, 'HttpTransport', return_value=transport), redirect_stdout(io.StringIO()):
                self.assertEqual(pai.main(['--config', str(config), 'workflows', 'submit', str(workflow), '--param', 'seed=7', '--idempotency-key', 'stable-key']), 0)
            method, url, headers, payload = transport.requests[0]
            self.assertEqual((method, url), ('POST', 'https://dashboard.test/api/v1/workflows'))
            self.assertEqual(headers['Idempotency-Key'], 'stable-key')
            self.assertEqual(json.loads(payload), {'yaml': 'workflow: {name: test}', 'overrides': {'seed': '7'}})

    def test_submission_acknowledges_preflight_only_with_explicit_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'private' / 'credentials.json'
            pai.ConfigStore(config).save('https://dashboard.test', TOKEN, 'project-a')
            workflow = Path(directory) / 'recipe.yaml'; workflow.write_text('workflow: {name: test}')
            transport = FakeTransport([Response(202, {'runId': 'run', 'status': 'PENDING'})])
            with patch.object(pai, 'HttpTransport', return_value=transport), redirect_stdout(io.StringIO()):
                self.assertEqual(pai.main(['--config', str(config), 'workflows', 'submit', str(workflow), '--acknowledge-preflight', '--param', 'seed=7']), 0)
            self.assertEqual(len(transport.requests), 1)
            self.assertEqual(json.loads(transport.requests[0][3]), {
                'yaml': 'workflow: {name: test}', 'overrides': {'seed': '7'}, 'acknowledgePreflight': True,
            })

    def test_preflight_rejection_never_automatically_consents_or_retries(self):
        for status, flags in [(428, []), (422, ['--acknowledge-preflight'])]:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / 'private' / 'credentials.json'
                pai.ConfigStore(config).save('https://dashboard.test', TOKEN, 'project-a')
                workflow = Path(directory) / 'recipe.yaml'; workflow.write_text('workflow: {name: test}')
                transport = FakeTransport([Response(status, {'error': 'review required', 'credentials': TOKEN})])
                output = io.StringIO()
                with patch.object(pai, 'HttpTransport', return_value=transport), redirect_stdout(output), redirect_stderr(output):
                    self.assertEqual(pai.main(['--config', str(config), 'workflows', 'submit', str(workflow)] + flags), 1)
                self.assertEqual(len(transport.requests), 1)
                self.assertEqual(json.loads(transport.requests[0][3]).get('acknowledgePreflight', False), bool(flags))
                self.assertIn('HTTP %s' % status, output.getvalue())
                self.assertNotIn(TOKEN, output.getvalue())

if __name__ == '__main__': unittest.main()

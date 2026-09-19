import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import prepare
import session


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
    def tearDown(self):
        self.tmp.cleanup()
    def test_prepare_owns_only_session_leaf_and_preserves_content(self):
        logs = self.root / 'checkpoints/projects/team-a/runs/run-a/train'
        logs.mkdir(parents=True)
        prepare.prepare(self.root, 'team-a', 'session-a', 'checkpoints/projects/team-a/runs/run-a/train')
        leaf = self.root / 'sessions/projects/team-a/session-a'
        self.assertEqual(leaf.stat().st_uid, 1000)
        self.assertEqual(leaf.stat().st_mode & 0o777, 0o700)
        self.assertEqual(leaf.parent.stat().st_uid, 0)
        (leaf / 'keep.txt').write_text('keep')
        prepare.prepare(self.root, 'team-a', 'session-a')
        self.assertEqual((leaf / 'keep.txt').read_text(), 'keep')
        self.assertEqual(logs.stat().st_uid, 0)
    def test_rejects_parent_and_leaf_symlinks(self):
        elsewhere = self.root / 'elsewhere'
        elsewhere.mkdir()
        (self.root / 'sessions').symlink_to(elsewhere)
        with self.assertRaises(OSError): prepare.prepare(self.root, 'team-a', 'session-a')
        (self.root / 'sessions').unlink()
        prepare.prepare(self.root, 'team-a', 'session-a')
        leaf = self.root / 'sessions/projects/team-a/session-a'
        leaf.rmdir(); leaf.symlink_to(elsewhere)
        with self.assertRaises(OSError): prepare.prepare(self.root, 'team-a', 'session-a')
    def test_rejects_logs_symlinks_traversal_and_other_projects(self):
        project = self.root / 'checkpoints/projects/team-a'
        project.mkdir(parents=True)
        (project / 'run').symlink_to(self.root)
        for path in ['checkpoints/projects/team-a/run', 'checkpoints/projects/other/run', 'checkpoints/projects/team-a/../other']:
            with self.assertRaises((OSError, ValueError)): prepare.prepare(self.root, 'team-a', 'session-a', path)
    def test_rejects_writable_trusted_ancestors(self):
        prepare.prepare(self.root, 'team-a', 'session-a')
        (self.root / 'sessions/projects').chmod(0o777)
        with self.assertRaises(ValueError): prepare.prepare(self.root, 'team-a', 'session-b')


class LauncherTests(unittest.TestCase):
    def test_apps_have_fixed_loopback_commands(self):
        for kind in session.PORTS:
            argv = session.command(kind)
            self.assertTrue(any('127.0.0.1' in argument for argument in argv))
            self.assertNotIn('0.0.0.0', ' '.join(argv))
            self.assertNotIn('pip install', ' '.join(argv))
        self.assertIn('--logdir=/logs', session.command('tensorboard'))
    def test_rejects_identity_injection_before_exec(self):
        for key in session.IDENTITY_ENV:
            with patch.dict(os.environ, {key: 'synthetic-value'}, clear=True), patch('os.execvpe') as execute:
                with self.assertRaises(ValueError): session.main(['jupyter'])
                execute.assert_not_called()
    def test_rejects_unregistered_app(self):
        with self.assertRaises(ValueError): session.command('http://unregistered')
    def test_empty_prefix_is_byte_identical_to_no_prefix(self):
        for kind in session.PORTS:
            self.assertEqual(session.command(kind), session.command(kind, ''))
    def test_jupyter_prefix_sets_base_url(self):
        self.assertIn('--ServerApp.base_url=/s/abc/', session.command('jupyter', '/s/abc'))
    def test_tensorboard_prefix_sets_path_prefix(self):
        self.assertIn('--path_prefix=/s/abc', session.command('tensorboard', '/s/abc'))
    def test_code_server_prefix_has_no_flag(self):
        self.assertEqual(session.command('code-server'), session.command('code-server', '/s/abc'))
    def test_invalid_prefix_raises(self):
        for bad in ('not-slash-s', '/s/abc/', '/s/' + 'x' * 80):
            with self.assertRaises(ValueError): session.command('jupyter', bad)


if __name__ == '__main__':
    unittest.main()

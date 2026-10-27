"""Behavioral release gate checks against temporary local Git history (no remote)."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

GATE = Path(__file__).resolve().parents[1] / 'scripts/check_release.py'


class ReleaseGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'offline@example.invalid')
        self.git('config', 'user.name', 'Offline test')
        self.original = self.commit('original')
        self.git('tag', 'v1.2.1')
        self.latest = self.commit('latest')
        self.git('update-ref', 'refs/remotes/origin/main', self.latest)

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, text=True,
                                       stderr=subprocess.DEVNULL).strip()

    def commit(self, message):
        self.git('commit', '--allow-empty', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def gate(self, tag='v1.2.1', sha=None):
        return subprocess.run([sys.executable, str(GATE)], cwd=self.root, text=True,
                              capture_output=True, env=dict(os.environ, RELEASE_TAG=tag,
                              RELEASE_EVENT_SHA=self.original if sha is None else sha))

    def rejected(self, result, message):
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn(message, result.stderr)

    def test_matching_lightweight_and_annotated_tag(self):
        for annotated in (False, True):
            if annotated:
                self.git('tag', '-f', '-a', 'v1.2.1', self.original, '-m', 'release')
            result = self.gate()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(dict(line.split('=', 1) for line in result.stdout.splitlines()),
                             {'trusted_sha': self.latest, 'release_sha': self.original, 'tag': 'v1.2.1'})

    def test_moved_tag_on_main_is_rejected(self):
        self.git('tag', '-f', 'v1.2.1', self.latest)
        self.rejected(self.gate(), 'event commit')

    def test_non_main_ancestry_is_rejected(self):
        self.git('checkout', '-b', 'side', self.original)
        side = self.commit('side')
        self.git('tag', '-f', 'v1.2.1', side)
        self.rejected(self.gate(sha=side), 'Git gate failed')

    def test_malformed_tags_are_rejected(self):
        for tag in ('v1.2.1-beta', 'v01.2.1', 'v0.0.0', 'v65536.0.0', '../main', 'v１.2.1'):
            with self.subTest(tag=tag):
                result = self.gate(tag=tag)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')

    def test_full_rerun_retains_original_event_sha(self):
        self.assertEqual(self.gate().returncode, 0)
        newer = self.commit('new main for full rerun')
        self.git('update-ref', 'refs/remotes/origin/main', newer)
        # New main checkout is allowed, but it cannot change the release commit.
        self.assertIn('release_sha=' + self.original, self.gate().stdout)
        self.git('tag', '-f', 'v1.2.1', newer)
        self.rejected(self.gate(), 'event commit')

    def test_event_sha_must_be_full_literal_commit(self):
        for sha in ('', self.original[:12], 'main', self.original + '^{commit}', '0' * 40):
            with self.subTest(sha=sha):
                self.rejected(self.gate(sha=sha), 'event commit')


if __name__ == '__main__':
    unittest.main()

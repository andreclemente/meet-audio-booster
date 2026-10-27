"""Offline release packaging and draft-only API contract tests."""
import base64
import copy
import os
import subprocess
from urllib.parse import parse_qs
import hashlib
import importlib.util
import json
import contextlib
import io
from unittest import mock
from pathlib import Path
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location('draft', Path(__file__).resolve().parents[1] / 'scripts/webstore_draft.py')
assert SPEC is not None and SPEC.loader is not None
draft = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(draft)
SCRATCH = '/opt/data/profiles/coder/cache/scratch' if Path('/opt/data/profiles/coder/cache/scratch').is_dir() else None


class DraftTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'dist/icons').mkdir(parents=True)
        self.manifest = {'manifest_version': 3, 'name': 'Test', 'version': '1.2.1',
                         'background': {'service_worker': 'service-worker.js'},
                         'icons': {'16': 'icons/icon16.png', '48': 'icons/icon48.png', '128': 'icons/icon128.png'},
                         'content_scripts': [{'js': ['audio-booster.js']}]}
        (self.root / 'package.json').write_text(json.dumps({'version': '1.2.1'}))
        self.save_manifests()
        for name in draft.FILES - {'manifest.json'}:
            (self.root / 'dist' / name).write_bytes(b'fixture')
        self.archive = self.root / 'extension.zip'
        # Synthetic offline IDs only; never use the configured real store item in tests.
        self.env = {'CWS_CLIENT_ID': 'client-SECRET', 'CWS_CLIENT_SECRET': 'client-secret-SECRET',
                    'CWS_REFRESH_TOKEN': 'refresh-SECRET', 'CWS_PUBLISHER_ID': 'publisher_123',
                    'CWS_EXTENSION_ID': 'a' * 32}
        self.name = 'publishers/publisher_123/items/' + 'a' * 32
        self.status = {'name': self.name, 'itemId': 'a' * 32,
                       'publishedItemRevisionStatus': {'state': 'PUBLISHED',
                           'distributionChannels': [{'crxVersion': '1.2.0', 'deployPercentage': 100}]}}
        self.response = {'name': self.name, 'itemId': 'a' * 32, 'crxVersion': '1.2.1', 'uploadState': 'SUCCEEDED'}
        self.calls = []
        self.sleeps = []

    def save_manifests(self):
        for name in ('manifest.json', 'dist/manifest.json'):
            (self.root / name).write_text(json.dumps(self.manifest))

    def pack(self):
        return draft.package(self.root, 'v1.2.1', self.archive)

    def run_upload(self, replies=None, **kwargs):
        if not self.archive.exists():
            self.pack()
        queue = copy.deepcopy(replies if replies is not None else [
            {'access_token': 'access-SECRET', 'token_type': 'Bearer'}, self.status, self.response, self.status])
        def network(method, url, headers, body, timeout):
            self.calls.append((method, url, headers, body, timeout))
            reply = queue.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return reply
        return draft.upload(self.archive, 'v1.2.1', hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                            self.env, transport=network, sleep=self.sleeps.append, **kwargs)

    def test_deterministic_zip_root_and_hash(self):
        first = self.pack()
        second = self.root / 'other.zip'
        self.assertEqual(first, draft.package(self.root, 'v1.2.1', second))
        self.assertEqual(self.archive.read_bytes(), second.read_bytes())
        with zipfile.ZipFile(second) as z:
            self.assertEqual(set(z.namelist()), draft.FILES)
            self.assertEqual(json.loads(z.read('manifest.json'))['version'], '1.2.1')
        self.assertEqual(first, draft.check_archive(second, 'v1.2.1', first))
        with self.assertRaises(draft.DraftError):
            self.pack()

    def service_env(self):
        self.env = {k: v for k, v in self.env.items() if k in ('CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID')}
        self.account = {'type': 'service_account', 'client_email': 'fixture@offline.iam.gserviceaccount.com',
                        'token_uri': draft.TOKEN_URL,
                        'private_key': '-----BEGIN PRIVATE KEY-----\nZml4dHVyZQ==\n-----END PRIVATE KEY-----\n'}
        self.env['CWS_SERVICE_ACCOUNT_JSON'] = json.dumps(self.account)

    def test_service_account_assertion_and_draft_boundaries(self):
        self.service_env()
        signed = []
        def signer(key, message):
            self.assertEqual(key, self.account['private_key'])
            signed.append(message)
            return b'fixture-signature'
        result = self.run_upload(signer=signer, now=lambda: 1700000000)
        self.assertTrue(result['manual_dashboard_verification_required'])
        form = parse_qs(self.calls[0][3].decode())
        self.assertEqual(set(form), {'grant_type', 'assertion'})
        self.assertEqual(form['grant_type'], ['urn:ietf:params:oauth:grant-type:jwt-bearer'])
        parts = form['assertion'][0].split('.')
        decode = lambda part: base64.urlsafe_b64decode(part + '=' * (-len(part) % 4))
        self.assertEqual(json.loads(decode(parts[0])), {'alg': 'RS256', 'typ': 'JWT'})
        self.assertEqual(json.loads(decode(parts[1])), {
            'iss': self.account['client_email'], 'scope': 'https://www.googleapis.com/auth/chromewebstore',
            'aud': draft.TOKEN_URL, 'iat': 1700000000, 'exp': 1700003600})
        self.assertEqual(decode(parts[2]), b'fixture-signature')
        self.assertEqual(signed, ['.'.join(parts[:2]).encode('ascii')])
        self.assertEqual([c[0] for c in self.calls], ['POST', 'GET', 'POST', 'GET'])
        self.assertEqual(self.calls[0][1], draft.TOKEN_URL)
        self.assertTrue(self.calls[2][1].endswith(':upload'))

    def test_service_account_invalid_or_ambiguous_auth_never_networks(self):
        self.service_env()
        valid = self.env.copy()
        for field, value in [('type', 'authorized_user'), ('token_uri', 'https://evil.invalid/token'),
                             ('client_email', 'bad\r\nemail'), ('client_email', []),
                             ('client_email', 'fixture@bad..gserviceaccount.com'),
                             ('client_email', 'fixture@-bad.gserviceaccount.com'),
                             ('private_key', 'SECRET'), ('private_key', '-----BEGIN RSA PRIVATE KEY-----\nSECRET')]:
            account = dict(self.account, **{field: value})
            self.env = dict(valid, CWS_SERVICE_ACCOUNT_JSON=json.dumps(account))
            with self.subTest(field=field, value=value), self.assertRaises(draft.DraftError) as ctx:
                self.run_upload(signer=lambda *_: self.fail('must not sign'))
            self.assertNotIn('SECRET', str(ctx.exception))
        for value in ('[]', '{broken-SECRET', 'null', '   '):
            self.env = dict(valid, CWS_SERVICE_ACCOUNT_JSON=value)
            with self.subTest(value=value), self.assertRaises(draft.DraftError):
                self.run_upload()
        for key in ('CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN'):
            self.env = dict(valid, **{key: 'oauth-SECRET'})
            with self.subTest(key=key), self.assertRaises(draft.DraftError):
                self.run_upload()
        self.env = {k: v for k, v in valid.items() if k != 'CWS_SERVICE_ACCOUNT_JSON'}
        with self.assertRaisesRegex(draft.DraftError, 'authentication'):
            self.run_upload()
        self.assertEqual(self.calls, [])

    def test_optional_oauth_missing_fields_fail_before_network(self):
        for key in ('CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN'):
            original = self.env[key]
            self.env[key] = ''
            with self.subTest(key=key), self.assertRaisesRegex(draft.DraftError, 'authentication'):
                self.run_upload()
            self.env[key] = original
        self.assertEqual(self.calls, [])
        self.env['CWS_SERVICE_ACCOUNT_JSON'] = ''
        self.run_upload()  # workflow passes an empty missing alternative secret

    def test_service_signer_failure_sanitized_before_network(self):
        self.service_env()
        with self.assertRaises(draft.DraftError) as ctx:
            self.run_upload(signer=mock.Mock(side_effect=RuntimeError('private-key-SECRET')))
        self.assertNotIn('SECRET', str(ctx.exception))
        self.assertEqual(self.calls, [])

    def test_real_openssl_rsa_signing_and_fd_cleanup(self):
        # Ephemeral, generated fixture only. No live credentials or key files.
        key = subprocess.run(['/usr/bin/openssl', 'genpkey', '-algorithm', 'RSA',
                              '-pkeyopt', 'rsa_keygen_bits:2048'], capture_output=True, check=True).stdout
        message = b'offline signing fixture'
        signature = draft.sign_rs256(key.decode(), message)
        public = subprocess.run(['/usr/bin/openssl', 'pkey', '-pubout'], input=key,
                                capture_output=True, check=True).stdout
        public_path = self.root / 'fixture-public.pem'
        signature_path = self.root / 'fixture-signature'
        public_path.write_bytes(public)
        signature_path.write_bytes(signature)
        verified = subprocess.run(['/usr/bin/openssl', 'dgst', '-sha256', '-verify', str(public_path),
                                   '-signature', str(signature_path)], input=message, capture_output=True)
        self.assertEqual(verified.returncode, 0)
        self.assertEqual(verified.stdout.strip(), b'Verified OK')
        original_key = key
        for key in (key, b'not-a-private-key', subprocess.run(
                ['/usr/bin/openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256'],
                capture_output=True, check=True).stdout):
            with mock.patch.object(draft.os, 'memfd_create', wraps=os.memfd_create) as create, \
                    mock.patch.object(draft.os, 'close', wraps=os.close) as close:
                if key != original_key:
                    with self.assertRaises(draft.DraftError):
                        draft.sign_rs256(key.decode(), message)
                else:
                    draft.sign_rs256(key.decode(), message)
                # Capture the real descriptor without assuming subprocess's own fd count.
                self.assertEqual(create.call_count, 1)
                fd = close.call_args.args[0]  # signer's finally is the last close
                close.assert_any_call(fd)
                with self.assertRaises(OSError):
                    os.fstat(fd)
        with self.assertRaises(draft.DraftError):
            draft.sign_rs256('invalid-SECRET', message)

    def test_signer_uses_memory_fd_minimal_environment_and_safe_failure(self):
        descriptors = []
        # Keep the original function before patching the shared os module.
        real_create = os.memfd_create
        def memory_fd(*args):
            fd = real_create(*args)
            descriptors.append(fd)
            return fd
        key = 'fixture-private-key-SECRET'
        def openssl(args, **kwargs):
            self.assertEqual(args[0], '/usr/bin/openssl')
            self.assertNotIn(key, ' '.join(args))
            fd = descriptors[-1]
            self.assertEqual(kwargs['pass_fds'], (fd,))
            self.assertEqual(os.read(fd, 4096), key.encode())
            self.assertEqual(kwargs['input'], b'unsigned-jwt')
            self.assertEqual(kwargs['env'], {'PATH': '/usr/bin:/bin'})
            self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
            self.assertEqual(kwargs['timeout'], 30)
            raise subprocess.TimeoutExpired(args, 30, stderr=b'private-key-SECRET')
        with mock.patch.object(draft.os, 'memfd_create', side_effect=memory_fd), \
                mock.patch.object(draft.subprocess, 'run', side_effect=openssl):
            with self.assertRaises(draft.DraftError) as ctx:
                draft.sign_rs256(key, b'unsigned-jwt')
        self.assertNotIn('SECRET', str(ctx.exception))
        with self.assertRaises(OSError):
            os.fstat(descriptors[0])

    def test_invalid_versions(self):
        for version in ('01.2.1', '1.2', '1.2.3.4', '1.2.65536', '1.2.3-beta', '0.0.0', '1.2.-1', '１.2.3'):
            with self.subTest(version=version), self.assertRaises(draft.DraftError):
                draft.version(version, stable=True)
        self.assertEqual(draft.version('65535.0.1', stable=True), (65535, 0, 1, 0))

    def test_tag_and_each_metadata_mismatch(self):
        for path in ('package.json', 'manifest.json', 'dist/manifest.json'):
            target = self.root / path
            original = target.read_text()
            data = json.loads(original)
            data['version'] = '1.2.2'
            target.write_text(json.dumps(data))
            with self.subTest(path=path), self.assertRaises(draft.DraftError):
                self.pack()
            target.write_text(original)
        with self.assertRaises(draft.DraftError):
            draft.package(self.root, '1.2.1', self.archive)

    def test_unexpected_missing_symlink_and_manifest_paths(self):
        secret = self.root / 'dist/.env'
        secret.write_text('secret')
        with self.assertRaises(draft.DraftError):
            self.pack()
        secret.unlink()
        icon = self.root / 'dist/icons/icon16.png'
        icon.unlink()
        with self.assertRaises(draft.DraftError):
            self.pack()
        icon.symlink_to(self.root / 'manifest.json')
        with self.assertRaises(draft.DraftError):
            self.pack()
        icon.unlink()
        icon.write_bytes(b'fixture')
        self.manifest['background']['service_worker'] = '../secret.js'
        self.save_manifests()
        with self.assertRaises(draft.DraftError):
            self.pack()

    def test_archive_tampering_and_traversal(self):
        sha = self.pack()
        with self.assertRaises(draft.DraftError):
            draft.check_archive(self.archive, 'v1.2.1', '0' * 64)
        with zipfile.ZipFile(self.archive, 'a') as z:
            z.writestr('../secret', 'bad')
        with self.assertRaises(draft.DraftError):
            draft.check_archive(self.archive, 'v1.2.1', hashlib.sha256(self.archive.read_bytes()).hexdigest())
        self.assertNotEqual(sha, hashlib.sha256(self.archive.read_bytes()).hexdigest())

    def test_success_and_exact_endpoint_allowlist(self):
        result = self.run_upload()
        self.assertTrue(result['upload_response_version_verified'])
        self.assertTrue(result['manual_dashboard_verification_required'])
        self.assertEqual([c[0] for c in self.calls], ['POST', 'GET', 'POST', 'GET'])
        allowed = {'https://oauth2.googleapis.com/token',
                   'https://chromewebstore.googleapis.com/v2/' + self.name + ':fetchStatus',
                   'https://chromewebstore.googleapis.com/upload/v2/' + self.name + ':upload'}
        self.assertEqual({c[1] for c in self.calls}, allowed)
        self.assertEqual(self.calls[2][2]['Content-Type'], 'application/zip')
        self.assertEqual(self.calls[2][3], self.archive.read_bytes())
        self.assertTrue(all(c[4] == 30 for c in self.calls))

    def test_sync_success_rejects_failed_readback(self):
        for state in ('FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED'):
            with self.subTest(state=state), self.assertRaises(draft.DraftError):
                self.run_upload([{'access_token': 'secret'}, self.status, self.response,
                                 dict(self.status, lastAsyncUploadState=state)])

    def test_preflight_rejections_do_not_upload(self):
        cases = []
        for field, value in [('name', 'other'), ('itemId', 'b' * 32), ('warned', True), ('takenDown', True),
                             ('lastAsyncUploadState', 'IN_PROGRESS'), ('lastAsyncUploadState', 'NEW_STATE')]:
            status = copy.deepcopy(self.status)
            status[field] = value
            cases.append(status)
        for state in ('PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'NEW_STATE'):
            status = copy.deepcopy(self.status)
            status['submittedItemRevisionStatus'] = {'state': state}
            cases.append(status)
        for v in ('1.2.1', '1.2.2', '9.0.0', 'bad'):
            status = copy.deepcopy(self.status)
            status['publishedItemRevisionStatus']['distributionChannels'][0]['crxVersion'] = v
            cases.append(status)
        for status in cases:
            self.calls.clear()
            with self.subTest(status=status), self.assertRaises(draft.DraftError):
                self.run_upload([{'access_token': 'secret'}, status])
            self.assertEqual(len(self.calls), 2)

    def test_bad_upload_identity_version_state(self):
        for field, value in [('name', 'wrong'), ('itemId', 'b' * 32), ('crxVersion', '1.2.0'),
                             ('uploadState', 'FAILED'), ('uploadState', 'NOT_FOUND'),
                             ('uploadState', 'UPLOAD_IN_PROGRESS'), ('uploadState', 'UPLOAD_STATE_UNSPECIFIED')]:
            reply = dict(self.response, **{field: value})
            with self.subTest(field=field, value=value), self.assertRaises(draft.DraftError):
                self.run_upload([{'access_token': 'secret'}, self.status, reply, self.status])

    def test_async_success_failure_timeout_and_concurrent_change(self):
        reply = dict(self.response, uploadState='IN_PROGRESS')
        reply.pop('crxVersion')
        pending = dict(self.status, lastAsyncUploadState='IN_PROGRESS')
        success = dict(self.status, lastAsyncUploadState='SUCCEEDED')
        result = self.run_upload([{'access_token': 'secret'}, self.status, reply, pending, success], polls=2)
        self.assertFalse(result['upload_response_version_verified'])
        self.assertTrue(result['item_level_completion_observed'])
        self.assertFalse(result['upload_operation_correlation_verified'])
        self.assertEqual(len(self.sleeps), 2)
        for state in ('FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', 'NEW_STATE', None):
            status = dict(self.status, lastAsyncUploadState=state)
            with self.subTest(state=state), self.assertRaises(draft.DraftError):
                self.run_upload([{'access_token': 'secret'}, self.status, reply, status], polls=1)
        with self.assertRaises(draft.DraftError):
            self.run_upload([{'access_token': 'secret'}, self.status, reply, pending], polls=1)
        changed = copy.deepcopy(self.status)
        changed['publishedItemRevisionStatus']['distributionChannels'][0]['deployPercentage'] = 99
        with self.assertRaises(draft.DraftError):
            self.run_upload([{'access_token': 'secret'}, self.status, self.response, changed])
        for count in (0, 61):
            with self.assertRaises(draft.DraftError):
                self.run_upload(polls=count)

    def test_config_and_network_errors_are_sanitized(self):
        for key in ('CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID'):
            env = self.env.copy()
            env[key] = ''
            with self.subTest(key=key), self.assertRaises(draft.DraftError):
                draft.config(env)
        self.env['CWS_EXTENSION_ID'] = '../invalid'
        with self.assertRaises(draft.DraftError):
            draft.config(self.env)
        self.env['CWS_EXTENSION_ID'] = 'a' * 32
        for reply in (RuntimeError('refresh-SECRET access-SECRET'), {'error': 'refresh-SECRET'}, []):
            with self.assertRaises(draft.DraftError) as ctx:
                self.run_upload([reply])
            self.assertNotIn('SECRET', str(ctx.exception))

    def test_metadata_and_untyped_status_fail_closed(self):
        for action in ('wrong-type', {'default_popup': 'secret.html'}):
            self.manifest['action'] = action
            self.save_manifests()
            with self.subTest(action=action), self.assertRaises(draft.DraftError):
                self.pack()
        self.manifest.pop('action')
        self.save_manifests()
        for field in ('lastAsyncUploadState', 'warned', 'takenDown'):
            status = dict(self.status, **{field: []})
            with self.subTest(field=field), self.assertRaises(draft.DraftError):
                self.run_upload([{'access_token': 'secret'}, status])

    def test_no_upload_retry_after_ambiguous_failure_or_readback_failure(self):
        self.pack()
        for replies in ([{'access_token': 'secret'}, self.status, TimeoutError('refresh-SECRET')],
                        [{'access_token': 'secret'}, self.status, self.response, TimeoutError('access-SECRET')],
                        [{'access_token': 'secret'}, self.status, self.response, dict(self.status, itemId='wrong')]):
            self.calls.clear()
            with self.assertRaises(draft.DraftError) as ctx:
                self.run_upload(replies)
            self.assertNotIn('SECRET', str(ctx.exception))
            self.assertEqual(sum(c[1].endswith(':upload') for c in self.calls), 1)

    def test_zip_duplicate_symlink_and_secret_entries(self):
        import stat
        import warnings
        for name, mode in (('manifest.json', stat.S_IFREG), ('icons/icon16.png', stat.S_IFLNK), ('.env', stat.S_IFREG)):
            path = self.root / ('crafted-' + str(mode) + '-' + name.replace('/', '-') + '.zip')
            with zipfile.ZipFile(path, 'w') as archive:
                for entry in sorted(draft.FILES):
                    info = zipfile.ZipInfo(entry)
                    info.external_attr = (mode if entry == name else stat.S_IFREG) << 16
                    archive.writestr(info, (self.root / 'dist' / entry).read_bytes())
                if mode == stat.S_IFREG:
                    with warnings.catch_warnings():
                        warnings.simplefilter('ignore', UserWarning)
                        archive.writestr(name, b'secret')
            with self.subTest(name=name), self.assertRaises(draft.DraftError):
                draft.check_archive(path, 'v1.2.1', hashlib.sha256(path.read_bytes()).hexdigest())

    def test_cli_package_check_are_offline_and_errors_safe(self):
        args = ['webstore_draft.py', 'package', '--root', str(self.root), '--tag', 'v1.2.1', '--output', str(self.archive)]
        output = io.StringIO()
        with mock.patch.object(draft.urllib.request, 'build_opener', side_effect=AssertionError('network forbidden')):
            with mock.patch('sys.argv', args), contextlib.redirect_stdout(output):
                self.assertEqual(draft.main(), 0)
            sha = json.loads(output.getvalue())['sha256']
            check_args = ['webstore_draft.py', 'check', '--tag', 'v1.2.1', '--archive', str(self.archive), '--sha256', sha]
            with mock.patch('sys.argv', check_args), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(draft.main(), 0)
        errors = io.StringIO()
        with mock.patch('sys.argv', args), mock.patch.object(draft, 'package', side_effect=RuntimeError('refresh-SECRET')):
            with contextlib.redirect_stderr(errors):
                self.assertEqual(draft.main(), 1)
        self.assertNotIn('SECRET', errors.getvalue())

    def test_oauth_form_and_transport_error_sanitization(self):
        from urllib.parse import parse_qs
        self.run_upload()
        form = parse_qs(self.calls[0][3].decode())
        self.assertEqual(form, {'client_id': [self.env['CWS_CLIENT_ID']],
                               'client_secret': [self.env['CWS_CLIENT_SECRET']],
                               'refresh_token': [self.env['CWS_REFRESH_TOKEN']], 'grant_type': ['refresh_token']})
        with mock.patch.object(draft.urllib.request, 'build_opener') as opener:
            opener.return_value.open.side_effect = RuntimeError('refresh-SECRET')
            with self.assertRaises(draft.DraftError) as ctx:
                draft.http_request('POST', draft.TOKEN_URL, {}, b'', 30)
            self.assertNotIn('SECRET', str(ctx.exception))
            self.assertEqual(opener.return_value.open.call_args.kwargs['timeout'], 30)
        for endpoint in (':publish', ':cancelSubmission', ':setPublishedDeployPercentage', ':upload?x=1'):
            with self.subTest(endpoint=endpoint), self.assertRaises(draft.DraftError):
                draft.http_request('POST', draft.API + 'v2/' + self.name + endpoint, {}, b'', 30)

    def test_transport_rejects_redirects_without_following(self):
        import urllib.request
        handler = draft.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, 'Found', {}, 'https://evil.invalid'))
        with self.assertRaises(draft.DraftError):
            draft.http_request('POST', 'https://evil.invalid', {}, b'', 30)


if __name__ == '__main__':
    unittest.main()

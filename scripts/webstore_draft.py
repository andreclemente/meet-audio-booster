#!/usr/bin/env python3
"""Deterministic offline packaging and narrowly scoped Chrome Web Store draft upload.

No publish, submission, cancellation or rollout operations exist here. Network
responses/errors are untrusted: never print their contents, URLs or credentials.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile

FILES = frozenset({'manifest.json', 'audio-booster.js', 'service-worker.js',
                   'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'})
MAX_SIZE = 32 * 1024 * 1024
TOKEN_URL = 'https://oauth2.googleapis.com/token'
API = 'https://chromewebstore.googleapis.com/'
UPLOAD_STATES = {'SUCCEEDED', 'IN_PROGRESS', 'FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED'}
REVISION_FIELDS = ('publishedItemRevisionStatus', 'submittedItemRevisionStatus')


class DraftError(Exception):
    """Safe, constant diagnostic suitable for CI logs."""


def require(condition, message):
    if not condition:
        raise DraftError(message)


def version(text, stable=False):
    count = r'{2}' if stable else r'{0,3}'
    require(isinstance(text, str) and re.fullmatch(r'(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4}))' + count, text, re.ASCII),
            'Invalid Chrome version or stable release version.')
    parts = tuple(int(p) for p in text.split('.'))
    require(all(p <= 65535 for p in parts) and any(parts), 'Chrome version outside allowed range.')
    return parts + (0,) * (4 - len(parts))


def tag_version(tag):
    require(isinstance(tag, str) and tag.startswith('v'), 'Expected stable tag vN.N.N.')
    version(tag[1:], stable=True)
    return tag[1:]


def decode_json(data):
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError):
        raise DraftError('Invalid JSON metadata.') from None
    require(isinstance(value, dict), 'Expected JSON object.')
    return value


def manifest_check(manifest, expected):
    require(manifest.get('version') == expected, 'Manifest version differs from release tag.')
    require(manifest.get('manifest_version') == 3 and isinstance(manifest.get('name'), str)
            and bool(manifest['name'].strip()), 'Invalid extension manifest metadata.')
    require(manifest.get('background') == {'service_worker': 'service-worker.js'},
            'Unexpected service worker configuration.')
    require(manifest.get('icons') == {'16': 'icons/icon16.png', '48': 'icons/icon48.png', '128': 'icons/icon128.png'},
            'Unexpected icon configuration.')
    scripts = manifest.get('content_scripts')
    require(isinstance(scripts, list) and len(scripts) == 1 and isinstance(scripts[0], dict)
            and scripts[0].get('js') == ['audio-booster.js'] and not scripts[0].get('css'),
            'Unexpected content script configuration.')
    # This package has no other local resources; fail closed if build layout changes.
    require(not any(manifest.get(k) for k in ('web_accessible_resources', 'options_page', 'options_ui',
                                             'devtools_page', 'chrome_url_overrides', 'sandbox')),
            'Unsupported extension resource configuration.')
    action = manifest.get('action', {})
    require(isinstance(action, dict) and not action.get('default_popup'), 'Unsupported popup resource.')


def plain_file(path):
    require(not path.is_symlink() and path.is_file(), 'Expected regular file; symlinks are forbidden.')
    require(path.stat().st_size <= MAX_SIZE, 'Package file exceeds size limit.')
    return path.read_bytes()


def package(root, tag, output):
    root, output = Path(root), Path(output)
    expected = tag_version(tag)
    require(not (root / 'dist').is_symlink(), 'Symlinked dist is forbidden.')
    require(decode_json(plain_file(root / 'package.json')).get('version') == expected,
            'Package version differs from release tag.')
    manifest_check(decode_json(plain_file(root / 'manifest.json')), expected)
    names = set()
    for path in (root / 'dist').rglob('*'):
        require(not path.is_symlink(), 'Symlinks in dist are forbidden.')
        if path.is_dir():
            require(path.relative_to(root / 'dist').as_posix() == 'icons', 'Unexpected dist directory.')
        else:
            names.add(path.relative_to(root / 'dist').as_posix())
    require(names == FILES, 'Dist must contain exactly the approved package files; no extras or secrets.')
    data = {name: plain_file(root / 'dist' / name) for name in sorted(FILES)}
    manifest_check(decode_json(data['manifest.json']), expected)
    require(decode_json(data['manifest.json']) == decode_json(plain_file(root / 'manifest.json')),
            'Root and dist manifests differ.')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, content in data.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, content)
    payload = buffer.getvalue()
    require(len(payload) <= MAX_SIZE, 'Archive exceeds size limit.')
    try:
        with output.open('xb') as stream:
            stream.write(payload)
    except FileExistsError:
        raise DraftError('Archive already exists; refusing overwrite.') from None
    return hashlib.sha256(payload).hexdigest()


def archive_bytes(path, tag, sha256):
    expected = tag_version(tag)
    require(isinstance(sha256, str) and re.fullmatch('[0-9a-f]{64}', sha256), 'Invalid expected SHA256.')
    data = plain_file(Path(path))
    require(hashlib.sha256(data).hexdigest() == sha256, 'Archive SHA256 mismatch.')
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            require(len(entries) == len(FILES) and {e.filename for e in entries} == FILES,
                    'Archive contains unexpected, missing or duplicate paths.')
            require(sum(e.file_size for e in entries) <= MAX_SIZE, 'Expanded archive exceeds size limit.')
            for entry in entries:
                require(stat.S_ISREG(entry.external_attr >> 16) and not entry.flag_bits & 1,
                        'Archive entries must be unencrypted regular files.')
                archive.read(entry)  # Validate CRC for every approved entry.
            manifest_check(decode_json(archive.read('manifest.json')), expected)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise DraftError('Invalid ZIP archive.') from None
    return data


def check_archive(path, tag, sha256):
    return hashlib.sha256(archive_bytes(path, tag, sha256)).hexdigest()


def config(env):
    keys = ('CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID')
    require(all(isinstance(env.get(k), str) and env[k].strip() for k in keys), 'Missing required CWS configuration.')
    require(re.fullmatch('[A-Za-z0-9_-]{1,128}', env['CWS_PUBLISHER_ID']), 'Invalid publisher ID.')
    require(re.fullmatch('[a-p]{32}', env['CWS_EXTENSION_ID']), 'Invalid extension ID.')
    return 'publishers/' + env['CWS_PUBLISHER_ID'] + '/items/' + env['CWS_EXTENSION_ID']


def sign_rs256(private_key, message):
    """Linux only: OpenSSL sees an anonymous memory fd, never a key file/argv value."""
    fd = None
    try:
        fd = os.memfd_create('cws-signing-key', os.MFD_CLOEXEC)
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(private_key.encode('ascii'))
        os.lseek(fd, 0, os.SEEK_SET)
        signed = subprocess.run(
            ['/usr/bin/openssl', 'dgst', '-sha256', '-sign', '/proc/self/fd/' + str(fd),
             '-sigopt', 'rsa_padding_mode:pkcs1'],
            input=message, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            pass_fds=(fd,), env={'PATH': '/usr/bin:/bin'}, timeout=30, check=True)
        require(bool(signed.stdout), 'Service account signing failed.')
        return signed.stdout
    except Exception:
        raise DraftError('Service account signing failed.') from None
    finally:
        if fd is not None:
            os.close(fd)


def authentication_form(env, *, signer=sign_rs256, now=time.time):
    oauth_keys = ('CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN')
    service = env.get('CWS_SERVICE_ACCOUNT_JSON')
    has_service = service is not None and service != ''
    has_oauth = any(env.get(k) not in (None, '') for k in oauth_keys)
    require(not (has_service and has_oauth), 'Ambiguous CWS authentication; configure only one method.')
    if not has_service:
        require(all(isinstance(env.get(k), str) and env[k].strip() for k in oauth_keys),
                'Missing CWS authentication: configure service account JSON or complete OAuth credentials.')
        return urllib.parse.urlencode({'client_id': env['CWS_CLIENT_ID'], 'client_secret': env['CWS_CLIENT_SECRET'],
                                       'refresh_token': env['CWS_REFRESH_TOKEN'], 'grant_type': 'refresh_token'}).encode()
    try:
        require(isinstance(service, str) and len(service) <= 65536, 'Invalid service account configuration.')
        account = decode_json(service)
        require(account.get('type') == 'service_account' and account.get('token_uri') == TOKEN_URL,
                'Invalid service account configuration.')
        email, key = account.get('client_email'), account.get('private_key')
        require(isinstance(email, str) and len(email) <= 254 and re.fullmatch(
            r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+gserviceaccount\.com', email),
            'Invalid service account configuration.')
        require(isinstance(key, str) and re.fullmatch(
            r'-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n?', key),
            'Invalid service account configuration.')
        base64.b64decode(''.join(key.splitlines()[1:-1]), validate=True)
        issued = int(now())
        def encode(value):
            return base64.urlsafe_b64encode(value).rstrip(b'=')
        header = encode(b'{"alg":"RS256","typ":"JWT"}')
        claims = encode(json.dumps({'iss': email, 'scope': 'https://www.googleapis.com/auth/chromewebstore',
                                    'aud': TOKEN_URL, 'iat': issued, 'exp': issued + 3600},
                                   separators=(',', ':')).encode('ascii'))
        unsigned = header + b'.' + claims
        signature = signer(key, unsigned)
        require(isinstance(signature, bytes) and bool(signature), 'Service account signing failed.')
        assertion = unsigned + b'.' + encode(signature)
        return urllib.parse.urlencode({'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                                       'assertion': assertion.decode('ascii')}).encode('ascii')
    except Exception:
        raise DraftError('Invalid service account configuration or signing failed.') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_request(method, url, headers, body, timeout):
    # Second independent transport boundary: only these exact forms are allowed.
    resource = r'publishers/[A-Za-z0-9_-]{1,128}/items/[a-p]{32}'
    allowed = ((method == 'POST' and url == TOKEN_URL)
               or (method == 'GET' and re.fullmatch(re.escape(API) + 'v2/' + resource + ':fetchStatus', url))
               or (method == 'POST' and re.fullmatch(re.escape(API) + 'upload/v2/' + resource + ':upload', url)))
    require(allowed, 'Network endpoint is not allowed.')
    try:
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            require(response.status == 200, 'Network request failed; inspect store manually before retry.')
            data = response.read(1024 * 1024 + 1)
            require(len(data) <= 1024 * 1024, 'API response exceeds size limit.')
            return decode_json(data)
    except Exception:
        raise DraftError('Network request failed; inspect store manually before retry.') from None


def identity(response, name, item):
    require(response.get('name') == name and response.get('itemId') == item, 'Store response identity mismatch.')


def status_check(response, name, item, proposed):
    identity(response, name, item)
    require(response.get('warned', False) is False and response.get('takenDown', False) is False,
            'Store warning or takedown requires manual attention.')
    async_state = response.get('lastAsyncUploadState')
    require(async_state is None or (isinstance(async_state, str) and async_state in UPLOAD_STATES),
            'Unknown async upload state.')
    versions = []
    for field in REVISION_FIELDS:
        revision = response.get(field)
        if revision is None:
            continue
        require(isinstance(revision, dict), 'Invalid store revision metadata.')
        allowed = {'PUBLISHED', 'PUBLISHED_TO_TESTERS'} if field == REVISION_FIELDS[0] else {'REJECTED', 'CANCELLED'}
        require(revision.get('state') in allowed, 'Active submission or unknown revision state; inspect store manually.')
        channels = revision.get('distributionChannels', [])
        require(isinstance(channels, list), 'Invalid distribution channels.')
        for channel in channels:
            require(isinstance(channel, dict), 'Invalid distribution channel.')
            versions.append(version(channel.get('crxVersion')))
        if field == REVISION_FIELDS[0]:
            require(bool(channels), 'Published version metadata is missing.')
    require(not versions or version(proposed, stable=True) > max(versions),
            'Proposed version must exceed every published/submitted version.')
    return {key: response.get(key) for key in REVISION_FIELDS}


def upload(path, tag, sha256, env, *, transport=http_request, sleep=time.sleep, polls=30,
           signer=sign_rs256, now=time.time):
    require(type(polls) is int and 1 <= polls <= 60, 'Polling limit must be between 1 and 60.')
    data = archive_bytes(path, tag, sha256)
    expected = tag_version(tag)
    name = config(env)
    item = env['CWS_EXTENSION_ID']

    def request(method, url, headers, body=None):
        try:
            response = transport(method, url, headers, body, 30)
        except Exception:
            raise DraftError('Network request failed; inspect store manually before retry.') from None
        require(isinstance(response, dict) and 'error' not in response, 'API request failed; inspect store manually before retry.')
        return response

    form = authentication_form(env, signer=signer, now=now)
    token = request('POST', TOKEN_URL, {'Content-Type': 'application/x-www-form-urlencoded'}, form)
    access = token.get('access_token')
    require(isinstance(access, str) and access and not any(c in access for c in '\r\n'), 'OAuth response has no valid access token.')
    assert isinstance(access, str)
    auth = {'Authorization': 'Bearer ' + access}
    status_url = API + 'v2/' + name + ':fetchStatus'
    before = request('GET', status_url, auth)
    snapshot = status_check(before, name, item, expected)
    require(before.get('lastAsyncUploadState') != 'IN_PROGRESS', 'Existing upload is still in progress.')
    response = request('POST', API + 'upload/v2/' + name + ':upload',
                       dict(auth, **{'Content-Type': 'application/zip'}), data)
    identity(response, name, item)
    state = response.get('uploadState')
    require(isinstance(state, str) and state in {'SUCCEEDED', 'IN_PROGRESS'},
            'Upload failed or has unknown state; inspect store manually before retry.')
    verified = state == 'SUCCEEDED'
    if verified:
        require(response.get('crxVersion') == expected, 'Uploaded version mismatch; inspect store manually.')
    elif 'crxVersion' in response:
        require(response['crxVersion'] == expected, 'Uploaded version mismatch; inspect store manually.')
    # Mandatory exact-target readback after mutation, including synchronous success.
    for _ in range(polls if not verified else 1):
        if not verified:
            sleep(5)
        after = request('GET', status_url, auth)
        require(status_check(after, name, item, expected) == snapshot,
                'Published/submitted store status changed concurrently; inspect store manually.')
        last = after.get('lastAsyncUploadState')
        if verified:
            # Stale async metadata can cause a false alarm; prefer manual inspection.
            require(last in {None, 'SUCCEEDED'}, 'Conflicting or failed upload status; inspect store manually.')
            break
        require(last in {'IN_PROGRESS', 'SUCCEEDED'}, 'Async upload failed or status is unknown; inspect store manually.')
        if last == 'SUCCEEDED':
            break
    else:
        raise DraftError('Async upload polling timed out; inspect store manually before retry.')
    # Async fetchStatus is item-level: no operation ID or draft-version correlation.
    return {'upload_processed': True, 'upload_response_version_verified': verified,
            'item_level_completion_observed': True, 'upload_operation_correlation_verified': False,
            'manual_dashboard_verification_required': True, 'published_and_submitted_status_unchanged': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    pack = sub.add_parser('package', help='Offline: validate versions and create a new archive.')
    pack.add_argument('--root', type=Path, default=Path('.'))
    pack.add_argument('--output', type=Path, required=True)
    pack.add_argument('--tag', required=True)
    for mode in ('check', 'upload'):
        command = sub.add_parser(mode, help='Offline artifact validation.' if mode == 'check' else 'Upload draft only; requires CWS environment.')
        command.add_argument('--archive', type=Path, required=True)
        command.add_argument('--tag', required=True)
        command.add_argument('--sha256', required=True)
    args = parser.parse_args()
    try:
        if args.mode == 'package':
            result = {'sha256': package(args.root, args.tag, args.output)}
        elif args.mode == 'check':
            result = {'sha256': check_archive(args.archive, args.tag, args.sha256)}
        else:
            result = upload(args.archive, args.tag, args.sha256, os.environ)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        # Never include raw exceptions, which may contain OAuth/API response data.
        print(str(error) if isinstance(error, DraftError) else 'Operation failed; inspect local inputs/store manually.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

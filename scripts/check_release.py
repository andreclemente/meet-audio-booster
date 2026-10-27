#!/usr/bin/env python3
"""Offline release gate; print immutable checkout outputs after local Git checks."""
import os
import re
import subprocess
import sys


def git(*args):
    return subprocess.check_output(['git', *args], text=True, stderr=subprocess.DEVNULL).strip()


def check_release(tag, event_sha):
    if not re.fullmatch(r'v(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){2}', tag, re.ASCII):
        raise ValueError('Expected stable tag vN.N.N')
    parts = [int(p) for p in tag[1:].split('.')]
    if max(parts) > 65535 or not any(parts):
        raise ValueError('Invalid Chrome version')
    trusted_sha = git('rev-parse', 'HEAD')
    release_sha = git('rev-parse', '--verify', f'refs/tags/{tag}^{{commit}}')
    # github.sha remains the original release event commit on full reruns.
    # Never reinterpret it as a mutable ref or accept an abbreviated object ID.
    if not re.fullmatch(r'[0-9a-f]{40}', event_sha) or release_sha != event_sha:
        raise ValueError('Release tag does not match exact event commit')
    git('merge-base', '--is-ancestor', release_sha, 'origin/main')
    return f'trusted_sha={trusted_sha}\nrelease_sha={release_sha}\ntag={tag}\n'


def main():
    try:
        outputs = check_release(os.environ['RELEASE_TAG'], os.environ['RELEASE_EVENT_SHA'])
    except (KeyError, ValueError, subprocess.CalledProcessError) as error:
        print(str(error) if isinstance(error, ValueError) else 'Release Git gate failed.', file=sys.stderr)
        return 1
    print(outputs, end='')
    return 0


if __name__ == '__main__':
    sys.exit(main())

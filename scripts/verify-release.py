#!/usr/bin/env python3
"""Inspect a release tarball without extracting files or disclosing matched secrets."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
import tempfile


REQUIRED = {
    'package/package.json', 'package/README.md', 'package/LICENSE', 'package/CHANGELOG.md',
    'package/cordis.patch.yml', 'package/lib/index.js', 'package/lib/index.d.ts',
    'package/scripts/relay-web.py', 'package/scripts/relay-watchdog.py',
    'package/scripts/verify-release.py', 'package/docs/011-native-implementation.md',
}
PRIVATE_NAMES = {'.env', '.env.local', 'hosts.yml', 'discord.json', 'discord-bot-token',
                 'web-cookies', 'node_modules', '.git', '__pycache__'}
MAX_FILE = 32 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
TOKEN = re.compile(rb'(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})')
HOME = re.compile(rb'/(?:Users|home)/[^/\s"<>]+/')


def verify(archive: Path, expected_version: str | None = None, secrets: tuple[bytes, ...] = ()) -> dict:
    """Return categories only; member names and matched credential bytes stay private."""
    issues: set[str] = set()
    names: set[str] = set()
    data: dict[str, bytes] = {}
    total = 0
    count = 0
    with tarfile.open(archive, 'r:*') as bundle:
        for member in bundle:
            count += 1
            if count > 10000:
                issues.add('too_many_members')
                break
            path = PurePosixPath(member.name)
            canonical = path.as_posix()
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'package' or '\\' in member.name:
                issues.add('unsafe_member_path')
            if canonical in names:
                issues.add('duplicate_member')
            names.add(canonical)
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                issues.add('unsafe_member_type')
                continue
            if any(part in PRIVATE_NAMES or part.startswith('.env.') for part in path.parts):
                issues.add('private_or_generated_file')
            if not member.isfile():
                continue
            total += member.size
            if member.size > MAX_FILE or total > MAX_TOTAL:
                issues.add('unpacked_size_limit')
                break
            stream = bundle.extractfile(member)
            content = stream.read(MAX_FILE + 1) if stream else b''
            if TOKEN.search(content) or any(secret and secret in content for secret in secrets):
                issues.add('credential_match')
            if HOME.search(content):
                issues.add('developer_home_path')
            if canonical in REQUIRED:
                data[canonical] = content
    if REQUIRED - data.keys():
        issues.add('missing_runtime_assets')
    version = None
    try:
        manifest = json.loads(data.get('package/package.json', b''))
        version = manifest['version']
        if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version):
            issues.add('invalid_package_version')
            version = None
        if manifest.get('name') != 'dsh-superagent-relay':
            issues.add('unexpected_package_name')
        if expected_version is not None and version != expected_version:
            issues.add('version_mismatch')
    except (ValueError, KeyError, TypeError):
        issues.add('invalid_package_manifest')
    hasher = hashlib.sha256()
    with archive.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    return {'passed': not issues, 'version': version if not issues else None, 'sha256': digest,
            'archive_members': count, 'issues': sorted(issues)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--version')
    parser.add_argument('--secret-file', type=Path, action='append', default=[],
                        help='Private file containing one exact credential; never included in output.')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        if args.output and args.output.resolve() in {path.resolve() for path in [args.archive, *args.secret_file]}:
            print(json.dumps({'passed': False, 'issues': ['output_overwrites_input']}))
            return 1
        secrets = tuple(path.read_bytes().strip() for path in args.secret_file)
        report = verify(args.archive, args.version, secrets)
        if args.output:
            descriptor, temporary = tempfile.mkstemp(dir=args.output.parent, prefix='.release-check-')
            try:
                with os.fdopen(descriptor, 'w') as stream:
                    json.dump(report, stream, indent=2)
                    stream.write('\n')
                os.replace(temporary, args.output)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
    except (OSError, tarfile.TarError, ValueError, EOFError):
        report = {'passed': False, 'issues': ['unreadable_or_invalid_input']}
    print(json.dumps(report))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())

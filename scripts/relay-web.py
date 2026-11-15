#!/usr/bin/env python3
"""Start a native Superagent Web deployment with a dedicated GitHub identity (no fixture mode)."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def private_json(path: Path, data: object) -> None:
    """Atomically replace a private config, never exposing an authentication token."""
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.')
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(data, stream, indent=2)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def account_json(cli: str, arguments: list[str], env: dict[str, str]) -> object:
    """Run bounded account probes; raw CLI errors might contain secrets and are not displayed."""
    try:
        result = subprocess.run([cli, *arguments], env=env, capture_output=True, text=True, timeout=30, check=True)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        raise RuntimeError('Dedicated GitHub account check failed. Sign in through the supplied wrapper and verify its access.') from None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, required=True, help='A private DSH home for this native deployment.')
    parser.add_argument('--repository', required=True, help='owner/repo')
    parser.add_argument('--github-cli', type=Path, required=True, help='Absolute path to the dedicated gh wrapper.')
    parser.add_argument('--agent-login', required=True)
    parser.add_argument('--allow-github', action='append', default=[])
    parser.add_argument('--discord-config', type=Path)
    parser.add_argument('--permission', choices=['read-only', 'workspace-write', 'danger-full-access'], default='workspace-write')
    parser.add_argument('--profile', default='superagent')
    parser.add_argument('--port', type=int, default=3085)
    parser.add_argument('--dsh', default=os.environ.get('SUPERAGENT_DSH', 'dsh'))
    parser.add_argument('--magpie-url', help='Optional OpenAI-compatible Magpie endpoint; key comes from MAGPIE_GATEWAY_KEY or this native home/.env.')
    parser.add_argument('--model', default='zhipu/glm-5.3-flash')
    parser.add_argument('--supervise', action='store_true', help='Run with a local watchdog and authenticated health checks.')
    parser.add_argument('--initialize', action='store_true', help='Create a missing profile and install this local package.')
    parser.add_argument('--check-only', action='store_true', help='Verify identity and access without modifying or starting a profile.')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository):
        parser.error('Expected repository owner/name')
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*', args.profile) or not 1024 <= args.port <= 65535:
        parser.error('Invalid profile or port')
    if not args.github_cli.is_absolute() or not os.access(args.github_cli, os.X_OK):
        parser.error('--github-cli must name an executable absolute-path wrapper')
    if args.agent_login.lower() == args.repository.split('/')[0].lower():
        parser.error('Use a dedicated bot identity, separate from the repository owner')
    if not all(re.fullmatch(r'[A-Za-z0-9-]+', login) for login in [args.agent_login, *args.allow_github]):
        parser.error('Invalid GitHub login')
    if args.discord_config:
        args.discord_config = args.discord_config.resolve(strict=True)
        config = json.loads(args.discord_config.read_text())
        if set(config) != {'channel', 'owner', 'tokenFile'} or not all(re.fullmatch(r'\d{16,22}', str(config.get(key, ''))) for key in ('channel', 'owner')):
            parser.error('Invalid Discord configuration')
        if not Path(config['tokenFile']).is_absolute() or not Path(config['tokenFile']).is_file():
            parser.error('Discord tokenFile must name a private, existing absolute path')
    env = dict(os.environ)
    for name in ('GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'DSH_SUPERAGENT_LOCAL_FIXTURE', 'DSH_SUPERAGENT_READ_ONLY',
                 'DSH_SUPERAGENT_RECOVERY_FIXTURE', 'DSH_SUPERAGENT_DISCORD_LAB', 'DSH_SUPERAGENT_DISCORD_CHAT'):
        env.pop(name, None)
    identity = account_json(str(args.github_cli), ['api', 'user', '--jq', '{login:.login}'], env)
    if not isinstance(identity, dict) or identity.get('login', '').lower() != args.agent_login.lower():
        raise RuntimeError('The GitHub wrapper is signed in to a different account; native startup refused.')
    access = account_json(str(args.github_cli), ['api', f'repos/{args.repository}', '--jq', '{push:.permissions.push}'], env)
    if not isinstance(access, dict) or access.get('push') is not True:
        raise RuntimeError('The dedicated bot does not have repository Write access. Accept its invitation and retry.')
    print(f'Identity verified: {args.agent_login}; repository Write access verified; mode: {args.permission}', flush=True)
    if args.check_only:
        return 0
    dsh = shutil.which(args.dsh)
    if not dsh:
        raise RuntimeError('DSH executable not found; set --dsh or SUPERAGENT_DSH.')
    os.umask(0o077)
    home = args.home.resolve()
    home.mkdir(parents=True, mode=0o700, exist_ok=True)
    env['DSH_HOME'] = str(home)
    if args.magpie_url:
        from urllib.parse import urlsplit
        endpoint = urlsplit(args.magpie_url)
        if endpoint.scheme not in ('http', 'https') or not endpoint.hostname or endpoint.username or endpoint.password:
            raise RuntimeError('Invalid provider endpoint; keep credentials in MAGPIE_GATEWAY_KEY.')
        if not env.get('MAGPIE_GATEWAY_KEY') and (home / '.env').is_file():
            for line in (home / '.env').read_text().splitlines():
                name, separator, value = line.partition('=')
                if separator and name.strip() == 'MAGPIE_GATEWAY_KEY':
                    env['MAGPIE_GATEWAY_KEY'] = value.strip().strip('\"\'')
        if not env.get('MAGPIE_GATEWAY_KEY'):
            raise RuntimeError('Missing MAGPIE_GATEWAY_KEY in the environment or native home/.env.')

    profile = home / 'profiles' / args.profile
    if not (profile / 'package.json').is_file():
        if not args.initialize:
            raise RuntimeError('Profile is missing; use --initialize once to create and install it.')
        subprocess.run([dsh, args.profile, '--from-default-profile', 'web', '--dump-config'], env=env, check=True, stdout=subprocess.DEVNULL)
        root = Path(__file__).resolve().parent.parent
        subprocess.run([dsh, 'plugin', '--profile', args.profile, 'add', f'link:{root}'], env=env, check=True)
    bootstrap = home / 'relay-bootstrap.json'
    private_json(bootstrap, {'repository': args.repository, 'githubCli': str(args.github_cli), 'agentLogin': args.agent_login,
                            'githubAllowed': args.allow_github, 'permissionPreset': args.permission,
                            **({'discordConfigFile': str(args.discord_config)} if args.discord_config else {})})
    env['DSH_SUPERAGENT_INITIAL_CONFIG'] = str(bootstrap)
    patch = home / 'relay-runtime.json'
    entries = [{'id': 'dsh-superagent', 'config': {'stateDir': str(home / 'state')}},
               {'id': 'dsh-superagent-feishu', 'disabled': True}]
    if args.magpie_url:
        entries.extend([{'id': 'llm-pi-ai', 'name': '@deepseek-ai/dsh-llm-pi-ai', 'config': {'providers': {'magpie': {
            'apiKeyEnv': 'MAGPIE_GATEWAY_KEY', 'api': 'openai-completions', 'baseURL': args.magpie_url,
            'models': [{'id': args.model, 'name': args.model, 'contextWindow': 1000000, 'maxTokens': 131072, 'input': ['text']}]}}}},
            {'id': 'agent-default-model', 'config': {'provider': 'magpie', 'model': args.model}}])
    private_json(patch, entries)
    if args.supervise:
        import importlib.util
        spec = importlib.util.spec_from_file_location('relay_watchdog', Path(__file__).with_name('relay-watchdog.py'))
        watchdog = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(watchdog)
        return watchdog.supervise([dsh, args.profile, '--patch', str(patch), '--host', '127.0.0.1', '--port', str(args.port), '--no-open'], env, home)
    os.execve(dsh, [dsh, args.profile, '--patch', str(patch), '--host', '127.0.0.1', '--port', str(args.port), '--no-open'], env)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        # Never include CLI stderr, process arguments or an authentication URL.
        print(str(error) if isinstance(error, RuntimeError) else type(error).__name__, file=sys.stderr)
        sys.exit(1)

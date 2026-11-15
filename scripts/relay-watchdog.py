#!/usr/bin/env python3
"""Local process watchdog with authenticated health probes and credential-free status snapshots."""
import fcntl
import http.cookiejar
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import time
import urllib.request


def supervise(command: list[str], env: dict[str, str], home: Path) -> int:
    """Restart crashes/unreachable hosts with bounded backoff; SIGTERM/INT intentionally stop the service."""
    lock = (home / 'relay-service.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('Another native Relay supervisor is already running.') from None
    stopping = False
    child = None
    previous = {}
    def stop(signum, frame):
        nonlocal stopping
        stopping = True
    for signum in (signal.SIGTERM, signal.SIGINT):
        previous[signum] = signal.signal(signum, stop)
    def status(state, **values):
        path = home / 'relay-service-status.json'
        descriptor = os.open(str(path) + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            json.dump({'state': state, 'pid': os.getpid(), 'child_pid': child.pid if child else None,
                       'checked_at': time.time(), **values}, stream)
        os.replace(str(path) + '.tmp', path)
    def terminate():
        if child is None:
            return
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=30)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
    failures = 0
    try:
        while not stopping:
            status('starting', restart_count=failures)
            child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, start_new_session=True, bufsize=0)
            client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            startup, base, probe_failures = b'', None, 0
            started = time.monotonic()
            next_probe = 0.0
            while not stopping and child.poll() is None:
                if select.select([child.stdout], [], [], 0.5)[0]:
                    chunk = os.read(child.stdout.fileno(), 65536)
                    # DSH prints a one-time authentication URL. Keep it in memory only, then discard it.
                    if base is None:
                        startup = (startup + chunk)[-100000:]
                        found = re.search(rb'(http://127\.0\.0\.1:\d+)/\?token=[^\s\x1b]+', startup)
                        if found:
                            try:
                                with client.open(found[0].decode(), timeout=5):
                                    pass
                                base = found[1].decode()
                                startup = b''
                            except Exception:
                                # Retry authentication while the listener finishes starting.
                                pass
                if base is None:
                    if time.monotonic() - started > 60:
                        status('unreachable', reason='authentication_or_startup_timeout')
                        break
                    continue
                if time.monotonic() < next_probe:
                    continue
                next_probe = time.monotonic() + 3
                try:
                    request = urllib.request.Request(base + '/orchestrator/api/state', headers={'x-orchestrator-request': '1'})
                    with client.open(request, timeout=5) as response:
                        data = json.load(response)
                    if not isinstance(data, dict) or 'setup' not in data:
                        raise ValueError('unexpected health schema')
                    # Never persist ticket content, model text, CLI errors or full health details.
                    setup = data.get('setup') or {}
                    status('running', base=base, restart_count=failures, setup_ready=bool(setup.get('accounts')) and setup.get('problem') is None,
                           health={key: value.get('state') for key, value in data.get('health', {}).items() if isinstance(value, dict)})
                    probe_failures = 0
                    if time.monotonic() - started > 120:
                        failures = 0
                except Exception:
                    probe_failures += 1
                    status('unreachable', failed_probes=probe_failures)
                    if probe_failures >= 3:
                        break
            terminate()
            if stopping:
                break
            failures += 1
            status('recovering', restart_count=failures)
            deadline = time.monotonic() + min(30, 2 ** min(failures, 5))
            while not stopping and time.monotonic() < deadline:
                time.sleep(0.25)
        status('stopped', intentional=True)
        return 0
    finally:
        terminate()
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        lock.close()

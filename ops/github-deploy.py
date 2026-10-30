#!/usr/bin/env python3
"""Restricted SSH receiver for GitHub builds; configuration and secrets stay on the host.

Install with a root-owned /etc/opennavo/github-deploy.json. This receiver is
intended for the existing versioned Compose/Caddy deployment, not first install.
"""
import base64
import concurrent.futures
import contextlib
import copy
import fcntl
import hashlib
import io
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

# DNS targets expose IP scrape URLs; the discovered DNS name identifies the release.
# Require every configured replica of each job to be healthy, not just one matching endpoint.
MONITORING_HEALTH_SCRIPT = """const base = 'http://prometheus:9090/api/v1/targets';
const expected = JSON.parse(process.argv[1]);
const webCount = Number(process.argv[2] || 1);
for(let i=0;i<30;i++) {
  try {
    const d=await fetch(base,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
    if(d.status==='success' && Object.entries(expected).every(([job,address])=>{
      const targets=d.data.activeTargets.filter(t=>(t.discoveredLabels?.job ?? t.labels.job)===job);
      const wanted=new URL('http://'+address+'/metrics');
      const required = job === 'web' ? webCount : 1;
      return targets.length >= required && targets.every(t=>{
        const actual=new URL(t.scrapeUrl);
        const dnsName=t.discoveredLabels?.__meta_dns_name;
        const identity=dnsName===undefined ? actual.host===wanted.host : dnsName===wanted.hostname;
        return identity && t.health==='up' && actual.protocol===wanted.protocol &&
          actual.port===wanted.port && actual.pathname===wanted.pathname && !actual.search;
      });
    })) process.exit(0);
  } catch {}
  await new Promise(r=>setTimeout(r,2000));
}
process.exit(1);"""

MAX_ARCHIVE = 40 * 1024 * 1024
RELEASE_NAME = re.compile(r'gh-[0-9a-f]{12}-[0-9]{1,20}-[0-9]{1,4}')
# Each release snapshot holds that deployment's pre-migration database dump.
RELEASE_RETENTION = 5
WEB_ASSET_RETENTION_SECONDS = 7 * 24 * 60 * 60
GIB = 1024 ** 3
DEFAULT_WEB_REPLICAS = 1
MIN_MEM_AVAILABLE_BASE = 1 * GIB
MIN_MEM_AVAILABLE_PER_EXTRA_REPLICA = 2 * GIB
DRAIN_GRACE_SECONDS = 300
DRAIN_POLL_TIMEOUT_SECONDS = 90
ROLLBACK_DRAIN_TIMEOUT_SECONDS = 30
PUBLIC_MCP_BEGIN = '# BEGIN opennavo public-mcp'
PUBLIC_MCP_END = '# END opennavo public-mcp'
PUBLIC_MCP_PROXY_IP = '172.30.80.3'
PUBLIC_MCP_PROXY_IP_ALT = '172.30.80.4'
PUBLIC_MCP_PROXY_IP_TOKEN = '${PUBLIC_MCP_PROXY_IP:-' + PUBLIC_MCP_PROXY_IP + '}/32'
PUBLIC_MCP_PROXY_IP_ALT_TOKEN = '${PUBLIC_MCP_PROXY_IP_ALT:-' + PUBLIC_MCP_PROXY_IP_ALT + '}/32'
PUBLIC_MCP_PROXY_TOKENS = (PUBLIC_MCP_PROXY_IP_TOKEN, PUBLIC_MCP_PROXY_IP_ALT_TOKEN)
DEFAULT_TRUSTED_PROXIES = ('${CADDY_PROXY_IP:-172.30.80.2},' +
                           PUBLIC_MCP_PROXY_IP_TOKEN + ',' + PUBLIC_MCP_PROXY_IP_ALT_TOKEN +
                           ',${SSR_PROXY_SUBNET:-172.30.81.0/24}')
APPLICATION_SERVICES = ('api', 'web', 'mcp', 'public-mcp', 'admin')
APPLICATION_SERVICE_PATTERN = r'(?:api|web|mcp|public-mcp|admin)(?:_[A-Za-z0-9_]+)?'
WARM_HOST = 'opennavo.com'
WARM_ORIGIN = 'http://127.0.0.1:3000'
WARM_INTERNAL_ORIGIN = 'http://127.0.0.1:9091'
WARM_PATHS = [
    '/', '/zh', '/ja', '/es', '/ru', '/download', '/zh/download', '/ja/download',
    '/es/download', '/ru/download', '/apps', '/recent', '/ru/apps', '/es/recent',
    '/apps/airbuild', '/apps/agentide'
]
PUBLIC_WARM_PATH = re.compile(r'/[A-Za-z0-9/_@+.,~:-]*\Z')
PRIVATE_WARM_PREFIXES = (
    '/api', '/admin', '/agent-api', '/auth', '/oauth', '/login', '/reset', '/callback',
    '/.', '/_', '/assets', '/icons', '/screenshots', '/sitemap', '/robots'
)
WARM_SCRIPT = r'''const paths=JSON.parse(process.argv[1]);
const origin=process.argv[2];
const host=process.argv[3];
const readyOrigin=process.argv[4];
const secondPassDurations=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(let pass=0;pass<2;pass++) {
  for(const path of paths) {
    const start=performance.now();
    try {
      const response=await fetch(origin+path,{
        redirect:'manual',signal:AbortSignal.timeout(15000),
        headers:{host,accept:'text/html','x-forwarded-proto':'https','user-agent':'OpenNavo-Warmup/1.0'}});
      await response.arrayBuffer();
      const elapsed=performance.now()-start;
      console.log(`warm pass=${pass+1} path=${path} status=${response.status} ms=${Math.round(elapsed)}`);
      if(response.status>=500) process.exit(1);
      if(pass===1) secondPassDurations.push(elapsed);
    } catch(error) {
      console.error(`warm failed pass=${pass+1} path=${path}: ${error?.name ?? 'request error'}`);
      process.exit(1);
    }
    await delay(500);
  }
}
secondPassDurations.sort((a,b)=>a-b);
const middle=Math.floor(secondPassDurations.length/2);
const median=secondPassDurations.length%2 ? secondPassDurations[middle] :
  (secondPassDurations[middle-1]+secondPassDurations[middle])/2;
if(median>3000) {
  console.error(`warm second-pass median exceeded 3000ms: ${Math.round(median)}ms`);
  process.exit(1);
}
for(let i=0;i<3;i++) {
  try {
    const response=await fetch(readyOrigin+'/readyz',{signal:AbortSignal.timeout(2500)});
    await response.arrayBuffer();
    console.log(`candidate ready check=${i+1} status=${response.status}`);
    if(response.status>=500) process.exit(1);
  } catch(error) {
    console.error(`candidate ready check failed: ${error?.name ?? 'request error'}`);
    process.exit(1);
  }
  await delay(1000);
}'''
DRAIN_SCRIPT = r'''const response=await fetch(process.argv[1]+'/metrics',{signal:AbortSignal.timeout(2500)});
if(!response.ok) process.exit(1);
const text=await response.text();
const match=text.match(/^opennavo_web_http_in_flight (\d+)$/m) ?? text.match(/^opennavo_web_in_flight (\d+)$/m);
if(!match) process.exit(1);
console.log(match[1]);'''


def configured_web_replicas(config):
    value = config.get('web_replicas', DEFAULT_WEB_REPLICAS)
    if isinstance(value, bool):
        raise ValueError('web_replicas must be a positive integer')
    if isinstance(value, int):
        replicas = value
    elif isinstance(value, str) and re.fullmatch(r'[1-9][0-9]*', value):
        replicas = int(value)
    else:
        raise ValueError('web_replicas must be a positive integer')
    if replicas < 1 or replicas > 8:
        raise ValueError('web_replicas must be between 1 and 8')
    return replicas


def required_mem_available(config, replicas=None):
    replicas = configured_web_replicas(config) if replicas is None else replicas
    base = int(config.get('web_mem_available_base_mib', MIN_MEM_AVAILABLE_BASE // (1024 ** 2))) * 1024 ** 2
    extra = int(config.get('web_mem_available_per_extra_replica_mib', MIN_MEM_AVAILABLE_PER_EXTRA_REPLICA // (1024 ** 2))) * 1024 ** 2
    if base < 0 or extra < 0:
        raise ValueError('web memory capacity thresholds must be non-negative')
    return base + max(0, replicas - 1) * extra


def mem_available_bytes(text):
    match = re.search(r'^MemAvailable:\s*(\d+)\s*kB\s*$', text, re.M)
    if not match:
        raise RuntimeError('capacity gate: MemAvailable is unavailable')
    return int(match.group(1)) * 1024


def public_warm_path(path):
    if not isinstance(path, str) or len(path) > 300 or not PUBLIC_WARM_PATH.fullmatch(path):
        return False
    # Reject query strings, fragments, encoded separators and duplicate path separators.
    if '//' in path or '..' in path or '%' in path:
        return False
    stripped = re.sub(r'^/(?:zh|zh-hant|ja|es|ru|de|fr|it|pt)(?=/|$)', '', path) or '/'
    if stripped.startswith(PRIVATE_WARM_PREFIXES):
        return False
    return not re.search(r'\.(?:ico|png|svg|webp|jpe?g|js|css|xml|txt|json|map|woff2?|ttf)$', stripped, re.I)


def warm_paths(payload):
    extra = payload.get('warm_paths', [])
    if extra is None:
        extra = []
    if not isinstance(extra, list) or len(extra) > 66:
        raise ValueError('invalid public warm paths')
    if not all(public_warm_path(path) for path in extra):
        raise ValueError('invalid public warm path')
    return list(dict.fromkeys([*WARM_PATHS, *extra]))[:66]


def web_asset_paths(directory):
    return sorted(path.relative_to(directory).as_posix()
                  for path in directory.rglob('*') if path.is_file())


def previous_web_asset_paths(destination):
    """Read the previous release's current asset list, with a legacy fallback.

    Releases created before the manifest was added have no reliable way to
    distinguish current assets from retained assets. Treat every existing file
    as current once so the first deployment after this change gives the whole
    legacy release a fresh retention deadline.
    """
    manifest = destination.parent / 'manifest.json'
    try:
        data = json.loads(manifest.read_text())
        assets = data.get('web_assets') if isinstance(data, dict) else None
    except (OSError, TypeError, ValueError):
        assets = None
    if isinstance(assets, list):
        return {asset for asset in assets
                if isinstance(asset, str) and asset and not PurePosixPath(asset).is_absolute()
                and '..' not in PurePosixPath(asset).parts
                and PurePosixPath(asset).as_posix() == asset}
    return {path.relative_to(destination).as_posix()
            for path in destination.rglob('*') if path.is_file()}


def release_manifest(payload, web_assets):
    manifest = {key: value for key, value in payload.items()
                if key not in ['admin_archive', 'registry_token']}
    manifest['web_assets'] = web_assets
    return manifest


def merge_web_assets(current, destination, now=None, previous_current=None):
    """Keep old fingerprinted assets for seven days and mark current assets as fresh."""
    timestamp = time.time() if now is None else now
    destination.mkdir(parents=True, exist_ok=True)
    current_paths = {source.relative_to(current).as_posix()
                     for source in current.rglob('*') if source.is_file()}
    if previous_current is None:
        previous_current = previous_web_asset_paths(destination)
    # Only the assets that were current in the release being replaced receive a
    # new retention deadline. Older retained assets keep their original mtime.
    for relative in set(previous_current) - current_paths:
        target = destination / relative
        if target.is_file():
            os.utime(target, (timestamp, timestamp))
    for source in current.rglob('*'):
        if not source.is_file():
            continue
        target = destination / source.relative_to(current)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        os.utime(target, (timestamp, timestamp))
    cutoff = timestamp - WEB_ASSET_RETENTION_SECONDS
    for path in destination.rglob('*'):
        if path.is_file() and path.stat().st_mtime < cutoff:
            path.unlink()


def validate(payload, registry):
    if not re.fullmatch(r'[0-9a-f]{40}', payload.get('sha', '')):
        raise ValueError('invalid source revision')
    if not re.fullmatch(r'[0-9]{1,20}', payload.get('run_id', '')):
        raise ValueError('invalid workflow run')
    if not re.fullmatch(r'[0-9]{1,4}', payload.get('run_attempt', '1')):
        raise ValueError('invalid workflow attempt')
    if set(payload.get('images', {})) != {'server', 'web', 'mcp'}:
        raise ValueError('all three application images are required')
    for kind, image in payload['images'].items():
        if not re.fullmatch(re.escape(f'{registry}/opennavo-{kind}@sha256:') + r'[0-9a-f]{64}', image):
            raise ValueError('images must use approved registry digests')
    archive = base64.b64decode(payload['admin_archive'], validate=True)
    if len(archive) > MAX_ARCHIVE or hashlib.sha256(archive).hexdigest() != payload.get('admin_sha256'):
        raise ValueError('invalid admin archive checksum or size')
    # Optional for compatibility with older senders and receivers; unknown fields are ignored by
    # the previous receiver, while this receiver validates the new field before touching the host.
    warm_paths(payload)
    return archive


def extract_admin(data, destination):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        if sum(m.size for m in members) > 160 * 1024 * 1024:
            raise ValueError('admin archive expands beyond the limit')
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError('unsafe admin archive member')
        # Extract only validated regular files/directories; supports older host Python
        # without applying archive ownership, modes, symlinks or device metadata.
        for member in members:
            target = destination.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
    if not (destination / 'index.html').is_file():
        raise ValueError('admin index is missing')


def command(args, output=None):
    result = subprocess.run(args, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=1200)
    if result.returncode:
        # Docker/Compose diagnostics can contain expanded credentials.
        raise RuntimeError(f'command failed: {args[0]} (exit {result.returncode}); inspect privately on host')
    return result.stdout.decode().strip() if output is None else ''


@contextlib.contextmanager
def phase(name):
    # Durations go to the public workflow log, so it shows where a deployment spends its time.
    start = time.monotonic()
    yield
    print(f'{name} took {time.monotonic() - start:.0f} s', flush=True)


def write_private(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def update_env(source, updates):
    lines = []
    remaining = dict(updates)
    for line in source.splitlines():
        key = line.split('=', 1)[0]
        if key in remaining:
            line = key + '=' + remaining.pop(key)
        lines.append(line)
    lines.extend(key + '=' + value for key, value in remaining.items())
    return '\n'.join(lines) + '\n'


def merge_public_mcp_trusted_proxy(value, proxy_ips=None):
    """Keep the existing proxy list and add both reserved public-MCP peers once."""
    # No ownership ledger exists for old entries: even stale /32s may be operator-owned.
    # Preserve them rather than infer ownership from their address or position.
    proxy_ips = tuple(proxy_ips or (PUBLIC_MCP_PROXY_IP, PUBLIC_MCP_PROXY_IP_ALT))
    if len(proxy_ips) != 2:
        raise ValueError('two public-MCP proxy addresses are required')
    tokens = (PUBLIC_MCP_PROXY_IP_TOKEN, PUBLIC_MCP_PROXY_IP_ALT_TOKEN) if proxy_ips == (PUBLIC_MCP_PROXY_IP, PUBLIC_MCP_PROXY_IP_ALT) else tuple(ip + '/32' for ip in proxy_ips)
    if value is None:
        return ('${CADDY_PROXY_IP:-172.30.80.2},' + ','.join(tokens) +
                ',${SSR_PROXY_SUBNET:-172.30.81.0/24}')
    if not isinstance(value, str):
        raise ValueError('TRUSTED_PROXIES must be a string')
    entries = []
    seen = set()
    for raw in value.split(','):
        entry = raw.strip()
        if entry and entry not in seen:
            entries.append(entry)
            seen.add(entry)
    variables = ('PUBLIC_MCP_PROXY_IP', 'PUBLIC_MCP_PROXY_IP_ALT')
    for index, (ip, token) in enumerate(zip(proxy_ips, tokens)):
        # Preserve an already configured literal or token. Older hosts used the literal .3
        # without /32; retaining it avoids rewriting operator configuration while the new
        # default always emits explicit host routes.
        variable = variables[index] if proxy_ips == (PUBLIC_MCP_PROXY_IP, PUBLIC_MCP_PROXY_IP_ALT) else None
        if not any(entry in {ip, ip + '/32', token} or
                   (variable and entry.startswith('${' + variable + ':-') and entry.endswith('}/32'))
                   for entry in entries):
            entries.append(token)
    return ','.join(entries)


def write_caddy_in_place(path, content):
    """Keep the inode of the single-file Caddy bind mount and durably write its contents.

    docker-compose.prod.yml bind-mounts ./caddy/Caddyfile as a single file, so a rename would
    swap the host inode and the container would keep reading the old one. The write is therefore
    in place, bracketed by an atomically written intent record (expected SHA-256) that lets the
    next run detect an interrupted write, and verified by reading the file back.
    """
    intent = caddy_intent_path(path)
    digest = hashlib.sha256(content).hexdigest()
    write_atomic(intent, (digest + '\n').encode())
    with path.open('wb') as target:
        target.write(content)
        target.flush()
        os.fsync(target.fileno())
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise OSError(f'{path} does not match the content just written; intent kept for recovery')
    intent.unlink(missing_ok=True)
    fsync_directory(path.parent)


def caddy_intent_path(path):
    return path.with_name('.' + path.name + '.intent')


def fsync_directory(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_atomic(path, content):
    """Write a non-mounted sidecar file: same-directory temp, fsync, rename, fsync directory."""
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name + '-', delete=False) as staged:
        try:
            staged.write(content)
            staged.flush()
            os.fsync(staged.fileno())
        except BaseException:
            Path(staged.name).unlink(missing_ok=True)
            raise
    os.replace(staged.name, path)
    fsync_directory(path.parent)


def interrupted_caddy_write(path):
    """True when an intent record exists and the live file does not hold its expected content."""
    intent = caddy_intent_path(path)
    if not intent.is_file():
        return False
    expected = intent.read_text().strip()
    if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
        intent.unlink(missing_ok=True)
        return False
    return True


class CaddyValidatorUnavailable(RuntimeError):
    """caddy validate could not run, so the configuration's validity is unknown."""


def caddy_validate(container, config_path):
    """Return True/False for a valid/invalid Caddyfile; raise CaddyValidatorUnavailable otherwise.

    Only a clean exit 1 from caddy itself counts as "invalid". Timeouts, OS errors, other exit
    codes, or an exit 1 while the container cannot run caddy at all are "unknown".
    """
    try:
        command(['docker', 'exec', container, 'caddy', 'validate', '--config', config_path,
                 '--adapter', 'caddyfile'])
        return True
    except RuntimeError as error:
        text = str(error)
        if '(exit ' in text and '(exit 1)' not in text:
            raise CaddyValidatorUnavailable(f'caddy validate could not run: {text}') from error
    except (OSError, subprocess.SubprocessError) as error:
        raise CaddyValidatorUnavailable(f'caddy validate could not run: {type(error).__name__}') from error
    try:
        command(['docker', 'exec', container, 'caddy', 'version'])
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        raise CaddyValidatorUnavailable('caddy validate failed and caddy is not runnable in the container') from error
    return False


def public_mcp_route(alias):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', alias):
        raise ValueError('invalid public-MCP proxy alias')
    return (f'{PUBLIC_MCP_BEGIN}\n'
            '\t@publicMcp path /mcp\n'
            '\thandle @publicMcp {\n'
            '\t\trequest_body {\n'
            '\t\t\tmax_size 2MB\n'
            '\t\t}\n'
            f'\t\treverse_proxy {alias}:8790 {{\n'
            '\t\t\tflush_interval -1\n'
            '\t\t}\n'
            '\t}\n'
            '\t@publicMcpOther path /mcp/*\n'
            '\thandle @publicMcpOther {\n'
            '\t\trespond 404\n'
            '\t}\n'
            f'{PUBLIC_MCP_END}\n')


def _caddy_site_block(source, site_pattern):
    """Return the unique Caddy site block matching site_pattern, or fail closed."""
    starts = list(re.finditer(site_pattern, source, re.M))
    if len(starts) != 1:
        raise ValueError('WEB_DOMAIN Caddy site block is missing or ambiguous')
    start = starts[0]
    depth = 1
    position = start.end()
    for line in source[position:].splitlines(keepends=True):
        # {$VAR} is a Caddy placeholder, not a block delimiter.
        syntax = re.sub(r'\{\$[A-Za-z_][A-Za-z0-9_]*\}', '', line)
        depth += syntax.count('{') - syntax.count('}')
        position += len(line)
        if depth == 0:
            return start.start(), position
        if depth < 0:
            break
    raise ValueError('WEB_DOMAIN Caddy site block has unbalanced braces')


def install_public_mcp_route(source, alias):
    """Install the public MCP route in the WEB_DOMAIN block before its catch-all proxy."""
    block_start, block_end = _caddy_site_block(
        source, r'^[ \t]*(?:(?:https?://)?\{\$WEB_DOMAIN\})[ \t]*\{[ \t]*$')
    block = source[block_start:block_end]
    if block.count(PUBLIC_MCP_BEGIN) != block.count(PUBLIC_MCP_END):
        raise ValueError('public-MCP Caddy route markers are unbalanced')
    markers = list(re.finditer(
        re.escape(PUBLIC_MCP_BEGIN) + r'.*?' + re.escape(PUBLIC_MCP_END) + r'\n?',
        block, re.S))
    if len(markers) > 1:
        raise ValueError('public-MCP Caddy route is ambiguous')
    if markers:
        block_without_route = block[:markers[0].start()] + block[markers[0].end():]
    else:
        block_without_route = block
        # Older repository installations shipped these two routes without markers.
        spans = []
        for matcher, path in [('publicMcp', '/mcp'), ('publicMcpOther', '/mcp/*')]:
            matches = list(re.finditer(
                r'^[ \t]*@' + matcher + r'[ \t]+path[ \t]+' + re.escape(path) +
                r'[ \t]*\n[ \t]*handle[ \t]+@' + matcher + r'[ \t]*\{[ \t]*\n', block, re.M))
            if len(matches) > 1:
                raise ValueError('legacy public-MCP Caddy route is ambiguous')
            if not matches:
                continue
            match = matches[0]
            depth, end = 1, match.end()
            for line in block[end:].splitlines(keepends=True):
                syntax = re.sub(r'\{\$[^}]+\}', '', line)
                depth += syntax.count('{') - syntax.count('}')
                end += len(line)
                if depth == 0:
                    break
            if depth != 0:
                raise ValueError('legacy public-MCP Caddy route has unbalanced braces')
            spans.append((match.start(), end))
        if spans and len(spans) != 2:
            raise ValueError('legacy public-MCP Caddy route is incomplete')
        for start, end in sorted(spans, reverse=True):
            block_without_route = block_without_route[:start] + block_without_route[end:]
    proxies = []
    depth = 0
    position = 0
    for line in block_without_route.splitlines(keepends=True):
        syntax = re.sub(r'\{\$[A-Za-z_][A-Za-z0-9_]*\}', '', line)
        if depth == 1 and re.fullmatch(r'[ \t]*reverse_proxy[ \t]*\{[ \t]*(?:#.*)?(?:\r?\n)?', line):
            proxies.append(position)
        depth += syntax.count('{') - syntax.count('}')
        position += len(line)
    if len(proxies) != 1:
        raise ValueError('WEB_DOMAIN Caddy catch-all reverse_proxy is missing or ambiguous')
    route = public_mcp_route(alias)
    insertion = proxies[0]
    # Keep the route at the same indentation as the surrounding site directives.
    block_with_route = block_without_route[:insertion] + route + block_without_route[insertion:]
    return source[:block_start] + block_with_route + source[block_end:]


def monitoring_targets(source, services):
    """Replace only simple API/web scrape jobs; preserve globals, rules and unrelated jobs.

    Refuse unfamiliar layouts rather than silently discard relabeling/auth settings.
    The host configuration remains operator-owned; no credentials enter release logs.
    """
    targets = {kind: name + ':' + ('9090' if kind == 'api' else '9091')
               for kind, name in services.items() if kind in ('api', 'web')}
    if set(targets) != {'api', 'web'} or any(not re.fullmatch(r'[A-Za-z0-9_-]+:[0-9]+', t) for t in targets.values()):
        raise ValueError('invalid monitoring services')
    start = re.search(r'^scrape_configs:\s*\n', source, re.M)
    if not start:
        raise ValueError('monitoring requires a block scrape_configs section')
    end = re.search(r'^[A-Za-z_][A-Za-z0-9_]*:', source[start.end():], re.M)
    finish = start.end() + end.start() if end else len(source)
    body = source[start.end():finish]
    jobs = list(re.finditer(r'^  - job_name: *[\'"]?([\w-]+)[\'"]? *\n', body, re.M))
    if not jobs or body[:jobs[0].start()].strip():
        raise ValueError('unsupported monitoring job layout')
    blocks, seen = [], set()
    for i, job in enumerate(jobs):
        block = body[job.start():jobs[i + 1].start() if i + 1 < len(jobs) else len(body)]
        name = job.group(1)
        if name in targets:
            if name in seen:
                raise ValueError('duplicate monitoring job')
            # Support the repository DNS layout without removing replica discovery,
            # honor_labels, refresh intervals or comments. Reject unfamiliar layouts.
            clean = re.sub(r'^ *#.*\n', '', block, flags=re.M)
            header = r"  - job_name: *['\"]?" + name + r"['\"]? *\n"
            static = header + r"    static_configs: *\n      - targets: *\[[^\n]*\] *\n\s*"
            dns = (header + r"(?:    honor_labels: (?:true|false) *\n)?"
                   r"    dns_sd_configs: *\n      - names: *\[[^\n]*\] *\n"
                   r"        type: A *\n        port: " + ('9090' if name == 'api' else '9091') +
                   r" *\n        refresh_interval: [0-9]+[smh] *\n\s*")
            if re.fullmatch(dns, clean):
                block = re.sub(r'(      - names: *)\[[^\n]*\]',
                               lambda m: m[1] + '[' + services[name] + ']', block)
            elif re.fullmatch(static, clean):
                if name == 'web':
                    # Web has one DNS A target per replica. A static target would silently scrape
                    # only one container after an operator scales the service.
                    block = (f"  - job_name: web\n"
                             f"    dns_sd_configs:\n"
                             f"      - names: [{services[name]}]\n"
                             f"        type: A\n"
                             f"        port: 9091\n"
                             f"        refresh_interval: 5s\n")
                else:
                    block = re.sub(r'(      - targets: *)\[[^\n]*\]',
                                   lambda m: m[1] + "['" + targets[name] + "']", block)
            else:
                raise ValueError('unsupported API/web monitoring job; review host config')
            seen.add(name)
        blocks.append(block)
    for name in targets.keys() - seen:
        if name == 'web':
            blocks.append(f"  - job_name: web\n    dns_sd_configs:\n      - names: [{services[name]}]\n"
                          "        type: A\n        port: 9091\n        refresh_interval: 5s\n")
        else:
            blocks.append(f"  - job_name: {name}\n    static_configs:\n      - targets: ['{targets[name]}']\n")
    return source[:start.end()] + ''.join(blocks) + source[finish:]


class Deployment:
    def __init__(self, config, payload):
        self.config, self.payload = config, payload
        self.root = Path(config['root'])
        self.state_path = self.root / 'deploy/github-state.json'
        self.state = json.loads(self.state_path.read_text())
        self.release = 'gh-' + payload['sha'][:12] + '-' + payload['run_id'] + '-' + payload.get('run_attempt', '1')
        self.directory = self.root / 'releases' / self.release
        self.live_caddy = self.root / config['caddy_file']
        self.rolling = self.root / 'deploy/rolling.compose.json'
        self.env = self.root / 'current-release.env'
        self.services = {kind: kind + '_' + self.release.replace('-', '_') for kind in APPLICATION_SERVICES}
        self.aliases = {}
        self.current_web_assets = []
        self.web_replicas = configured_web_replicas(config)
        self.warm_paths = warm_paths(payload)

    @property
    def degraded_path(self):
        return self.root / 'deploy/github-degraded.json'

    def recovery_instructions(self):
        return ('Manual intervention required: verify Caddy routing, running services and release '
                f'configuration, then remove {self.degraded_path} to allow deployments.')

    def mark_degraded(self, reason):
        # Keep this outside release snapshots and the last verified state so retries cannot
        # bypass unresolved routing. Only a verified rollback in this run may clear it.
        write_private(self.degraded_path, {
            'release': self.release, 'sha': self.payload['sha'], 'reason': reason,
        })
        self.degraded_marker_written = True
        print(f'DEGRADED: {reason}. {self.recovery_instructions()}', flush=True)

    def compose(self, *args, candidate=True):
        directory = self.directory if candidate else self.root
        result = command(['docker', 'compose', '--project-directory', str(self.root), '-p', self.config['project'],
                          '--env-file', str(self.root / '.env'), '--env-file', str(directory / ('release.env' if candidate else 'current-release.env')),
                          '-f', str(self.root / self.config['compose_file']),
                          '-f', str(self.directory / 'rolling.compose.json' if candidate else self.rolling),
                          '--profile', 'ops', '--profile', 'automation', *args])
        if args and args[0] == 'up':
            services = self.services if candidate else self.state['services']
            public_mcp = services.get('public-mcp')
            if public_mcp and public_mcp in args[1:]:
                self.restore_public_mcp_proxy(public_mcp, candidate=candidate)
        return result

    def restore_public_mcp_proxy(self, service, *, candidate):
        """Restore an endpoint reclaimed by preflight before the caller can switch routes."""
        ids = self.compose('ps', '-q', service, candidate=candidate).splitlines()
        if not ids:
            raise RuntimeError('public-MCP proxy restore found no running service container')
        # Use Compose's resolved configuration so inherited addresses and DNS aliases survive
        # a reconnect, including hosts whose base Compose file supplies the fixed address.
        resolved = json.loads(self.compose('config', '--format', 'json', candidate=candidate))
        options = resolved['services'][service]['networks']['proxy'] or {}
        address = None if candidate else self.public_mcp_overlay_ip()
        address = address or options.get('ipv4_address')
        if address:
            address = str(ipaddress.ip_address(address))
        network = self.config.get('proxy_network') or self.config['project'] + '_proxy'
        containers = json.loads(command(['docker', 'inspect', *ids]))
        for container in containers:
            endpoint = (container.get('NetworkSettings') or {}).get('Networks', {}).get(network)
            if endpoint is not None:
                if address and endpoint.get('IPAddress') != address:
                    raise RuntimeError('public-MCP proxy restore found an unexpected fixed address')
                continue
            if not address:
                raise RuntimeError('public-MCP proxy restore requires a recorded fixed address')
            # Compose up can restart a retained container without restoring disconnected
            # networks. Reconnect only the missing endpoint; healthy peers stay untouched.
            connect = ['docker', 'network', 'connect', '--ip', address]
            for alias in dict.fromkeys([service, *(options.get('aliases') or [])]):
                connect.extend(['--alias', alias])
            command([*connect, network, container['Id']])

    def write_manifest(self, directory=None):
        target = self.directory if directory is None else Path(directory)
        write_private(target / 'manifest.json', release_manifest(
            self.payload, getattr(self, 'current_web_assets', [])))

    def public_mcp_proxy_ips(self):
        """Resolve the two reserved proxy addresses without asking Compose to recreate a network."""
        configured = getattr(self, 'config', {})
        values = configured.get('public_mcp_proxy_ips')
        if values is not None:
            if isinstance(values, str):
                values = [item.strip() for item in values.split(',')]
            if not isinstance(values, (list, tuple)) or len(values) != 2:
                raise RuntimeError('public-MCP proxy preflight requires exactly two proxy addresses')
            raw = list(values)
        else:
            env = {}
            try:
                for line in (self.root / '.env').read_text().splitlines():
                    if '=' in line and not line.lstrip().startswith('#'):
                        key, value = line.split('=', 1)
                        env[key.strip()] = value.strip()
            except OSError:
                pass
            raw = [configured.get('public_mcp_proxy_ip') or env.get('PUBLIC_MCP_PROXY_IP') or
                   os.environ.get('PUBLIC_MCP_PROXY_IP') or PUBLIC_MCP_PROXY_IP,
                   configured.get('public_mcp_proxy_ip_alt') or env.get('PUBLIC_MCP_PROXY_IP_ALT') or
                   os.environ.get('PUBLIC_MCP_PROXY_IP_ALT') or PUBLIC_MCP_PROXY_IP_ALT]
        try:
            addresses = tuple(str(ipaddress.ip_address(value)) for value in raw)
        except ValueError as error:
            raise RuntimeError('public-MCP proxy preflight found an invalid reserved address') from error
        if len(set(addresses)) != 2:
            raise RuntimeError('public-MCP proxy preflight requires two distinct reserved addresses')
        return addresses

    def public_mcp_overlay_ip(self, overlay=None):
        """Read the live public-MCP address from the previous overlay when available."""
        try:
            for key in ('public_mcp_proxy_ip', 'public_mcp_ip'):
                value = self.state.get(key)
                if value:
                    return str(ipaddress.ip_address(value))
            state_service = self.state.get('public-mcp')
            if isinstance(state_service, dict) and state_service.get('ipv4_address'):
                return str(ipaddress.ip_address(state_service['ipv4_address']))
            overlay = json.loads(self.rolling.read_text()) if overlay is None else overlay
            old = self.state.get('services', {}).get('public-mcp')
            options = overlay.get('services', {}).get(old, {}).get('networks', {}).get('proxy', {})
            value = options.get('ipv4_address') if isinstance(options, dict) else None
            return str(ipaddress.ip_address(value)) if value else None
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return None

    @staticmethod
    def _container_is_public_mcp(container, network_entry, project):
        labels = (container.get('Config') or {}).get('Labels') or {}
        if labels:
            return (labels.get('com.docker.compose.project') == project and
                    ((labels.get('com.docker.compose.service') or '') == 'public-mcp' or
                     (labels.get('com.docker.compose.service') or '').startswith('public-mcp_')))
        return False

    def public_mcp_preflight(self):
        """Check reserved proxy addresses before any pull, migration, or candidate start."""
        if not hasattr(self, 'config'):
            return
        project = self.config.get('project')
        if not project:
            raise RuntimeError('public-MCP proxy preflight requires the Compose project name')
        addresses = self.public_mcp_proxy_ips()
        network = self.config.get('proxy_network') or project + '_proxy'
        try:
            inspected = json.loads(command(['docker', 'network', 'inspect', network]))
            network_info = inspected[0]
            entries = network_info.get('Containers') or {}
        except (RuntimeError, OSError, TypeError, ValueError, IndexError, KeyError) as error:
            raise RuntimeError(f'public-MCP proxy preflight could not inspect network {network}') from error

        occupied = {address: [] for address in addresses}
        for container_id, entry in entries.items():
            raw_ip = (entry or {}).get('IPv4Address', '').split('/', 1)[0]
            if raw_ip in occupied:
                occupied[raw_ip].append((container_id, entry or {}))
        details = {}
        ids = [container_id for holders in occupied.values() for container_id, _ in holders]
        if ids:
            try:
                inspected_containers = json.loads(command(['docker', 'inspect', *ids]))
                details = {item.get('Id'): item for item in inspected_containers if isinstance(item, dict)}
            except (RuntimeError, OSError, TypeError, ValueError):
                # Missing inspect labels cannot prove ownership; refuse the occupied address.
                details = {}
        public_holders = {}
        reclaim = []
        for address, holders in occupied.items():
            for container_id, entry in holders:
                container = details.get(container_id, {})
                if not self._container_is_public_mcp(container, entry, project):
                    name = (entry.get('Name') or container_id).lstrip('/')
                    raise RuntimeError(
                        f'public-MCP proxy preflight refused: reserved address {address} is occupied '
                        f'by non-public-mcp container {name}')
                state = container.get('State') or {}
                if state.get('Running') is False and not state.get('Restarting') and not state.get('Paused'):
                    reclaim.append((address, container_id, entry))
                else:
                    public_holders[address] = container_id

        # Check every holder before changing anything. Disconnect only stopped, label-proven
        # project services; retained containers remain available to Compose for rollback.
        for address, container_id, entry in reclaim:
            command(['docker', 'network', 'disconnect', network, container_id])
            occupied[address].remove((container_id, entry))

        free = [address for address in addresses if not occupied[address]]
        if not free:
            raise RuntimeError('public-MCP proxy preflight refused: both reserved addresses are occupied')
        old_ip = self.public_mcp_overlay_ip()
        if old_ip in addresses:
            choices = [address for address in addresses if address != old_ip and address in free]
        else:
            current = next((address for address in addresses if address in public_holders), None)
            if current:
                self.public_mcp_live_ip = current
            choices = [address for address in addresses if address != current and address in free]
        if not choices:
            raise RuntimeError('public-MCP proxy preflight refused: no alternate reserved address is free')
        self.public_mcp_proxy_ip = choices[0]
        print(f'Public MCP proxy preflight passed: candidate address {self.public_mcp_proxy_ip}.', flush=True)

    def ensure_live_manifest(self):
        release = self.state.get('release')
        if not release:
            return
        try:
            directory = self.root / 'releases' / release
            manifest = directory / 'manifest.json'
            try:
                data = json.loads(manifest.read_text())
                if isinstance(data, dict) and isinstance(data.get('web_assets'), list):
                    return
            except (OSError, TypeError, ValueError):
                pass
            assets = directory / 'web-assets'
            self.current_web_assets = web_asset_paths(assets) if assets.is_dir() else []
            self.write_manifest(directory)
        except OSError:
            print('Live release manifest repair skipped; continuing deployment.', flush=True)

    def prepare(self, archive):
        self.directory.mkdir(mode=0o700)
        for source, name in [(self.live_caddy, 'before-caddy'), (self.rolling, 'before-rolling.json'), (self.env, 'before-release.env'), (self.state_path, 'before-state.json')]:
            shutil.copyfile(source, self.directory / name)
        overlay = json.loads(self.rolling.read_text())
        # Keep only the live release as the rollback candidate in the next overlay.
        live_services = set(self.state['services'].values())
        # Capture a base public-MCP definition before filtering the previous overlay. Hosts
        # deployed before public-MCP was introduced have no state entry to clone.
        base_public_mcp = copy.deepcopy(overlay['services'].get('public-mcp'))
        proxy_ips = self.public_mcp_proxy_ips()
        old_public_mcp = self.state['services'].get('public-mcp')
        old_public_mcp_ip = self.public_mcp_overlay_ip(overlay) if old_public_mcp else None
        if old_public_mcp and not old_public_mcp_ip and getattr(self, 'public_mcp_live_ip', None):
            old_options = overlay['services'].setdefault(old_public_mcp, {}).setdefault('networks', {}).setdefault('proxy', {})
            old_options['ipv4_address'] = self.public_mcp_live_ip
            # Preserve the live address in the rollback snapshot as well, so a restart during
            # recovery cannot move the previous container to a dynamic address.
            before_overlay_path = self.directory / 'before-rolling.json'
            before_overlay = json.loads(before_overlay_path.read_text())
            before_options = before_overlay['services'].setdefault(old_public_mcp, {}).setdefault('networks', {}).setdefault('proxy', {})
            before_options['ipv4_address'] = self.public_mcp_live_ip
            write_private(before_overlay_path, before_overlay)
        candidate_public_mcp_ip = getattr(self, 'public_mcp_proxy_ip', None)
        if candidate_public_mcp_ip is None:
            candidate_public_mcp_ip = next((ip for ip in proxy_ips if ip != old_public_mcp_ip), proxy_ips[0])
        overlay['services'] = {name: service for name, service in overlay['services'].items()
                               if not re.match(r'^(?:api|web|mcp|public-mcp|admin)(?:_|$)', name) or name in live_services}
        routes = self.live_caddy.read_text()
        for kind, new in self.services.items():
            old = self.state['services'].get(kind)
            if old is None and kind == 'public-mcp':
                service = base_public_mcp or {
                    'image': '${MCP_IMAGE:?Build or pull MCP_IMAGE}',
                    'restart': 'unless-stopped',
                    'user': '10001:10001',
                    'read_only': True,
                    'tmpfs': ['/tmp:rw,noexec,nosuid,size=64m'],
                    'security_opt': ['no-new-privileges:true'],
                    'cap_drop': ['ALL'],
                    'entrypoint': ['opennavo-public-mcp'],
                    'environment': {
                        'OPENNAVO_PUBLIC_API_BASE': 'http://api-proxy:8080/api/v1',
                        'OPENNAVO_PUBLIC_MCP_HOST': '0.0.0.0',
                        'OPENNAVO_PUBLIC_MCP_PORT': '8790',
                        'OPENNAVO_PUBLIC_MCP_PATH': '/mcp',
                        'OPENNAVO_PUBLIC_MCP_TRUSTED_PROXIES': '["${CADDY_PROXY_IP:-172.30.80.2}/32"]',
                        'OPENNAVO_PUBLIC_MCP_RATE_LIMIT': '60',
                        'OPENNAVO_PUBLIC_MCP_RATE_WINDOW_SECONDS': '60',
                    },
                    'networks': {'proxy': {'aliases': ['public-mcp-proxy'],
                                           'ipv4_address': candidate_public_mcp_ip}},
                    'deploy': {'resources': {'limits': {'memory': '256M'}}},
                    'depends_on': {'api': {'condition': 'service_healthy'}},
                }
            else:
                service = copy.deepcopy(overlay['services'][old])
            for network, options in service.get('networks', {}).items():
                if not options:
                    continue
                aliases = options.get('aliases', [])
                for index, alias in enumerate(aliases):
                    replacement = f'{kind}-{network}-{self.release}'
                    if kind == 'admin':
                        replacement = 'admin-static-' + self.release
                    self.aliases[alias] = replacement
                    aliases[index] = replacement
            if kind != 'admin':
                image_kind = 'server' if kind == 'api' else 'mcp' if kind == 'public-mcp' else kind
                service['image'] = self.payload['images'][image_kind]
            for mount in service.get('volumes', []):
                if isinstance(mount, dict) and '/releases/' in mount.get('source', ''):
                    mount['source'] = str(self.directory / Path(mount['source']).name)
            service.setdefault('labels', {})['org.opencontainers.image.revision'] = self.payload['sha']
            if kind == 'web':
                service.setdefault('deploy', {})['replicas'] = self.web_replicas
                service['stop_grace_period'] = '90s'
                # Check both the internal listener and a cheap Nitro route; readiness must not flap
                # when the API is briefly restarting during a rolling deployment.
                service['healthcheck'] = {
                    'test': ['CMD', 'node', '-e',
                             "const signal=AbortSignal.timeout(2500);Promise.all([fetch('http://127.0.0.1:9091/healthz',{signal}),fetch('http://127.0.0.1:3000/robots.txt',{signal})]).then(async ([health,robots])=>{await Promise.all([health.arrayBuffer(),robots.arrayBuffer()]);process.exit(health.status===200&&robots.status===200?0:1)}).catch(()=>process.exit(1))"],
                    'interval': '30s', 'timeout': '3s', 'retries': 3,
                    'start_period': '60s', 'start_interval': '2s'}
            elif kind == 'public-mcp':
                service.setdefault('entrypoint', ['opennavo-public-mcp'])
                proxy = service.setdefault('networks', {}).setdefault('proxy', {})
                proxy['ipv4_address'] = candidate_public_mcp_ip
                # Compose --wait uses this liveness endpoint to reject a bad candidate before
                # Caddy is switched. Keep it explicit for overlays from before public-MCP existed.
                service['healthcheck'] = {
                    'test': ['CMD', 'python', '-I', '-c',
                             "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8790/healthz', timeout=2).close()"],
                    'interval': '30s', 'timeout': '3s', 'retries': 3,
                    'start_period': '60s', 'start_interval': '2s'}
            overlay['services'][new] = service
        for kind, new in self.services.items():
            service = overlay['services'][new]
            for key in ['NUXT_API_BASE_INTERNAL', 'OPENNAVO_AGENT_API_BASE', 'OPENNAVO_PUBLIC_API_BASE']:
                if key in service.get('environment', {}):
                    for old, replacement in self.aliases.items():
                        service['environment'][key] = service['environment'][key].replace(old, replacement)
        for old, replacement in self.aliases.items():
            routes = routes.replace(old, replacement)
        routes = install_public_mcp_route(
            routes, self.aliases.get('public-mcp-proxy', 'public-mcp-proxy-' + self.release))
        routes = re.sub(r'X-OpenNavo-Release "[^"]+"', f'X-OpenNavo-Release "{self.payload["sha"][:12]}"', routes)
        overlay['services'].setdefault('worker', {})['image'] = self.payload['images']['server']
        # The cache notifier must follow the new web service when the previous release retires.
        worker_env = overlay['services']['worker'].get('environment', {})
        if 'WEB_INTERNAL_URL' in worker_env:
            for old, replacement in {**self.aliases, self.state['services']['web']: self.services['web']}.items():
                worker_env['WEB_INTERNAL_URL'] = worker_env['WEB_INTERNAL_URL'].replace(old, replacement)
        # Disposable isolated OG storage. Also provision it on existing hosts whose base compose
        # predates this service; no ports/volumes and no changes to business Redis.
        overlay['services'].setdefault('image-cache', {
            'image': '${REDIS_IMAGE:-registry.hub.docker.com/library/redis:8}',
            'restart': 'unless-stopped',
            'command': ['redis-server', '--save', '', '--appendonly', 'no', '--maxmemory', '384mb', '--maxmemory-policy', 'allkeys-lru'],
            'deploy': {'resources': {'limits': {'memory': '512M'}}},
            'healthcheck': {'test': ['CMD', 'redis-cli', 'ping'], 'interval': '10s', 'timeout': '3s', 'retries': 3}})
        overlay['services'][self.services['web']].setdefault('environment', {})['NUXT_IMAGE_REDIS_URL'] = 'redis://image-cache:6379/0'
        # Usage stats read CF-IPCountry only from these peers. The new API copies the previous release's
        # service, so an overlay that predates the setting gets the base compose value; a host value, even
        # an empty one, is kept.
        api_environment = overlay['services'][self.services['api']].setdefault('environment', {})
        api_environment.setdefault('USAGE_COUNTRY_TRUSTED_PROXIES', '${CADDY_PROXY_IP:-172.30.80.2}')
        api_environment['TRUSTED_PROXIES'] = merge_public_mcp_trusted_proxy(
            api_environment.get('TRUSTED_PROXIES'), proxy_ips)
        write_private(self.directory / 'rolling.compose.json', overlay)
        (self.directory / 'release.env').write_text(update_env(self.env.read_text(), {
            'SERVER_IMAGE': self.payload['images']['server'], 'WEB_IMAGE': self.payload['images']['web'],
            'MCP_IMAGE': self.payload['images']['mcp'], 'ADMIN_DIST': str(self.directory / 'admin')}))
        (self.directory / 'Caddyfile.next').write_text(routes)
        old_admin = overlay['services'][self.state['services']['admin']]
        old_web = overlay['services'][self.state['services']['web']]
        def mount_source(service, target):
            return Path(next(m['source'] for m in service['volumes'] if m['target'] == target))
        shutil.copyfile(mount_source(old_admin, '/etc/caddy/Caddyfile'), self.directory / 'Caddyfile.admin')
        extract_admin(archive, self.directory / 'admin')
        old_assets = mount_source(old_admin, '/srv/admin') / 'assets'
        if old_assets.exists():
            for source in old_assets.rglob('*'):
                if source.is_file():
                    target = self.directory / 'admin/assets' / source.relative_to(old_assets)
                    if not target.exists():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(source, target)
        old_web_assets = mount_source(old_web, '/app/.output/public/_nuxt')
        shutil.copytree(old_web_assets, self.directory / 'web-assets')
        container = command(['docker', 'create', self.payload['images']['web']])
        try:
            with tempfile.TemporaryDirectory(dir=self.directory) as incoming:
                command(['docker', 'cp', container + ':/app/.output/public/_nuxt/.', incoming])
                self.current_web_assets = web_asset_paths(Path(incoming))
                merge_web_assets(Path(incoming), self.directory / 'web-assets',
                                 previous_current=previous_web_asset_paths(old_web_assets))
        finally:
            command(['docker', 'rm', container])
        # Release directories are private; bind-mounted public assets must be readable by container users.
        for public in [self.directory / 'admin', self.directory / 'web-assets']:
            for path in [public, *public.rglob('*')]:
                path.chmod(0o755 if path.is_dir() else 0o644)
        (self.directory / 'Caddyfile.admin').chmod(0o644)
        self.compose('config', '--quiet')

    def backup(self):
        dump = self.directory / 'before-migration.dump'
        args = ['docker', 'exec', self.config['postgres_container'], 'pg_dump', '-U', self.config['postgres_user'], '-d', self.config['postgres_database'], '-Fc']
        # zstd compresses several times faster than pg_dump's default gzip, and the
        # dump shares a two-core host with production traffic. Servers built
        # without zstd fall back to the default.
        try:
            with dump.open('wb') as output:
                command([*args, '--compress=zstd'], output=output)
        except RuntimeError:
            with dump.open('wb') as output:
                command(args, output=output)
        if dump.stat().st_size < 1024:
            raise RuntimeError('database backup is unexpectedly small')
        with dump.open('rb') as source:
            result = subprocess.run(['docker', 'exec', '-i', self.config['postgres_container'], 'pg_restore', '--list'], stdin=source, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
        if result.returncode:
            raise RuntimeError('database backup archive validation failed')
        print('Database backup created and archive validated.', flush=True)

    def capacity_gate(self):
        """Reject an overlap that the host cannot afford before touching the release."""
        if not hasattr(self, 'config'):
            # Test doubles and older callers construct Deployment with object.__new__; the real
            # receiver always has a host config and therefore always executes the gate.
            return
        replicas = getattr(self, 'web_replicas', None) or configured_web_replicas(self.config)
        required = required_mem_available(self.config, replicas)
        try:
            available = mem_available_bytes(Path('/proc/meminfo').read_text())
        except OSError as error:
            raise RuntimeError('capacity gate: cannot read /proc/meminfo') from error
        if available < required:
            raise RuntimeError(
                f'capacity gate: web_replicas={replicas} requires at least '
                f'{required // (1024 ** 2)} MiB MemAvailable; host has {available // (1024 ** 2)} MiB'
            )
        print(
            f'Capacity gate passed: web_replicas={replicas}, '
            f'MemAvailable={available // (1024 ** 2)} MiB, '
            f'required={required // (1024 ** 2)} MiB.',
            flush=True,
        )

    def candidate_webs(self):
        replicas = getattr(self, 'web_replicas', None) or configured_web_replicas(self.config)
        ids = command([
            'docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=' + self.config['project'],
            '--filter', 'label=com.docker.compose.service=' + self.services['web']
        ]).splitlines()
        if len(ids) != replicas:
            raise RuntimeError(f'expected {replicas} candidate web replicas, found {len(ids)}')
        return ids

    def candidate_up_args(self):
        """Build the candidate command without changing the one-replica legacy invocation."""
        replicas = getattr(self, 'web_replicas', None) or configured_web_replicas(getattr(self, 'config', {}))
        args = ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '240']
        if replicas > 1:
            args.extend(['--scale', f"{self.services['web']}={replicas}"])
        return [*args, *self.services.values()]

    def warm_candidates(self):
        """Warm each candidate independently before Caddy can see it."""
        for container in self.candidate_webs():
            health = command(['docker', 'inspect', '-f', '{{.State.Health.Status}}', container])
            if health != 'healthy':
                raise RuntimeError('candidate web is not healthy')
            command([
                'docker', 'exec', container, 'node', '--input-type=module', '-e', WARM_SCRIPT,
                json.dumps(self.warm_paths), WARM_ORIGIN, WARM_HOST, WARM_INTERNAL_ORIGIN
            ])
            print(f'Warmed candidate web replica {container[:12]}.', flush=True)
        print('All candidate web replicas warmed and ready.', flush=True)

    def drain_retired(self, containers, *, preserve_stream_grace=True, timeout=None):
        """Wait for the MCP stream grace period and prove retired web requests drained.

        The caller decides whether to retain or stop containers after a failed drain. The normal
        cleanup keeps the existing five-minute stream-close semantics; rollback uses only a short,
        bounded poll because candidates are no longer on the public route.
        """
        running = [container for container in containers if container.get('State', {}).get('Running')]
        if not running:
            return True
        if preserve_stream_grace and getattr(self, 'switch_at', None) is not None:
            deadline = self.switch_at + DRAIN_GRACE_SECONDS
            remaining = max(0, deadline - time.monotonic())
            print(f'Draining retired containers; preserving {DRAIN_GRACE_SECONDS}s MCP stream grace '
                  f'({remaining:.0f}s remaining).', flush=True)
            if remaining:
                time.sleep(remaining)
        elif preserve_stream_grace:
            print('Drain start time unavailable; release was already switched, so polling immediately.', flush=True)
        else:
            print('Draining rollback candidates with a bounded grace period.', flush=True)
        timeout = DRAIN_POLL_TIMEOUT_SECONDS if timeout is None else timeout
        webs = [
            container['Id'] for container in running
            if (container.get('Config', {}).get('Labels', {}).get('com.docker.compose.service', '')
                .startswith('web_'))
        ]
        if not webs:
            print('No retired web replicas require in-flight polling.', flush=True)
            return True
        poll_deadline = time.monotonic() + timeout
        streak = 0
        while time.monotonic() < poll_deadline:
            try:
                counts = [command(['docker', 'exec', container, 'node', '--input-type=module', '-e', DRAIN_SCRIPT,
                                   WARM_INTERNAL_ORIGIN])
                          for container in webs]
                if any(not re.fullmatch(r'\d+', count) for count in counts):
                    print('WARNING: retired web metrics returned an invalid sample; drain cannot be proved.', flush=True)
                    return False
                empty = all(count == '0' for count in counts)
            except Exception:
                print('WARNING: retired web metrics could not be read; drain cannot be proved.', flush=True)
                return False
            streak = streak + 1 if empty else 0
            if streak >= 3:
                print('Retired web replicas drained (three consecutive zero samples).', flush=True)
                return True
            time.sleep(1)
        print('WARNING: retired container drain timed out; applying the configured undrained policy.', flush=True)
        return False

    def update_monitoring(self, services):
        # Find the optional installed monitor by Compose labels, not a release-specific name.
        ids = command(['docker', 'ps', '-q', '--filter',
                       'label=com.docker.compose.project=' + self.config['project'],
                       '--filter', 'label=com.docker.compose.service=prometheus']).splitlines()
        if not ids:
            print('No running Prometheus service; monitoring update skipped.', flush=True)
            return
        if len(ids) != 1:
            raise RuntimeError('expected one Prometheus instance')
        monitor = json.loads(command(['docker', 'inspect', ids[0]]))[0]
        mount = next((m for m in monitor['Mounts'] if m['Destination'] == '/etc/prometheus/prometheus.yml'), None)
        if not mount or mount['Type'] != 'bind':
            raise RuntimeError('monitoring config must be a host bind mount')
        path = Path(mount['Source'])
        before = path.read_text()
        after = monitoring_targets(before, services)
        backup = self.directory / 'before-prometheus.yml'
        if self.directory.is_dir() and not backup.exists():
            backup.write_text(before)
            backup.chmod(0o600)
        try:
            # Preserve the inode of the existing read-only container bind mount.
            path.write_text(after)
            command(['docker', 'exec', ids[0], 'promtool', 'check', 'config', '/etc/prometheus/prometheus.yml'])
            command(['docker', 'kill', '--signal=HUP', ids[0]])
            # Verify ingestion, not just YAML syntax. The web image already contains Node.
            web = self.config['project'] + '-' + services['web'] + '-1'
            command(['docker', 'exec', web, 'node', '--input-type=module', '-e', MONITORING_HEALTH_SCRIPT,
                     json.dumps({k: services[k] + (':9090' if k == 'api' else ':9091') for k in ('api', 'web')}),
                     str(getattr(self, 'web_replicas', None) or configured_web_replicas(self.config))])
        except Exception:
            path.write_text(before)
            command(['docker', 'kill', '--signal=HUP', ids[0]])
            raise
        print('API and web monitoring targets updated and healthy.', flush=True)

    def _validate_staged(self, content):
        """Validate content as a staged copy inside the Caddy container; never touches the live file."""
        container = self.config['caddy_container']
        with tempfile.NamedTemporaryFile(dir=self.live_caddy.parent, prefix='.Caddyfile-', delete=False) as staged:
            path = Path(staged.name)
            remote = '/tmp/' + path.name
            try:
                staged.write(content)
                staged.flush()
                os.fsync(staged.fileno())
                command(['docker', 'cp', str(path), container + ':' + remote])
                return caddy_validate(container, remote)
            finally:
                path.unlink(missing_ok=True)
                with contextlib.suppress(RuntimeError, OSError):
                    command(['docker', 'exec', container, 'rm', '-f', remote])

    def install_caddy(self, content):
        """Back up the live file and validate a staged copy before updating its inode."""
        backup = self.live_caddy.with_name('Caddyfile.bak')
        write_atomic(backup, self.live_caddy.read_bytes())
        if not self._validate_staged(content):
            raise RuntimeError('invalid staged Caddyfile; live configuration left untouched')
        try:
            write_caddy_in_place(self.live_caddy, content)
        except Exception:
            print(f'WARNING: writing {self.live_caddy} failed; checking whether it needs recovery.', flush=True)
            # The failed write leaves its intent record, so this restores the backup only when the
            # live file is incomplete/invalid and the backup validates (same rule everywhere).
            self.validate_live_caddy()
            raise

    def validate_live_caddy(self):
        """Recover an interrupted or invalid in-place write before trusting the live configuration.

        The backup is restored only when caddy definitively rejects the live file (or an intent
        record shows the last write never completed) and the backup itself validates. If the
        validator cannot run, nothing is touched and the deployment aborts.
        """
        container = self.config['caddy_container']
        backup = self.live_caddy.with_name('Caddyfile.bak')
        interrupted = interrupted_caddy_write(self.live_caddy)
        if not interrupted and caddy_validate(container, '/etc/caddy/Caddyfile'):
            return
        reason = 'an interrupted write' if interrupted else 'live Caddyfile validation failed'
        self._restore_live_caddy(backup, reason)

    def _restore_live_caddy(self, backup, reason):
        """The single recovery path: restore backup in place only if it validates as a staged copy."""
        container = self.config['caddy_container']
        if not backup.is_file():
            raise RuntimeError(f'Live Caddyfile validation failed for {self.live_caddy} ({reason}); '
                               f'backup {backup} is missing. The live file is left as found (not valid) and needs manual '
                               f'recovery. Aborting deployment.')
        if not self._validate_staged(backup.read_bytes()):
            raise RuntimeError(f'Live Caddyfile validation failed for {self.live_caddy} ({reason}) and '
                               f'backup {backup} is invalid too. The backup was not restored; the live file is left as found '
                               f'(not valid) and needs manual recovery. Aborting deployment.')
        print(f'WARNING: {reason}; restoring {self.live_caddy} in place from {backup}.', flush=True)
        write_caddy_in_place(self.live_caddy, backup.read_bytes())
        if not caddy_validate(container, '/etc/caddy/Caddyfile'):
            raise RuntimeError(f'Restored {self.live_caddy} from {backup} but it still fails validation.')
        print(f'Restored live Caddyfile from {backup}; validation passed.', flush=True)

    def reload(self):
        try:
            self.validate_live_caddy()
        except Exception:
            # validate_live_caddy already restored a good backup when that was provably safe;
            # never overwrite a file whose validity is unknown.
            self.mark_degraded('Caddy reload failed; routing unconfirmed')
            raise
        try:
            command(['docker', 'kill', '--signal=USR1', self.config['caddy_container']])
        except Exception:
            # The live file was just validated, so a failed signal is not a reason to overwrite it
            # with a backup. Leave every file as is and require manual confirmation.
            print(f'WARNING: Caddy reload signal failed; {self.live_caddy} validated and was left unchanged.', flush=True)
            self.mark_degraded('Caddy reload failed; routing unconfirmed')
            raise
        self.switch_at = time.monotonic()

    @staticmethod
    def _mcp_payload(body):
        try:
            return json.loads(body)
        except (TypeError, ValueError):
            # Streamable HTTP may return one or more SSE data events.
            events = []
            for line in body.decode('utf-8', 'replace').splitlines():
                if line.startswith('data:'):
                    try:
                        events.append(json.loads(line[5:].strip()))
                    except (TypeError, ValueError):
                        continue
            if not events:
                raise RuntimeError('public MCP returned an invalid response')
            return events[-1]

    def verify_public_mcp(self):
        checks = self.config.get('checks', [])
        host = self.config.get('public_mcp_host') or next(
            (check.get('host') for check in checks if check.get('path') == '/'), None)
        if not host:
            raise RuntimeError('public MCP verification requires WEB_DOMAIN host')
        endpoint = self.config['local_origin'].rstrip('/') + '/mcp'
        session = None

        def post(request_id, method, call_params=None):
            nonlocal session
            params = ({
                'protocolVersion': '2025-06-18',
                'capabilities': {},
                'clientInfo': {'name': 'opennavo-deploy', 'version': '1'},
            } if method == 'initialize' else (call_params or {}))
            request = urllib.request.Request(
                endpoint,
                data=json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': method,
                                 'params': params}).encode(),
                method='POST',
                headers={
                    'Host': host,
                    'Accept': 'application/json, text/event-stream',
                    'Content-Type': 'application/json',
                    'MCP-Protocol-Version': '2025-06-18',
                    **({'Mcp-Session-Id': session} if session else {}),
                })
            with urllib.request.urlopen(request, timeout=15) as response:
                status = getattr(response, 'status', None)
                if status is None:
                    status = response.getcode()
                if status != 200:
                    raise RuntimeError('public MCP route returned an unexpected status')
                body = response.read(2 * 1024 * 1024 + 1)
                headers = getattr(response, 'headers', {})
            for name in ('Mcp-Session-Id', 'MCP-Session-Id', 'mcp-session-id'):
                value = headers.get(name)
                if value:
                    session = value
                    break
            payload = self._mcp_payload(body)
            if not isinstance(payload, dict) or 'result' not in payload or 'error' in payload:
                raise RuntimeError('public MCP JSON-RPC request failed')
            return payload['result']

        post(1, 'initialize')
        result = post(2, 'tools/list')
        if not isinstance(result, dict) or not isinstance(result.get('tools'), list) or not result['tools']:
            raise RuntimeError('public MCP tools/list returned no tools')
        # initialize/tools/list never reach the API; a real tool call proves API base and trust work.
        called = post(3, 'tools/call', {'name': 'list_categories', 'arguments': {}})
        content = called.get('content') if isinstance(called, dict) else None
        if (not isinstance(content, list) or not content or called.get('isError')
                or not any(isinstance(item, dict) and str(item.get('text') or '').strip() for item in content)):
            raise RuntimeError('public MCP tools/call list_categories returned an error or no content')
        # Only the exact /mcp path is public; sub-paths must not reach the MCP service.
        probe = urllib.request.Request(endpoint + '/x', method='GET', headers={'Host': host})
        try:
            with urllib.request.urlopen(probe, timeout=15) as response:
                status = getattr(response, 'status', None) or response.getcode()
        except urllib.error.HTTPError as error:
            status = error.code
        if status != 404:
            raise RuntimeError(f'public MCP sub-path /mcp/x returned {status}, expected 404')
        print(f'Public MCP route verified ({len(result["tools"])} tools).', flush=True)

    def verify(self, expected=None):
        # A legacy deployment may have no recorded SHA; still check its routes without a header match.
        checking_current = expected is None
        expected = self.payload['sha'][:12] if expected is None else expected
        last_error = None
        for _ in range(30):
            try:
                for check in self.config['checks']:
                    request = urllib.request.Request(self.config['local_origin'] + check['path'], headers={'Host': check['host']})
                    with urllib.request.urlopen(request, timeout=15) as response:
                        if response.status != 200 or (expected and response.headers.get('X-OpenNavo-Release') != expected):
                            raise RuntimeError('route is not serving the new release')
                        while response.read(65536):
                            pass
                if checking_current and 'public-mcp' in getattr(self, 'services', {}):
                    self.verify_public_mcp()
                return
            except Exception as error:
                last_error = type(error).__name__
                time.sleep(2)
        raise RuntimeError('post-deployment route checks failed: ' + str(last_error))

    def rollback(self):
        self.env.write_bytes((self.directory / 'before-release.env').read_bytes())
        self.rolling.write_bytes((self.directory / 'before-rolling.json').read_bytes())
        # Restore and verify the old services before changing the public route. This keeps a failed
        # candidate from being the only service available during rollback. compose() also restores
        # any reclaimed public-MCP proxy endpoint before returning.
        try:
            self.compose('up', '-d', '--no-deps', '--wait', '--wait-timeout', '240',
                         *self.state['services'].values(), 'worker', candidate=False)
        except Exception as error:
            # Retain candidate configuration for recovery. The route is unconfirmed: the initial
            # Caddy reload may have failed before these files were promoted.
            self.mark_degraded('previous services failed to start; routing unconfirmed; '
                               'candidate containers retained')
            self.env.write_bytes((self.directory / 'release.env').read_bytes())
            self.rolling.write_bytes((self.directory / 'rolling.compose.json').read_bytes())
            print('Candidate env and rolling configuration restored for manual recovery.', flush=True)
            raise RuntimeError('degraded rollback: previous services failed to start; routing unconfirmed') from error
        print('Previous release services are healthy; switching Caddy back.', flush=True)
        # Deliberate switch back to the previous release's config (not a backup recovery);
        # reload() validates it before signalling and recovers only under the shared rule.
        # Every abort from here on leaves env/rolling on the previous release while Caddy may still
        # route to the candidate, so each one records the persistent degraded marker that blocks
        # the next deployment until an operator confirms recovery.
        live_note = f'{self.live_caddy} was not changed and still routes to the candidate'
        try:
            previous = (self.directory / 'before-caddy').read_bytes()
            valid = self._validate_staged(previous)
        except Exception:
            self.mark_degraded('previous Caddyfile could not be validated; routing still on candidate; '
                               'candidate containers retained')
            print(f'WARNING: rollback aborted before writing Caddy; {live_note}.', flush=True)
            raise
        if not valid:
            self.mark_degraded('previous Caddyfile is invalid; routing still on candidate; candidate containers retained')
            raise RuntimeError(f'degraded rollback: {self.directory / "before-caddy"} failed caddy validate; '
                               f'{live_note}.')
        try:
            write_caddy_in_place(self.live_caddy, previous)
        except Exception:
            self.mark_degraded('rollback Caddyfile write failed; routing unconfirmed; candidate containers retained')
            print(f'WARNING: rollback write to {self.live_caddy} failed; the file may be partially written '
                  f'({caddy_intent_path(self.live_caddy).name} records the expected content).', flush=True)
            raise
        self.reload()  # marks degraded itself on every failure
        try:
            self.verify(expected=self.state.get('sha', '')[:12])
            if 'public-mcp' in self.state['services']:
                self.verify_public_mcp()
            self.update_monitoring(self.state['services'])
        except Exception:
            self.mark_degraded('rollback verification or monitoring failed; candidate containers retained')
            print('WARNING: rollback verification or monitoring failed; candidate containers retained.', flush=True)
            raise
        candidates = []
        for service in self.services.values():
            ids = command([
                'docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=' + self.config['project'],
                '--filter', 'label=com.docker.compose.service=' + service
            ]).splitlines()
            candidates.extend({'Id': container, 'State': {'Running': True},
                               'Config': {'Labels': {'com.docker.compose.service': service}}}
                              for container in ids)
        drained = self.drain_retired(candidates, preserve_stream_grace=False, timeout=ROLLBACK_DRAIN_TIMEOUT_SECONDS)
        if not drained and self.config.get('retain_undrained_containers') is True:
            print('WARNING: retain_undrained_containers=true; rollback candidates were kept.', flush=True)
        else:
            if not drained:
                print('WARNING: rollback drain failed; stopping candidates with a 90s grace period.', flush=True)
            self.compose('stop', '--timeout', '90', *self.services.values())
            # The previous release remains on its original fixed address; remove only the
            # candidate service containers after the old route has been verified.
            self.compose('rm', '--force', '--stop', *self.services.values())
        print('Previous routes and worker restored; database was not rolled back.', flush=True)

    def cleanup(self, previous):
        """Stop retired application containers and retain only one rollback release."""
        current = set(self.services.values())
        retained = set(previous.get('services', {}).values())
        ids = command(['docker', 'ps', '-aq', '--filter',
                       'label=com.docker.compose.project=' + self.config['project']]).splitlines()
        if not ids:
            return
        containers = json.loads(command(['docker', 'inspect', *ids]))
        retired = []
        for container in containers:
            labels = container['Config'].get('Labels') or {}
            service = labels.get('com.docker.compose.service', '')
            if (labels.get('com.docker.compose.project') != self.config['project']
                    or not re.fullmatch(APPLICATION_SERVICE_PATTERN, service)
                    or service in current):
                continue
            retired.append((container, service))
        running = [container['Id'] for container, _ in retired if container['State']['Running']]
        if running:
            drained = self.drain_retired([container for container, _ in retired if container['State']['Running']])
            if not drained and self.config.get('retain_undrained_containers') is True:
                print('WARNING: retain_undrained_containers=true; retired containers were kept.', flush=True)
                return
            if not drained:
                print('WARNING: drain failed; stopping retired containers with a 90s grace period.', flush=True)
            command(['docker', 'stop', '--timeout', '90', *running])
        obsolete = [container['Id'] for container, service in retired if service not in retained]
        if obsolete:
            # Never remove volumes, images, or release files during container cleanup.
            command(['docker', 'rm', *obsolete])
        print('Retired containers stopped; at most one previous release retained.', flush=True)

    def prune(self, previous):
        """Bound disk use after container cleanup; failures are reported, never fatal."""
        try:
            ids = command(['docker', 'ps', '-aq']).split()
            containers = json.loads(command(['docker', 'inspect', *ids])) if ids else []
            self.prune_releases(previous, containers)
            self.prune_images(containers)
        except Exception as error:
            print('Retention cleanup incomplete; the next deployment retries it: ' + str(error), flush=True)

    def prune_releases(self, previous, containers):
        """Keep the newest snapshots plus the live, previous and any mounted release."""
        keep = max(2, int(self.config.get('release_retention', RELEASE_RETENTION)))
        protected = {self.release, self.state.get('release'), previous.get('release')}
        mounted = [Path(mount['Source']) for container in containers
                   for mount in container.get('Mounts') or [] if mount.get('Source')]
        snapshots = [path for path in (self.root / 'releases').iterdir()
                     if RELEASE_NAME.fullmatch(path.name) and not path.is_symlink() and path.is_dir()]
        snapshots.sort(key=lambda path: path.stat().st_mtime, reverse=True)
        for path in snapshots[keep:]:
            if path.name in protected or any(source == path or path in source.parents for source in mounted):
                continue
            shutil.rmtree(path)
            print('Removed release snapshot ' + path.name, flush=True)

    def prune_images(self, containers):
        """Protect container and rollback images before selecting unused application images."""
        used = {container['Image'] for container in containers}
        # On a same-SHA retry, the payload's run ID may differ from the deployed release.
        release = self.state.get('release') if self.state.get('sha') == self.payload['sha'] else self.release
        snapshot = self.root / 'releases' / release
        references = command([
            'docker', 'compose', '--project-directory', str(self.root), '-p', self.config['project'],
            '--env-file', str(self.root / '.env'), '--env-file', str(snapshot / 'before-release.env'),
            '-f', str(self.root / self.config['compose_file']), '-f', str(snapshot / 'before-rolling.json'),
            '--profile', 'ops', '--profile', 'automation', 'config', '--images']).splitlines()
        # Resolve every reference first; if configuration or image lookup fails, delete nothing.
        for reference in dict.fromkeys(references):
            used.add(command(['docker', 'image', 'inspect', '--format', '{{.Id}}', reference]))
        for kind in ['server', 'web', 'mcp']:
            listed = command(['docker', 'image', 'ls', '--no-trunc', '--quiet', self.config['registry'] + '/opennavo-' + kind])
            for image in dict.fromkeys(listed.split()):
                if image in used:
                    continue
                short = image.split(':')[-1][:12]
                try:
                    command(['docker', 'image', 'rm', image])
                    print(f'Removed unused {kind} image {short}', flush=True)
                except RuntimeError:
                    print(f'Kept {kind} image {short}: Docker refused removal', flush=True)

    def apply(self, archive):
        if self.degraded_path.exists():
            raise RuntimeError('deployment blocked by persistent degraded marker. ' + self.recovery_instructions())
        self.degraded_marker_written = False
        self.validate_live_caddy()
        if self.state.get('sha') == self.payload['sha']:
            self.services = self.state['services']
            self.ensure_live_manifest()
            self.verify()
            self.update_monitoring(self.services)
            self.cleanup(self.state.get('previous', {}))
            self.prune(self.state.get('previous', {}))
            print('This source revision is already deployed.'); return
        # This read-only gate runs before image pulls, release directories, migrations or Caddy
        # changes. A second web replica therefore fails cleanly when the host cannot overlap it.
        self.capacity_gate()
        # The production receiver always has a host .env. Lightweight unit-test doubles may
        # omit the host installation files and exercise the rest of the rollout in isolation.
        if (self.root / '.env').is_file():
            self.public_mcp_preflight()
        with tempfile.TemporaryDirectory() as auth:
            token = self.payload.get('registry_token', '')
            if token:
                result = subprocess.run(['docker', '--config', auth, 'login', 'ghcr.io', '--username', self.payload['registry_username'], '--password-stdin'], input=token.encode(), capture_output=True, timeout=60)
                if result.returncode:
                    raise RuntimeError('registry authentication failed')
            def pull(image):
                command(['docker', '--config', auth, 'pull', image])
                labels = json.loads(command(['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', image]))
                if labels.get('org.opencontainers.image.revision') != self.payload['sha']:
                    raise RuntimeError('image source revision does not match the deployment')
            with phase('Pulling images'), concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                for pulled in [pool.submit(pull, image) for image in self.payload['images'].values()]:
                    pulled.result()
        with phase('Preparing the release'):
            self.prepare(archive)
            # A verified release must already carry its asset manifest before
            # routes or deployment state can point at it.
            self.write_manifest()
        with phase('Database backup'):
            self.backup()
        print('Applying migrations and starting isolated candidates.', flush=True)
        with phase('Migrations'):
            self.compose('run', '--rm', '--no-deps', 'migrate', 'up')
            self.compose('run', '--rm', '--no-deps', 'db-permissions')
        try:
            with phase('Starting candidates'):
                self.compose('up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'image-cache')
                self.compose(*self.candidate_up_args())
            self.warm_candidates()
        except Exception:
            # Caddy still points at the old release, so no rollback is needed. Keep the stop bounded.
            try:
                self.compose('stop', '--timeout', '90', *self.services.values())
            finally:
                raise
        print('All candidates healthy and warmed; switching routes.', flush=True)
        try:
            with phase('Switching routes and worker'):
                # Preserve the inode because Caddy bind-mounts this file.
                self.install_caddy((self.directory / 'Caddyfile.next').read_bytes())
                self.reload()
                self.verify()
                self.env.write_bytes((self.directory / 'release.env').read_bytes())
                self.rolling.write_bytes((self.directory / 'rolling.compose.json').read_bytes())
                self.compose('up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'worker', candidate=False)
                self.verify()
                self.update_monitoring(self.services)
        except Exception:
            self.rollback()
            if self.degraded_marker_written:
                # rollback() confirmed old services, restored routing and verification before returning.
                self.degraded_path.unlink()
                self.degraded_marker_written = False
                print('Rollback verified; cleared this deployment\'s degraded marker.', flush=True)
            raise
        previous = {key: value for key, value in self.state.items() if key != 'previous'}
        write_private(self.state_path, {'sha': self.payload['sha'], 'release': self.release, 'services': self.services, 'previous': previous})
        print('Production deployed and verified: ' + self.payload['sha'], flush=True)
        # Cleanup failure must not roll back a verified release; a retry resumes cleanup.
        with phase('Cleanup'):
            self.cleanup(previous)
            self.prune(previous)


def main():
    os.umask(0o077)
    config = json.loads(Path('/etc/opennavo/github-deploy.json').read_text())
    with (Path(config['root']) / 'deploy/github-deploy.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        raw = sys.stdin.buffer.read(MAX_ARCHIVE * 2 + 1)
        if len(raw) > MAX_ARCHIVE * 2:
            raise ValueError('deployment payload exceeds the limit')
        payload = json.loads(raw)
        if payload.get('action') == 'publish-desktop':
            version = payload.get('version', '')
            if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?', version):
                raise ValueError('invalid desktop version')
            state = json.loads((Path(config['root']) / 'deploy/github-state.json').read_text())
            container = config['project'] + '-' + state['services']['api'] + '-1'
            print(command(['docker', 'exec', container, '/desktop-publish', '--version', version, '--apply']))
            return
        archive = validate(payload, config['registry'])
        Deployment(config, payload).apply(archive)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never echo input payloads, environment or captured subprocess diagnostics.
        print('Deployment failed: ' + str(error), file=sys.stderr)
        sys.exit(1)

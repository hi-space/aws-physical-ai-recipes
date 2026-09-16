#!/usr/bin/env python3
"""Physical AI CLI. Python standard library only; POSIX secure file operations."""
import argparse
import base64
import codecs
from contextlib import contextmanager
import getpass
import hashlib
import http.cookiejar
from http.cookies import SimpleCookie, CookieError
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings

TOKEN_RE = re.compile(r'^pai_[A-Za-z0-9_-]{43}$')
OPAQUE_RE = re.compile(r'^[A-Za-z0-9_-]{43}$')
ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,62}$')
MAX_JSON = 2 * 1024 * 1024
MAX_UPLOAD = 5 * 1024 ** 3
CHUNK = 1024 * 1024
IGNORED = {'.git', 'node_modules', '.aws', '.ssh'}

class CliError(Exception):
    pass

def redact(value):
    value = re.sub(r'pai_[A-Za-z0-9_-]{43}', '[TOKEN]', str(value))
    value = re.sub(r'(?i)(?:https?|wss?|s3)://[^\s]+', '[URL]', value)
    return re.sub(r'(?i)ticket=[^&\s]+', 'ticket=[REDACTED]', value)

def api_origin(value):
    try:
        url = urllib.parse.urlsplit(value)
        if (url.scheme != 'https' or not url.hostname or url.username or url.password or
                url.path not in ('', '/') or url.query or url.fragment or re.search(r'[\s\\\x00-\x1f]', value)):
            raise ValueError()
        port = url.port
        host = url.hostname
        if not re.fullmatch(r'[a-z0-9.-]+', host) or host.endswith('.'):
            raise ValueError()
        return 'https://' + host + (':' + str(port) if port and port != 443 else '')
    except (ValueError, TypeError):
        raise CliError('Use an HTTPS dashboard origin without credentials, path, query or fragment.') from None

def default_config():
    return Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'physical-ai' / 'credentials.json'

def directory_fd(path, create=False):
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise CliError('Secure file operations require a POSIX system with O_NOFOLLOW.')
    path = Path(path).expanduser().absolute()
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            if part in ('.', '..'):
                raise CliError('Unsafe local directory.')
            if create:
                try: os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError: pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except (OSError, CliError):
        os.close(fd)
        raise CliError('Local directory is unavailable or contains a symlink.') from None

class ConfigStore:
    def __init__(self, path=None): self.path = Path(path or default_config()).expanduser().absolute()
    def _parent(self, create=False):
        fd = directory_fd(self.path.parent, create)
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            os.close(fd)
            raise CliError('Credentials directory must be owned by you and have mode 0700.')
        return fd
    def save(self, url, token, project_id):
        origin = api_origin(url)
        if not TOKEN_RE.fullmatch(token) or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', project_id):
            raise CliError('Invalid token or project binding.')
        parent = self._parent(True)
        temp = '.credentials-' + secrets.token_hex(12)
        try:
            try:
                old = os.stat(self.path.name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(old.st_mode) or old.st_nlink != 1 or old.st_uid != os.getuid():
                    raise CliError('Refusing to replace unsafe credentials file.')
            except FileNotFoundError: pass
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            with os.fdopen(fd, 'w') as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump({'url': origin, 'token': token, 'projectId': project_id}, stream)
                stream.flush(); os.fsync(stream.fileno())
            os.replace(temp, self.path.name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        except OSError:
            raise CliError('Could not save private credentials.') from None
        finally:
            try: os.unlink(temp, dir_fd=parent)
            except FileNotFoundError: pass
            os.close(parent)
    def load(self):
        parent = self._parent()
        try:
            fd = os.open(self.path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            with os.fdopen(fd, 'r') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 16384:
                    raise CliError('Credentials file must be a private regular file (mode 0600).')
                result = json.load(stream)
            result['url'] = api_origin(result['url'])
            if not TOKEN_RE.fullmatch(result['token']) or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', result['projectId']): raise ValueError()
            return result
        except (OSError, ValueError, KeyError, TypeError):
            raise CliError('Cannot read valid private credentials. Run login.') from None
        finally: os.close(parent)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None

class HttpTransport:
    def __init__(self):
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    def open(self, method, url, headers, data=None):
        try:
            return self.opener.open(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=60)
        except urllib.error.HTTPError as response: return response
        except (urllib.error.URLError, OSError, ValueError):
            raise CliError('HTTPS connection failed. No request URL or credential is included in this error.') from None

def read_json(response):
    raw = response.read(MAX_JSON + 1)
    if len(raw) > MAX_JSON: raise CliError('JSON response exceeds the client limit.')
    try: return json.loads(raw)
    except (ValueError, UnicodeError): raise CliError('Server did not return valid JSON.') from None

def status_ok(response, expected=None):
    if 300 <= response.status < 400: raise CliError('Redirect refused; credentials will not be forwarded.')
    if expected is not None and response.status != expected or expected is None and not 200 <= response.status < 300:
        raise CliError('Request failed (HTTP %s).' % response.status)

class ApiClient:
    def __init__(self, url, token, project_id=None, transport=None):
        self.origin = api_origin(url)
        if not TOKEN_RE.fullmatch(token): raise CliError('Invalid API token format.')
        self._token = token
        self.project_id = project_id
        self.transport = transport or HttpTransport()
    def json(self, method, path, payload=None, headers=None):
        parsed = urllib.parse.urlsplit(path)
        if (not path.startswith('/') or path.startswith('//') or parsed.scheme or parsed.netloc or parsed.fragment or
                '\\' in path or any(urllib.parse.unquote(part) in ('.', '..') for part in parsed.path.split('/'))):
            raise CliError('Invalid API path.')
        request_headers = {'Authorization': 'Bearer ' + self._token, 'Accept': 'application/json'}
        if headers: request_headers.update(headers)
        data = None
        if payload is not None:
            data = json.dumps(payload).encode(); request_headers['Content-Type'] = 'application/json'
        with self.transport.open(method, self.origin + '/api/v1' + path, request_headers, data) as response:
            status_ok(response)
            return None if response.status == 204 else read_json(response)

class LogCursorFile:
    """Private checkpoint written after output flush, never a log/authentication bearer."""
    def __init__(self, path, binding):
        self.store = ConfigStore(path); self.binding = binding
    def load(self):
        parent = self.store._parent(True)
        try:
            try: fd = os.open(self.store.path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            except FileNotFoundError: return None
            with os.fdopen(fd, 'r') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 8192:
                    raise CliError('Log cursor must be a private regular file.')
                value = json.load(stream)
            if value.get('kind') != 'pai-log-cursor-v1' or value.get('binding') != self.binding or not OPAQUE_RE.fullmatch(value.get('cursor', '')):
                raise CliError('Log cursor file belongs to another command or identity.')
            return value['cursor']
        except (OSError, ValueError, TypeError):
            raise CliError('Cannot read a private log cursor file.') from None
        finally: os.close(parent)
    def save(self, cursor):
        self.load()  # Do not overwrite another file type or a changed binding.
        parent = self.store._parent(True); temp = '.pai-log-cursor-' + secrets.token_hex(12)
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            with os.fdopen(fd, 'w') as stream:
                json.dump({'kind': 'pai-log-cursor-v1', 'binding': self.binding, 'cursor': cursor}, stream)
                stream.flush(); os.fsync(stream.fileno())
            os.replace(temp, self.store.path.name, src_dir_fd=parent, dst_dir_fd=parent); os.fsync(parent)
        finally:
            try: os.unlink(temp, dir_fd=parent)
            except FileNotFoundError: pass
            os.close(parent)

def replay_logs(api, path, args):
    if not ID_RE.fullmatch(args.task) or args.cursor and not OPAQUE_RE.fullmatch(args.cursor):
        raise CliError('Invalid task or log cursor.')
    if args.attempt is not None and args.attempt < 1 or args.member is not None and not 0 <= args.member < 64:
        raise CliError('Invalid log attempt/member.')
    if args.container and not ID_RE.fullmatch(args.container) or args.stream and not re.fullmatch(r'[a-f0-9]{64}', args.stream):
        raise CliError('Invalid log source.')
    query = {'start': args.start}
    for key in ('attempt', 'member', 'container', 'stream'):
        if getattr(args, key) is not None: query[key] = getattr(args, key)
    binding = hashlib.sha256(json.dumps([api.origin, api.project_id, hashlib.sha256(api._token.encode()).hexdigest(), path, args.task, query], sort_keys=True).encode()).hexdigest()
    checkpoint = LogCursorFile(args.cursor_file, binding) if args.cursor_file else None
    saved = checkpoint.load() if checkpoint else None
    if saved and args.cursor and saved != args.cursor: raise CliError('Explicit cursor differs from the cursor file.')
    cursor, sequence, stream_id = args.cursor or saved, None, args.stream
    pending = b''; known_secret = api._token.encode()
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    def output(data, final=False):
        nonlocal pending
        data = pending + data; end = len(data) if final else max(0, len(data) - len(known_secret) + 1)
        result = bytearray(); pos = 0
        while pos < end:
            at = data.find(known_secret, pos)
            if at < 0 or at >= end: result.extend(data[pos:end]); pos = end; break
            result.extend(data[pos:at]); result.extend(b'[REDACTED]'); pos = at + len(known_secret)
        pending = data[pos:]
        if hasattr(sys.stdout, 'buffer'): sys.stdout.buffer.write(result); sys.stdout.buffer.flush()
        else: sys.stdout.write(decoder.decode(result, final=final)); sys.stdout.flush()
    completed = False
    try:
        while True:
            request_query = dict(query)
            if cursor: request_query['cursor'] = cursor
            try:
                page = require_object(api.json('GET', path + '/tasks/' + args.task + '/logs?' + urllib.parse.urlencode(request_query)))
            except CliError as error:
                # These are local generic transport/status messages, never upstream log content.
                transient = str(error).startswith('HTTPS connection failed.') or bool(re.fullmatch(r'Request failed \(HTTP 5[0-9]{2}\)\.', str(error)))
                if not args.follow or not transient: raise
                print('Log connection interrupted; retrying the saved position.', file=sys.stderr); time.sleep(2); continue
            if page.get('source') == 'none':
                if not args.follow: completed = True; break
                time.sleep(2); continue
            source = require_object(page.get('stream'))
            records = page.get('records'); next_cursor = page.get('cursor')
            if not isinstance(records, list) or len(records) > 64 or not isinstance(next_cursor, str) or not OPAQUE_RE.fullmatch(next_cursor):
                raise CliError('Invalid archive replay page.')
            if not re.fullmatch(r'[a-f0-9]{64}', source.get('id', '')) or stream_id and stream_id != source['id']:
                raise CliError('Archive source changed during replay.')
            next_sequence = sequence; pieces = []
            for r in records:
                r = require_object(r); seq = r.get('sequence')
                if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1: raise CliError('Invalid archive sequence.')
                if next_sequence is not None and seq <= next_sequence: continue
                if next_sequence is not None and seq != next_sequence + 1: raise CliError('Archive replay skipped a committed record.')
                if r.get('kind') == 'data':
                    value = r.get('data')
                    if not isinstance(value, str) or len(value) > 21848: raise CliError('Archive record exceeds bounds.')
                    try: decoded = base64.b64decode(value, validate=True)
                    except ValueError: raise CliError('Invalid archive bytes.') from None
                    if len(decoded) > 16384: raise CliError('Archive record exceeds bounds.')
                    pieces.append(decoded)
                elif r.get('kind') == 'gap':
                    print('Log capture coverage boundary; original source bytes may be missing.', file=sys.stderr)
                else: raise CliError('Invalid archive record.')
                next_sequence = seq
            output(b''.join(pieces))
            cursor, sequence, stream_id = next_cursor, next_sequence, source['id']
            if page.get('hasMore'): continue
            if not args.follow or source.get('state') in ('closed', 'capped'): completed = True; break
            time.sleep(2)
    except KeyboardInterrupt:
        completed = True
    finally:
        output(b'', final=True)
        # Abrupt process death can replay the last invocation; stdout/checkpoint are not atomic.
        if completed and checkpoint and cursor: checkpoint.save(cursor)

def ignored(relative):
    return any(part in IGNORED or part.startswith(('.env', '.pai-', 'pai-checkpoint-')) for part in relative.split('/'))

def safe_relative(value, root=False):
    if root and value == '': return ''
    if (not isinstance(value, str) or not value or len(value) > 4096 or value.startswith('/') or '\\' in value or ':' in value or
            re.search(r'[\x00-\x1f\x7f]', value) or any(part in ('', '.', '..') for part in value.split('/')) or ignored(value)):
        raise CliError('Unsafe or private relative file path.')
    return value

class GatewayClient:
    def __init__(self, dashboard_origin, session_id, launch_url, transport=None):
        dashboard = urllib.parse.urlsplit(api_origin(dashboard_origin))
        if not ID_RE.fullmatch(session_id): raise CliError('Invalid session identifier.')
        host = session_id + '.apps.' + dashboard.hostname
        try:
            url = urllib.parse.urlsplit(launch_url)
            query = urllib.parse.parse_qs(url.query, keep_blank_values=True)
            if (url.scheme != 'https' or url.netloc != host or url.path != '/' or url.fragment or
                    set(query) != {'ticket'} or len(query['ticket']) != 1 or not OPAQUE_RE.fullmatch(query['ticket'][0])):
                raise ValueError()
        except (ValueError, TypeError): raise CliError('Launch URL is not the expected isolated gateway.') from None
        self.origin = 'https://' + host
        self.host = host
        self._launch_url = launch_url
        self.transport = transport or HttpTransport()
        self.cookies = http.cookiejar.CookieJar()
    def exchange(self):
        with self.transport.open('GET', self._launch_url, {'Accept': 'application/json'}) as response:
            if response.status != 303: status_ok(response, 303)
            if not response.headers.get('Location'): raise CliError('Gateway omitted the clean redirect target.')
            location = urllib.parse.urlsplit(urllib.parse.urljoin(self.origin + '/', response.headers['Location']))
            if location.scheme != 'https' or location.netloc != self.host or location.path != '/' or location.query or location.fragment:
                raise CliError('Gateway redirected outside the clean session URL.')
            values = response.headers.get_all('Set-Cookie', []) if hasattr(response.headers, 'get_all') else [response.headers.get('Set-Cookie', '')]
            candidates = [value for value in values if value.startswith('__Host-pai-session=')]
            if len(candidates) != 1 or candidates[0].count('__Host-pai-session=') != 1: raise CliError('Gateway did not issue one host-only session cookie.')
            cookie = SimpleCookie()
            try: cookie.load(candidates[0])
            except CookieError: raise CliError('Invalid gateway cookie syntax.') from None
            morsel = cookie.get('__Host-pai-session')
            if (morsel is None or not OPAQUE_RE.fullmatch(morsel.value) or morsel['domain'] or morsel['path'] != '/' or
                    not morsel['secure'] or not morsel['httponly']): raise CliError('Unsafe gateway session cookie.')
            try: expires = int(time.time()) + int(morsel['max-age']) if morsel['max-age'] else None
            except ValueError: raise CliError('Invalid gateway cookie lifetime.') from None
            if expires is not None and expires <= time.time(): raise CliError('Gateway session cookie has already expired.')
            self.cookies.set_cookie(http.cookiejar.Cookie(0, '__Host-pai-session', morsel.value, None, False, self.host, False, False,
                '/', True, True, expires, expires is None, None, None, {'HttpOnly': None}, False))
        self._launch_url = None
    def _open(self, method, path, data=None, size=None):
        request = urllib.request.Request(self.origin + path)
        self.cookies.add_cookie_header(request)
        headers = dict(request.header_items())
        headers['Origin'] = self.origin
        if size is not None: headers.update({'Content-Length': str(size), 'Content-Type': 'application/octet-stream'})
        return self.transport.open(method, self.origin + path, headers, data)
    def listing(self, path=''):
        safe_relative(path, root=True)
        with self._open('GET', '/api/files?' + urllib.parse.urlencode({'path': path})) as response:
            status_ok(response); listing = read_json(response)
        if not isinstance(listing, dict) or listing.get('path') != path or not isinstance(listing.get('entries'), list) or len(listing['entries']) > 4096:
            raise CliError('Invalid file listing protocol.')
        limit = listing.get('maxUploadBytes')
        if type(limit) is not int or not 0 < limit <= MAX_UPLOAD: raise CliError('Invalid file upload limit.')
        entries = []
        for entry in listing['entries']:
            if not isinstance(entry, dict) or not isinstance(entry.get('name'), str) or '/' in entry['name']: raise CliError('Invalid file listing entry.')
            relative = (path + '/' if path else '') + entry['name']
            # Validate before skipping ignored entries: remote paths must never escape their listed folder.
            if entry.get('path') != relative or entry.get('type') not in ('file', 'directory'): raise CliError('Invalid file listing path.')
            if ignored(relative): continue
            safe_relative(relative)
            if type(entry.get('size')) is not int or entry['size'] < 0: raise CliError('Invalid file size.')
            entries.append(entry)
        return {**listing, 'entries': entries}
    def upload(self, path, source, size):
        safe_relative(path)
        if not 0 <= size <= MAX_UPLOAD: raise CliError('Upload exceeds the supported file size.')
        with self._open('PUT', '/files/' + urllib.parse.quote(path, safe='/'), source, size) as response: status_ok(response, 204)
    def download(self, path):
        safe_relative(path)
        response = self._open('GET', '/files/' + urllib.parse.quote(path, safe='/'))
        try: status_ok(response, 200)
        except Exception: response.close(); raise
        return response

class LocalTree:
    def __init__(self, path, credentials_path=None, create=True):
        self.path = Path(path).expanduser().absolute()
        self.credentials = Path(credentials_path or default_config()).expanduser().absolute()
        self.fd = directory_fd(self.path, create=create)
    def __enter__(self): return self
    def __exit__(self, *args): os.close(self.fd)
    def _validate(self, path):
        safe_relative(path)
        candidate = self.path.joinpath(*path.split('/'))
        if candidate == self.credentials or self.credentials.parent == candidate:
            raise CliError('Credentials are excluded from file synchronization.')
    def files(self):
        result = []
        def walk(fd, prefix='', depth=0):
            if depth > 128 or len(result) > 100000: raise CliError('Local tree exceeds traversal limits.')
            for name in sorted(os.listdir(fd)):
                relative = prefix + name
                if ignored(relative) or self.path.joinpath(*relative.split('/')) in (self.credentials, self.credentials.parent): continue
                self._validate(relative)
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try: walk(child, relative + '/', depth + 1)
                    finally: os.close(child)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1: result.append(relative)
        try: walk(self.fd)
        except OSError: raise CliError('Could not safely traverse local files.') from None
        return result
    def _parent(self, path, create=False):
        self._validate(path); parts = path.split('/'); fd = os.dup(self.fd)
        try:
            for part in parts[:-1]:
                if create:
                    try: os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError: pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = child
            return fd, parts[-1]
        except OSError:
            os.close(fd); raise CliError('Unsafe local file parent.') from None
    def open_file(self, path):
        parent, name = self._parent(path)
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                os.close(fd); raise CliError('Only regular, non-linked local files can be uploaded.')
            return os.fdopen(fd, 'rb')
        except OSError: raise CliError('Local file is unsafe or unavailable.') from None
        finally: os.close(parent)
    def save(self, path, source, expected_size=None):
        parent, name = self._parent(path, create=True); temporary = '.pai-sync-' + secrets.token_hex(12)
        try:
            try:
                existing = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1: raise CliError('Refusing to replace an unsafe local file.')
            except FileNotFoundError: pass
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            with os.fdopen(fd, 'wb') as output:
                received = 0
                while True:
                    chunk = source.read(CHUNK)
                    if not chunk: break
                    received += len(chunk)
                    if expected_size is not None and received > expected_size:
                        raise CliError('Downloaded file grew beyond the listed size; retry with a fresh listing.')
                    output.write(chunk)
                if expected_size is not None and received != expected_size:
                    raise CliError('Download was incomplete or the remote file changed; the existing file was kept.')
                output.flush(); os.fsync(output.fileno())
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent); os.fsync(parent)
        except OSError: raise CliError('Download could not be committed safely.') from None
        finally:
            try: os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError: pass
            os.close(parent)

def upload_tree(gateway, tree, remote='', previous=None):
    safe_relative(remote, root=True)
    limit = gateway.listing('')['maxUploadBytes']; previous = previous or {}; state = {}
    for path in tree.files():
        with tree.open_file(path) as source:
            size = os.fstat(source.fileno()).st_size
            if size > limit: raise CliError('A local file exceeds the runtime upload limit.')
            digest = hashlib.file_digest(source, 'sha256').hexdigest(); state[path] = digest
            if previous.get(path) == digest: continue
            source.seek(0); gateway.upload((remote + '/' if remote else '') + path, source, size)
    return state

def download_tree(gateway, tree, remote=''):
    safe_relative(remote, root=True); pending = [(remote, '')]; visited = set(); count = 0
    while pending:
        directory, local = pending.pop()
        if directory in visited or len(visited) > 10000: raise CliError('Remote tree exceeds traversal limits.')
        visited.add(directory)
        for entry in gateway.listing(directory)['entries']:
            relative = local + entry['name']; tree._validate(relative)
            if entry['type'] == 'directory': pending.append((entry['path'], relative + '/'))
            else:
                with gateway.download(entry['path']) as response: tree.save(relative, response, expected_size=entry['size'])
                count += 1
    return count

@contextmanager
def file_session(api, workflow, task, transport=None, timeout=120):
    if not ID_RE.fullmatch(workflow) or not ID_RE.fullmatch(task): raise CliError('Invalid workflow or task identifier.')
    created = api.json('POST', '/sessions', {'kind': 'port-forward', 'workflowId': workflow, 'taskName': task, 'replicaIndex': 0, 'portName': 'pai-files', 'ttlMinutes': 60})
    session_id = created.get('id') if isinstance(created, dict) else None
    if not isinstance(session_id, str) or not ID_RE.fullmatch(session_id): raise CliError('Session API did not return an identifier.')
    if (created.get('canEnd') is not True or created.get('projectId') != api.project_id or created.get('workflowId') != workflow or
            created.get('taskName') != task or created.get('kind') != 'port-forward'):
        raise CliError('Session response has an unverified owner/project binding; no session will be reused or deleted.')
    try:
        deadline = time.monotonic() + timeout
        current = created
        while True:
            if (current.get('projectId') != api.project_id or current.get('workflowId') != workflow or current.get('taskName') != task or current.get('kind') != 'port-forward'):
                raise CliError('File session binding does not match this request.')
            if current.get('status') == 'READY' and current.get('canOpen') is True: break
            if current.get('status') in ('FAILED', 'CLOSED', 'CLOSING') or time.monotonic() >= deadline: raise CliError('File session is unavailable or did not become ready.')
            time.sleep(1)
            # The existing server exposes readiness through the own-session list, not GET /sessions/:id.
            sessions = api.json('GET', '/sessions')
            if not isinstance(sessions, list): raise CliError('Session listing API is unavailable.')
            current = next((item for item in sessions if isinstance(item, dict) and item.get('id') == session_id), {})
        launch = api.json('POST', '/sessions/' + session_id + '/launch')
        if not isinstance(launch, dict) or not isinstance(launch.get('url'), str): raise CliError('Session launch API is unavailable.')
        gateway = GatewayClient(api.origin, session_id, launch['url'], transport)
        gateway.exchange(); yield gateway
    finally:
        api.json('DELETE', '/sessions/' + session_id)

def print_json(value): print(redact(json.dumps(value, ensure_ascii=False, indent=2)))

def require_object(value):
    if not isinstance(value, dict): raise CliError('API response is not the expected object.')
    return value

def parser():
    result = argparse.ArgumentParser(description='Physical AI project CLI (no token in command-line arguments)')
    result.add_argument('--config', type=Path, default=default_config())
    commands = result.add_subparsers(dest='command', required=True)
    login = commands.add_parser('login'); login.add_argument('--url', required=True)
    workflows = commands.add_parser('workflows').add_subparsers(dest='action', required=True)
    listing = workflows.add_parser('list'); listing.add_argument('--status'); listing.add_argument('--search')
    submit = workflows.add_parser('submit'); submit.add_argument('file', type=Path); submit.add_argument('--param', action='append', default=[]); submit.add_argument('--idempotency-key')
    submit.add_argument('--acknowledge-preflight', action='store_true', help='Confirm you reviewed image/runtime preflight findings for this workflow; blocked findings cannot be overridden.')
    for action in ('status', 'cancel'):
        item = workflows.add_parser(action); item.add_argument('id')
    logs = workflows.add_parser('logs'); logs.add_argument('id'); logs.add_argument('--task', required=True); logs.add_argument('--follow', action='store_true')
    logs.add_argument('--start', choices=('tail', 'beginning'), default='tail', help='Replay bounded archive tail or all committed bytes')
    logs.add_argument('--attempt', type=int); logs.add_argument('--member', type=int); logs.add_argument('--container'); logs.add_argument('--stream')
    logs.add_argument('--cursor'); logs.add_argument('--cursor-file', type=Path, help='Private resume checkpoint, saved after clean exit/output flush')
    sync = commands.add_parser('sync').add_subparsers(dest='action', required=True)
    for action in ('upload', 'download', 'watch'):
        item = sync.add_parser(action); item.add_argument('--workflow', required=True); item.add_argument('--task', required=True); item.add_argument('--local', type=Path, required=True); item.add_argument('--path', default=''); item.add_argument('--interval', type=float, default=2)
    return result

def main(argv=None):
    args = parser().parse_args(argv)
    try:
        store = ConfigStore(args.config)
        if args.command == 'login':
            origin = api_origin(args.url)
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter('error', getpass.GetPassWarning)
                    token = getpass.getpass('API token (hidden): ').strip()
            except (getpass.GetPassWarning, EOFError):
                raise CliError('A private terminal is required for token input.') from None
            api = ApiClient(origin, token)
            identity = api.json('GET', '/me')
            if not isinstance(identity, dict) or identity.get('authMethod') != 'token' or identity.get('role') not in ('viewer', 'researcher') or not identity.get('tokenProjectId'):
                raise CliError('Versioned token authentication API is not ready.')
            store.save(origin, token, identity['tokenProjectId']); print('Login saved securely.'); return 0
        config = store.load(); api = ApiClient(config['url'], config['token'], config['projectId'])
        if args.command == 'workflows':
            if args.action == 'list':
                query = urllib.parse.urlencode({key: value for key, value in {'status': args.status, 'q': args.search}.items() if value})
                data = api.json('GET', '/workflows' + ('?' + query if query else ''))
                rows = data if isinstance(data, list) else data.get('items') if isinstance(data, dict) else None
                if not isinstance(rows, list): raise CliError('Invalid workflow listing response.')
                if not all(isinstance(row, dict) for row in rows): raise CliError('Invalid workflow listing entry.')
                print_json([{key: row.get(key) for key in ('id', 'name', 'status', 'createdAt', 'taskCount', 'succeededCount')} for row in rows])
            elif args.action == 'submit':
                overrides = {}
                for item in args.param:
                    key, separator, value = item.partition('=')
                    if not separator or not key: raise CliError('Use --param name=value.')
                    overrides[key] = value
                with LocalTree(args.file.parent, args.config, create=False) as tree, tree.open_file(args.file.name) as source:
                    raw = source.read(MAX_JSON + 1)
                    if len(raw) > MAX_JSON: raise CliError('Workflow file exceeds the input size limit.')
                    text = raw.decode('utf-8')
                payload = {'yaml': text, 'overrides': overrides}
                if args.acknowledge_preflight: payload['acknowledgePreflight'] = True
                result = require_object(api.json('POST', '/workflows', payload, {'Idempotency-Key': args.idempotency_key or secrets.token_hex(16)}))
                run_id = result.get('runId') or result.get('id')
                if not isinstance(run_id, str) or not ID_RE.fullmatch(run_id): raise CliError('Submission did not return a workflow ID.')
                print_json({'id': run_id, 'status': result.get('status')})
            else:
                if not ID_RE.fullmatch(args.id): raise CliError('Invalid workflow identifier.')
                path = '/workflows/' + args.id
                if args.action == 'status':
                    data = require_object(api.json('GET', path)); workflow = require_object(data.get('workflow', data))
                    tasks = data.get('tasks', [])
                    if workflow.get('id') != args.id or not isinstance(workflow.get('status'), str) or not isinstance(tasks, list) or not all(isinstance(task, dict) for task in tasks):
                        raise CliError('Invalid workflow status response.')
                    print_json({**{key: workflow.get(key) for key in ('id', 'name', 'status', 'taskCount', 'succeededCount', 'failedCount')},
                        'tasks': [{key: task.get(key) for key in ('name', 'phase', 'attempts', 'message')} for task in tasks]})
                elif args.action == 'cancel':
                    data = require_object(api.json('POST', path + '/cancel'))
                    if data.get('id') != args.id or not isinstance(data.get('status'), str): raise CliError('Invalid workflow cancellation response.')
                    print_json({'id': data.get('id'), 'status': data.get('status')})
                else:
                    replay_logs(api, path, args)
        else:
            if args.interval < 1: raise CliError('Watch interval must be at least one second.')
            safe_relative(args.path, root=True)
            if args.action != 'download' and not args.local.is_dir(): raise CliError('Upload source directory does not exist.')
            with LocalTree(args.local, args.config) as tree, file_session(api, args.workflow, args.task) as gateway:
                if args.action == 'download': print_json({'downloaded': download_tree(gateway, tree, args.path)})
                else:
                    state = upload_tree(gateway, tree, args.path)
                    print_json({'localFiles': len(state), 'status': 'uploaded'})
                    while args.action == 'watch':
                        time.sleep(args.interval); state = upload_tree(gateway, tree, args.path, state)
        return 0
    except KeyboardInterrupt:
        print('Stopped.'); return 0
    except (CliError, OSError, ValueError, KeyError, TypeError) as error:
        print(redact(str(error)) if isinstance(error, CliError) else 'Operation failed; check API availability and local files.', file=sys.stderr)
        return 1

if __name__ == '__main__': sys.exit(main())

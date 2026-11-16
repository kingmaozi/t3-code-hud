#!/opt/homebrew/bin/python3
"""Resilient stdio JSON-RPC wrapper around sibling agy_acp_server.par.

Automatically retries transient -32603 Internal error failures (caused by
upstream proxy RemoteDisconnected drops to *.googleapis.com) on idempotent
session-setup RPCs (authenticate, session/new, session/resume, session/load)
against the already-running ACP server process, counts (never deletes) newly
leaked 0-byte conversation .db files from failed session/new attempts, and
preserves all stdout/stderr auth handshakes and streaming protocol semantics
verbatim.

Hardened on macOS to:
1) Run under Homebrew CLI python3 instead of Xcode's GUI Python.app (3.9.6),
   avoiding macOS CrashReporter GUI modal popups ("Python 意外退出").
2) Use raw OS file-descriptor I/O (os.read / os.write) instead of CPython
   BufferedReader/BufferedWriter locks so daemon pump threads can never trigger
   _Py_FatalErrorFormat(SIGABRT) during interpreter shutdown or signal teardown.
   InterruptedError is retried on every raw read/write, pump lines are
   exception-isolated (one bad line never kills a pump), forwarded signals
   escalate with a bounded kill+wait watchdog (no orphans), launch failures
   emit only the event type to stderr, and child stderr is forwarded verbatim
   but persisted only as an event kind (never full text). Child exit codes
   always propagate verbatim (128+signum for signal deaths); os._exit is used
   only to skip the finalization crash, never to mask a failure. Normal exit
   drains pumps/retry workers fully; forced cancel uses a bounded drain.
"""

import datetime
import json
import os
import re
import resource
import signal
import subprocess
import sys
import threading
import time

try:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
except Exception:
    pass

SETUP_METHODS = frozenset(("authenticate", "session/new", "session/resume", "session/load"))
DEFAULT_BACKOFFS = (0.25, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0)
MAX_LOG_BYTES = 512 * 1024

SECRET_PATTERNS = (
    re.compile(r"Bearer\s+\S+", re.IGNORECASE),
    re.compile(r"ya29\.[A-Za-z0-9._-]+"),
    re.compile(r"1//[A-Za-z0-9._-]+"),
    re.compile(r"AIza[A-Za-z0-9_-]+"),
    re.compile(r"GOCSPX-[A-Za-z0-9_-]+"),
    re.compile(r"https://accounts\.google\.com/\S+"),
)


def redact(text):
    out = text
    for pat in SECRET_PATTERNS:
        out = pat.sub("<REDACTED>", out)
    return out


SECRET_LIKE_RE = re.compile(
    r"access[_-]?token|api[_-]?key|secret|password|bearer|session[_-]?token|refresh",
    re.IGNORECASE,
)


def stderr_event_kind(raw):
    # Minimal persistence policy: never store child stderr text verbatim.
    # Record only byte length + whether the line looks secret-like.
    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception:
        text = ""
    if any(p.search(text) for p in SECRET_PATTERNS) or SECRET_LIKE_RE.search(text):
        return "secret_like"
    return "line"


def parse_backoffs():
    raw = os.environ.get("AGY_WRAPPER_BACKOFFS", "").strip()
    if not raw:
        return DEFAULT_BACKOFFS
    try:
        vals = tuple(float(x.strip()) for x in raw.split(",") if x.strip())
        return vals if vals else DEFAULT_BACKOFFS
    except ValueError:
        return DEFAULT_BACKOFFS


def conversations_dir():
    gemini_home = os.environ.get("GEMINI_HOME", "").strip()
    if not gemini_home:
        return ""
    return os.path.join(gemini_home, "antigravity-acp", "conversations")


def snapshot_dbs(conv_dir):
    if not conv_dir or not os.path.isdir(conv_dir):
        return set()
    try:
        return {name for name in os.listdir(conv_dir) if name.endswith(".db")}
    except OSError:
        return set()


def count_new_zero_byte_dbs(conv_dir, pre_existing):
    # Ownership of concurrent zero-byte .db files is unprovable (another
    # process may be mid-write), so never delete: count only, for diagnostics.
    # Filenames are private and are never logged.
    if not conv_dir or not os.path.isdir(conv_dir):
        return 0
    count = 0
    try:
        entries = os.listdir(conv_dir)
    except OSError:
        return 0
    for name in entries:
        if not name.endswith(".db") or name in pre_existing:
            continue
        full = os.path.join(conv_dir, name)
        meta = full + ".meta"
        try:
            if os.path.exists(meta) or os.path.islink(full) or not os.path.isfile(full):
                continue
            if os.stat(full).st_size == 0:
                count += 1
        except OSError:
            pass
    return count


def req_key(req_id):
    return (type(req_id).__name__, req_id)


def write_all_fd(fd, data):
    view = memoryview(data)
    total = len(view)
    sent = 0
    while sent < total:
        try:
            n = os.write(fd, view[sent:])
        except InterruptedError:
            continue
        if n <= 0:
            raise OSError("short write")
        sent += n


def iter_fd_lines(fd):
    buf = bytearray()
    while True:
        try:
            chunk = os.read(fd, 65536)
        except InterruptedError:
            continue
        except OSError:
            break
        if not chunk:
            if buf:
                yield bytes(buf)
            break
        buf.extend(chunk)
        while True:
            nl = buf.find(b"\n")
            if nl < 0:
                break
            line = bytes(buf[: nl + 1])
            del buf[: nl + 1]
            yield line


class DiagnosticLogger(object):
    def __init__(self):
        default_path = os.path.expanduser("~/.t3/userdata/logs/provider/antigravity-acp-stderr.log")
        self.path = os.environ.get("AGY_WRAPPER_LOG_PATH", default_path)
        self.lock = threading.Lock()

    def write(self, message):
        if not self.path:
            return
        safe = redact(message.rstrip("\r\n"))
        if not safe.strip():
            return
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        line = f"[{ts}] [pid={os.getpid()}] {safe}\n"
        with self.lock:
            try:
                parent = os.path.dirname(self.path)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                if os.path.exists(self.path) and os.path.getsize(self.path) > MAX_LOG_BYTES:
                    os.replace(self.path, self.path + ".1")
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line)
            except OSError:
                pass


class SetupState(object):
    def __init__(self, method, raw_bytes, pre_dbs):
        self.method = method
        self.raw_bytes = raw_bytes
        self.pre_dbs = pre_dbs
        self.attempt = 0
        self.emitted_side_effect = False


def main():
    real_dir = os.path.dirname(os.path.realpath(__file__))
    real_bin = os.environ.get("AGY_WRAPPER_REAL_BIN") or os.path.join(real_dir, "agy_acp_server.par")
    backoffs = parse_backoffs()
    conv_dir = conversations_dir()
    diag = DiagnosticLogger()

    child = subprocess.Popen(
        [real_bin] + sys.argv[1:],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )

    state_lock = threading.Lock()
    child_stdin_lock = threading.Lock()
    stdout_write_lock = threading.Lock()
    stderr_write_lock = threading.Lock()
    inflight_setup = {}
    stdin_eof = threading.Event()
    cancel_requested = threading.Event()
    cancel_signum = [None]
    retry_threads = []
    child_stdin_closed = [False]

    shutdown_watchdog_started = threading.Event()

    def forward_signal(signum, _frame):
        stdin_eof.set()
        cancel_requested.set()
        if cancel_signum[0] is None:
            cancel_signum[0] = signum
        try:
            child.send_signal(signum)
        except OSError:
            pass
        if not shutdown_watchdog_started.is_set():
            shutdown_watchdog_started.set()

            def _watchdog():
                # Bounded kill+wait escalation: forwarding alone hangs forever
                # when the child ignores the signal. Grace (3s), then SIGKILL
                # (unignorable) and reap, so no orphan survives our exit.
                # The forced path avoids interpreter finalization (os._exit).
                for _ in range(15):
                    if child.poll() is not None:
                        return
                    time.sleep(0.2)
                try:
                    child.kill()
                except OSError:
                    pass
                for _ in range(10):
                    if child.poll() is not None:
                        return
                    time.sleep(0.2)
                # Reap (wait) if kill did not reap yet; only if still alive
                # after kill+wait fall back to force-exit (child is SIGKILLed
                # and cannot survive unless D-state; accept that residue).
                try:
                    child.wait(timeout=2)
                except Exception:
                    pass
                if child.poll() is None:
                    os._exit(128 + signum)

            threading.Thread(target=_watchdog, daemon=True).start()

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(sig, forward_signal)
        except (OSError, ValueError):
            pass

    def close_child_stdin():
        with child_stdin_lock:
            if not child_stdin_closed[0]:
                child_stdin_closed[0] = True
                try:
                    child.stdin.close()
                except (OSError, ValueError):
                    pass

    def write_child_stdin(data):
        with child_stdin_lock:
            if child_stdin_closed[0] or child.poll() is not None:
                return False
            try:
                write_all_fd(child.stdin.fileno(), data)
                return True
            except (OSError, ValueError):
                return False

    def write_client_stdout(data):
        with stdout_write_lock:
            try:
                write_all_fd(1, data)
            except OSError:
                pass

    def write_client_stderr(data):
        with stderr_write_lock:
            try:
                write_all_fd(2, data)
            except OSError:
                pass

    def schedule_retry(key, st, delay, last_error_raw):
        def _retry_worker():
            def _cancel_and_forward():
                with state_lock:
                    popped = inflight_setup.pop(key, None)
                if popped is st:
                    write_client_stdout(last_error_raw)
                else:
                    # Already terminal: forward error so the client never
                    # hangs waiting for a response that will never arrive.
                    write_client_stdout(last_error_raw)

            if stdin_eof.wait(timeout=delay) or child.poll() is not None:
                _cancel_and_forward()
                return
            with state_lock:
                current = inflight_setup.get(key)
                if current is not st:
                    return
                if st.emitted_side_effect:
                    # A notification landed during backoff: do not resend a
                    # non-idempotent setup. Forward the original error.
                    inflight_setup.pop(key, None)
                    cancelled = True
                elif st.method == "session/new":
                    st.pre_dbs = snapshot_dbs(conv_dir)
                    cancelled = False
                else:
                    cancelled = False
            if cancelled:
                write_client_stdout(last_error_raw)
                return
            if not write_child_stdin(st.raw_bytes):
                _cancel_and_forward()

        t = threading.Thread(target=_retry_worker, daemon=True)
        retry_threads.append(t)
        t.start()

    def pump_stdin():
        try:
            for raw in iter_fd_lines(0):
                stripped = raw.strip()
                if stripped.startswith(b"{"):
                    try:
                        msg = json.loads(stripped.decode("utf-8"))
                    except Exception:
                        msg = None
                    if isinstance(msg, dict):
                        method = msg.get("method")
                        req_id = msg.get("id")
                        if req_id is not None and method in SETUP_METHODS:
                            pre_dbs = snapshot_dbs(conv_dir) if method == "session/new" else set()
                            with state_lock:
                                inflight_setup[req_key(req_id)] = SetupState(method, raw, pre_dbs)
                if not write_child_stdin(raw):
                    break
        finally:
            stdin_eof.set()
            close_child_stdin()

    def pump_stdout():
        try:
            for raw in iter_fd_lines(child.stdout.fileno()):
                try:
                    _pump_stdout_line(raw)
                except Exception as exc:
                    diag.write(f"pump_stdout line error: {exc!r}")
                    write_client_stdout(raw)
        except Exception as exc:
            diag.write(f"pump_stdout fatal: {exc!r}")

    def _pump_stdout_line(raw):
        stripped = raw.strip()
        if not stripped.startswith(b"{"):
            write_client_stdout(raw)
            return
        try:
            msg = json.loads(stripped.decode("utf-8"))
        except Exception:
            write_client_stdout(raw)
            return
        if not isinstance(msg, dict):
            write_client_stdout(raw)
            return
        if "method" in msg:
            with state_lock:
                for st in inflight_setup.values():
                    st.emitted_side_effect = True
            write_client_stdout(raw)
            return
        if "id" in msg:
            key = req_key(msg["id"])
            with state_lock:
                st = inflight_setup.get(key)
                if st is not None:
                    err = msg.get("error")
                    err_code = err.get("code") if isinstance(err, dict) else None
                    can_retry = (
                        err_code == -32603
                        and not st.emitted_side_effect
                        and st.attempt < len(backoffs)
                        and not stdin_eof.is_set()
                    )
                    if can_retry:
                        delay = backoffs[st.attempt]
                        st.attempt += 1
                        attempt_num = st.attempt
                        method_name = st.method
                        pre_dbs = st.pre_dbs
                    else:
                        inflight_setup.pop(key, None)
                        attempt_num = None
                        method_name = st.method
                        pre_dbs = st.pre_dbs
                        is_terminal_err = isinstance(err, dict)
                else:
                    attempt_num = None
                    method_name = None
                    pre_dbs = None
                    is_terminal_err = False
            if st is not None and attempt_num is not None:
                counted = count_new_zero_byte_dbs(conv_dir, pre_dbs) if method_name == "session/new" else 0
                diag.write(
                    f"retrying {method_name} (attempt {attempt_num}/{len(backoffs)} in {delay}s) "
                    f"after -32603 Internal error; zero_byte_dbs={counted}"
                )
                schedule_retry(key, st, delay, raw)
                return
            if st is not None and is_terminal_err and method_name == "session/new":
                counted = count_new_zero_byte_dbs(conv_dir, pre_dbs)
                diag.write(f"terminal error on session/new; zero_byte_dbs={counted}")
        write_client_stdout(raw)

    def pump_stderr():
        try:
            for raw in iter_fd_lines(child.stderr.fileno()):
                write_client_stderr(raw)
                try:
                    diag.write(f"acp_stderr bytes={len(raw)} kind={stderr_event_kind(raw)}")
                except Exception:
                    pass
        except Exception as exc:
            diag.write(f"pump_stderr fatal: {exc!r}")

    t_in = threading.Thread(target=pump_stdin, daemon=True)
    t_out = threading.Thread(target=pump_stdout, daemon=True)
    t_err = threading.Thread(target=pump_stderr, daemon=True)
    t_in.start()
    t_out.start()
    t_err.start()

    while True:
        try:
            rc = child.wait()
            break
        except InterruptedError:
            continue
    stdin_eof.set()
    # A cancellation may arrive AFTER child.wait() or during a slow-client
    # drain. Recheck on every bounded join instead of committing to an
    # uncancellable join() based on a single earlier snapshot.
    cancel_deadline = None
    def drain_thread(t):
        nonlocal cancel_deadline
        while t.is_alive():
            if cancel_requested.is_set():
                if cancel_deadline is None:
                    cancel_deadline = time.monotonic() + 2.0
                if time.monotonic() >= cancel_deadline:
                    break
            t.join(timeout=0.05)

    drain_thread(t_out)
    drain_thread(t_err)
    # Only stdout creates retry threads. Snapshot AFTER it has drained so
    # a retry scheduled concurrently with child exit cannot be omitted.
    for t in list(retry_threads):
        drain_thread(t)
    if cancel_signum[0] is not None:
        exit_code = 128 + cancel_signum[0]
    elif rc >= 0:
        exit_code = rc
    else:
        exit_code = 128 + abs(rc)
    os._exit(exit_code)


if __name__ == "__main__":
    try:
        main()
    except BaseException as _exc:
        # Launch/setup failures must stay visible but minimized: emit only
        # the event type on fd 2 (never stdout/protocol, never a full
        # traceback that may embed paths/secrets) before the abrupt exit;
        # child exit codes never take this path.
        try:
            write_all_fd(2, ("launch_error: %s\n" % type(_exc).__name__).encode("utf-8", "replace"))
        except Exception:
            pass
        os._exit(1)

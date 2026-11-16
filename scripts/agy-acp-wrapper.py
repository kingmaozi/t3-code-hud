#!/opt/homebrew/bin/python3
"""Resilient stdio JSON-RPC wrapper around sibling agy_acp_server.par.

Forwards ACP messages without automatically replaying failed requests: an
Internal error cannot establish that the server had no side effects. Counts
(never deletes) newly leaked 0-byte conversation .db files and preserves
stdout/stderr streaming semantics.

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
   drains output pumps fully; forced cancel uses a bounded drain.
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


def main():
    real_dir = os.path.dirname(os.path.realpath(__file__))
    real_bin = os.environ.get("AGY_WRAPPER_REAL_BIN") or os.path.join(real_dir, "agy_acp_server.par")
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
    inflight_new = {}
    cancel_requested = threading.Event()
    cancel_signum = [None]
    child_stdin_closed = [False]

    shutdown_watchdog_started = threading.Event()

    def forward_signal(signum, _frame):
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
                        if method == "session/new" and isinstance(req_id, (str, int, float)):
                            pre_dbs = snapshot_dbs(conv_dir)
                            with state_lock:
                                inflight_new[req_key(req_id)] = pre_dbs
                if not write_child_stdin(raw):
                    break
        finally:
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
        if "method" not in msg and isinstance(msg.get("id"), (str, int, float)):
            key = req_key(msg["id"])
            with state_lock:
                pre_dbs = inflight_new.pop(key, None)
            if pre_dbs is not None and isinstance(msg.get("error"), dict):
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

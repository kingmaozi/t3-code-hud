#!/opt/homebrew/bin/python3
"""Idempotently install the canonical AGY ACP resilient wrapper.

Source of truth: scripts/agy-acp-wrapper.py (this directory).
Target: ~/.t3/tools/antigravity-acp/darwin-arm64/versions/<ver>/agy_acp_resilient_wrapper
(T3 Code spawns this path directly via settings.json binaryPath.)

Usage:
    python3 scripts/agy-acp-wrapper-install.py           # install (backup + atomic replace/create)
    python3 scripts/agy-acp-wrapper-install.py --check   # report drift only, change nothing
    python3 scripts/agy-acp-wrapper-install.py --root ~/.t3/tools/antigravity-acp/darwin-arm64/versions

Discovery: every version dir with an existing wrapper (replace if drifted)
AND every version dir with a valid agy_acp_server.par but no wrapper
(create). A valid server is a regular executable file of at least 1MB;
anything else is ignored (reported, never touched).

Safety:
- Never sends signals or restarts any T3/ACP process. Running wrappers keep
  their in-memory image; the new bytes apply on the next T3 spawn.
- Never reads or writes T3 provider bindings (settings.json binaryPath);
  an existing binding is left exactly as found.
- Refuses to install when the canonical shebang interpreter is missing or
  not executable (exit non-zero before touching any target; not a warning).
- Backs up each replaced file to <name>.bak.<timestamp> before replacing.
- Uses write-temp-then-rename so a crash cannot leave a half-written wrapper.
- Verifies the canonical source compiles under every available interpreter
  in-memory (no __pycache__); --check performs only reads.
- Preserves the 0755 executable bit.
"""

import argparse
import datetime
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.realpath(__file__))
CANONICAL = os.path.join(HERE, "agy-acp-wrapper.py")
DEFAULT_ROOT = os.path.expanduser("~/.t3/tools/antigravity-acp/darwin-arm64/versions")
WRAPPER_NAME = "agy_acp_resilient_wrapper"
SERVER_NAME = "agy_acp_server.par"
MIN_SERVER_BYTES = 1_000_000
INTERPRETERS = [
    "/opt/homebrew/bin/python3",
    "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework"
    "/Versions/3.9/Resources/Python.app/Contents/MacOS/Python",
]


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def available_interpreters():
    return [p for p in INTERPRETERS if os.path.isfile(p) and os.access(p, os.X_OK)]


def read_shebang_interpreter(canonical):
    with open(canonical, "r", encoding="utf-8") as f:
        first = f.readline().strip()
    if not first.startswith("#!"):
        raise SystemExit("refusing to install: canonical has no shebang: %s" % canonical)
    rest = first[2:].strip()
    if not rest:
        raise SystemExit("refusing to install: empty shebang in %s" % canonical)
    return rest.split()[0]


def verify_shebang_executable(canonical):
    interp = read_shebang_interpreter(canonical)
    if not (os.path.isfile(interp) and os.access(interp, os.X_OK)):
        raise SystemExit(
            "refusing to install: shebang interpreter missing or not executable: %s"
            % interp
        )
    return interp


def verify_compile(canonical, src):
    # In-memory compile only; never writes __pycache__ (check stays pure).
    try:
        compile(src, canonical, "exec")
    except SyntaxError as e:
        raise SystemExit("compile check failed in %s: %s" % (canonical, e))
    interps = available_interpreters()
    if not interps:
        raise SystemExit("no interpreter available for compile check")
    for py in interps:
        r = subprocess.run(
            [py, "-c",
             "import sys; compile(open(sys.argv[1]).read(), sys.argv[1], 'exec')",
             canonical],
            capture_output=True, timeout=30,
        )
        if r.returncode != 0:
            raise SystemExit(
                "compile check failed under %s:\n%s" % (py, r.stderr.decode("utf-8", "replace"))
            )
    return src


def is_valid_server(path):
    try:
        if os.path.islink(path) or not os.path.isfile(path):
            return False
        if not os.access(path, os.X_OK):
            return False
        return os.path.getsize(path) >= MIN_SERVER_BYTES
    except OSError:
        return False


def discover(root):
    """Return list of (version_dir, wrapper_path, server_path, has_wrapper, has_server)."""
    out = []
    if not os.path.isdir(root):
        return out
    for name in sorted(os.listdir(root)):
        d = os.path.join(root, name)
        if not os.path.isdir(d):
            continue
        w = os.path.join(d, WRAPPER_NAME)
        s = os.path.join(d, SERVER_NAME)
        has_wrapper = os.path.isfile(w)
        has_server = is_valid_server(s)
        if has_wrapper or has_server:
            out.append((d, w, s, has_wrapper, has_server))
    return out


def atomic_write(target, src_bytes):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix=".agy-wrapper-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(src_bytes)
        os.chmod(tmp, 0o755)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def install_one(target, src_bytes, has_wrapper):
    if has_wrapper:
        cur = open(target, "rb").read()
        if cur == src_bytes:
            return "already-canonical"
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = "%s.bak.%s" % (target, stamp)
        shutil.copy2(target, backup)
        atomic_write(target, src_bytes)
        return "replaced (backup %s)" % backup
    atomic_write(target, src_bytes)
    return "created"


def main():
    ap = argparse.ArgumentParser(description="Install canonical AGY wrapper")
    ap.add_argument("--check", action="store_true", help="report drift only")
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--canonical", default=CANONICAL)
    args = ap.parse_args()
    if not os.path.isfile(args.canonical):
        raise SystemExit("canonical source missing: %s" % args.canonical)
    # Hard refusals before any write (check mode included): a bad shebang or
    # broken source must exit non-zero without touching targets.
    verify_shebang_executable(args.canonical)
    with open(args.canonical, "rb") as f:
        src = f.read()
    verify_compile(args.canonical, src)
    entries = discover(args.root)
    if not entries:
        raise SystemExit("no wrapper/server targets under %s" % args.root)
    canon_sha = sha256_bytes(src)
    print("canonical sha256: %s" % canon_sha)
    drift = 0
    for _d, w, _s, has_wrapper, has_server in entries:
        if has_wrapper:
            cur_sha = sha256(w)
            state = "ok" if cur_sha == canon_sha else "DRIFT"
            if cur_sha != canon_sha:
                drift += 1
            print("%s %s" % (state, w))
            if args.check:
                continue
            result = install_one(w, src, has_wrapper=True)
            print("  -> %s" % result)
        else:
            # Valid server but no wrapper yet: safely create.
            drift += 1
            print("WOULD-CREATE %s (server present, wrapper missing)" % w)
            if args.check:
                continue
            result = install_one(w, src, has_wrapper=False)
            print("  -> %s" % result)
    print("provider binding (settings.json binaryPath) left unchanged")
    if args.check and drift:
        return 1
    if not args.check:
        print("done: live processes untouched; new bytes apply on next T3 spawn")
    return 0


if __name__ == "__main__":
    sys.exit(main())

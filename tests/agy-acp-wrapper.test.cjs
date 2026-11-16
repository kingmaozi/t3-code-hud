"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WRAPPER = path.join(__dirname, "../scripts/agy-acp-wrapper.py");
const BREW = "/opt/homebrew/bin/python3";
const XCODE =
  "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python";

function interpreters() {
  const list = [];
  for (const py of [BREW, XCODE]) {
    try {
      fs.accessSync(py, fs.constants.X_OK);
      list.push(py);
    } catch {
      // unavailable on this machine; skip
    }
  }
  return list;
}

function makeChild(tmp, body) {
  const p = path.join(tmp, "fake_child.py");
  fs.writeFileSync(p, `#!${BREW}\n${body}`);
  fs.chmodSync(p, 0o755);
  return p;
}

function runWrapper(py, childBody, input, extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
  const child = makeChild(tmp, childBody);
  const env = {
    ...process.env,
    AGY_WRAPPER_REAL_BIN: child,
    AGY_WRAPPER_LOG_PATH: path.join(tmp, "diag.log"),
    ...extraEnv,
  };
  return new Promise((resolve, reject) => {
    const proc = spawn(py, [WRAPPER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf-8");
    proc.stderr.setEncoding("utf-8");
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const killer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`wrapper did not exit within 15s (py=${py})`));
    }, 15000);
    proc.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
    proc.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, out, err, tmp });
    });
    if (input != null) proc.stdin.end(input);
    else proc.stdin.end();
  });
}

test("canonical wrapper exists and is executable", () => {
  assert.ok(fs.existsSync(WRAPPER), `missing ${WRAPPER}`);
  fs.accessSync(WRAPPER, fs.constants.X_OK);
});

for (const py of interpreters()) {
  const tag = py.includes("homebrew") ? "homebrew-python" : "xcode-python-3.9";

  test(`${tag}: normal echo exits 0 without SIGABRT`, async () => {
    const r = await runWrapper(
      py,
      "import sys\nfor l in sys.stdin.buffer:\n sys.stdout.buffer.write(b'{\\\"id\\\":1,\\\"result\\\":{}}\\n'); sys.stdout.buffer.flush()\n",
      '{"id":1,"method":"authenticate"}\n'
    );
    assert.equal(r.signal, null, `killed by ${r.signal}; stderr=${r.err.slice(-300)}`);
    assert.equal(r.code, 0);
    assert.match(r.out, /"id":1/);
  });

  test(`${tag}: non-zero child exit propagates verbatim (never masked as 0)`, async () => {
    const r = await runWrapper(
      py,
      "import sys; sys.stdout.buffer.write(b'{\\\"id\\\":9,\\\"result\\\":1}\\n'); sys.stdout.buffer.flush(); sys.exit(3)\n",
      '{"id":1,"method":"authenticate"}\n'
    );
    assert.equal(r.signal, null);
    assert.equal(r.code, 3, `expected 3, got ${r.code}; stderr=${r.err.slice(-300)}`);
    assert.match(r.out, /"id":9/);
  });

  test(`${tag}: signal-dead child maps to 128+signum (143)`, async () => {
    const r = await runWrapper(
      py,
      "import os,signal; os.kill(os.getpid(),signal.SIGTERM)\n",
      '{"id":1,"method":"authenticate"}\n'
    );
    assert.equal(r.code, 143, `expected 143, got ${r.code}`);
  });

  test(`${tag}: malformed lines pass through verbatim and pump survives`, async () => {
    const r = await runWrapper(
      py,
      "import sys\nsys.stdout.buffer.write(b'not-json\\n{bad\\n{\\\"id\\\":1,\\\"result\\\":{}}\\n'); sys.stdout.buffer.flush()\n",
      '{"id":1,"method":"authenticate"}\n'
    );
    assert.equal(r.code, 0);
    assert.match(r.out, /not-json/);
    assert.match(r.out, /\{bad/);
    assert.match(r.out, /"id":1/);
  });

  test(`${tag}: -32603 retry swallows first error and forwards success`, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
    const body = [
      "import sys,json",
      "cnt={}",
      "for line in sys.stdin.buffer:",
      " line=line.strip()",
      " if not line: continue",
      " msg=json.loads(line); mid=msg.get('id'); method=msg.get('method')",
      " if method=='authenticate':",
      "  cnt[mid]=cnt.get(mid,0)+1",
      "  if cnt[mid]==1: sys.stdout.buffer.write((json.dumps({'id':mid,'error':{'code':-32603,'message':'Internal error'}})+'\\n').encode()); sys.stdout.buffer.flush()",
      "  else: sys.stdout.buffer.write((json.dumps({'id':mid,'result':{'ok':True}})+'\\n').encode()); sys.stdout.buffer.flush()",
      " else: sys.stdout.buffer.write((json.dumps({'id':mid,'result':{}})+'\\n').encode()); sys.stdout.buffer.flush()",
      "",
    ].join("\n");
    const child = makeChild(tmp, body);
    const env = {
      ...process.env,
      AGY_WRAPPER_REAL_BIN: child,
      AGY_WRAPPER_LOG_PATH: path.join(tmp, "diag.log"),
      AGY_WRAPPER_BACKOFFS: "0.1",
    };
    const proc = spawn(py, [WRAPPER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (d) => (out += d));
    const code = await new Promise((resolve, reject) => {
      const killer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("retry test timed out"));
      }, 15000);
      proc.on("error", reject);
      proc.on("close", (c) => {
        clearTimeout(killer);
        resolve(c);
      });
      proc.stdin.write('{"id":7,"method":"authenticate","params":{}}\n');
      proc.stdin.write('{"id":8,"method":"session/new","params":{}}\n');
      // Keep stdin open until the retried success line arrives, then EOF.
      const iv = setInterval(() => {
        if (out.includes('"ok": true') || out.includes('"ok":true')) {
          clearInterval(iv);
          proc.stdin.end();
        }
      }, 100);
    });
    assert.equal(code, 0);
    assert.ok(out.includes('"ok": true') || out.includes('"ok":true'), `out=${out}`);
    assert.ok(!out.includes("-32603"), `first -32603 must be swallowed; out=${out}`);
  });

  test(`${tag}: SIGTERM to wrapper is forwarded; wrapper exits 143 (no hang, no -6)`, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
    const child = makeChild(
      tmp,
      "import sys\nsys.stdout.buffer.write(b'{\\\"ready\\\":1}\\n'); sys.stdout.buffer.flush()\nfor l in sys.stdin.buffer: pass\n"
    );
    const env = {
      ...process.env,
      AGY_WRAPPER_REAL_BIN: child,
      AGY_WRAPPER_LOG_PATH: path.join(tmp, "diag.log"),
    };
    const proc = spawn(py, [WRAPPER], { env, stdio: ["pipe", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      let buf = "";
      proc.stdout.setEncoding("utf-8");
      proc.stdout.on("data", (d) => {
        buf += d;
        if (buf.includes("ready")) resolve();
      });
      setTimeout(() => reject(new Error("never saw ready line")), 8000);
    });
    proc.kill("SIGTERM");
    const code = await new Promise((resolve, reject) => {
      setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("wrapper hung after SIGTERM"));
      }, 8000);
      proc.on("close", (c) => resolve(c));
    });
    assert.equal(code, 143);
  });

  test(`${tag}: broken client stdout (EPIPE) never aborts (-6)`, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
    const child = makeChild(
      tmp,
      "import sys\nfor i in range(3000):\n sys.stdout.buffer.write(b'x'*200+b'\\n'); sys.stdout.buffer.flush()\n"
    );
    const env = {
      ...process.env,
      AGY_WRAPPER_REAL_BIN: child,
      AGY_WRAPPER_LOG_PATH: path.join(tmp, "diag.log"),
    };
    const proc = spawn(py, [WRAPPER], { env, stdio: ["pipe", "pipe", "pipe"] });
    await new Promise((resolve) => {
      proc.stdout.on("data", () => resolve());
    });
    proc.stdout.destroy();
    proc.stdin.write('{"id":1,"method":"authenticate"}\n');
    proc.stdin.end();
    const code = await new Promise((resolve, reject) => {
      setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("wrapper hung on EPIPE"));
      }, 10000);
      proc.on("close", (c, sig) => {
        if (sig) reject(new Error(`killed by ${sig}`));
        resolve(c);
      });
    });
    assert.equal(code, 0);
  });
}

// ---- Independent review regressions (7 items). Expect FAIL on pre-fix code. ----
const INSTALLER = path.join(__dirname, "../scripts/agy-acp-wrapper-install.py");

function installerEnv() {
  return { ...process.env };
}

function runInstaller(args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BREW, args, { cwd, env: installerEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("installer timed out"));
    }, 20000);
    proc.on("close", (code) => resolve({ code, out, err }));
  });
}

// 1. Watchdog must kill+wait (no orphan when child ignores SIGTERM).
test("review:1 watchdog kill+wait reaps SIGTERM-ignoring child (no orphan)", async () => {
  const py = BREW;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-review1-"));
  const pidfile = path.join(tmp, "child.pid");
  const body = [
    "import os, signal, time",
    `open(${JSON.stringify(pidfile)}, 'w').write(str(os.getpid()))`,
    "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    "print('ready', flush=True)",
    "while True: time.sleep(0.2)",
    "",
  ].join("\n");
  const child = makeChild(tmp, body);
  const env = {
    ...process.env,
    AGY_WRAPPER_REAL_BIN: child,
    AGY_WRAPPER_LOG_PATH: path.join(tmp, "diag.log"),
  };
  const proc = spawn(py, [WRAPPER], { env, stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      let buf = "";
      proc.stdout.setEncoding("utf-8");
      proc.stdout.on("data", (d) => {
        buf += d;
        if (buf.includes("ready")) resolve();
      });
      setTimeout(() => reject(new Error("never ready")), 8000);
    });
    assert.ok(fs.existsSync(pidfile), "child pidfile missing");
    const childPid = Number(fs.readFileSync(pidfile, "utf-8").trim());
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    proc.kill("SIGTERM");
    const code = await new Promise((resolve, reject) => {
      setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("wrapper hung after SIGTERM (watchdog)"));
      }, 15000);
      proc.on("close", (c) => resolve(c));
    });
    assert.equal(code, 143, `expected 143, got ${code}`);
    // Child must be gone (kill+wait reaped, not orphaned).
    await new Promise((r) => setTimeout(r, 500));
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `child ${childPid} orphaned after wrapper exit`);
  } finally {
    if (proc.exitCode == null) proc.kill("SIGKILL");
    try {
      if (fs.existsSync(pidfile)) {
        const p = Number(fs.readFileSync(pidfile, "utf-8").trim());
        if (Number.isInteger(p) && p > 0) {
          try {
            process.kill(p, "SIGKILL");
          } catch {}
        }
      }
    } catch {}
  }
});

// 2a. Installer must refuse when shebang interpreter is missing (no overwrite).
test("review:2a installer refuses missing shebang interpreter and changes nothing", async () => {
  const tmpInstall = fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-"));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-root-"));
  fs.copyFileSync(INSTALLER, path.join(tmpInstall, "agy-acp-wrapper-install.py"));
  fs.writeFileSync(path.join(tmpInstall, "agy-acp-wrapper.py"), "#!/nonexistent/python3\nx = 1\n");
  const ver = path.join(tmpRoot, "v1");
  fs.mkdirSync(ver);
  const target = path.join(ver, "agy_acp_resilient_wrapper");
  fs.writeFileSync(target, "STALE\n");
  fs.chmodSync(target, 0o755);
  const before = fs.readFileSync(target, "utf-8");
  const r = await runInstaller(
    [path.join(tmpInstall, "agy-acp-wrapper-install.py"), "--root", tmpRoot],
    tmpInstall
  );
  assert.notEqual(r.code, 0, `must refuse, got exit 0; out=${r.out} err=${r.err}`);
  assert.equal(fs.readFileSync(target, "utf-8"), before, "target must be unchanged on refusal");
  assert.deepEqual(
    fs.readdirSync(ver).filter((f) => f.includes(".bak")),
    [],
    "no backup may be written on refusal"
  );
});

// 2b. --check must be side-effect free (no __pycache__ written).
test("review:2b installer --check writes no __pycache__", async () => {
  const tmpInstall = fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-check-"));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-root-check-"));
  fs.copyFileSync(INSTALLER, path.join(tmpInstall, "agy-acp-wrapper-install.py"));
  fs.copyFileSync(WRAPPER, path.join(tmpInstall, "agy-acp-wrapper.py"));
  const ver = path.join(tmpRoot, "v1");
  fs.mkdirSync(ver);
  const target = path.join(ver, "agy_acp_resilient_wrapper");
  fs.copyFileSync(WRAPPER, target);
  const before = fs.readdirSync(tmpInstall).sort();
  const r = await runInstaller(
    [path.join(tmpInstall, "agy-acp-wrapper-install.py"), "--root", tmpRoot, "--check"],
    tmpInstall
  );
  assert.equal(r.code, 0, `check on canonical must exit 0; out=${r.out} err=${r.err}`);
  assert.deepEqual(fs.readdirSync(tmpInstall).sort(), before, "--check must not write __pycache__");
});

// 3. Zero-byte .db must NOT be deleted (ownership unprovable); diag has no filenames.
test("review:3 new zero-byte session db is preserved (never deleted)", async () => {
  const py = BREW;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-review3-"));
  const gem = path.join(tmp, "gem");
  const conv = path.join(gem, "antigravity-acp", "conversations");
  fs.mkdirSync(conv, { recursive: true });
  fs.writeFileSync(path.join(conv, "keep.db"), "0123456789");
  const leakName = "new-leak-9f3a.db";
  const body = [
    "import sys, json, os",
    `conv=${JSON.stringify(conv)}`,
    "for line in sys.stdin.buffer:",
    " line=line.strip()",
    " if not line: continue",
    " msg=json.loads(line); mid=msg.get('id'); method=msg.get('method')",
    " if method=='session/new':",
    `  open(os.path.join(conv, ${JSON.stringify(leakName)}), 'wb').close()`,
    "  sys.stdout.buffer.write((json.dumps({'id':mid,'error':{'code':-32602,'message':'bad'}})+'\\n').encode()); sys.stdout.buffer.flush()",
    " else: sys.stdout.buffer.write((json.dumps({'id':mid,'result':{}})+'\\n').encode()); sys.stdout.buffer.flush()",
    "",
  ].join("\n");
  const child = makeChild(tmp, body);
  const r = await runWrapper(py, body, '{"id":11,"method":"session/new"}\n', {
    GEMINI_HOME: gem,
  });
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(conv, "keep.db")), "pre-existing db must survive");
  assert.ok(fs.existsSync(path.join(conv, leakName)), "new zero-byte db must NOT be deleted");
  const diagPath = path.join(r.tmp, "diag.log");
  const diag = fs.existsSync(diagPath) ? fs.readFileSync(diagPath, "utf-8") : "";
  assert.ok(!diag.includes(leakName), `diag must not record private filenames; diag=${diag}`);
});

// 4. Side effect during backoff cancels retry and forwards original error.
test("review:4 side-effect during backoff cancels retry (error forwarded, no resend)", async () => {
  const py = BREW;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-review4-"));
  const countFile = path.join(tmp, "auth-count");
  fs.writeFileSync(countFile, "0");
  const body = [
    "import sys, json, time",
    `countFile=${JSON.stringify(countFile)}`,
    "for line in sys.stdin.buffer:",
    " line=line.strip()",
    " if not line: continue",
    " msg=json.loads(line); mid=msg.get('id'); method=msg.get('method')",
    " if method=='authenticate':",
    "  n=int(open(countFile).read() or '0')+1; open(countFile,'w').write(str(n))",
    "  if n==1:",
    "   sys.stdout.buffer.write((json.dumps({'id':mid,'error':{'code':-32603,'message':'Internal error'}})+'\\n').encode()); sys.stdout.buffer.flush()",
    "   time.sleep(0.2)",
    "   sys.stdout.buffer.write((json.dumps({'method':'session/update','params':{'side':'effect'}})+'\\n').encode()); sys.stdout.buffer.flush()",
    "  else: sys.stdout.buffer.write((json.dumps({'id':mid,'result':{'ok':True}})+'\\n').encode()); sys.stdout.buffer.flush()",
    " else: sys.stdout.buffer.write((json.dumps({'id':mid,'result':{}})+'\\n').encode()); sys.stdout.buffer.flush()",
    "",
  ].join("\n");
  const child = makeChild(tmp, body);
  const env = {
    ...process.env,
    AGY_WRAPPER_REAL_BIN: child,
    AGY_WRAPPER_LOG_PATH: path.join(tmp, "diag.log"),
    AGY_WRAPPER_BACKOFFS: "0.5",
  };
  const proc = spawn(py, [WRAPPER], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  proc.stdout.setEncoding("utf-8");
  proc.stdout.on("data", (d) => (out += d));
  const code = await new Promise((resolve, reject) => {
    setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("review4 timed out"));
    }, 15000);
    proc.on("close", (c) => resolve(c));
    proc.stdin.write('{"id":7,"method":"authenticate","params":{}}\n');
    setTimeout(() => {
      try {
        proc.stdin.end();
      } catch {}
    }, 2500);
  });
  assert.equal(code, 0, `code=${code} out=${out}`);
  assert.ok(out.includes("-32603"), `original error must be forwarded on cancel; out=${out}`);
  assert.ok(!out.includes('"ok": true') && !out.includes('"ok":true'), `must not resend; out=${out}`);
  assert.equal(Number(fs.readFileSync(countFile, "utf-8").trim()), 1, "child must see exactly one request");
});

// 5a. Sensitive stderr never persisted to diag file (forwarding preserved).
test("review:5a sensitive stderr is forwarded but never persisted verbatim", async () => {
  const py = BREW;
  const r = await runWrapper(
    py,
    "import sys\n" +
      "sys.stderr.write('access_token=TOPSECRET_AAAA_1111\\n'); sys.stderr.write('api_key=TOPSECRET_BBBB_2222\\n'); sys.stderr.write('normal line\\n'); sys.stderr.flush()\n" +
      "sys.stdout.buffer.write(b'{\\\"id\\\":1,\\\"result\\\":{}}\\n'); sys.stdout.buffer.flush()\n",
    '{"id":1,"method":"authenticate"}\n'
  );
  assert.equal(r.code, 0);
  assert.ok(r.err.includes("TOPSECRET_AAAA_1111"), "stderr protocol forwarding must preserve");
  const diagPath = path.join(r.tmp, "diag.log");
  const diag = fs.existsSync(diagPath) ? fs.readFileSync(diagPath, "utf-8") : "";
  assert.ok(!diag.includes("TOPSECRET_AAAA_1111"), `secret persisted; diag=${diag}`);
  assert.ok(!diag.includes("TOPSECRET_BBBB_2222"), `secret persisted; diag=${diag}`);
});

// 5b. Launch failure emits only event type, never full traceback.
test("review:5b launch failure is minimized (no full traceback)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-review5b-"));
  const env = {
    ...process.env,
    AGY_WRAPPER_REAL_BIN: "/nonexistent/agx-bin-xyz",
    AGY_WRAPPER_LOG_PATH: path.join(tmp, "diag.log"),
  };
  const proc = spawn(BREW, [WRAPPER], { env, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  proc.stderr.setEncoding("utf-8");
  proc.stderr.on("data", (d) => (err += d));
  const code = await new Promise((resolve, reject) => {
    setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("startup failure test timed out"));
    }, 8000);
    proc.on("close", (c) => resolve(c));
  });
  assert.equal(code, 1);
  assert.match(err, /launch_error/);
  assert.ok(!err.includes("Traceback"), `full traceback leaked; err=${err}`);
});

// 6. Installer creates wrapper in par-only version dir; never touches bindings.
test("review:6 installer creates wrapper for par-only dir, preserves bindings", async () => {
  const tmpInstall = fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-par-"));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-root-par-"));
  fs.copyFileSync(INSTALLER, path.join(tmpInstall, "agy-acp-wrapper-install.py"));
  fs.copyFileSync(WRAPPER, path.join(tmpInstall, "agy-acp-wrapper.py"));
  const va = path.join(tmpRoot, "vA");
  const vb = path.join(tmpRoot, "vB");
  fs.mkdirSync(va);
  fs.mkdirSync(vb);
  fs.writeFileSync(path.join(va, "agy_acp_resilient_wrapper"), "STALE\n");
  fs.chmodSync(path.join(va, "agy_acp_resilient_wrapper"), 0o755);
  const par = path.join(vb, "agy_acp_server.par");
  fs.writeFileSync(par, Buffer.alloc(2_000_000, 1));
  fs.chmodSync(par, 0o755);
  assert.ok(!fs.existsSync(path.join(vb, "agy_acp_resilient_wrapper")), "precondition: no wrapper");
  // Snapshot real T3 binding file (installer must not modify it).
  const settingsPath = "/Users/longxiaking/.t3/userdata/settings.json";
  let settingsBefore = null;
  try {
    settingsBefore = fs.readFileSync(settingsPath, "utf-8");
  } catch {}
  // --check must report would-create without creating.
  const chk = await runInstaller(
    [path.join(tmpInstall, "agy-acp-wrapper-install.py"), "--root", tmpRoot, "--check"],
    tmpInstall
  );
  assert.notEqual(chk.code, 0, "check with drift must exit non-zero");
  assert.ok(!fs.existsSync(path.join(vb, "agy_acp_resilient_wrapper")), "--check must not create");
  const r = await runInstaller(
    [path.join(tmpInstall, "agy-acp-wrapper-install.py"), "--root", tmpRoot],
    tmpInstall
  );
  assert.equal(r.code, 0, `install failed; out=${r.out} err=${r.err}`);
  const created = path.join(vb, "agy_acp_resilient_wrapper");
  assert.ok(fs.existsSync(created), "par-only dir must gain a wrapper");
  assert.equal(fs.readFileSync(created, "utf-8"), fs.readFileSync(WRAPPER, "utf-8"));
  if (settingsBefore != null) {
    assert.equal(fs.readFileSync(settingsPath, "utf-8"), settingsBefore, "settings binding unchanged");
  }
});

// 7. Slow client (>2s to first read) must receive full tail (reliable drain
// on normal exit, not a 2s cutoff). A Python reader process sleeps 3s
// before its first read, so the wrapper pipe is genuinely full while the
// child has already exited; only unbounded drain delivers the full tail.
test("review:7 slow reader receives complete tail on normal exit", async () => {
  const py = BREW;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-review7-"));
  const body =
    "import sys\n" +
    "for i in range(600):\n sys.stdout.buffer.write((str(i).encode()+b':'+b'x'*190+b'\\n'))\n" +
    "sys.stdout.buffer.write(b'{\\\"id\\\":1,\\\"result\\\":{}} \\n'); sys.stdout.buffer.flush()\n";
  const child = makeChild(tmp, body);
  const reader = path.join(tmp, "slow_reader.py");
  fs.writeFileSync(
    reader,
    [
      "import subprocess, sys, os, time",
      `py = ${JSON.stringify(py)}`,
      `wrapper = ${JSON.stringify(WRAPPER)}`,
      "env = dict(os.environ)",
      `env['AGY_WRAPPER_REAL_BIN'] = ${JSON.stringify(child)}`,
      `env['AGY_WRAPPER_LOG_PATH'] = ${JSON.stringify(path.join(tmp, "diag.log"))}`,
      "proc = subprocess.Popen([py, wrapper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)",
      "proc.stdin.write(b'{\"id\":1,\"method\":\"authenticate\"}\\n'); proc.stdin.close()",
      "time.sleep(3)",
      "data = proc.stdout.read()",
      "rc = proc.wait(timeout=15)",
      "print('total=%d rc=%d' % (len(data), rc))",
      "sys.stdout.write('has_id=%s\\n' % (b'\"id\":1' in data))",
      "",
    ].join("\n")
  );
  const r = await new Promise((resolve, reject) => {
    const proc = spawn(py, [reader], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf-8");
    proc.stderr.setEncoding("utf-8");
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("slow-reader timed out"));
    }, 25000);
    proc.on("close", (c) => resolve({ c, out, err }));
  });
  assert.equal(r.c, 0, `reader failed; out=${r.out} err=${r.err.slice(-400)}`);
  const m = /total=(\d+) rc=(\d+)/.exec(r.out);
  assert.ok(m, `unparseable reader output; out=${r.out}`);
  assert.equal(Number(m[2]), 0);
  assert.ok(Number(m[1]) > 100000, `tail truncated: total=${m[1]}; out=${r.out}`);
  assert.ok(r.out.includes("has_id=True"), `final response missing; out=${r.out}`);
});

if (interpreters().length === 0) {
  test("no python3 interpreter available (all skipped)", () => {
    assert.fail("expected at least one python interpreter");
  });
}
for (const py of interpreters()) {
  test(`late cancel while output is blocked after child exit: ${path.basename(py)}`, async t => {
    const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agy-late-cancel-'));
    t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
    const done=path.join(tmp,'child-done');
    const child=makeChild(tmp, `import os\ndata=b'x'*262144+b'\\n'\nwhile data:\n n=os.write(1,data); data=data[n:]\nopen(${JSON.stringify(done)},'w').close()\n`);
    const reader=path.join(tmp,'reader.py');
    fs.writeFileSync(reader, `import os,subprocess,time,signal\nenv=dict(os.environ,AGY_WRAPPER_REAL_BIN=${JSON.stringify(child)},AGY_WRAPPER_LOG_PATH='')\np=subprocess.Popen([${JSON.stringify(py)},${JSON.stringify(WRAPPER)}],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)\ntry:\n deadline=time.monotonic()+5\n while not os.path.exists(${JSON.stringify(done)}):\n  assert time.monotonic()<deadline,'child could not finish'\n  time.sleep(.02)\n time.sleep(.2)\n p.send_signal(signal.SIGTERM)\n rc=p.wait(timeout=4)\n assert rc==143,rc\n print('late-cancel=143')\nfinally:\n if p.poll() is None: p.kill(); p.wait()\n`);
    const result=await require('node:util').promisify(require('node:child_process').execFile)(py,[reader],{timeout:11000});
    assert.match(result.stdout,/late-cancel=143/);
  });
}
test('retry created while stdout drains is awaited before normal exit',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agy-drain-retry-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const ready=path.join(tmp,'retry-creating');
 const child=makeChild(tmp,`import sys,os,time\nsys.stdin.buffer.readline()\nos.write(1,b'{"id":1,"error":{"code":-32603}}\\n')\nwhile not os.path.exists(${JSON.stringify(ready)}): time.sleep(.01)\nos._exit(3)\n`);
 const loader=path.join(tmp,'loader.py');
 fs.writeFileSync(loader,`import threading,time,runpy\noriginal=threading.Thread.__init__\ndef intercept(self,*args,**kwargs):\n target=kwargs.get('target')\n if getattr(target,'__name__','')=='_retry_worker':\n  open(${JSON.stringify(ready)},'w').close()\n  time.sleep(.3)\n  def delayed():\n   time.sleep(.3)\n   target()\n  kwargs['target']=delayed\n original(self,*args,**kwargs)\nthreading.Thread.__init__=intercept\nrunpy.run_path(${JSON.stringify(WRAPPER)},run_name='__main__')\n`);
 const result=await new Promise((resolve,reject)=>{
  const proc=spawn(BREW,[loader],{env:{...process.env,AGY_WRAPPER_REAL_BIN:child,AGY_WRAPPER_LOG_PATH:'',AGY_WRAPPER_BACKOFFS:'.01'},stdio:['pipe','pipe','pipe']});
  let out='',err='';proc.stdout.on('data',d=>out+=d);proc.stderr.on('data',d=>err+=d);
  const timer=setTimeout(()=>{proc.kill('SIGKILL');reject(new Error('retry drain timed out'));},6000);
  proc.on('error',reject);proc.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  proc.stdin.on('error',()=>{});proc.stdin.write('{"id":1,"method":"session/new"}\n');
 });
 assert.equal(result.code,3,result.err);assert.match(result.out,/"code":-32603/);
});

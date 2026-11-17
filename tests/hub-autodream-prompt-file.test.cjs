"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createMemoryVault } = require("../src/memory-vault.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-prompt-regression-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), temp = path.join(root, "scratch"), homeDir = path.join(root, "home"), hubDir = path.join(root, "hub"), vaultDir = path.join(root, "vault"), projectRoot = path.join(root, "project");
  for (const d of [bin, temp, homeDir, hubDir, vaultDir, projectRoot]) fs.mkdirSync(d, { recursive: true });
  const probe = path.join(root, "probe.json"), fake = path.join(bin, "muse");
  const body = `#!${process.execPath}\n` + `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),i=args.indexOf('--prompt-file'),input=i<0?'':args[i+1], mode=process.env.DREAM_STUB_MODE||'success';
let result={args,input};
try { const st=fs.lstatSync(input),parent=fs.lstatSync(path.dirname(input)); result.regular=st.isFile()&&!st.isSymbolicLink(); result.fileMode=st.mode&0o777;result.dirMode=parent.mode&0o777; if(result.regular)result.content=fs.readFileSync(input,'utf8'); }
catch(e){result.error=e.code}
fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify(result));
if(!result.regular)process.exit(71);
if(mode==='fail'){process.stderr.write('api_key=FAKE_SECRET');process.exit(7)}
if(mode==='timeout'){setInterval(()=>{},1000);return}
if(mode==='overflow'){process.stdout.write('X'.repeat(2048));return}
if(mode==='replace'){const other=path.join(path.dirname(input),'other');fs.writeFileSync(other,'foreign replacement');fs.renameSync(other,input);}
process.stdout.write('{"merges":[]}');
`;
  fs.writeFileSync(fake, body, { mode: 0o755 });
  const vault = createMemoryVault({ homeDir, hubDir, vaultDir, _dreamPath: bin, _dreamPromptTempRoot: temp, _embedFn: () => null, _healthFn: () => ({ modelId: "test", dim: 2 }) });
  return { root, bin, temp, homeDir, hubDir, vaultDir, projectRoot, probe, fake, vault };
}
function gray(f) {
  const entries = [
    ["alpha", "w1 w2 w3 w4 w5 w6 w7 w8 x9 x10 x11 x12"],
    ["beta", "w1 w2 w3 w4 w5 w6 w7 w8 y9 y10 y11 y12"],
  ];
  const ids = entries.map(([title,content]) => f.vault.saveMemory({ projectRoot: f.projectRoot, module: "topics", title, content, autoEvolve: false }).item.id);
  const db = new DatabaseSync(path.join(f.vaultDir,"index.sqlite"));
  try { const s=db.prepare("INSERT OR REPLACE INTO memory_vectors(id,model_id,dim,vec_f32,updated_at) VALUES(?,?,?,?,?)");
    s.run(ids[0],"test",2,Buffer.from(new Float32Array([1,0]).buffer),new Date().toISOString());
    s.run(ids[1],"test",2,Buffer.from(new Float32Array([0.8,0.6]).buffer),new Date().toISOString());
  } finally { db.close(); }
}
function cli(f, prompt, timeoutMs=5000) {
  return f.vault.runDreamAgentCli({ cmd:f.fake, args:["exec","--prompt-file","placeholder"], prompt, promptFile:true, timeoutMs });
}

test("production Muse receives a regular private prompt file and cleans it", async t => {
  const f=fixture(t); gray(f);
  assert.equal(f.vault.updateDreamConfig({dreamMode:"agent",providerInstanceId:"muse",model:"muse-ember-1.0",reasoningEffort:"medium",minDeltaMemories:1}).ok,true);
  const result=await f.vault.runDreamCycle({force:true,projectRoot:f.projectRoot});
  assert.equal(result.ok,true,JSON.stringify(result));
  const seen=JSON.parse(fs.readFileSync(f.probe,"utf8"));
  assert.equal(seen.regular,true); assert.equal(seen.fileMode,0o600); assert.equal(seen.dirMode,0o700);
  assert.ok(seen.content.includes('"merges"')); assert.ok(!seen.args.some(a=>a.includes('"merges"')));
  assert.equal(fs.existsSync(seen.input),false); assert.deepEqual(fs.readdirSync(f.temp),[]);
});

for(const mode of ["success","fail","timeout"]) {
  test(`temporary prompt is removed after ${mode}`,async t=>{
    const f=fixture(t), prompt="synthetic private prompt $(`no-shell`)\nline two";
    const previous=process.env.DREAM_STUB_MODE; process.env.DREAM_STUB_MODE=mode;
    try {
      if(mode==='success') { const result=await cli(f,prompt); assert.match(result.stdout,/merges/); }
      else await assert.rejects(cli(f,prompt,mode==='timeout'?1500:5000), mode==='timeout'?/cli-timeout/:/cli-exit-7/);
      const seen=JSON.parse(fs.readFileSync(f.probe,"utf8"));
      assert.equal(seen.regular,true);assert.equal(seen.content,prompt);assert.equal(seen.fileMode,0o600);assert.equal(seen.dirMode,0o700);
      assert.ok(!seen.args.includes(prompt));assert.equal(fs.existsSync(seen.input),false);assert.deepEqual(fs.readdirSync(f.temp),[]);
    } finally { if(previous===undefined)delete process.env.DREAM_STUB_MODE;else process.env.DREAM_STUB_MODE=previous; }
  });
}

test("temporary prompt is removed if executable cannot start",async t=>{
  const f=fixture(t);
  await assert.rejects(f.vault.runDreamAgentCli({cmd:path.join(f.bin,"missing"),args:["--prompt-file","placeholder"],prompt:"sensitive",promptFile:true,timeoutMs:500}),/cli-unavailable/);
  assert.deepEqual(fs.readdirSync(f.temp),[]);
});

test("temporary prompt is removed when writing the file fails",async t=>{
  const f=fixture(t),write=fs.writeFileSync;
  fs.writeFileSync=function(file,...rest){if(typeof file==='number')throw new Error('injected-write-error:/synthetic/secret sensitive');return write.call(this,file,...rest)};
  try {await assert.rejects(cli(f,"sensitive"), err => {
    assert.equal(err.message, 'cli-spawn-failed');
    assert.ok(!err.message.includes('/'));
    assert.ok(!err.message.includes(f.root));
    assert.ok(!err.message.includes('sensitive'));
    assert.ok(!err.message.includes('secret'));
    return true;
  });}
  finally {fs.writeFileSync=write;}
  assert.deepEqual(fs.readdirSync(f.temp),[]);
});

test('review-6: closeSync failure cannot report a successful CLI run', async t => {
  const f = fixture(t), close = fs.closeSync;
  let injected = false;
  fs.closeSync = function(fd) {
    const result = close.call(this, fd);
    if (!injected) { injected = true; throw new Error('injected-close:/synthetic/secret'); }
    return result;
  };
  try {
    await assert.rejects(cli(f,'synthetic'), err => {
      assert.equal(err.message,'cli-temp-cleanup-failed');
      assert.deepEqual(err.diagnostic,{category:'unknown'});
      return true;
    });
  } finally { fs.closeSync = close; }
  assert.equal(injected,true);
  assert.deepEqual(fs.readdirSync(f.temp),[]);
});

test('review-6: an existing CLI failure takes precedence over close failure', async t => {
  const f = fixture(t), close = fs.closeSync, previous = process.env.DREAM_STUB_MODE;
  process.env.DREAM_STUB_MODE = 'fail';
  fs.closeSync = function(fd) { close.call(this,fd); throw new Error('injected-close:/synthetic/secret'); };
  try {
    await assert.rejects(cli(f,'synthetic'), err => {
      assert.equal(err.message,'cli-exit-7');
      assert.equal(err.cleanupError,'cli-temp-cleanup-failed');
      return true;
    });
  } finally {
    fs.closeSync = close;
    if (previous===undefined) delete process.env.DREAM_STUB_MODE; else process.env.DREAM_STUB_MODE=previous;
  }
  assert.deepEqual(fs.readdirSync(f.temp),[]);
});

test("temporary prompt is removed when CLI output exceeds the limit",async t=>{
  const f=fixture(t),previous=process.env.DREAM_STUB_MODE;process.env.DREAM_STUB_MODE='overflow';
  try {
    await assert.rejects(f.vault.runDreamAgentCli({cmd:f.fake,args:["--prompt-file","placeholder"],prompt:"sensitive",promptFile:true,timeoutMs:5000,maxOutputBytes:32}),/cli-output-overflow/);
    const seen=JSON.parse(fs.readFileSync(f.probe,"utf8"));
    assert.equal(fs.existsSync(seen.input),false);assert.deepEqual(fs.readdirSync(f.temp),[]);
  } finally {if(previous===undefined)delete process.env.DREAM_STUB_MODE;else process.env.DREAM_STUB_MODE=previous;}
});

test("cleanup does not delete a file replaced by another actor",async t=>{
  const f=fixture(t),previous=process.env.DREAM_STUB_MODE;process.env.DREAM_STUB_MODE='replace';
  try {
    await assert.rejects(cli(f,"synthetic"),/cli-temp-cleanup-failed/);
    const seen=JSON.parse(fs.readFileSync(f.probe,"utf8"));
    assert.equal(fs.readFileSync(seen.input,"utf8"),"foreign replacement");
  } finally {if(previous===undefined)delete process.env.DREAM_STUB_MODE;else process.env.DREAM_STUB_MODE=previous;}
});

test("defect-2: temp setup failure is sanitized without local paths",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dream-setup-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bin=path.join(root,"bin"),homeDir=path.join(root,"home"),hubDir=path.join(root,"hub"),vaultDir=path.join(root,"vault");
  for(const d of [bin,homeDir,hubDir,vaultDir]) fs.mkdirSync(d,{recursive:true});
  const fake=path.join(bin,"muse");
  fs.writeFileSync(fake,`#!${process.execPath}\nprocess.stdout.write('{"merges":[]}');\n`,{mode:0o755});
  const badRoot=path.join(root,"missing-parent","subdir");
  const vault=createMemoryVault({homeDir,hubDir,vaultDir,_dreamPath:bin,_dreamPromptTempRoot:badRoot,_embedFn:()=>null,_healthFn:()=>({modelId:"test",dim:2})});
  await assert.rejects(vault.runDreamAgentCli({cmd:fake,args:["--prompt-file","placeholder"],prompt:"sensitive",promptFile:true,timeoutMs:5000}),(err)=>{
    assert.equal(err.message,"cli-spawn-failed");
    assert.ok(!err.message.includes(root));
    assert.ok(!err.message.includes("missing-parent"));
    assert.ok(err.diagnostic&&err.diagnostic.category==="unknown");
    return true;
  });
});

test("defect-3: moved prompt file fails cleanup and is truncated",async t=>{
  const f=fixture(t);
  const saved=path.join(f.root,"moved.txt");
  const mover=path.join(f.bin,"mover");
  fs.writeFileSync(mover,`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);const i=a.indexOf('--prompt-file');const input=a[i+1];fs.renameSync(input,${JSON.stringify(saved)});process.stdout.write('{"merges":[]}');\n`,{mode:0o755});
  await assert.rejects(f.vault.runDreamAgentCli({cmd:mover,args:["--prompt-file","placeholder"],prompt:"synthetic private prompt",promptFile:true,timeoutMs:5000}),(err)=>{
    assert.equal(err.message,"cli-temp-cleanup-failed");
    return true;
  });
  assert.deepEqual(fs.readdirSync(f.temp),[]);
  assert.equal(fs.existsSync(saved),true);
  assert.equal(fs.readFileSync(saved,"utf8"),"");
});

for (const cliFails of [false, true]) {
  test(`review-8 defect-2: replacement after lstat is detected${cliFails ? ' with CLI failure' : ''}`, async t => {
    const f = fixture(t), lstat = fs.lstatSync, rmdir = fs.rmdirSync;
    const previous = process.env.DREAM_STUB_MODE;
    process.env.DREAM_STUB_MODE = cliFails ? 'fail' : 'success';
    const moved = path.join(f.root, 'original-inode');
    let replaced = false, parent, removedParent = false;
    fs.lstatSync = function(file, ...args) {
      const stat = lstat.call(this, file, ...args);
      if (!replaced && typeof file === 'string' && file.startsWith(f.temp + path.sep) && path.basename(file) === 'prompt.txt') {
        replaced = true; parent = path.dirname(file);
        fs.renameSync(file, moved);
        fs.writeFileSync(file, 'foreign replacement');
      }
      return stat;
    };
    fs.rmdirSync = function(dir, ...args) {
      if (dir === parent) removedParent = true;
      return rmdir.call(this, dir, ...args);
    };
    try {
      await assert.rejects(cli(f, 'synthetic private prompt'), err => {
        assert.equal(err.message, cliFails ? 'cli-exit-7' : 'cli-temp-cleanup-failed');
        if (cliFails) assert.equal(err.cleanupError, 'cli-temp-cleanup-failed');
        assert.deepEqual(err.diagnostic, {category:'unknown'});
        assert.ok(!JSON.stringify(err).includes(f.root));
        return true;
      });
    } finally {
      fs.lstatSync = lstat; fs.rmdirSync = rmdir;
      if (previous === undefined) delete process.env.DREAM_STUB_MODE; else process.env.DREAM_STUB_MODE = previous;
    }
    assert.equal(replaced, true);
    assert.equal(removedParent, false, 'an unlink identity anomaly must suppress directory removal');
    assert.equal(fs.readFileSync(moved, 'utf8'), '', 'the original open inode must be wiped');
    assert.equal(fs.statSync(moved, {bigint:true}).nlink, 1n);
  });
}

test('review-8 defect-2: normal unlink is verified through the still-open inode', async t => {
  const f = fixture(t), open = fs.openSync, fstat = fs.fstatSync, close = fs.closeSync;
  let promptFd, unlinkedWhileOpen = false, closedAfterVerification = false;
  fs.openSync = function(file, flags, ...args) {
    const fd = open.call(this, file, flags, ...args);
    if (flags === 'wx' && typeof file === 'string' && (file.startsWith(f.temp + path.sep) || (file.startsWith('/.vol/') && path.basename(file) === 'prompt.txt'))) promptFd = fd;
    return fd;
  };
  fs.fstatSync = function(fd, ...args) {
    const stat = fstat.call(this, fd, ...args);
    if (fd === promptFd && stat.nlink === 0n) unlinkedWhileOpen = true;
    return stat;
  };
  fs.closeSync = function(fd) {
    if (fd === promptFd) closedAfterVerification = unlinkedWhileOpen;
    return close.call(this, fd);
  };
  try { assert.match((await cli(f, 'synthetic')).stdout, /merges/); }
  finally { fs.openSync = open; fs.fstatSync = fstat; fs.closeSync = close; }
  assert.equal(unlinkedWhileOpen, true);
  assert.equal(closedAfterVerification, true);
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test('review-8 defect-2: a hard-linked prompt is wiped but never unlinked as exclusive ownership', async t => {
  const f = fixture(t), lstat = fs.lstatSync;
  const alias = path.join(f.root, 'alias');
  let linked = false, input;
  fs.lstatSync = function(file, ...args) {
    if (!linked && typeof file === 'string' && file.startsWith(f.temp + path.sep) && path.basename(file) === 'prompt.txt') {
      linked = true; input = file; fs.linkSync(file, alias);
    }
    return lstat.call(this, file, ...args);
  };
  try { await assert.rejects(cli(f, 'synthetic private prompt'), {message:'cli-temp-cleanup-failed'}); }
  finally { fs.lstatSync = lstat; }
  assert.equal(linked, true);
  assert.equal(fs.existsSync(input), true);
  assert.equal(fs.readFileSync(alias, 'utf8'), '');
});

for (const cliFails of [false, true]) {
  test(`review-9 defect-1: unlink+replace after lstat preserves foreign file and reports cleanupError${cliFails ? ' with CLI failure' : ''}`, async t => {
    const f = fixture(t), lstat = fs.lstatSync, rmdir = fs.rmdirSync;
    const previous = process.env.DREAM_STUB_MODE;
    process.env.DREAM_STUB_MODE = cliFails ? 'fail' : 'success';
    let replaced = false, targetFile, parent, removedParent = false;
    fs.lstatSync = function(file, ...args) {
      const stat = lstat.call(this, file, ...args);
      if (!replaced && typeof file === 'string' && file.startsWith(f.temp + path.sep) && path.basename(file) === 'prompt.txt') {
        replaced = true; targetFile = file; parent = path.dirname(file);
        fs.unlinkSync(file);
        fs.writeFileSync(file, 'foreign after unlink');
      }
      return stat;
    };
    fs.rmdirSync = function(dir, ...args) {
      if (dir === parent) removedParent = true;
      return rmdir.call(this, dir, ...args);
    };
    try {
      await assert.rejects(cli(f, 'synthetic private prompt'), err => {
        assert.equal(err.message, cliFails ? 'cli-exit-7' : 'cli-temp-cleanup-failed');
        if (cliFails) assert.equal(err.cleanupError, 'cli-temp-cleanup-failed');
        assert.ok(!JSON.stringify(err).includes(f.root));
        return true;
      });
    } finally {
      fs.lstatSync = lstat; fs.rmdirSync = rmdir;
      if (previous === undefined) delete process.env.DREAM_STUB_MODE; else process.env.DREAM_STUB_MODE = previous;
    }
    assert.equal(replaced, true);
    assert.equal(removedParent, false);
    assert.equal(fs.existsSync(targetFile), true, 'foreign replacement file must not be deleted');
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'foreign after unlink');
  });
}

test('review-9 defect-1b: unlink+replace right before stage rename rescues foreign file intact', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-r9-1b-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['scratch', 'home', 'hub', 'vault']) fs.mkdirSync(path.join(root, d), { recursive: true });
  let raced = false, targetFile;
  const vault = createMemoryVault({
    homeDir: path.join(root, 'home'),
    hubDir: path.join(root, 'hub'),
    vaultDir: path.join(root, 'vault'),
    _dreamPromptTempRoot: path.join(root, 'scratch'),
    _dreamAtomicUnlinkHook: ({ phase, filePath }) => {
      if (phase === 'before-rename' && !raced) {
        raced = true; targetFile = filePath;
        fs.unlinkSync(filePath);
        fs.writeFileSync(filePath, 'foreign raced right before rename');
      }
    },
  });
  await assert.rejects(
    vault.runDreamAgentCli({
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write("{}")', '--', '--prompt-file', 'placeholder'],
      prompt: 'synthetic private prompt',
      promptFile: true,
      timeoutMs: 3000,
    }),
    { message: 'cli-temp-cleanup-failed' }
  );
  assert.equal(raced, true);
  assert.equal(fs.existsSync(targetFile), true);
  assert.equal(fs.readFileSync(targetFile, 'utf8'), 'foreign raced right before rename');
});

test('review-10 & review-12 (#7.1, #7.2, #7.4): FIFO never blocks cleanup, symlink/foreign files/dirs are never deleted even with pre-opened parentFd or mkdtempSync/mkdirSync monkeypatching, and CLI-success cleanup failure sets cleanupError', async t => {
  const cp = require('node:child_process');

  // 1) Pre-opened parentFd on `dir` sees zero `.g-*`/`.s-*` staging subdirs and cannot trick cleanup into deleting a foreign replacement file (#7.1)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-r12-parentfd-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const d of ['scratch', 'home', 'hub', 'vault']) fs.mkdirSync(path.join(root, d), { recursive: true });
    let parentFd = null, seenEntriesDuringCleanup = null, racedFile = null;
    const vault = createMemoryVault({
      homeDir: path.join(root, 'home'),
      hubDir: path.join(root, 'hub'),
      vaultDir: path.join(root, 'vault'),
      _dreamPromptTempRoot: path.join(root, 'scratch'),
      _dreamAtomicUnlinkHook: ({ phase, dir, filePath }) => {
        if (phase === 'before-rename' && parentFd === null) {
          parentFd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
          seenEntriesDuringCleanup = fs.readdirSync(dir);
          racedFile = filePath;
          // External holder with parentFd swaps prompt.txt right before unlink:
          fs.unlinkSync(filePath);
          fs.writeFileSync(filePath, 'foreign-via-parentfd');
        }
      },
    });
    try {
      await assert.rejects(
        vault.runDreamAgentCli({
          cmd: process.execPath,
          args: ['-e', 'process.stdout.write("{}")', '--', '--prompt-file', 'placeholder'],
          prompt: 'synthetic',
          promptFile: true,
          timeoutMs: 3000,
        }),
        err => {
          assert.equal(err.message, 'cli-temp-cleanup-failed');
          assert.equal(err.cleanupError, 'cli-temp-cleanup-failed');
          return true;
        }
      );
      assert.deepEqual(seenEntriesDuringCleanup, ['prompt.txt'], 'no .g-* or .s-* staging directory may ever exist inside dir');
      assert.equal(fs.readFileSync(racedFile, 'utf8'), 'foreign-via-parentfd', 'foreign replacement file must stay intact');
    } finally {
      if (parentFd !== null) try { fs.closeSync(parentFd); } catch {}
    }
  }

  // 2) Monkey-patched fs.mkdtempSync / fs.mkdirSync swap cannot trick cleanup into deleting a foreign directory (#7.2)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-r12-mkdirswap-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const d of ['scratch', 'home', 'hub', 'vault', 'foreign-keep']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const foreignDir = path.join(root, 'foreign-keep');
    const foreignMarker = path.join(foreignDir, 'keep.txt');
    fs.writeFileSync(foreignMarker, 'untouched');
    const origMkdtemp = fs.mkdtempSync;
    const origMkdir = fs.mkdirSync;
    fs.mkdtempSync = function(...args) {
      origMkdtemp.apply(this, args);
      return foreignDir;
    };
    fs.mkdirSync = function(...args) {
      return origMkdir.apply(this, args);
    };
    try {
      const vault = createMemoryVault({
        homeDir: path.join(root, 'home'),
        hubDir: path.join(root, 'hub'),
        vaultDir: path.join(root, 'vault'),
        _dreamPromptTempRoot: path.join(root, 'scratch'),
      });
      const out = await vault.runDreamAgentCli({
        cmd: process.execPath,
        args: ['-e', 'process.stdout.write("{}")', '--', '--prompt-file', 'placeholder'],
        prompt: 'synthetic',
        promptFile: true,
        timeoutMs: 3000,
      });
      assert.equal(out.stdout, '{}');
      assert.equal(fs.existsSync(foreignDir), true);
      assert.equal(fs.readFileSync(foreignMarker, 'utf8'), 'untouched');
      assert.deepEqual(fs.readdirSync(path.join(root, 'scratch')), []);
    } finally {
      fs.mkdtempSync = origMkdtemp;
      fs.mkdirSync = origMkdir;
    }
  }

  // 3) Symlink raced right before unlink is preserved intact
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-r10-symlink-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const d of ['scratch', 'home', 'hub', 'vault']) fs.mkdirSync(path.join(root, d), { recursive: true });
    let originalPath = null;
    const vault = createMemoryVault({
      homeDir: path.join(root, 'home'),
      hubDir: path.join(root, 'hub'),
      vaultDir: path.join(root, 'vault'),
      _dreamPromptTempRoot: path.join(root, 'scratch'),
      _dreamAtomicUnlinkHook: ({ phase, filePath }) => {
        if (phase === 'before-rename' && !originalPath) {
          originalPath = filePath;
          fs.unlinkSync(filePath);
          fs.symlinkSync('unrelated-target', filePath);
        }
      },
    });
    await assert.rejects(
      vault.runDreamAgentCli({
        cmd: process.execPath,
        args: ['-e', 'process.stdout.write("{}")', '--', '--prompt-file', 'placeholder'],
        prompt: 'synthetic',
        promptFile: true,
        timeoutMs: 3000,
      }),
      { message: 'cli-temp-cleanup-failed', cleanupError: 'cli-temp-cleanup-failed' }
    );
    assert.ok(originalPath);
    assert.equal(fs.lstatSync(originalPath).isSymbolicLink(), true, 'symlink must remain intact at original path');
    assert.equal(fs.readlinkSync(originalPath), 'unrelated-target');
  }

  // 4) FIFO raced right before unlink never blocks cleanup and stays intact
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-r10-fifo-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const d of ['scratch', 'home', 'hub', 'vault']) fs.mkdirSync(path.join(root, d), { recursive: true });
    let originalPath = null;
    const vault = createMemoryVault({
      homeDir: path.join(root, 'home'),
      hubDir: path.join(root, 'hub'),
      vaultDir: path.join(root, 'vault'),
      _dreamPromptTempRoot: path.join(root, 'scratch'),
      _dreamAtomicUnlinkHook: ({ phase, filePath }) => {
        if (phase === 'before-rename' && !originalPath) {
          originalPath = filePath;
          fs.unlinkSync(filePath);
          const mk = cp.spawnSync('mkfifo', [filePath]);
          assert.equal(mk.status, 0);
        }
      },
    });
    const t0 = performance.now();
    await assert.rejects(
      vault.runDreamAgentCli({
        cmd: process.execPath,
        args: ['-e', 'process.stdout.write("{}")', '--', '--prompt-file', 'placeholder'],
        prompt: 'synthetic',
        promptFile: true,
        timeoutMs: 3000,
      }),
      { message: 'cli-temp-cleanup-failed', cleanupError: 'cli-temp-cleanup-failed' }
    );
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 1500, `FIFO cleanup must not block, took ${elapsed}ms`);
    assert.equal(fs.lstatSync(originalPath).isFIFO(), true, 'FIFO must stay intact at original path');
  }

  // 5) Temp directory replaced by a foreign empty directory right before rmdir stays intact
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-r11-dirswap-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const d of ['scratch', 'home', 'hub', 'vault']) fs.mkdirSync(path.join(root, d), { recursive: true });
    let swappedDir = null, movedOriginal = null, foreignStat = null;
    const vault = createMemoryVault({
      homeDir: path.join(root, 'home'),
      hubDir: path.join(root, 'hub'),
      vaultDir: path.join(root, 'vault'),
      _dreamPromptTempRoot: path.join(root, 'scratch'),
      _dreamAtomicUnlinkHook: ({ phase, dir }) => {
        if (phase === 'before-dir-rename' && !swappedDir) {
          swappedDir = dir;
          movedOriginal = path.join(root, 'moved-original-dir');
          fs.renameSync(dir, movedOriginal);
          fs.mkdirSync(dir, 0o700);
          foreignStat = fs.lstatSync(dir, { bigint: true });
        }
      },
    });
    await assert.rejects(
      vault.runDreamAgentCli({
        cmd: process.execPath,
        args: ['-e', 'process.stdout.write("{}")', '--', '--prompt-file', 'placeholder'],
        prompt: 'synthetic',
        promptFile: true,
        timeoutMs: 3000,
      }),
      { message: 'cli-temp-cleanup-failed', cleanupError: 'cli-temp-cleanup-failed' }
    );
    assert.ok(swappedDir && foreignStat);
    const afterStat = fs.lstatSync(swappedDir, { bigint: true });
    assert.equal(afterStat.isDirectory(), true, 'foreign replacement directory must stay intact');
    assert.equal(afterStat.ino, foreignStat.ino);
    fs.chmodSync(movedOriginal, 0o700);
  }

  // 6) Full runDreamCycle reports BOTH error="cli-temp-cleanup-failed" AND cleanupError="cli-temp-cleanup-failed" when CLI succeeds (#7.4)
  {
    const f = fixture(t);
    gray(f);
    assert.equal(f.vault.updateDreamConfig({ dreamMode: 'agent', providerInstanceId: 'muse', model: 'muse-ember-1.0', reasoningEffort: 'medium', minDeltaMemories: 1 }).ok, true);
    const previous = process.env.DREAM_STUB_MODE;
    process.env.DREAM_STUB_MODE = 'replace';
    try {
      const cycle = await f.vault.runDreamCycle({ force: true, projectRoot: f.projectRoot });
      assert.equal(cycle.ok, false);
      assert.equal(cycle.report.agent.status, 'failed');
      assert.equal(cycle.report.agent.error, 'cli-temp-cleanup-failed');
      assert.equal(cycle.report.agent.cleanupError, 'cli-temp-cleanup-failed');
      assert.deepEqual(cycle.report.agent.diagnostic, { category: 'unknown' });
    } finally {
      if (previous === undefined) delete process.env.DREAM_STUB_MODE;
      else process.env.DREAM_STUB_MODE = previous;
    }
  }
});

test('review-13 (#7-L3-1): directory swap between mkdir and inode open never deletes an empty foreign dir or chmods a 0755 foreign dir', async t => {
  const cp = require('node:child_process');
  for (const kind of ['empty-0700', 'nonempty-0755']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `dream-r13-${kind}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const preload = path.join(root, 'preload.cjs');
    const runner = path.join(root, 'runner.cjs');
    const vaultModulePath = path.resolve(__dirname, '../src/memory-vault.cjs');
    fs.writeFileSync(preload, `
      "use strict";
      const fs = require("node:fs");
      const path = require("node:path");
      const scratch = process.env.R13_SCRATCH;
      const staged = process.env.R13_STAGED;
      const foreign = process.env.R13_FOREIGN;
      const origMkdirSync = fs.mkdirSync;
      let swapped = false;
      fs.mkdirSync = function(target, ...rest) {
        const out = origMkdirSync.call(this, target, ...rest);
        const s = typeof target === "string" ? target : "";
        if (!swapped && scratch && s.startsWith(scratch + path.sep) && path.basename(s).startsWith("t3-dream-prompt-")) {
          swapped = true;
          fs.renameSync(s, staged);
          fs.renameSync(foreign, s);
          process.env.R13_SWAPPED_TARGET = s;
        }
        return out;
      };
    `, 'utf8');
    fs.writeFileSync(runner, `
      "use strict";
      const fs = require("node:fs");
      const path = require("node:path");
      const { createMemoryVault } = require(${JSON.stringify(vaultModulePath)});
      (async () => {
        const root = process.env.R13_ROOT;
        const scratch = process.env.R13_SCRATCH;
        const staged = process.env.R13_STAGED;
        const foreign = process.env.R13_FOREIGN;
        const vault = createMemoryVault({
          homeDir: path.join(root, "home"),
          hubDir: path.join(root, "hub"),
          vaultDir: path.join(root, "vault"),
          _dreamPromptTempRoot: scratch,
          _dreamAfterDirCreateHook: ({ dir }) => {
            if (!process.env.R13_SWAPPED_TARGET && fs.existsSync(foreign)) {
              fs.renameSync(dir, staged);
              fs.renameSync(foreign, dir);
              process.env.R13_SWAPPED_TARGET = dir;
            }
          },
        });
        let status = "ok", message = "", cleanupError = "";
        try {
          await vault.runDreamAgentCli({
            cmd: process.execPath,
            args: ["-e", "process.stdout.write('{}')", "--", "--prompt-file", "placeholder"],
            prompt: "synthetic secret prompt",
            promptFile: true,
            timeoutMs: 3000,
          });
        } catch (err) {
          status = "err";
          message = String(err && err.message || "");
          cleanupError = String(err && err.cleanupError || "");
        }
        process.stdout.write(JSON.stringify({ status, message, cleanupError, target: process.env.R13_SWAPPED_TARGET || "" }));
      })();
    `, 'utf8');
    const scratch = path.join(root, 'scratch');
    const staged = path.join(root, 'staged-real');
    const foreign = path.join(root, 'foreign-dir');
    for (const d of ['scratch', 'home', 'hub', 'vault']) fs.mkdirSync(path.join(root, d), { recursive: true });
    if (kind === 'empty-0700') {
      fs.mkdirSync(foreign, { mode: 0o700 });
    } else {
      fs.mkdirSync(foreign, { mode: 0o755 });
      fs.chmodSync(foreign, 0o755);
      fs.writeFileSync(path.join(foreign, 'keep.txt'), 'foreign-payload');
    }
    const foreignIno = fs.lstatSync(foreign, { bigint: true }).ino;
    const proc = cp.spawnSync(process.execPath, ['--require', preload, runner], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        HOME: path.join(root, 'home'),
        R13_ROOT: root,
        R13_SCRATCH: scratch,
        R13_STAGED: staged,
        R13_FOREIGN: foreign,
      },
    });
    assert.equal(proc.status, 0, proc.stderr);
    const out = JSON.parse(proc.stdout);
    assert.equal(out.status, 'err', `${kind}: swapped prompt directory must never allow CLI run to succeed`);
    assert.ok(out.target, `${kind}: race hook must have swapped target directory`);
    assert.equal(fs.existsSync(out.target), true, `${kind}: foreign directory must not be deleted`);
    const afterStat = fs.lstatSync(out.target, { bigint: true });
    assert.equal(afterStat.ino, foreignIno, `${kind}: foreign directory inode must remain intact`);
    if (kind === 'nonempty-0755') {
      assert.equal(Number(afterStat.mode & 0o777n), 0o755, 'foreign 0755 directory permissions must not be mutated to 0700');
      assert.equal(fs.readFileSync(path.join(out.target, 'keep.txt'), 'utf8'), 'foreign-payload');
    } else {
      assert.deepEqual(fs.readdirSync(out.target), [], 'foreign empty directory must remain untouched and empty');
    }
  }
});

test('review-14 (#7-R8-1 & #7-R8-2): atomic creation swaps before/after initial open and non-Darwin rmdir race preserve foreign empty dirs', async t => {
  const cp = require('node:child_process');
  const vaultModulePath = path.resolve(__dirname, '../src/memory-vault.cjs');

  // 1) Keep the real Python helper: replace the directory on either side of the
  // first open. Neither a successful nor a failing CLI may even be started.
  const swapCases = ['_dreamBeforeInitialDirOpenHook', '_dreamAfterDirCreateHook']
    .flatMap(hook => [0, 7].map(cliExit => ({hook, cliExit})));
  for (const {hook, cliExit} of swapCases) {
    const label = `${hook}, cliExit=${cliExit}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `dream-r14-swap-${cliExit}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runner = path.join(root, 'runner.cjs');
    const cliCode = 'require("node:fs").writeFileSync(process.env.R14_CLI_MARKER, "started");' +
      (cliExit === 0 ? 'process.stdout.write("{}")' : 'process.stderr.write("HTTP 429");process.exit(7)');
    fs.writeFileSync(runner, `
      "use strict";
      const fs = require("node:fs");
      const path = require("node:path");
      const { createMemoryVault } = require(${JSON.stringify(vaultModulePath)});
      (async () => {
        const root = process.env.R14_ROOT;
        const scratch = path.join(root, "scratch");
        const staged = path.join(root, "staged-real");
        let foreignIno = "0", ownedIno = "0", swappedTarget = "";
        const vault = createMemoryVault({
          homeDir: path.join(root, "home"),
          hubDir: path.join(root, "hub"),
          vaultDir: path.join(root, "vault"),
          _dreamPromptTempRoot: scratch,
          ${hook}: ({ dir }) => {
            if (!swappedTarget) {
              ownedIno = String(fs.lstatSync(dir, { bigint: true }).ino);
              // A newly created foreign directory must not be mistaken for ours.
              const lateForeign = path.join(root, "late-foreign");
              fs.mkdirSync(lateForeign, { mode: 0o700 });
              foreignIno = String(fs.lstatSync(lateForeign, { bigint: true }).ino);
              fs.renameSync(dir, staged);
              fs.renameSync(lateForeign, dir);
              swappedTarget = dir;
            }
          },
        });
        let status = "ok", message = "", cleanupError = "";
        try {
          await vault.runDreamAgentCli({
            cmd: process.execPath,
            args: ["-e", ${JSON.stringify(cliCode)}, "--", "--prompt-file", "placeholder"],
            prompt: "synthetic secret prompt",
            promptFile: true,
            timeoutMs: 3000,
          });
        } catch (err) {
          status = "err";
          message = String(err && err.message || "");
          cleanupError = String(err && err.cleanupError || "");
        }
        process.stdout.write(JSON.stringify({ status, message, cleanupError, swappedTarget, foreignIno, ownedIno }));
      })();
    `, 'utf8');
    for (const d of ['scratch', 'home', 'hub', 'vault']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const marker = path.join(root, 'cli-started');
    const proc = cp.spawnSync(process.execPath, [runner], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: path.join(root, 'home'), R14_ROOT: root, R14_CLI_MARKER: marker },
    });
    assert.equal(proc.status, 0, proc.stderr);
    const out = JSON.parse(proc.stdout);
    assert.equal(out.status, 'err', `${label}: foreign swap must reject`);
    assert.equal(out.message, 'cli-spawn-failed', label);
    assert.equal(out.cleanupError, 'cli-temp-cleanup-failed', `${label}: must surface cleanupError`);
    assert.equal(fs.existsSync(marker), false, `${label}: CLI must not execute`);
    assert.ok(out.swappedTarget, `${label}: hook swapped target`);
    assert.equal(fs.existsSync(out.swappedTarget), true, `${label}: foreign dir must not be deleted`);
    assert.equal(String(fs.lstatSync(out.swappedTarget, { bigint: true }).ino), out.foreignIno);
    assert.equal(fs.lstatSync(out.swappedTarget).mode & 0o7777, 0o700);
    assert.deepEqual(fs.readdirSync(out.swappedTarget), [], 'foreign dir remains empty');
    assert.equal(String(fs.lstatSync(path.join(root, 'staged-real'), { bigint: true }).ino), out.ownedIno);
  }

  // 2) Non-Darwin cleanup branch race right after readdirSync(dir) before directory removal
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-r14-rmdir-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const preload = path.join(root, 'preload.cjs');
    const runner = path.join(root, 'runner.cjs');
    fs.writeFileSync(preload, `
      "use strict";
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const fs = require("node:fs");
      const path = require("node:path");
      const origWriteFileSync = fs.writeFileSync;
      const origReaddirSync = fs.readdirSync;
      let writeFailed = false, swappedOnCleanup = false;
      fs.writeFileSync = function(target, data, ...rest) {
        if (typeof target === "number" && data === "synthetic secret" && !writeFailed) {
          writeFailed = true;
          throw new Error("injected-prompt-write-failure");
        }
        return origWriteFileSync.call(this, target, data, ...rest);
      };
      fs.readdirSync = function(target, ...rest) {
        const out = origReaddirSync.call(this, target, ...rest);
        const s = typeof target === "string" ? target : "";
        if (writeFailed && !swappedOnCleanup && process.env.R14_SCRATCH && s.startsWith(process.env.R14_SCRATCH + path.sep) && path.basename(s).startsWith("t3-dream-prompt-")) {
          // Wait until prompt.txt was unlinked (or never existed) and out is empty during canRemoveDir!
          if (Array.isArray(out) && out.length === 0 && process.env.R14_IN_FINALLY === "1") {
            swappedOnCleanup = true;
            const foreign = path.join(process.env.R14_ROOT, "foreign-rmdir");
            const savedOrig = path.join(process.env.R14_ROOT, "saved-orig-rmdir");
            origMkdir(foreign);
            process.env.R14_FOREIGN_INO = String(fs.lstatSync(foreign, { bigint: true }).ino);
            fs.renameSync(s, savedOrig);
            fs.renameSync(foreign, s);
            process.env.R14_SWAPPED_DIR = s;
          }
        }
        return out;
      };
      function origMkdir(p) { fs.mkdirSync(p, { mode: 0o700 }); }
    `, 'utf8');
    fs.writeFileSync(runner, `
      "use strict";
      const path = require("node:path");
      const { createMemoryVault } = require(${JSON.stringify(vaultModulePath)});
      (async () => {
        const root = process.env.R14_ROOT;
        const scratch = path.join(root, "scratch");
        const vault = createMemoryVault({
          homeDir: path.join(root, "home"),
          hubDir: path.join(root, "hub"),
          vaultDir: path.join(root, "vault"),
          _dreamPromptTempRoot: scratch,
          _dreamAtomicUnlinkHook: ({ phase }) => {
            if (phase === "before-dir-rename") process.env.R14_IN_FINALLY = "1";
          },
        });
        let status = "ok", message = "", cleanupError = "";
        try {
          await vault.runDreamAgentCli({
            cmd: process.execPath,
            args: ["-e", "process.stdout.write('{}')", "--", "--prompt-file", "placeholder"],
            prompt: "synthetic secret",
            promptFile: true,
            timeoutMs: 3000,
          });
        } catch (err) {
          status = "err";
          message = String(err && err.message || "");
          cleanupError = String(err && err.cleanupError || "");
        }
        process.stdout.write(JSON.stringify({
          status, message, cleanupError,
          swappedDir: process.env.R14_SWAPPED_DIR || "",
          foreignIno: process.env.R14_FOREIGN_INO || "",
        }));
      })();
    `, 'utf8');
    for (const d of ['scratch', 'home', 'hub', 'vault']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const proc = cp.spawnSync(process.execPath, ['--require', preload, runner], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: path.join(root, 'home'), R14_ROOT: root, R14_SCRATCH: path.join(root, 'scratch') },
    });
    assert.equal(proc.status, 0, proc.stderr);
    const out = JSON.parse(proc.stdout);
    assert.equal(out.status, 'err');
    assert.equal(out.cleanupError, 'cli-temp-cleanup-failed', 'non-Darwin rmdir race must report cleanupError');
    assert.ok(out.swappedDir, 'non-Darwin rmdir race hook must have fired');
    assert.equal(fs.existsSync(out.swappedDir), true, 'foreign dir swapped before rmdir must remain at target path');
    assert.equal(String(fs.lstatSync(out.swappedDir, { bigint: true }).ino), out.foreignIno);
  }
});

test('default prompt root is created as hubDir/dream-tmp with mode 0700 and emptied after the run', async t => {
  const f = fixture(t);
  fs.rmdirSync(f.hubDir);
  const tempRoot = path.join(f.hubDir, 'dream-tmp');
  const vault = createMemoryVault({homeDir:f.homeDir, hubDir:f.hubDir, vaultDir:f.vaultDir});
  assert.equal(fs.existsSync(tempRoot), false, 'default root must not be pre-created by the fixture');
  const result = await vault.runDreamAgentCli({
    cmd:f.fake, args:['--prompt-file','placeholder'], prompt:'synthetic default-root prompt', promptFile:true, timeoutMs:3000,
  });
  assert.equal(result.stdout, '{"merges":[]}');
  const seen = JSON.parse(fs.readFileSync(f.probe, 'utf8'));
  assert.equal(path.dirname(path.dirname(seen.input)), tempRoot, 'prompt must be under the default Hub root');
  assert.equal(seen.content, 'synthetic default-root prompt');
  assert.equal(seen.regular, true);
  assert.equal(seen.fileMode, 0o600);
  assert.equal(seen.dirMode, 0o700);
  for (const dir of [f.hubDir, tempRoot]) {
    assert.equal(fs.lstatSync(dir).isSymbolicLink(), false);
    assert.equal(fs.statSync(dir).mode & 0o7777, 0o700);
  }
  assert.equal(fs.existsSync(seen.input), false);
  assert.deepEqual(fs.readdirSync(tempRoot), [], 'all per-run prompt artifacts must be removed');
  assert.deepEqual(fs.readdirSync(f.hubDir), ['dream-tmp'], 'no helper-born, sentinel or stage artifacts remain');
});

for (const target of ['hub', 'dream-tmp']) {
  test(`default prompt root fails closed when ${target} is a symbolic link`, async t => {
    const f = fixture(t);
    const outside = path.join(f.root, 'foreign-root');
    fs.mkdirSync(outside, {mode:0o700});
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'foreign data');
    const outsideIno = fs.lstatSync(outside, {bigint:true}).ino;
    const link = target === 'hub' ? f.hubDir : path.join(f.hubDir, 'dream-tmp');
    if (target === 'hub') fs.rmdirSync(f.hubDir);
    fs.symlinkSync(outside, link, 'dir');
    const linkIno = fs.lstatSync(link, {bigint:true}).ino;
    const vault = createMemoryVault({homeDir:f.homeDir, hubDir:f.hubDir, vaultDir:f.vaultDir});
    await assert.rejects(vault.runDreamAgentCli({
      cmd:f.fake, args:['--prompt-file','placeholder'], prompt:'synthetic', promptFile:true, timeoutMs:3000,
    }), err => {
      assert.equal(err.message, 'cli-spawn-failed');
      assert.equal(err.cleanupError, undefined);
      assert.deepEqual(err.diagnostic, {category:'unknown'});
      return true;
    });
    assert.equal(fs.existsSync(f.probe), false, 'CLI must not execute');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(link, {bigint:true}).ino, linkIno, 'symlink must remain untouched');
    assert.equal(fs.lstatSync(outside, {bigint:true}).ino, outsideIno);
    assert.deepEqual(fs.readdirSync(outside), ['keep.txt'], 'no files may be created in the symlink target');
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'foreign data');
    assert.deepEqual(fs.readdirSync(f.hubDir), target === 'hub' ? ['keep.txt'] : ['dream-tmp']);
  });
}

test('review-14: missing Python fails closed without creating a prompt directory or starting the CLI', async t => {
  const cp = require('node:child_process');
  const f = fixture(t);
  const preload = path.join(f.root, 'no-python.cjs');
  fs.writeFileSync(preload, `
    const cp = require('node:child_process');
    const original = cp.spawnSync;
    cp.spawnSync = function(cmd, ...rest) {
      if (typeof cmd === 'string' && cmd.includes('python3')) {
        process.env.PYTHON_BLOCKED = '1';
        return { status: null, error: Object.assign(new Error('unavailable'), { code: 'ENOENT' }) };
      }
      return original.call(this, cmd, ...rest);
    };
  `);
  const runner = `
    const { createMemoryVault } = require(${JSON.stringify(path.resolve(__dirname, '../src/memory-vault.cjs'))});
    const vault = createMemoryVault(${JSON.stringify({homeDir:f.homeDir, hubDir:f.hubDir, vaultDir:f.vaultDir, _dreamPromptTempRoot:f.temp})});
    vault.runDreamAgentCli({cmd:${JSON.stringify(f.fake)},args:['--prompt-file','placeholder'],prompt:'synthetic',promptFile:true})
      .then(() => { throw new Error('unexpected success'); }, err => {
        process.stdout.write(JSON.stringify({message:err.message, cleanupError:err.cleanupError || '', blocked:process.env.PYTHON_BLOCKED}));
      });
  `;
  const proc = cp.spawnSync(process.execPath, ['--require', preload, '-e', runner], {
    encoding:'utf8', timeout:5000, env:{...process.env, HOME:f.homeDir},
  });
  assert.equal(proc.status, 0, proc.stderr);
  assert.deepEqual(JSON.parse(proc.stdout), {message:'cli-spawn-failed', cleanupError:'', blocked:'1'});
  assert.equal(fs.existsSync(f.probe), false, 'CLI must not execute');
  assert.deepEqual(fs.readdirSync(f.temp), [], 'no unpinned fallback directory may be created');
  assert.deepEqual(fs.readdirSync(f.hubDir), [], 'sentinel and staging directories must not remain');
});

// Run filesystem fault injection before the module captures RAW_FS, with every
// path (including HOME, Hub and the prompt root) inside one disposable fixture.
function isolatedReview16(t, { defaultRoot = false, preload = '', hook = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-review16-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['home', 'hub', 'vault', 'scratch']) fs.mkdirSync(path.join(root, d), {mode:0o700});
  const tempRoot = defaultRoot ? path.join(root, 'hub', 'dream-tmp') : path.join(root, 'scratch');
  if (defaultRoot) fs.mkdirSync(tempRoot, {mode:0o700});
  const runner = `
    const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
    const root = ${JSON.stringify(root)}, tempRoot = ${JSON.stringify(tempRoot)};
    const state = {started:false};
    const spawn = cp.spawn;
    cp.spawn = function(...args) { state.started = true; return spawn.apply(this, args); };
    ${preload}
    const {createMemoryVault} = require(${JSON.stringify(path.resolve(__dirname, '../src/memory-vault.cjs'))});
    const vault = createMemoryVault({homeDir:path.join(root,'home'), hubDir:path.join(root,'hub'), vaultDir:path.join(root,'vault'),
      ${defaultRoot ? '' : '_dreamPromptTempRoot:tempRoot,'}
      _dreamAtomicUnlinkHook: async context => { ${hook} }
    });
    (async () => {
      let message = '', cleanupError = '';
      try { await vault.runDreamAgentCli({cmd:process.execPath,
        args:['-e', 'process.stdout.write("{}")', '--', '--prompt-file', 'placeholder'],
        prompt:'synthetic review16 prompt', promptFile:true, timeoutMs:3000}); }
      catch (e) { message = e.message; cleanupError = e.cleanupError || ''; }
      process.stdout.write(JSON.stringify({message, cleanupError, ...state}));
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `;
  const proc = require('node:child_process').spawnSync(process.execPath, ['-e', runner], {
    encoding:'utf8', timeout:15000, env:{...process.env, HOME:path.join(root,'home'), TMPDIR:root, PYTHONDONTWRITEBYTECODE:'1'},
  });
  assert.equal(proc.status, 0, proc.stderr);
  return {root, tempRoot, out:JSON.parse(proc.stdout)};
}

for (const defaultRoot of [true, false]) {
  for (const fault of ['permissions', 'owner', 'symlink', 'identity']) {
    test(`review-16 defect-1: ${defaultRoot ? 'default' : 'explicit'} root rejects ${fault}`, t => {
      const {root, tempRoot, out} = isolatedReview16(t, { defaultRoot, preload:`
        const fault = ${JSON.stringify(fault)};
        if (fault === 'permissions') fs.chmodSync(tempRoot, ${defaultRoot ? '0o755' : '0o777'});
        if (fault === 'symlink') {
          fs.renameSync(tempRoot, path.join(root,'foreign-root'));
          fs.symlinkSync(path.join(root,'foreign-root'), tempRoot);
        }
        const open = fs.openSync, fstat = fs.fstatSync, rootFds = new Set();
        fs.openSync = function(target, ...args) {
          const fd = open.call(this, target, ...args);
          if (target === tempRoot) { state.rootOpened = true; rootFds.add(fd); }
          return fd;
        };
        fs.fstatSync = function(fd, ...args) {
          const st = fstat.call(this, fd, ...args);
          if (rootFds.has(fd) && (fault === 'owner' || fault === 'identity')) {
            state.injected = true;
            return Object.assign(Object.create(Object.getPrototypeOf(st)), st,
              fault === 'owner' ? {uid: st.uid + 1n} : {ino: st.ino + 1n});
          }
          return st;
        };
      `});
      assert.equal(out.message, 'cli-spawn-failed');
      assert.equal(out.cleanupError, '');
      assert.equal(out.started, false, 'unsafe root must fail before CLI execution');
      if (fault === 'owner' || fault === 'identity') assert.equal(out.injected, true);
      assert.deepEqual(fs.readdirSync(tempRoot), []);
      if (fault === 'symlink') assert.equal(fs.lstatSync(tempRoot).isSymbolicLink(), true);
      if (fault === 'permissions') assert.equal(fs.statSync(tempRoot).mode & 0o777, defaultRoot ? 0o755 : 0o777);
      assert.deepEqual(fs.readdirSync(path.join(root,'hub')), defaultRoot ? ['dream-tmp'] : []);
    });
  }
}

test('review-16 defect-1: explicit 0755 root is opened with no-follow directory flags and remains usable', t => {
  const {tempRoot, out} = isolatedReview16(t, {preload:`
    fs.chmodSync(tempRoot, 0o755);
    const open = fs.openSync;
    fs.openSync = function(target, flags, ...args) {
      if (target === tempRoot) state.rootFlags = flags;
      return open.call(this, target, flags, ...args);
    };
  `});
  assert.equal(out.message, '');
  assert.equal(out.started, true);
  assert.equal(typeof out.rootFlags, 'number', 'the root itself must be pinned by an open fd');
  assert.equal(out.rootFlags & fs.constants.O_DIRECTORY, fs.constants.O_DIRECTORY);
  assert.equal(out.rootFlags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
  assert.equal(fs.statSync(tempRoot).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

for (const replacement of ['directory', 'symlink']) {
  test(`review-16 defect-1: Python refuses root ${replacement} swapped after parent validation`, t => {
    const {root, tempRoot, out} = isolatedReview16(t, {preload:`
      const spawnSync = cp.spawnSync;
      cp.spawnSync = function(cmd, args, opts) {
        if (String(cmd).includes('python3') && args[2].includes('temp_root') && !state.swapped) {
          state.swapped = true;
          fs.renameSync(tempRoot, path.join(root,'original-root'));
          fs.mkdirSync(path.join(root,'foreign-root'), {mode:0o700});
          if (${JSON.stringify(replacement)} === 'symlink') fs.symlinkSync(path.join(root,'foreign-root'),tempRoot);
          else fs.renameSync(path.join(root,'foreign-root'),tempRoot);
        }
        return spawnSync.call(this, cmd, args, opts);
      };
    `});
    assert.equal(out.swapped, true);
    assert.equal(out.message, 'cli-spawn-failed');
    assert.equal(out.cleanupError, '');
    assert.equal(out.started, false);
    assert.deepEqual(fs.readdirSync(tempRoot), [], 'helper must not create in the substituted root');
    assert.deepEqual(fs.readdirSync(path.join(root,'original-root')), []);
  });
}

test('review-16 defect-2: unverified foreign 0755 stage directory survives failed initial open validation', t => {
  const {out} = isolatedReview16(t, {preload:`
    Object.defineProperty(process, 'platform', {value:'linux', configurable:true});
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = function(target, ...args) {
      const result = mkdir.call(this, target, ...args);
      if (typeof target === 'string' && path.basename(target).startsWith('.t3-dream-stage-') && !state.stage) {
        fs.renameSync(target, path.join(root,'owned-stage'));
        mkdir.call(this, target, {mode:0o755});
        fs.chmodSync(target, 0o755);
        state.stage = target;
        state.foreignIno = String(fs.lstatSync(target, {bigint:true}).ino);
      }
      return result;
    };
  `});
  assert.equal(out.started, true);
  assert.ok(out.stage, 'stage replacement must be injected');
  assert.equal(out.cleanupError, 'cli-temp-cleanup-failed');
  assert.equal(fs.existsSync(out.stage), true, 'unverified foreign directory must never be removed');
  assert.equal(String(fs.lstatSync(out.stage, {bigint:true}).ino), out.foreignIno);
  assert.equal(fs.statSync(out.stage).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(out.stage), []);
});

test('review-16 defect-4: non-Darwin stage restores a foreign symlink to its original path', t => {
  const {out} = isolatedReview16(t, {preload:`
    Object.defineProperty(process, 'platform', {value:'linux', configurable:true});
  `, hook:`
    if (context.phase === 'before-stage-move' && !state.replaced) {
      state.replaced = true;
      state.file = context.filePath;
      state.target = path.join(root, 'foreign-target');
      fs.writeFileSync(state.target, 'foreign data');
      fs.unlinkSync(context.filePath);
      fs.symlinkSync(state.target, context.filePath);
    }
  `});
  assert.equal(out.started, true);
  assert.equal(out.replaced, true);
  assert.equal(out.cleanupError, 'cli-temp-cleanup-failed');
  assert.equal(fs.lstatSync(out.file).isSymbolicLink(), true, 'foreign symlink must be restored');
  assert.equal(fs.readlinkSync(out.file), out.target);
  assert.equal(fs.readFileSync(out.target, 'utf8'), 'foreign data');
});

test('review-15: atomic candidate collision retries safely, missing Python fails closed, and stage restore preserves foreign entries A and B', async t => {
  const cp = require('node:child_process');
  const vaultModulePath = path.resolve(__dirname, '../src/memory-vault.cjs');

  // 1) Exercise the real helper's EEXIST retry, and separately the missing-helper
  // refusal. A pre-existing empty directory must retain its inode in both cases.
  for (const blockPython of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `dream-r15-cand-${blockPython ? 'nopy' : 'py'}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const d of ['scratch', 'home', 'hub', 'vault']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const fixedHex = 'aa'.repeat(16);
    const foreignEmpty = path.join(root, 'scratch', `t3-dream-prompt-${fixedHex}`);
    fs.mkdirSync(foreignEmpty, { mode: 0o700 });
    const foreignIno = String(fs.lstatSync(foreignEmpty, { bigint: true }).ino);

    const preload = path.join(root, 'preload.cjs');
    const runner = path.join(root, 'runner.cjs');
    fs.writeFileSync(preload, `
      "use strict";
      const cp = require("node:child_process");
      const origSpawnSync = cp.spawnSync;
      cp.spawnSync = function(cmd, args, opts) {
        if (typeof cmd === "string" && cmd.includes("python3")) {
          if (${JSON.stringify(blockPython)}) {
            process.env.R15_PYTHON_BLOCKED = "1";
            return { status: 127, stdout: "", stderr: "python3 blocked", error: new Error("EPERM") };
          }
          // Candidate randomness now lives in Python, not crypto.randomBytes.
          // Fix only attempt 0; keep real fd-relative mkdir, EEXIST, and later entropy.
          const patched = [...args];
          patched[2] = patched[2]
            .replace("'t3-dream-prompt-' + os.urandom(16).hex()", "'t3-dream-prompt-' + (bytes.fromhex('${fixedHex}') if attempt == 0 else os.urandom(16)).hex()")
            .replace("if err == errno.EEXIST and attempt < 3: continue", "if err == errno.EEXIST and attempt < 3: sys.stderr.write('collision-retried'); continue");
          const result = origSpawnSync.call(this, cmd, patched, opts);
          if (String(result.stderr).includes('collision-retried')) process.env.R15_COLLISION_RETRIED = "1";
          if (result.status === 0 && result.stdout.trim()) process.env.R15_CREATED_DIR = JSON.parse(result.stdout).dir;
          return result;
        }
        return origSpawnSync.call(this, cmd, args, opts);
      };
      const origSpawn = cp.spawn;
      cp.spawn = function(...args) {
        process.env.R15_CLI_STARTED = "1";
        return origSpawn.apply(this, args);
      };
    `, 'utf8');
    fs.writeFileSync(runner, `
      "use strict";
      const path = require("node:path");
      const { createMemoryVault } = require(${JSON.stringify(vaultModulePath)});
      (async () => {
        const root = process.env.R15_ROOT;
        const vault = createMemoryVault({
          homeDir: path.join(root, "home"),
          hubDir: path.join(root, "hub"),
          vaultDir: path.join(root, "vault"),
          _dreamPromptTempRoot: path.join(root, "scratch"),
        });
        let status = "ok", stdout = "", message = "", cleanupError = "";
        try {
          const out = await vault.runDreamAgentCli({
            cmd: process.execPath,
            args: ["-e", "process.stdout.write('{\\"ok\\":true}')", "--", "--prompt-file", "placeholder"],
            prompt: "synthetic prompt",
            promptFile: true,
            timeoutMs: 3000,
          });
          stdout = out.stdout;
        } catch (err) {
          status = "err"; message = err.message; cleanupError = err.cleanupError || "";
        }
        process.stdout.write(JSON.stringify({ status, stdout, message, cleanupError,
          retried: process.env.R15_COLLISION_RETRIED || "", created: process.env.R15_CREATED_DIR || "",
          blocked: process.env.R15_PYTHON_BLOCKED || "", started: process.env.R15_CLI_STARTED || "" }));
      })();
    `, 'utf8');
    const proc = cp.spawnSync(process.execPath, ['--require', preload, runner], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: path.join(root, 'home'), R15_ROOT: root },
    });
    assert.equal(proc.status, 0, proc.stderr);
    const out = JSON.parse(proc.stdout);
    if (blockPython) {
      assert.equal(out.status, 'err');
      assert.equal(out.message, 'cli-spawn-failed');
      assert.equal(out.cleanupError, '');
      assert.equal(out.blocked, '1');
      assert.equal(out.created, '');
      assert.equal(out.retried, '');
      assert.equal(out.started, '');
    } else {
      assert.equal(out.status, 'ok', out.message);
      assert.equal(out.stdout, '{"ok":true}');
      assert.equal(out.retried, '1', 'real atomic mkdir must encounter EEXIST and retry');
      assert.equal(path.dirname(out.created), path.join(root, 'scratch'));
      assert.notEqual(out.created, foreignEmpty, 'retry must select a new random name');
      assert.equal(fs.existsSync(out.created), false, 'successfully used candidate is cleaned');
      assert.equal(out.started, '1');
    }
    assert.equal(fs.existsSync(foreignEmpty), true, 'pre-existing empty 0700 foreign directory must remain present');
    assert.equal(String(fs.lstatSync(foreignEmpty, { bigint: true }).ino), foreignIno, 'pre-existing empty 0700 foreign directory inode must not be replaced');
    assert.equal(fs.lstatSync(foreignEmpty).mode & 0o7777, 0o700);
    assert.deepEqual(fs.readdirSync(foreignEmpty), []);
    assert.deepEqual(fs.readdirSync(path.join(root, 'scratch')), [`t3-dream-prompt-${fixedHex}`]);
    assert.deepEqual(fs.readdirSync(path.join(root, 'hub')), [], 'no helper-born or staging directories remain');
  }

  // 2) Non-Darwin file cleanup: foreign A staged, then second foreign B appears before restore -> neither B nor A is overwritten/deleted
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-r15-filerestore-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const d of ['scratch', 'home', 'hub', 'vault']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const preload = path.join(root, 'preload.cjs');
    const runner = path.join(root, 'runner.cjs');
    fs.writeFileSync(preload, `
      "use strict";
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    `, 'utf8');
    fs.writeFileSync(runner, `
      "use strict";
      const fs = require("node:fs");
      const path = require("node:path");
      const { createMemoryVault } = require(${JSON.stringify(vaultModulePath)});
      (async () => {
        const root = process.env.R15_ROOT;
        let targetFile = "", stagedRecord = "", inoA = "", inoB = "";
        const vault = createMemoryVault({
          homeDir: path.join(root, "home"),
          hubDir: path.join(root, "hub"),
          vaultDir: path.join(root, "vault"),
          _dreamPromptTempRoot: path.join(root, "scratch"),
          _dreamAtomicUnlinkHook: ({ phase, filePath, stagePath }) => {
            if (phase === "before-stage-move" && !targetFile) {
              targetFile = filePath;
              fs.unlinkSync(filePath);
              fs.writeFileSync(filePath, "foreign-A");
              inoA = String(fs.lstatSync(filePath, { bigint: true }).ino);
            } else if (phase === "before-stage-restore" && !stagedRecord) {
              stagedRecord = stagePath;
              fs.writeFileSync(filePath, "foreign-B");
              inoB = String(fs.lstatSync(filePath, { bigint: true }).ino);
            }
          },
        });
        let status = "ok", cleanupError = "";
        try {
          await vault.runDreamAgentCli({
            cmd: process.execPath,
            args: ["-e", "process.stdout.write('{}')", "--", "--prompt-file", "placeholder"],
            prompt: "synthetic prompt",
            promptFile: true,
            timeoutMs: 3000,
          });
        } catch (err) {
          status = "err";
          cleanupError = String(err && err.cleanupError || "");
        }
        process.stdout.write(JSON.stringify({ status, cleanupError, targetFile, stagedRecord, inoA, inoB }));
      })();
    `, 'utf8');
    const proc = cp.spawnSync(process.execPath, ['--require', preload, runner], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: path.join(root, 'home'), R15_ROOT: root },
    });
    assert.equal(proc.status, 0, proc.stderr);
    const out = JSON.parse(proc.stdout);
    assert.equal(out.status, 'err');
    assert.equal(out.cleanupError, 'cli-temp-cleanup-failed');
    assert.equal(fs.readFileSync(out.targetFile, 'utf8'), 'foreign-B', 'second foreign entry B at target path must not be overwritten');
    assert.equal(String(fs.lstatSync(out.targetFile, { bigint: true }).ino), out.inoB);
    assert.equal(fs.readFileSync(out.stagedRecord, 'utf8'), 'foreign-A', 'first foreign entry A in stageRoot must remain preserved');
    assert.equal(String(fs.lstatSync(out.stagedRecord, { bigint: true }).ino), out.inoA);
  }

  // 3) Non-Darwin dir cleanup with the real helper preserves A and B on restore
  // collision. Without Python, reject before any write, swap, or CLI execution.
  for (const blockPython of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `dream-r15-dirrestore-${blockPython ? 'nopy' : 'py'}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const d of ['scratch', 'home', 'hub', 'vault']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const preload = path.join(root, 'preload.cjs');
    const runner = path.join(root, 'runner.cjs');
    fs.writeFileSync(preload, `
      "use strict";
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const cp = require("node:child_process");
      const fs = require("node:fs");
      const path = require("node:path");
      if (${JSON.stringify(blockPython)}) {
        const origSpawnSync = cp.spawnSync;
        cp.spawnSync = function(cmd, args, opts) {
          if (typeof cmd === "string" && cmd.includes("python3")) {
            process.env.R15_PYTHON_BLOCKED = "1";
            return { status: 127, stdout: "", stderr: "python3 blocked", error: new Error("EPERM") };
          }
          return origSpawnSync.call(this, cmd, args, opts);
        };
      }
      const origSpawn = cp.spawn;
      cp.spawn = function(...args) {
        process.env.R15_CLI_STARTED = "1";
        return origSpawn.apply(this, args);
      };
      const origWriteFileSync = fs.writeFileSync;
      const origReaddirSync = fs.readdirSync;
      let writeFailed = false, swappedOnCleanup = false;
      fs.writeFileSync = function(target, data, ...rest) {
        if (typeof target === "number" && data === "synthetic secret" && !writeFailed) {
          writeFailed = true;
          throw new Error("injected-prompt-write-failure");
        }
        return origWriteFileSync.call(this, target, data, ...rest);
      };
      fs.readdirSync = function(target, ...rest) {
        const out = origReaddirSync.call(this, target, ...rest);
        const s = typeof target === "string" ? target : "";
        if (writeFailed && !swappedOnCleanup && process.env.R15_SCRATCH && s.startsWith(process.env.R15_SCRATCH + path.sep) && path.basename(s).startsWith("t3-dream-prompt-")) {
          if (Array.isArray(out) && out.length === 0 && process.env.R15_IN_FINALLY === "1") {
            swappedOnCleanup = true;
            const foreignA = path.join(process.env.R15_ROOT, "foreign-dir-A");
            const savedOrig = path.join(process.env.R15_ROOT, "saved-orig-dir");
            fs.mkdirSync(foreignA, { mode: 0o700 });
            origWriteFileSync(path.join(foreignA, "a.txt"), "keep-A");
            process.env.R15_INO_A = String(fs.lstatSync(foreignA, { bigint: true }).ino);
            fs.renameSync(s, savedOrig);
            fs.renameSync(foreignA, s);
            process.env.R15_SWAPPED_DIR = s;
          }
        }
        return out;
      };
    `, 'utf8');
    fs.writeFileSync(runner, `
      "use strict";
      const fs = require("node:fs");
      const path = require("node:path");
      const { createMemoryVault } = require(${JSON.stringify(vaultModulePath)});
      (async () => {
        const root = process.env.R15_ROOT;
        let stagedDirRecord = "", inoB = "", message = "";
        const vault = createMemoryVault({
          homeDir: path.join(root, "home"),
          hubDir: path.join(root, "hub"),
          vaultDir: path.join(root, "vault"),
          _dreamPromptTempRoot: path.join(root, "scratch"),
          _dreamAtomicUnlinkHook: ({ phase, dir, stagePath }) => {
            if (phase === "before-dir-rename") process.env.R15_IN_FINALLY = "1";
            else if (phase === "before-dir-restore" && !stagedDirRecord) {
              stagedDirRecord = stagePath;
              fs.mkdirSync(dir, { mode: 0o700 });
              fs.writeFileSync(path.join(dir, "b.txt"), "keep-B");
              inoB = String(fs.lstatSync(dir, { bigint: true }).ino);
            }
          },
        });
        let status = "ok", cleanupError = "";
        try {
          await vault.runDreamAgentCli({
            cmd: process.execPath,
            args: ["-e", "process.stdout.write('{}')", "--", "--prompt-file", "placeholder"],
            prompt: "synthetic secret",
            promptFile: true,
            timeoutMs: 3000,
          });
        } catch (err) {
          status = "err";
          message = String(err && err.message || "");
          cleanupError = String(err && err.cleanupError || "");
        }
        process.stdout.write(JSON.stringify({
          status, message, cleanupError,
          swappedDir: process.env.R15_SWAPPED_DIR || "",
          inoA: process.env.R15_INO_A || "",
          stagedDirRecord, inoB, blocked: process.env.R15_PYTHON_BLOCKED || "",
          started: process.env.R15_CLI_STARTED || "",
        }));
      })();
    `, 'utf8');
    const proc = cp.spawnSync(process.execPath, ['--require', preload, runner], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: path.join(root, 'home'), R15_ROOT: root, R15_SCRATCH: path.join(root, 'scratch') },
    });
    assert.equal(proc.status, 0, proc.stderr);
    const out = JSON.parse(proc.stdout);
    assert.equal(out.status, 'err');
    assert.equal(out.message, 'cli-spawn-failed');
    assert.equal(out.started, '', 'CLI must not execute after setup failure');
    if (blockPython) {
      assert.equal(out.blocked, '1');
      assert.equal(out.cleanupError, '', 'no owned prompt directory exists to clean');
      assert.equal(out.swappedDir, '');
      assert.equal(out.stagedDirRecord, '');
      assert.equal(out.inoA, '');
      assert.equal(out.inoB, '');
      assert.deepEqual(fs.readdirSync(path.join(root, 'scratch')), []);
      assert.deepEqual(fs.readdirSync(path.join(root, 'hub')), []);
      continue;
    }
    assert.equal(out.cleanupError, 'cli-temp-cleanup-failed');
    assert.ok(out.swappedDir, 'directory A must have been substituted');
    assert.ok(out.stagedDirRecord, 'restore collision must have been exercised');
    assert.equal(String(fs.lstatSync(out.swappedDir, { bigint: true }).ino), out.inoB, 'second foreign dir B must remain at target path');
    assert.equal(fs.readFileSync(path.join(out.swappedDir, 'b.txt'), 'utf8'), 'keep-B');
    assert.equal(String(fs.lstatSync(out.stagedDirRecord, { bigint: true }).ino), out.inoA, 'first foreign dir A must remain preserved in stageRoot');
    assert.equal(fs.readFileSync(path.join(out.stagedDirRecord, 'a.txt'), 'utf8'), 'keep-A');
  }
});

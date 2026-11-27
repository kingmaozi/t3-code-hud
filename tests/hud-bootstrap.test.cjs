'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const {EventEmitter} = require('node:events');
const {execFile, execFileSync} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const repo = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'src/bootstrap.cjs'), 'utf8');
const bin = fs.readFileSync(path.join(repo, 'bin/t3-hud'), 'utf8');
const electron = '/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)';
const tick = () => new Promise(r => setImmediate(r));

function sandbox(t, {healthy=true, failWrite=false, marker, preLock=null, config, env={}, observedPs=undefined, failHostStdin=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hud-bootstrap-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const runDir=path.join(root,'.t3/hud-plugin/run'); fs.mkdirSync(runDir,{recursive:true});
  const markerFile=path.join(runDir,'active.pid');
  const lockFile=path.join(runDir,'bootstrap.lock');
  const logFile=path.join(runDir,'bootstrap.log');
  if (config) fs.writeFileSync(path.join(runDir, '..', 'config.json'), JSON.stringify(config));
  if(marker) fs.writeFileSync(markerFile,marker);
  if(preLock) fs.writeFileSync(lockFile, JSON.stringify(preLock), { mode: 0o600 });
  const child = new EventEmitter(); child.pid=123456789;
  child.stderr=new EventEmitter(); child.stderr.destroy=()=>{}; child.unref=()=>{};
  const timers=[]; const sockets=[]; const exits=[]; const spawns=[];
  let probes=0, launchEnv, launchArgs, hostChild=null, hostStdinData='';
  const mockFs=Object.create(fs);
  mockFs.existsSync=p=>String(p).startsWith('/Applications/') || fs.existsSync(p);
  mockFs.readdirSync=p=>String(p).startsWith('/Applications/') ? ['T3 Code (Beta)'] : fs.readdirSync(p);
  mockFs.writeFileSync=(p,...args)=>{
    if(failWrite && String(p).startsWith(runDir) && String(p).includes('active.pid')) throw new Error('EACCES');
    return fs.writeFileSync(p,...args);
  };
  class Socket { constructor(){sockets.push(this);} send(message){this.request=JSON.parse(message);} close(){} }
  const telemetryMod = require('../src/hub-telemetry-guard.cjs');
  let bootingTopLevel = true;
  const context={require(id){
    if(id==='node:fs')return mockFs;
    if(id==='node:os')return {...os,homedir:()=>root};
    if(id==='node:child_process')return {
      spawn:(exe,args,options)=>{
        spawns.push({exe,args,options});
        if (spawns.length === 1) {
          launchEnv=options.env;
          launchArgs=args;
          return child;
        }
        hostChild = new EventEmitter();
        hostChild.pid = 223456789;
        hostChild.unref = () => {};
        const stdinEm = new EventEmitter();
        stdinEm.end = (chunk) => {
          if (failHostStdin) throw new Error('EPIPE');
          hostStdinData += String(chunk || '');
        };
        hostChild.stdin = stdinEm;
        return hostChild;
      }
    };
    if(id==='./hud-runtime.cjs')return require('../src/hud-runtime.cjs');
    if(id==='./hud-health.cjs')return {checkHud:async()=>{probes++;return healthy;}};
    if(id==='./update-guardian.cjs')return {
      resolveNodeRuntime: () => ({ bin: '/opt/homebrew/bin/node', useRunAsNode: false }),
    };
    if(id==='./hub-telemetry-guard.cjs')return {...telemetryMod,
      buildTelemetryLaunch:(childEnv)=>telemetryMod.buildTelemetryLaunch(childEnv,path.dirname(runDir)),
      createTelemetryGuard:()=>telemetryMod.createTelemetryGuard({homeDir:root,pluginDir:path.dirname(runDir)}),
      observeProcessTelemetry:(pid)=>{
        if (observedPs !== undefined) return typeof observedPs === 'function' ? observedPs(pid, launchEnv) : observedPs;
        return { pid, ...telemetryMod.optOutFlags(launchEnv || {}) };
      },
      processStart:()=>"test process start"};
    return require(id);
  },__dirname:path.join(repo,'src'),process:{env,argv:['node','bootstrap'],pid:process.pid,execPath:process.execPath,versions:process.versions,
    kill(pid){if(pid===child.pid) return; return process.kill(pid,0);},exit:c=>{ exits.push(c); if (bootingTopLevel) throw new Error('__EXIT__'); }},
    console:{error(){}},WebSocket:Socket,setTimeout(fn,ms){const h={fn,ms,unref(){}};timers.push(h);return h;},clearTimeout(h){if(h)h.cancelled=true;}};
  try {
    vm.runInNewContext(source,context);
  } catch (err) {
    if (err?.message !== '__EXIT__') throw err;
  } finally {
    bootingTopLevel = false;
  }
  const safeCall = (fn) => { try { fn(); } catch (e) { if (e?.message !== '__EXIT__') throw e; } };
  function inspectUrl(){safeCall(() => child.stderr.emit('data',Buffer.from('Debugger listening on ws://127.0.0.1:9999/abcdef\n')));}
  function cdpUrl(u='ws://127.0.0.1:43210/devtools/browser/11111111-2222-3333-4444-555555555555'){
    safeCall(() => child.stderr.emit('data',Buffer.from(`DevTools listening on ${u}\n`)));
  }
  async function evaluateInspect(ok=true, observed={}) {
    inspectUrl();
    sockets[0].onopen();
    const desktop = {
      pid:child.pid, env:launchEnv,
      getBuiltinModule:(id)=>id==='node:module' ? {createRequire:()=>()=>{}} : {close(){}},
    };
    const value = ok ? vm.runInNewContext(sockets[0].request.params.expression,{process:desktop,setTimeout(){}}) : 'ERR:test';
    if (ok) Object.assign(value.telemetry,observed);
    safeCall(() => sockets[0].onmessage({data:JSON.stringify({id:1,result:{result:{value}}})}));
    await tick();
  }
  async function attachCdp() {
    cdpUrl();
    await tick();
  }
  return {
    child,exits,timers,markerFile,lockFile,logFile,spawns,safeCall,
    inspectUrl,cdpUrl,evaluateInspect,attachCdp,launchEnv,launchArgs,
    get hostChild(){return hostChild;},
    get hostStdin(){return hostStdinData;},
    get probes(){return probes;},
  };
}

test('real Electron reads valid ASAR package without launching user application', {skip:!fs.existsSync(electron)},()=>{
 const output=execFileSync(electron,['-e',`console.log(require('node:fs').existsSync('/Applications/T3 Code (Beta).app/Contents/Resources/app.asar/package.json'))`],{env:{...process.env,NODE_OPTIONS:'',ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:10000,cwd:'/tmp'});
 assert.equal(output.trim(),'true');
});

test('exclusive bootstrap.lock blocks second concurrent bootstrap before spawning T3', t => {
 const s = sandbox(t, {
   preLock: { pid: process.pid, lockId: 'other-owner', targetPid: 5555, startedAt: Date.now() },
 });
 assert.deepEqual(s.exits, [1]);
 assert.equal(s.spawns.length, 0, 'must NOT spawn T3 when another live bootstrap holds lock');
 const preserved = JSON.parse(fs.readFileSync(s.lockFile, 'utf8'));
 assert.equal(preserved.lockId, 'other-owner');
});

test('byte-by-byte split CDP listening line spawns host exactly once only after newline with full 36-char UUID', async t => {
 const s = sandbox(t);
 const line = 'DevTools listening on ws://127.0.0.1:43210/devtools/browser/11111111-2222-3333-4444-555555555555\n';
 // Feed every single byte individually; before the final \n, host must NOT spawn!
 for (let i = 0; i < line.length - 1; i++) {
   s.safeCall(() => s.child.stderr.emit('data', Buffer.from(line[i])));
   assert.equal(s.spawns.length, 1, `must not spawn CDP host before newline (byte ${i})`);
 }
 // Feed final newline
 s.safeCall(() => s.child.stderr.emit('data', Buffer.from('\n')));
 await tick();
 assert.equal(s.spawns.length, 2, 'must spawn CDP host exactly once after complete line');
 const cfg = JSON.parse(s.hostStdin);
 assert.equal(cfg.cdpUrl, 'ws://127.0.0.1:43210/devtools/browser/11111111-2222-3333-4444-555555555555');
 assert.deepEqual(s.exits, [0]);
});

test('noisy unbounded stderr stays bounded and truncated non-UUID lines are ignored', async t => {
 const s = sandbox(t);
 // Emit 64KB of noise + a truncated partial UUID line
 s.safeCall(() => s.child.stderr.emit('data', Buffer.from('X'.repeat(40000))));
 s.safeCall(() => s.child.stderr.emit('data', Buffer.from('DevTools listening on ws://127.0.0.1:43210/devtools/browser/11111111-2222\n')));
 assert.equal(s.spawns.length, 1, 'truncated UUID must not trigger CDP host spawn');
 s.safeCall(() => s.child.stderr.emit('data', Buffer.from('noise line\n'.repeat(2000))));
 assert.equal(s.spawns.length, 1);
 await s.attachCdp();
 assert.equal(s.spawns.length, 2);
 assert.deepEqual(s.exits, [0]);
});

test('CDP host early exit and stdin write error fail cleanly and write sanitized bounded 0600 bootstrap.log', async t => {
 // Case 1: early exit before ready
 const s1 = sandbox(t, { healthy: false });
 await s1.attachCdp();
 s1.safeCall(() => s1.hostChild.emit('exit', 1, null));
 assert.deepEqual(s1.exits, [1]);
 assert.equal(fs.existsSync(s1.lockFile), false);
 assert.equal(fs.statSync(s1.logFile).mode & 0o777, 0o600);
 assert.match(fs.readFileSync(s1.logFile, 'utf8'), /cdp_host_early_exit/);

 // Case 2: stdin write error + pre-oversized log gets truncated to bounded size
 const s2 = sandbox(t, { failHostStdin: true });
 fs.writeFileSync(s2.logFile, 'A'.repeat(80 * 1024) + '\n', { mode: 0o600 });
 await s2.attachCdp();
 assert.deepEqual(s2.exits, [1]);
 const st = fs.statSync(s2.logFile);
 assert.equal(st.mode & 0o777, 0o600);
 assert.ok(st.size < 40 * 1024, 'oversized bootstrap.log must be rotated/bounded');
 const content = fs.readFileSync(s2.logFile, 'utf8');
 assert.match(content, /cdp_host_stdin_error/);
 assert.doesNotMatch(content, /11111111-2222|ws:\/\//);
});

test('default CDP bootstrap launches with --remote-debugging-port=0, passes config over stdin, cleans bootstrap.lock, and records observed telemetry', async t => {
 const s = sandbox(t, { env: { T3CODE_TELEMETRY_ENABLED: 'true', T3CODE_OTEL_SDK_DISABLED: 'false', OTEL_SDK_DISABLED: 'false' } });
 assert.deepEqual([...s.launchArgs], ['--remote-debugging-port=0']);
 assert.equal(fs.existsSync(s.lockFile), true, 'bootstrap.lock must exist during cold boot');
 assert.equal(fs.statSync(s.lockFile).mode & 0o777, 0o600);
 const lock = JSON.parse(fs.readFileSync(s.lockFile, 'utf8'));
 assert.equal(lock.pid, process.pid);
 assert.equal(lock.targetPid, s.child.pid);
 assert.equal(s.timers.some(x => x.ms === 20000), true, 'default boot timeout must be 20000ms');

 await s.attachCdp();
 assert.equal(s.spawns.length, 2, 'must spawn detached hud-cdp-host.cjs');
 assert.equal(path.basename(s.spawns[1].args[0]), 'hud-cdp-host.cjs');
 assert.equal(s.spawns[1].args.length, 1, 'cdpUrl must not appear in CLI argv');
 assert.equal(JSON.stringify(s.spawns[1].options.env).includes('devtools/browser'), false, 'cdpUrl must not appear in env');
 const hostCfg = JSON.parse(s.hostStdin);
 assert.equal(hostCfg.pid, s.child.pid);
 assert.match(hostCfg.cdpUrl, /^ws:\/\/127\.0\.0\.1:43210\/devtools\/browser\//);

 assert.ok(s.probes > 0);
 assert.deepEqual(s.exits, [0]);
 assert.equal(fs.existsSync(s.lockFile), false, 'bootstrap.lock must be removed on finish');
 assert.equal(fs.readFileSync(s.markerFile, 'utf8'), String(s.child.pid));
 const receipt = path.join(path.dirname(s.markerFile), 'official-telemetry-launch.json');
 assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), {
   pid: s.child.pid, started: 'test process start', injected: true, observed: true, productOff: true, otelOff: true,
 });
});

test('default CDP bootstrap never fabricates telemetry receipt when env probe returns null', async t => {
 const s = sandbox(t, { observedPs: null });
 await s.attachCdp();
 assert.deepEqual(s.exits, [0]);
 const receipt = path.join(path.dirname(s.markerFile), 'official-telemetry-launch.json');
 assert.equal(fs.existsSync(receipt), false);
});

test('CDP bootstrap timeout honors T3_HUD_BOOT_TIMEOUT_MS, cleans lock, and writes sanitized 0600 diagnostic log', async t => {
 const s = sandbox(t, { healthy: false, env: { T3_HUD_BOOT_TIMEOUT_MS: '15000' } });
 const bootTimer = s.timers.find(x => x.ms === 15000);
 assert.ok(bootTimer, 'custom T3_HUD_BOOT_TIMEOUT_MS must be respected');
 await s.attachCdp();
 s.safeCall(() => bootTimer.fn());
 assert.deepEqual(s.exits, [1]);
 assert.equal(fs.existsSync(s.lockFile), false, 'bootstrap.lock must be cleaned on timeout');
 assert.equal(fs.existsSync(s.markerFile), false);
 assert.equal(fs.existsSync(s.logFile), true);
 assert.equal(fs.statSync(s.logFile).mode & 0o777, 0o600);
 const logText = fs.readFileSync(s.logFile, 'utf8');
 assert.match(logText, /timeout_waiting_for_hud_readiness/);
 assert.doesNotMatch(logText, /ws:\/\/|11111111-2222/);
});

test('CDP bootstrap preserves live instance marker on concurrent launch', async t => {
 const s = sandbox(t, { marker: String(process.pid) });
 await s.attachCdp();
 assert.deepEqual(s.exits, [1]);
 assert.equal(fs.readFileSync(s.markerFile, 'utf8'), String(process.pid));
 assert.equal(fs.existsSync(s.lockFile), false);
});

test('legacy T3_HUD_TRANSPORT=inspect: successful evaluate waits for a live RPC before writing marker',async t=>{
 const s=sandbox(t,{env:{T3_HUD_TRANSPORT:'inspect'}});
 assert.deepEqual([...s.launchArgs],['--inspect=127.0.0.1:0']);
 assert.equal(fs.existsSync(s.markerFile),false); await s.evaluateInspect();
 assert.ok(s.probes>0); assert.deepEqual(s.exits,[0]);assert.equal(fs.readFileSync(s.markerFile,'utf8'),String(s.child.pid));
});

test('legacy inspect sends all opt-out flags to T3 and records only verified launch evidence', async t=>{
 const s=sandbox(t,{env:{T3_HUD_TRANSPORT:'inspect',T3CODE_TELEMETRY_ENABLED:'true',T3CODE_OTEL_SDK_DISABLED:'false',OTEL_SDK_DISABLED:'false',PRIVATE_TEST_FLAG:'secret'}});
 const receipt=path.join(path.dirname(s.markerFile),'official-telemetry-launch.json');
 assert.equal(s.launchEnv.T3CODE_TELEMETRY_ENABLED,'false');
 assert.equal(s.launchEnv.T3CODE_OTEL_SDK_DISABLED,'true');
 assert.equal(s.launchEnv.OTEL_SDK_DISABLED,'true');
 assert.equal(fs.existsSync(receipt),false);
 await s.evaluateInspect();
 assert.deepEqual(JSON.parse(fs.readFileSync(receipt,'utf8')),{pid:s.child.pid,started:'test process start',injected:true,observed:true,productOff:true,otelOff:true});
});

test('observed desktop flags take precedence over the launch intent', async t=>{
 const s=sandbox(t,{env:{T3_HUD_TRANSPORT:'inspect'}});
 await s.evaluateInspect(true,{otelOff:false});
 const receipt=JSON.parse(fs.readFileSync(path.join(path.dirname(s.markerFile),'official-telemetry-launch.json'),'utf8'));
 assert.equal(receipt.otelOff,false);
 assert.deepEqual(s.exits,[0]);
});

test('bootstrap leaves inherited flags alone when telemetry opt-out is off', t=>{
 const s=sandbox(t,{config:{disableOfficialTelemetry:false},env:{T3CODE_TELEMETRY_ENABLED:'false',OTEL_SDK_DISABLED:'false'}});
 assert.equal(s.launchEnv.T3CODE_TELEMETRY_ENABLED,'false');
 assert.equal(s.launchEnv.T3CODE_OTEL_SDK_DISABLED,undefined);
 assert.equal(s.launchEnv.OTEL_SDK_DISABLED,'false');
});

test('custom T3_HUD_DIR writes telemetry launch receipt to the custom run directory', async t=>{
 const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-custom-dir-'));
 t.after(()=>fs.rmSync(customDir,{recursive:true,force:true}));
 const customRunDir = path.join(customDir, 'run');
 fs.mkdirSync(customRunDir, { recursive: true });
 const s = sandbox(t, { env: { T3_HUD_DIR: customDir } });
 await s.attachCdp();
 const defaultReceipt = path.join(path.dirname(s.markerFile), 'official-telemetry-launch.json');
 const customReceipt = path.join(customRunDir, 'official-telemetry-launch.json');
 assert.equal(fs.existsSync(defaultReceipt), false);
 assert.deepEqual(JSON.parse(fs.readFileSync(customReceipt, 'utf8')), {
  pid: s.child.pid, started: 'test process start', injected: true, observed: true, productOff: true, otelOff: true,
 });
 assert.deepEqual(s.exits, [0]);
});

test('evaluate OK with unavailable RPC never reports mounted',async t=>{
 const s=sandbox(t,{healthy:false,env:{T3_HUD_TRANSPORT:'inspect'}});await s.evaluateInspect();assert.ok(s.probes>0);
 assert.equal(fs.existsSync(s.markerFile),false);assert.ok(!s.exits.includes(0));
 s.safeCall(() => s.timers.find(x=>x.ms===20000).fn());assert.deepEqual(s.exits,[1]);
});

test('inspector URL alone times out as failure',t=>{const s=sandbox(t,{env:{T3_HUD_TRANSPORT:'inspect'}});s.inspectUrl();s.safeCall(() => s.timers.find(x=>x.ms===20000).fn());assert.deepEqual(s.exits,[1]);assert.equal(fs.existsSync(s.markerFile),false);});
test('failed concurrent launch preserves existing healthy marker',t=>{const s=sandbox(t,{marker:String(process.pid)});s.safeCall(() => s.child.emit('exit',0));assert.deepEqual(s.exits,[1]);assert.equal(fs.readFileSync(s.markerFile,'utf8'),String(process.pid));});
test('evaluate failure preserves other instance marker',async t=>{const s=sandbox(t,{marker:String(process.pid),env:{T3_HUD_TRANSPORT:'inspect'}});await s.evaluateInspect(false);assert.deepEqual(s.exits,[1]);assert.equal(fs.readFileSync(s.markerFile,'utf8'),String(process.pid));});
test('marker write failure exits nonzero',async t=>{const s=sandbox(t,{failWrite:true});await s.attachCdp();assert.deepEqual(s.exits,[1]);});

async function healthFixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hud-health-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const markerFile=path.join(root,'active.pid'),rpcFile=path.join(root,'rpc.json');fs.writeFileSync(markerFile,String(process.pid));
 let reply={ok:true,pid:process.pid,lastInjectError:null,mounted:true},auth=true;
 const server=http.createServer((req,res)=>{auth=req.headers['x-t3-hud-token']==='fixture-token';res.writeHead(auth?200:403);res.end(JSON.stringify(reply));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const cfg={pid:process.pid,url:`http://127.0.0.1:${server.address().port}`,adminToken:'fixture-token'};
 fs.writeFileSync(rpcFile,JSON.stringify(cfg));
 return {markerFile,rpcFile,cfg,setReply:r=>reply=r};
}
test('health probe requires actual authenticated matching RPC response',async t=>{
 const {checkHud}=require('../src/hud-health.cjs');const f=await healthFixture(t);
 const args={...f,pid:process.pid};assert.equal(await checkHud(args),true);
 f.setReply({ok:true,pid:process.pid,lastInjectError:null,mounted:false});assert.equal(await checkHud(args),false);
 f.setReply({ok:true,pid:process.pid+1});assert.equal(await checkHud(args),false);
 f.setReply({ok:true,pid:process.pid,lastInjectError:'failed'});assert.equal(await checkHud(args),false);
 fs.unlinkSync(f.rpcFile);assert.equal(await checkHud(args),false);
});
test('status shell fails when RPC missing or endpoint is not serving',async t=>{
 const f=await healthFixture(t); const fn=bin.slice(bin.indexOf('rpc_file_for_pid()'),bin.indexOf('\nactivate_t3()'));
 const env={...process.env,T3_BIN:process.execPath,PLUGIN_DIR:path.join(repo,'src'),RUN_DIR:path.dirname(f.rpcFile),MARKER_FILE:f.markerFile,RPC_FILE:f.rpcFile};
 await run('bash',['-c',`${fn}\nis_hud_mounted "$1"`,'fixture',String(process.pid)],{env});
 fs.unlinkSync(f.rpcFile);
 await assert.rejects(run('bash',['-c',`${fn}\nis_hud_mounted "$1"`,'fixture',String(process.pid)],{env}));
 fs.writeFileSync(f.rpcFile,JSON.stringify({...f.cfg,url:'http://127.0.0.1:1'}));
 await assert.rejects(run('bash',['-c',`${fn}\nis_hud_mounted "$1"`,'fixture',String(process.pid)],{env}));
});
test('t3-hud restart fails runtime capability precheck BEFORE quitting existing T3 when RunAsNode=0 and node is incompatible', async t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-restart-precheck-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 const fakeApp = path.join(root, 'T3 Code.app');
 fs.mkdirSync(path.join(fakeApp, 'Contents/MacOS'), { recursive: true });
 fs.writeFileSync(path.join(fakeApp, 'Contents/MacOS/T3 Code'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
 const fwDir = path.join(fakeApp, 'Contents/Frameworks/Electron Framework.framework/Versions/A');
 fs.mkdirSync(fwDir, { recursive: true });
 const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
 fs.writeFileSync(path.join(fwDir, 'Electron Framework'), Buffer.concat([sentinel, Buffer.from([1, 9]), Buffer.from('001000011', 'ascii')]));
 const oldNode = path.join(root, 'old-node');
 fs.writeFileSync(oldNode, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
 const quitMarker = path.join(root, 'quit-called');

 const fnBlock = bin.slice(bin.indexOf('rpc_file_for_pid()'), bin.indexOf('\nactivate_t3()'));
 const caseBlock = bin.slice(bin.indexOf('case "$cmd" in'));
 const script = `set -euo pipefail
cmd=restart
T3_APP='${fakeApp}'
T3_BIN='${path.join(fakeApp, 'Contents/MacOS/T3 Code')}'
T3_HUD_NODE_BIN='${oldNode}'
PLUGIN_DIR='${path.join(repo, 'src')}'
RUN_DIR='${root}'
MARKER_FILE='${path.join(root, 'active.pid')}'
CONFIG_FILE='${path.join(root, 'config.json')}'
get_main_pid(){ echo 99999; }
activate_t3(){ :; }
quit_t3_gracefully(){ touch '${quitMarker}'; }
launch_enhanced(){ touch '${quitMarker}'; }
${fnBlock}
${caseBlock}`;
 await assert.rejects(run('bash', ['-c', script]));
 assert.equal(fs.existsSync(quitMarker), false, 'restart must NOT quit running T3 if runtime capability precheck fails');

 // With capable system node, resolve_node_runtime succeeds even when RunAsNode=0
 const okScript = `set -euo pipefail
T3_APP='${fakeApp}'
T3_BIN='${path.join(fakeApp, 'Contents/MacOS/T3 Code')}'
T3_HUD_NODE_BIN='${process.execPath}'
${fnBlock}
run_node_script -e 'console.log("ok-fallback")'`;
 const res = await run('bash', ['-c', okScript]);
 assert.equal(res.stdout.trim(), 'ok-fallback');
});
test('install.sh JS_RUNNER selects capable system node across RunAsNode=0 and aborts cleanly when no capable node exists', async t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-runner-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 const fakeApp = path.join(root, 'T3 Code.app');
 fs.mkdirSync(path.join(fakeApp, 'Contents/MacOS'), { recursive: true });
 fs.writeFileSync(path.join(fakeApp, 'Contents/MacOS/T3 Code'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
 const fwDir = path.join(fakeApp, 'Contents/Frameworks/Electron Framework.framework/Versions/A');
 fs.mkdirSync(fwDir, { recursive: true });
 const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
 fs.writeFileSync(path.join(fwDir, 'Electron Framework'), Buffer.concat([sentinel, Buffer.from([1, 9]), Buffer.from('001000011', 'ascii')]));
 const oldNode = path.join(root, 'old-node');
 fs.writeFileSync(oldNode, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

 const src = fs.readFileSync(path.join(repo, 'install.sh'), 'utf8');
 const start = src.indexOf('install_electron_run_as_node_disabled()');
 const end = src.indexOf('DEST_DIR=', start);
 assert.ok(start >= 0 && end > start);
 const snippet = src.slice(start, end);

 // With capable system node -> selects system node (JS_RUNNER_USE_RUN_AS_NODE=0)
 const ok = await run('bash', ['-euo', 'pipefail', '-c', `${snippet}\nprintf "%s|%s" "$JS_RUNNER" "$JS_RUNNER_USE_RUN_AS_NODE"`], {
   env: { ...process.env, T3_APP_PATH: fakeApp, T3_HUD_NODE_BIN: process.execPath },
 });
 assert.equal(ok.stdout.trim(), `${process.execPath}|0`);

 // With incapable system node + RunAsNode=0 -> aborts cleanly with non-zero exit
 await assert.rejects(
   run('bash', ['-euo', 'pipefail', '-c', snippet], {
     env: { ...process.env, T3_APP_PATH: fakeApp, T3_HUD_NODE_BIN: oldNode },
   })
 );
});
test('production install snippet replaces symlink without touching its target',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hud-install-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dest=path.join(root,'bin');fs.mkdirSync(dest);const target=path.join(root,'original');fs.writeFileSync(target,'preserve');fs.symlinkSync(target,path.join(dest,'t3-hud'));
 const src=fs.readFileSync(path.join(repo,'install.sh'),'utf8'); const start=src.indexOf('if [[ -L "$BIN_DIR/t3-hud" ]]');const end=src.indexOf('chmod +x "$BIN_DIR/t3-hud"',start);
 assert.ok(start>=0&&end>start);await run('bash',['-e','-c',src.slice(start,end)],{env:{...process.env,BIN_DIR:dest,SCRIPT_DIR:repo}});
 assert.equal(fs.lstatSync(path.join(dest,'t3-hud')).isSymbolicLink(),false);assert.equal(fs.readFileSync(target,'utf8'),'preserve');assert.equal(fs.readFileSync(path.join(dest,'t3-hud'),'utf8'),bin);
});
test('child exit while RPC is pending cannot later publish success',async t=>{
 const s=sandbox(t,{healthy:false});await s.attachCdp();s.safeCall(() => s.child.emit('exit',0));
 for(const h of s.timers.filter(x=>x.ms===100))s.safeCall(() => h.fn());await tick();
 assert.deepEqual(s.exits,[1]);assert.equal(fs.existsSync(s.markerFile),false);
});
test('successful second launch cannot overwrite a live instance marker',async t=>{
 const s=sandbox(t,{marker:String(process.pid)});await s.attachCdp();
 assert.deepEqual(s.exits,[1]);assert.equal(fs.readFileSync(s.markerFile,'utf8'),String(process.pid));
});
test('RPC probe is bounded when an endpoint accepts but never responds',async t=>{
 const {checkHud}=require('../src/hud-health.cjs');const f=await healthFixture(t);
 const server=http.createServer(()=>{});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 fs.writeFileSync(f.rpcFile,JSON.stringify({...f.cfg,url:`http://127.0.0.1:${server.address().port}`}));
 const start=Date.now();assert.equal(await checkHud({...f,pid:process.pid,timeoutMs:60}),false);assert.ok(Date.now()-start<1000);
});
test('normal start preserves an existing unmounted T3 instead of restarting it',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hud-start-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const script=`set -eu\ncmd=start\nget_main_pid(){ echo 123; }\nis_hud_mounted(){ return 1; }\nactivate_t3(){ :; }\nquit_t3_gracefully(){ touch "$FIXTURE_QUIT"; }\nlaunch_enhanced(){ touch "$FIXTURE_QUIT"; }\n${bin.slice(bin.indexOf('case "$cmd" in'))}`;
 await assert.rejects(run('bash',['-c',script],{env:{...process.env,FIXTURE_QUIT:path.join(root,'quit')}}));assert.equal(fs.existsSync(path.join(root,'quit')),false);
});
function hookFixture(t, root, pid, env = {}) {
 const source=fs.readFileSync(path.join(repo,'src/main-hook.cjs'),'utf8');const servers=[];
 let mounted=false,loading=false,delayed=false;
 const win={id:1,isDestroyed:()=>false,getTitle:()=> 'T3 Code',webContents:{isDestroyed:()=>false,isLoading:()=>loading,getURL:()=> 't3code://app/',executeJavaScript:()=>delayed?new Promise(()=>{}):Promise.resolve(mounted)}};
 const app=new EventEmitter();app.whenReady=()=>new Promise(()=>{});
 const factory=vm.runInNewContext(`(function(require,process,__dirname,setTimeout,clearTimeout,setInterval,URL){${source}\nreturn {startLoopbackFallbackServer, ensureSidecarBridge};})`);
 const hooks=factory(id=>{
   if(id==='electron')return {app,BrowserWindow:{getAllWindows:()=>[win]}};
   if(id==='node:os')return {...os,homedir:()=>root};
   if(id==='node:http')return {...http,createServer(...args){const s=http.createServer(...args);servers.push(s);return s;}};
   if(id.endsWith('/backend.cjs'))return {};
   if(id==='./hud-runtime.cjs')return require('../src/hud-runtime.cjs');
   return require(id);
 },{pid,env,versions:{electron:'fixture'},type:'browser',execPath:'/fixture/T3 Code'},path.join(repo,'src'),setTimeout,clearTimeout,setInterval,URL);
 t.after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}});
 return {...hooks,setMounted:x=>mounted=x,setLoading:x=>loading=x,setDelayed:x=>delayed=x};
}
test('main hook publishes RPC into custom T3_HUD_DIR so bootstrap health check succeeds',async t=>{
 const {checkHud}=require('../src/hud-health.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hud-hook-custom-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const customDir=path.join(root,'custom-hud');
 const h=hookFixture(t,root,process.pid,{T3_HUD_DIR:customDir});
 h.setMounted(true);
 await h.startLoopbackFallbackServer();
 const customRpc=path.join(customDir,'run',`rpc-${process.pid}.json`);
 const defaultRpc=path.join(root,'.t3','hud-plugin','run',`rpc-${process.pid}.json`);
 assert.equal(fs.existsSync(defaultRpc),false);
 assert.equal(await checkHud({rpcFile:customRpc,pid:process.pid}),true);
});
test('main hook readiness queries actual window elements; unmounted/loading/unresponsive are false',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hud-hook-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const h=hookFixture(t,root,process.pid);await h.startLoopbackFallbackServer();
 const cfg=JSON.parse(fs.readFileSync(path.join(root,`.t3/hud-plugin/run/rpc-${process.pid}.json`),'utf8'));
 const status=()=>fetch(cfg.url+'/admin/status',{headers:{'X-T3-Hud-Token':cfg.adminToken}}).then(r=>r.json());
 assert.equal((await status()).mounted,false);h.setMounted(true);assert.equal((await status()).mounted,true);
 h.setLoading(true);assert.equal((await status()).mounted,false);h.setLoading(false);h.setDelayed(true);assert.equal((await status()).mounted,false);
});
test('two main hooks publish separate RPC records and preserve existing legacy RPC',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hud-hook-concurrent-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'.t3/hud-plugin/run');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'rpc.json'),'existing legacy record');
 const a=hookFixture(t,root,10101),b=hookFixture(t,root,20202);
 await a.startLoopbackFallbackServer();const before=fs.readFileSync(path.join(dir,'rpc-10101.json'),'utf8');
 await b.startLoopbackFallbackServer();assert.equal(fs.readFileSync(path.join(dir,'rpc-10101.json'),'utf8'),before);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'rpc-20202.json'),'utf8')).pid,20202);
 assert.equal(fs.readFileSync(path.join(dir,'rpc.json'),'utf8'),'existing legacy record');
});

test('get_main_pid ignores Electron helper, script and inline-eval processes but finds the real app', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hud-main-pid-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const fakeBin=path.join(root,'bin');fs.mkdirSync(fakeBin);
 const psOutput=path.join(root,'ps-output.txt');
 const helpers=`1300 ${electron} -e console.log(1)\n1301 ${electron} --eval=console.log(1)\n1302 ${electron} --print console.log(1)\n1303 ${electron} /Users/fixture/project/server.js\n1304 ${electron} /Users/fixture/project/server.cjs\n1305 ${electron} /Users/fixture/project/server.mjs\n1306 ${electron} --type=renderer\n1307 ${electron}X --inspect=9229\n1308 /tmp/launcher ${electron} --inspect=9229\n1309 ${electron} /Users/fixture/.t3/hud-plugin/hub-bridge.cjs\n1310 ${electron} /Users/fixture/.t3/hud-plugin/hud-health.cjs\n1311 ${electron} /Users/fixture/.t3/hud-plugin/hud-cdp-host.cjs\n`;
 fs.writeFileSync(psOutput,helpers+`96619 ${electron} --remote-debugging-port=0\n`);
 const fakePs=path.join(fakeBin,'ps');fs.writeFileSync(fakePs,'#!/bin/sh\ncat "$FIXTURE_PS_OUTPUT"\n',{mode:0o755});
 const functionMatch=bin.match(/get_main_pid\(\) \{[\s\S]*?\n\}/);
 assert.ok(functionMatch,'extract the production get_main_pid shell function');
 const current=functionMatch[0];
 const runFunction=async fn=>{
  const script=`T3_BIN='${electron}'\n${fn}\nget_main_pid`;
  const result=await run('bash',['-c',script],{env:{...process.env,PATH:`${fakeBin}:${process.env.PATH}`,FIXTURE_PS_OUTPUT:psOutput}});
  return result.stdout.trim();
 };
 assert.equal(await runFunction(current),'96619','with the production exclusions, the Electron main process is selected');
 fs.writeFileSync(psOutput,helpers);
 assert.equal(await runFunction(current),'','helper, script, inline-eval and unrelated wrapper processes are not the app main process');
 fs.writeFileSync(psOutput,`96620 ${electron}\n`);
 assert.equal(await runFunction(current),'96620','a normal T3 process without startup flags is still found');
});

test('health rejects symlinks for both marker and RPC even when their contents are valid', async t => {
 const {checkHud} = require('../src/hud-health.cjs');
 const f = await healthFixture(t);
 const args = {...f, pid: process.pid};
 for (const file of [f.markerFile, f.rpcFile]) {
   fs.renameSync(file, file + '.original');
   fs.symlinkSync(file + '.original', file);
   assert.equal(await checkHud(args), false);
   fs.unlinkSync(file);
   fs.renameSync(file + '.original', file);
 }
 assert.equal(await checkHud(args), true);
});

test('inspect hook reuses its own live bridge while the shared record belongs to another instance', async t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-inspect-bridge-'));
 t.after(() => fs.rmSync(root, {recursive: true, force: true}));
 const pluginDir = path.join(root, 'hud-plugin');
 const runDir = path.join(pluginDir, 'run');
 fs.mkdirSync(runDir, {recursive: true});
 const own = {pid: process.ppid, watchPid: process.pid, url: 'http://127.0.0.1:1234', token: 'a'.repeat(64)};
 const ownFile = path.join(runDir, `hub-bridge-${process.pid}.json`);
 const shared = path.join(runDir, 'hub-bridge.json');
 fs.writeFileSync(ownFile, JSON.stringify(own), {mode: 0o600});
 fs.writeFileSync(shared, JSON.stringify({...own, watchPid: process.pid + 1}), {mode: 0o600});
 const hooks = hookFixture(t, root, process.pid, {T3_HUD_DIR: pluginDir});
 assert.deepEqual(await hooks.ensureSidecarBridge(), own);
 fs.renameSync(ownFile, ownFile + '.original');
 fs.symlinkSync(ownFile + '.original', ownFile);
 const fallback = {...own, token: 'b'.repeat(64)};
 fs.writeFileSync(shared, JSON.stringify(fallback), {mode: 0o600});
 assert.deepEqual(await hooks.ensureSidecarBridge(), fallback);
});

test('installer capability preflight preserves SHA-256 of installed files', {skip: process.platform !== 'darwin'}, async t => {
 const { createHash } = require('node:crypto');
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-install-preflight-'));
 t.after(() => fs.rmSync(root, {recursive: true, force: true}));
 const app = path.join(root, 'T3 Code.app');
 const appBin = path.join(app, 'Contents/MacOS/T3 Code');
 const unexpectedProbe = path.join(root, 'electron-probed');
 const framework = path.join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
 fs.mkdirSync(path.dirname(appBin), {recursive: true});
 fs.mkdirSync(path.dirname(framework), {recursive: true});
 fs.writeFileSync(framework, Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 2]), Buffer.from('01')]));
 fs.writeFileSync(appBin, '#!/bin/bash\n: > "$FIXTURE_ELECTRON_PROBE"\nexit 1\n', {mode: 0o700});
 const oldNode = path.join(root, 'no-sqlite-node');
 fs.writeFileSync(oldNode, '#!/bin/bash\nexit 2\n', {mode: 0o700});
 const prior = ['hud-plugin/backend.cjs', 'hud-plugin/renderer-ui.js', 'hud-plugin/hud-release.json', 'bin/t3-hud']
   .map(name => path.join(root, '.t3', name));
 for (const file of prior) {
   fs.mkdirSync(path.dirname(file), {recursive: true});
   fs.writeFileSync(file, 'existing ' + path.basename(file));
 }
 const hashes = () => prior.map(file => createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
 const before = hashes();
 await assert.rejects(run('/bin/bash', [path.join(repo, 'install.sh')], {
   env: {...process.env, HOME: root, T3_APP_PATH: app, T3_HUD_NODE_BIN: oldNode, FIXTURE_ELECTRON_PROBE: unexpectedProbe},
 }), err => err.code === 1 && err.stderr.includes('安装已中止'));
 assert.deepEqual(hashes(), before);
 assert.equal(fs.existsSync(unexpectedProbe), false);
 assert.deepEqual(fs.readdirSync(path.join(root, '.t3')).sort(), ['bin', 'hud-plugin']);
});

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
function sandbox(t, {healthy=true, failWrite=false, marker}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hud-bootstrap-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const runDir=path.join(root,'.t3/hud-plugin/run'); fs.mkdirSync(runDir,{recursive:true});
  const markerFile=path.join(runDir,'active.pid');
  if(marker) fs.writeFileSync(markerFile,marker);
  const child = new EventEmitter(); child.pid=123456789;
  child.stderr=new EventEmitter(); child.stderr.destroy=()=>{}; child.unref=()=>{};
  const timers=[]; const sockets=[]; const exits=[]; let probes=0;
  const mockFs=Object.create(fs);
  mockFs.existsSync=p=>String(p).startsWith('/Applications/') || fs.existsSync(p);
  mockFs.readdirSync=p=>String(p).startsWith('/Applications/') ? ['T3 Code (Beta)'] : fs.readdirSync(p);
  mockFs.writeFileSync=(p,...args)=>{if(failWrite && String(p).startsWith(runDir)) throw new Error('EACCES'); return fs.writeFileSync(p,...args);};
  class Socket { constructor(){sockets.push(this);} send(){} close(){} }
  const context={require(id){
    if(id==='node:fs')return mockFs;
    if(id==='node:os')return {...os,homedir:()=>root};
    if(id==='node:child_process')return {spawn:()=>child};
    if(id==='./hud-health.cjs')return {checkHud:async()=>{probes++;return healthy;}};
    return require(id);
  },__dirname:path.join(repo,'src'),process:{env:{},argv:['node','bootstrap'],pid:process.pid,
    kill(pid){if(pid===child.pid) return; return process.kill(pid,0);},exit:c=>exits.push(c)},
    console:{error(){}},WebSocket:Socket,setTimeout(fn,ms){const h={fn,ms,unref(){}};timers.push(h);return h;},clearTimeout(h){if(h)h.cancelled=true;}};
  vm.runInNewContext(source,context);
  function url(){child.stderr.emit('data',Buffer.from('Debugger listening on ws://127.0.0.1:9999/abcdef\n'));}
  async function evaluate(ok=true){url();sockets[0].onmessage({data:JSON.stringify({id:1,result:{result:{value:ok?'OK':'ERR:test'}}})});await tick();}
  return {child,exits,timers,markerFile,url,evaluate,get probes(){return probes;}};
}
test('real Electron reads valid ASAR package without launching user application', {skip:!fs.existsSync(electron)},()=>{
 const output=execFileSync(electron,['-e',`console.log(require('node:fs').existsSync('/Applications/T3 Code (Beta).app/Contents/Resources/app.asar/package.json'))`],{env:{...process.env,NODE_OPTIONS:'',ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:10000,cwd:'/tmp'});
 assert.equal(output.trim(),'true');
});
test('successful evaluate waits for a live RPC before writing marker',async t=>{
 const s=sandbox(t); assert.equal(fs.existsSync(s.markerFile),false); await s.evaluate();
 assert.ok(s.probes>0); assert.deepEqual(s.exits,[0]);assert.equal(fs.readFileSync(s.markerFile,'utf8'),String(s.child.pid));
});
test('evaluate OK with unavailable RPC never reports mounted',async t=>{
 const s=sandbox(t,{healthy:false});await s.evaluate();assert.ok(s.probes>0);
 assert.equal(fs.existsSync(s.markerFile),false);assert.ok(!s.exits.includes(0));
 s.timers.find(x=>x.ms===10000).fn();assert.deepEqual(s.exits,[1]);
});
test('inspector URL alone times out as failure',t=>{const s=sandbox(t);s.url();s.timers.find(x=>x.ms===10000).fn();assert.deepEqual(s.exits,[1]);assert.equal(fs.existsSync(s.markerFile),false);});
test('failed concurrent launch preserves existing healthy marker',t=>{const s=sandbox(t,{marker:String(process.pid)});s.child.emit('exit',0);assert.deepEqual(s.exits,[1]);assert.equal(fs.readFileSync(s.markerFile,'utf8'),String(process.pid));});
test('evaluate failure preserves other instance marker',async t=>{const s=sandbox(t,{marker:String(process.pid)});await s.evaluate(false);assert.deepEqual(s.exits,[1]);assert.equal(fs.readFileSync(s.markerFile,'utf8'),String(process.pid));});
test('marker write failure exits nonzero',async t=>{const s=sandbox(t,{failWrite:true});await s.evaluate();assert.deepEqual(s.exits,[1]);});
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
test('production install snippet replaces symlink without touching its target',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hud-install-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dest=path.join(root,'bin');fs.mkdirSync(dest);const target=path.join(root,'original');fs.writeFileSync(target,'preserve');fs.symlinkSync(target,path.join(dest,'t3-hud'));
 const src=fs.readFileSync(path.join(repo,'install.sh'),'utf8'); const start=src.indexOf('if [[ -L "$BIN_DIR/t3-hud" ]]');const end=src.indexOf('chmod +x "$BIN_DIR/t3-hud"',start);
 assert.ok(start>=0&&end>start);await run('bash',['-e','-c',src.slice(start,end)],{env:{...process.env,BIN_DIR:dest,SCRIPT_DIR:repo}});
 assert.equal(fs.lstatSync(path.join(dest,'t3-hud')).isSymbolicLink(),false);assert.equal(fs.readFileSync(target,'utf8'),'preserve');assert.equal(fs.readFileSync(path.join(dest,'t3-hud'),'utf8'),bin);
});
test('child exit while RPC is pending cannot later publish success',async t=>{
 const s=sandbox(t,{healthy:false});await s.evaluate();s.child.emit('exit',0);
 for(const h of s.timers.filter(x=>x.ms===100))h.fn();await tick();
 assert.deepEqual(s.exits,[1]);assert.equal(fs.existsSync(s.markerFile),false);
});
test('successful second launch cannot overwrite a live instance marker',async t=>{
 const s=sandbox(t,{marker:String(process.pid)});await s.evaluate();
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
function hookFixture(t, root, pid) {
 const source=fs.readFileSync(path.join(repo,'src/main-hook.cjs'),'utf8');const servers=[];
 let mounted=false,loading=false,delayed=false;
 const win={id:1,isDestroyed:()=>false,getTitle:()=> 'T3 Code',webContents:{isDestroyed:()=>false,isLoading:()=>loading,getURL:()=> 't3code://app/',executeJavaScript:()=>delayed?new Promise(()=>{}):Promise.resolve(mounted)}};
 const app=new EventEmitter();app.whenReady=()=>new Promise(()=>{});
 const factory=vm.runInNewContext(`(function(require,process,__dirname,setTimeout,clearTimeout,setInterval,URL){${source}\nreturn {startLoopbackFallbackServer};})`);
 const hooks=factory(id=>{
   if(id==='electron')return {app,BrowserWindow:{getAllWindows:()=>[win]}};
   if(id==='node:os')return {...os,homedir:()=>root};
   if(id==='node:http')return {...http,createServer(...args){const s=http.createServer(...args);servers.push(s);return s;}};
   if(id.endsWith('/backend.cjs'))return {};
   return require(id);
 },{pid,versions:{electron:'fixture'},type:'browser',execPath:'/fixture/T3 Code'},path.join(repo,'src'),setTimeout,clearTimeout,setInterval,URL);
 t.after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}});
 return {...hooks,setMounted:x=>mounted=x,setLoading:x=>loading=x,setDelayed:x=>delayed=x};
}
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
 const helpers=`1300 ${electron} -e console.log(1)\n1301 ${electron} --eval=console.log(1)\n1302 ${electron} --print console.log(1)\n1303 ${electron} /Users/fixture/project/server.js\n1304 ${electron} /Users/fixture/project/server.cjs\n1305 ${electron} /Users/fixture/project/server.mjs\n1306 ${electron} --type=renderer\n1307 ${electron}X --inspect=9229\n1308 /tmp/launcher ${electron} --inspect=9229\n1309 ${electron} /Users/fixture/.t3/hud-plugin/hub-bridge.cjs\n1310 ${electron} /Users/fixture/.t3/hud-plugin/hud-health.cjs\n`;
 fs.writeFileSync(psOutput,helpers+`96619 ${electron} --inspect=127.0.0.1:9229\n`);
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

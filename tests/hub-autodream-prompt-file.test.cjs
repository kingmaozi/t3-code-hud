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
  fs.writeFileSync=function(file,...rest){if(typeof file==='number')throw new Error('injected-write-error');return write.call(this,file,...rest)};
  try {await assert.rejects(cli(f,"sensitive"),/injected-write-error/);}
  finally {fs.writeFileSync=write;}
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

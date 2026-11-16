"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createMemoryVault } = require("../src/memory-vault.cjs");

function fixture(t, stderr, stdout = "", exit = 1) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dream-diagnostic-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bin = path.join(base, "bin"), homeDir = path.join(base, "home"), hubDir = path.join(base, "hub"), vaultDir = path.join(base, "vault"), projectRoot = path.join(base, "project");
  for (const d of [bin, homeDir, hubDir, vaultDir, projectRoot]) fs.mkdirSync(d, { recursive: true });
  const fake = path.join(bin, "muse");
  fs.writeFileSync(fake, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(stderr)});process.stdout.write(${JSON.stringify(stdout)});process.exitCode=${exit};\n`, { mode: 0o755 });
  const vault = createMemoryVault({ homeDir, hubDir, vaultDir, _dreamPath: bin, _dreamPromptTempRoot: base, _embedFn: () => null, _healthFn: () => ({modelId:"test",dim:2}) });
  return { base, bin, hubDir, vaultDir, projectRoot, fake, vault };
}
function seedGray(f) {
  const ids = [["alpha", "w1 w2 w3 w4 w5 w6 w7 w8 x9 x10 x11 x12"], ["beta", "w1 w2 w3 w4 w5 w6 w7 w8 y9 y10 y11 y12"]].map(([title, content]) => {
    const r = f.vault.saveMemory({projectRoot:f.projectRoot,module:"topics",title,content,autoEvolve:false}); assert.equal(r.ok,true); return r.item.id;
  });
  const db=new DatabaseSync(path.join(f.vaultDir,"index.sqlite"));
  try {const stmt=db.prepare("INSERT OR REPLACE INTO memory_vectors(id,model_id,dim,vec_f32,updated_at) VALUES(?,?,?,?,?)");
    stmt.run(ids[0],"test",2,Buffer.from(new Float32Array([1,0]).buffer),new Date().toISOString());
    stmt.run(ids[1],"test",2,Buffer.from(new Float32Array([0.8,0.6]).buffer),new Date().toISOString());
  } finally {db.close();}
}
async function runFake(f) { try {await f.vault.runDreamAgentCli({cmd:f.fake,args:[],prompt:"",timeoutMs:5000}); assert.fail("expected failure");} catch(e) { return e; } }

for (const [description,stderr,expected] of [
  ["HTTP 401", "HTTP/1.1 401 Unauthorized", {category:"http",httpStatus:401}],
  ["HTTP 403", "request failed: HTTP 403", {category:"http",httpStatus:403}],
  ["HTTP 404", '{"statusCode":404}', {category:"http",httpStatus:404}],
  ["HTTP 408", "HTTP 408 request timeout", {category:"http",httpStatus:408}],
  ["HTTP 409", "HTTP 409 conflict", {category:"http",httpStatus:409}],
  ["HTTP 429", "response status: 429", {category:"http",httpStatus:429}],
  ["HTTP 502", "HTTP/1.0 502 Bad Gateway", {category:"http",httpStatus:502}],
  ["HTTP 599", "status_code=599", {category:"http",httpStatus:599}],
  ["authentication", "missing credentials: please sign in", {category:"authentication"}],
  ["model", "model not found", {category:"model"}],
  ["arguments", "error: unexpected argument --bad", {category:"arguments"}],
  ["DNS", "getaddrinfo ENOTFOUND fake.invalid", {category:"dns"}],
  ["TLS", "TLS certificate verification failed", {category:"tls"}],
  ["network", "transport error: connection failed", {category:"network"}],
  ["unknown", "error at https://fake.invalid/429, trace 502 api_key=FAKE_SECRET", {category:"unknown"}],
]) {
  test(`safe classification: ${description}`,async t=>{
    const f=fixture(t,stderr);const error=await runFake(f);
    assert.equal(error.message,"cli-exit-1");
    assert.deepEqual(error.diagnostic,expected);
    assert.ok(!JSON.stringify(error.diagnostic).includes("FAKE_SECRET"));
  });
}

test("conflicting explicit HTTP codes are not collapsed into a guessed code",async t=>{
  const f=fixture(t,"HTTP 429 then HTTP 503");const error=await runFake(f);
  assert.deepEqual(error.diagnostic,{category:"http"});
});

test("stdout may carry explicit diagnosis when stderr is empty",async t=>{
  const f=fixture(t,"","HTTP/2 503 Service Unavailable");const error=await runFake(f);
  assert.deepEqual(error.diagnostic,{category:"http",httpStatus:503});
});

test("real runner reports a code found after the first 500 bytes without leaking raw output",async t=>{
  const raw="x".repeat(9000)+"\nHTTP/1.1 429 Too Many Requests https://fake.invalid/private?access_token=FAKE_SECRET";
  const f=fixture(t,raw);seedGray(f);
  f.vault.updateDreamConfig({dreamMode:"agent",providerInstanceId:"muse",model:"muse-ember-1.0",minDeltaMemories:1});
  const result=await f.vault.runDreamCycle({force:true,projectRoot:f.projectRoot});
  assert.equal(result.ok,false);assert.equal(result.status,"partial");assert.equal(result.report.local.status,"success");
  assert.equal(result.report.agent.error,"cli-exit-1");assert.deepEqual(result.report.agent.diagnostic,{category:"http",httpStatus:429});
  assert.equal(result.config.hasDeferredClusters,true);
  const state=f.vault.getDreamOverview(), serialized=JSON.stringify({result,state});
  assert.ok(!serialized.includes("FAKE_SECRET"));assert.ok(!serialized.includes("fake.invalid"));assert.ok(!serialized.includes("x".repeat(500)));
  const journal=fs.readFileSync(path.join(f.hubDir,"dream-journal.json"),"utf8");
  assert.ok(!journal.includes("FAKE_SECRET")&&!journal.includes("fake.invalid"));
});

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
  ["HTTP 429", "HTTP status: 429", {category:"http",httpStatus:429}],
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

test("defect-1: injected diagnostic is sanitized before report and journal persistence",async t=>{
  const f=fixture(t,"unused");seedGray(f);
  f.vault.updateDreamConfig({dreamMode:"agent",providerInstanceId:"muse",model:"muse-ember-1.0",minDeltaMemories:1});
  const evil=()=>{const e=new Error("boom");e.diagnostic={category:"unknown",stderr:"api_key=FAKE_SECRET",httpStatus:999,extra:"leak"};throw e;};
  const result=await f.vault.runDreamCycle({force:true,projectRoot:f.projectRoot,agentRunner:evil});
  assert.equal(result.report.agent.status,"failed");
  assert.deepEqual(result.report.agent.diagnostic,{category:"unknown"});
  const serialized=JSON.stringify(result);
  assert.ok(!serialized.includes("FAKE_SECRET"));
  assert.ok(!serialized.includes("leak"));
  const journal=fs.readFileSync(path.join(f.hubDir,"dream-journal.json"),"utf8");
  assert.ok(!journal.includes("FAKE_SECRET")&&!journal.includes("leak"));
  const f2=fixture(t,"unused");seedGray(f2);
  f2.vault.updateDreamConfig({dreamMode:"agent",providerInstanceId:"muse",model:"muse-ember-1.0",minDeltaMemories:1});
  const evilHttp=()=>{const e=new Error("boom");e.diagnostic={category:"http",httpStatus:999,stderr:"api_key=FAKE_SECRET"};throw e;};
  const result2=await f2.vault.runDreamCycle({force:true,projectRoot:f2.projectRoot,agentRunner:evilHttp});
  assert.deepEqual(result2.report.agent.diagnostic,{category:"http"});
  assert.ok(!JSON.stringify(result2).includes("FAKE_SECRET"));
  const f3=fixture(t,"unused");seedGray(f3);
  f3.vault.updateDreamConfig({dreamMode:"agent",providerInstanceId:"muse",model:"muse-ember-1.0",minDeltaMemories:1});
  const evilBadCat=()=>{const e=new Error("boom");e.diagnostic={category:"bogus",httpStatus:429};throw e;};
  const result3=await f3.vault.runDreamCycle({force:true,projectRoot:f3.projectRoot,agentRunner:evilBadCat});
  assert.deepEqual(result3.report.agent.diagnostic,{category:"unknown"});
});

test("defect-4: non-HTTP statuses and plain TLS config are not misclassified",async t=>{
  const f=fixture(t,"");
  assert.deepEqual(f.vault.classifyDreamDiagnostic("", "process exited with status 127"),{category:"unknown"});
  assert.deepEqual(f.vault.extractDreamHttpStatuses('{"userStatus":429}'),[]);
  assert.deepEqual(f.vault.classifyDreamDiagnostic('{"userStatus":429}',""),{category:"unknown"});
  assert.deepEqual(f.vault.extractDreamHttpStatuses('{"exitStatus":500}'),[]);
  assert.deepEqual(f.vault.extractDreamHttpStatuses('{"substatus":502}'),[]);
  assert.deepEqual(f.vault.extractDreamHttpStatuses("exit status 500"),[]);
  assert.deepEqual(f.vault.classifyDreamDiagnostic("", "TLS enabled; model failed to start"),{category:"unknown"});
  assert.deepEqual(f.vault.classifyDreamDiagnostic("", "using TLS 1.3 for transport"),{category:"unknown"});
  assert.deepEqual(f.vault.extractDreamHttpStatuses("HTTP/1.1 429"),[429]);
  assert.deepEqual(f.vault.extractDreamHttpStatuses('{"httpStatus":429}'),[429]);
  assert.deepEqual(f.vault.extractDreamHttpStatuses('{"statusCode":503}'),[503]);
  assert.deepEqual(f.vault.extractDreamHttpStatuses("status_code=502"),[502]);
  assert.deepEqual(f.vault.classifyDreamDiagnostic("", "TLS handshake failed"),{category:"tls"});
  assert.deepEqual(f.vault.classifyDreamDiagnostic("", "TLS certificate verification failed"),{category:"tls"});
});

test("defect-5: diagnostic sees middle codes and never fabricates head-tail codes",async t=>{
  const f=fixture(t,"");
  const middle="x ".repeat(2500)+"HTTP/1.1 502 Bad Gateway "+"y ".repeat(5000)+"HTTP/1.1 429 Too Many";
  assert.deepEqual(f.vault.classifyDreamDiagnostic("",middle),{category:"http"});
  const strad="x".repeat(4088)+" HTTP/1.1 502 "+"y".repeat(10000);
  assert.deepEqual(f.vault.classifyDreamDiagnostic("",strad),{category:"http",httpStatus:502});
  const head="a".repeat(4086)+" HTTP/1.1 ";
  const fab=head+"m".repeat(2000)+"502 "+"b".repeat(8188);
  assert.deepEqual(f.vault.extractDreamHttpStatuses(fab),[]);
  assert.deepEqual(f.vault.classifyDreamDiagnostic("",fab),{category:"unknown"});
});

test("defect-6: output overflow still captures queued stderr diagnostic",async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"dream-overflow-"));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const bin=path.join(base,"bin"),homeDir=path.join(base,"home"),hubDir=path.join(base,"hub"),vaultDir=path.join(base,"vault");
  for(const d of [bin,homeDir,hubDir,vaultDir]) fs.mkdirSync(d,{recursive:true});
  const fake=path.join(bin,"muse");
  fs.writeFileSync(fake,`#!${process.execPath}\nconst fs=require('node:fs');fs.writeSync(1,'X'.repeat(5000));fs.writeSync(2,'HTTP/1.1 502 Bad Gateway');setTimeout(()=>{process.exit(1)},100);\n`,{mode:0o755});
  const vault=createMemoryVault({homeDir,hubDir,vaultDir,_dreamPath:bin,_embedFn:()=>null,_healthFn:()=>({modelId:"test",dim:2})});
  const err=await vault.runDreamAgentCli({cmd:fake,args:[],prompt:"",timeoutMs:5000,maxOutputBytes:32}).catch((e)=>e);
  assert.equal(err.message,"cli-output-overflow");
  assert.deepEqual(err.diagnostic,{category:"http",httpStatus:502});
});

test("review-2: long whitespace cannot block either direct or CLI diagnostics", t => {
  const f = fixture(t, "HTTP" + " ".repeat(50000));
  // Isolate the old pathological regexp: a blocked event loop cannot enforce
  // its own timeout. The parent kills only this synthetic test process.
  const script = `
    const assert = require('node:assert/strict');
    const {EventEmitter}=require('node:events');
    const child=new EventEmitter();
    child.stdout=new EventEmitter(); child.stderr=new EventEmitter();
    child.stdin=new EventEmitter(); child.stdin.end=child.stdin.destroy=()=>{};
    child.stdout.destroy=child.stderr.destroy=()=>{};
    child.kill=()=>{setImmediate(()=>{child.emit('exit',null,'SIGTERM');child.emit('close',null,'SIGTERM')});return true;};
    require('node:child_process').spawn=()=>{
      setImmediate(()=>child.stderr.emit('data',Buffer.from('HTTP'+' '.repeat(50000))));
      return child;
    };
    const {createMemoryVault} = require(${JSON.stringify(require.resolve('../src/memory-vault.cjs'))});
    const vault = createMemoryVault(${JSON.stringify({homeDir:path.join(f.base,'home'),hubDir:f.hubDir,vaultDir:f.vaultDir})});
    const start = performance.now();
    assert.deepEqual(vault.extractDreamHttpStatuses('HTTP'+' '.repeat(50000)), []);
    assert.ok(performance.now()-start < 100,'bounded direct scan must be fast');
    vault.runDreamAgentCli({cmd:${JSON.stringify(f.fake)},timeoutMs:100,maxOutputBytes:32}).then(
      () => {throw new Error('expected failure')},
      error => {assert.equal(error.message,'cli-output-overflow');assert.ok(performance.now()-start < 500);}
    ).catch(e=>{console.error(e);process.exitCode=1});
  `;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', script], {timeout:1500, encoding:'utf8'});
  assert.equal(result.error, undefined, 'diagnostic scan exceeded the parent hard deadline');
  assert.equal(result.status, 0, result.stderr);
});

for (const [label, chunks] of [
  ['split numeric suffix', ['HTTP 429', '0\n']],
  ['split compound key', ['{"user', 'Status":429}\n']],
  ['compound key at former overlap edge', ['x'.repeat(4000)+'{"user', 'Status":429}\n']],
  ['compound key after long line', ['x'.repeat(9000)+'{"user', 'Status":429}\n']],
  ['long token at a segment edge', ['x'.repeat(8190)+'user', 'Status":429}\n']],
  ['compound key truncated at former overlap', ['{"userStatus":'+' '.repeat(248), '429}\n']],
]) {
  test(`review-3: delayed streaming rejects ${label}`, t => {
    const {vault} = fixture(t, '');
    const acc = vault.createDreamDiagAccumulator();
    acc.feed(chunks[0]); acc.feed(chunks[1]);
    assert.deepEqual([...acc.finish().codes], []);
  });
}

test('review-3: UTF-8 decoding survives every byte boundary and flush is idempotent', t => {
  const {vault} = fixture(t, '');
  const bytes = Buffer.from('中🙂 HTTP/2 503\r\n{"httpStatus":429}');
  for (let i=1; i<bytes.length; i++) {
    const acc = vault.createDreamDiagAccumulator();
    acc.feed(bytes.subarray(0,i)); acc.feed(bytes.subarray(i));
    assert.deepEqual([...acc.finish().codes].sort(), [429,503]);
    assert.deepEqual([...acc.finish().codes].sort(), [429,503]);
  }
});

test('review-4: only independent HTTP protocol/status keys are accepted', t => {
  const {vault} = fixture(t, '');
  for (const text of ['{"user-status":429}', '{"exit-status":500}', '{"sub_status":502}',
    '{"userStatus":429}', '{"status":429}', 'response status: 429', 'http-status=429',
    'xHTTP 429', '/HTTP/1.1 429', 'exit-HTTP 429', 'HTTP 4290', 'HTTP 429.0',
    'user-httpStatus=429', 'xstatusCode=429', '"prefix statusCode":429', '"statusCode\'=429']) {
    assert.deepEqual(vault.extractDreamHttpStatuses(text), [], text);
    assert.deepEqual(vault.classifyDreamDiagnostic('',text), {category:'unknown'}, text);
  }
  for (const text of ['HTTP/1.0 429', 'HTTP/1.1 429', 'HTTP/2.0 429', 'HTTP/3 429',
    'HTTP status code: 429', 'HTTP error=429', 'HTTP\t429', '"httpStatus":429',
    "'http_status'=429", 'statusCode=429', 'status_code:429']) {
    assert.deepEqual(vault.extractDreamHttpStatuses(text), [429], text);
  }
});

test('review-5: successful DNS and TLS messages never imply a failure', t => {
  const {vault} = fixture(t, '');
  for (const text of ['DNS resolution succeeded; model failed to start', 'TLS handshake completed',
    'SSL handshake succeeded; unrelated task failed', 'getaddrinfo succeeded', 'certificate loaded; model failed']) {
    assert.deepEqual(vault.classifyDreamDiagnostic('', text), {category:'unknown'}, text);
  }
  for (const text of ['EAI_FAIL','EAI_NONAME','SERVFAIL','NXDOMAIN','getaddrinfo failed',
    'DNS lookup failed','DNS resolution timed out']) {
    assert.deepEqual(vault.classifyDreamDiagnostic('', text), {category:'dns'}, text);
  }
  for (const text of ['ERR_TLS_CERT_123','ERR_CERT_AUTHORITY_INVALID','SELF_SIGNED_CERT_IN_CHAIN',
    'x509: certificate expired','certificate verify failed','TLS handshake aborted','SSL handshake timed out']) {
    assert.deepEqual(vault.classifyDreamDiagnostic('', text), {category:'tls'}, text);
  }
});

for (const type of ['string','buffer']) {
  test(`review-7: four MiB scan budget counts UTF-8 bytes for ${type}`, t => {
    const {vault} = fixture(t, '');
    const acc = vault.createDreamDiagAccumulator(), budget = 4*1024*1024;
    const feed = text => acc.feed(type==='buffer' ? Buffer.from(text) : text);
    const padding = '中'.repeat(Math.floor(budget/3));
    feed(padding); feed('中\nHTTP 429\n');
    assert.deepEqual([...acc.finish().codes], []);
    assert.deepEqual(vault.classifyDreamDiagnostic('', type==='buffer' ? Buffer.from(padding+'中\nHTTP 429') : padding+'中\nHTTP 429'), {category:'unknown'});
  });
}

test('review-7: artificial byte cutoff never completes a truncated HTTP token', t => {
  const {vault} = fixture(t, ''), budget = 4*1024*1024;
  const prefix = 'x'.repeat(budget-9)+' HTTP 429';
  assert.deepEqual(vault.classifyDreamDiagnostic('', prefix+'0\n'), {category:'unknown'});
});

for (const type of ['string', 'buffer']) {
  test(`review-16 defect-3: four MiB cutoff masks unfinished relative paths and queries (${type})`, t => {
    const {vault} = fixture(t, ''), budget = 4 * 1024 * 1024;
    const classify = text => vault.classifyDreamDiagnostic('', type === 'buffer' ? Buffer.from(text) : text);
    for (const fragment of ['./api/v1/items,statusCode=429;', '../api/v1/items,statusCode=429;', '/api/v1/items,statusCode=429;', '?key=statusCode=429;']) {
      const prefix = 'x'.repeat(budget - fragment.length - 1) + ' ' + fragment;
      assert.equal(Buffer.byteLength(prefix), budget);
      assert.deepEqual(classify(prefix + '?x=1'), {category:'unknown'}, fragment);
      const acc = vault.createDreamDiagAccumulator();
      acc.feed(type === 'buffer' ? Buffer.from(prefix) : prefix);
      acc.feed(type === 'buffer' ? Buffer.from('?x=1') : '?x=1');
      assert.deepEqual([...acc.finish().codes], [], 'stream cutoff: ' + fragment);
    }
    // A completed earlier line must survive masking of the final partial line.
    const fragment = './api/v1/items,statusCode=429;';
    assert.deepEqual(classify('HTTP 503\n' + 'x'.repeat(budget - 10 - fragment.length) + ' ' + fragment + '?x=1'), {category:'http', httpStatus:503});
  });
}

test('review-3: long-line segmentation preserves real boundaries and diagnoses across every edge', t => {
  const {vault} = fixture(t, '');
  for (let offset=7900; offset<=8300; offset++) {
    const prefix='x'.repeat(offset)+' ';
    const good=prefix+'HTTP/1.1 429 '+'y'.repeat(10000)+' HTTP 503';
    assert.deepEqual(vault.classifyDreamDiagnostic('',good),{category:'http'},String(offset));
    const bad=prefix+'{"userhttpStatus":429} HTTP 4290 '+'y'.repeat(10000);
    assert.deepEqual(vault.classifyDreamDiagnostic('',bad),{category:'unknown'},String(offset));
  }
});

for (const type of ['string', 'buffer']) {
  test(`review-8 defect-3: truncated long ${type} retains only genuinely delimited statuses`, t => {
    const {vault} = fixture(t, ''), budget = 4 * 1024 * 1024;
    const classify = text => vault.classifyDreamDiagnostic('', type === 'buffer' ? Buffer.from(text) : text);
    assert.deepEqual(classify('x'.repeat(budget - 1000) + ' HTTP 429 ' + 'x'.repeat(1010)), {category:'http', httpStatus:429});
    assert.deepEqual(classify('x'.repeat(budget - 9) + ' HTTP 4290'), {category:'unknown'});
    for (const suffix of ['e-1', '.7', 'ms', '中', '𝒜']) {
      assert.deepEqual(classify('x'.repeat(budget - 9) + ' HTTP 429' + suffix), {category:'unknown'}, suffix);
    }
    assert.deepEqual(classify('x'.repeat(budget - 1000) + ' HTTP 429. Retrying ' + '中'.repeat(1010)), {category:'http', httpStatus:429});
  });
}

for (const [text, category] of [
  ['x509: certificate verified successfully', 'unknown'],
  ['SSL routines initialized successfully', 'unknown'],
  ['x509: certificate loaded', 'unknown'],
  ['SSL routines:ssl3_read_bytes:initialized successfully', 'unknown'],
  ['x509: certificate signed by unknown authority', 'tls'],
  ['x509: certificate has expired or is not yet valid', 'tls'],
  ['x509: certificate is not valid for any names', 'tls'],
  ['x509: certificate rely on legacy Common Name field', 'tls'],
  ['SSL routines:tls_process_server_certificate:certificate verify failed', 'tls'],
  ['SSL routines:ssl3_get_record:wrong version number', 'tls'],
  ['SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca', 'tls'],
  ['SSL routines::unexpected eof while reading', 'tls'],
  ['SSL routines:SSL_connect:handshake failure', 'tls'],
  ['SSL routines:ssl3_read_bytes:sslv3 alert handshake failure', 'tls'],
  ['SSL routines:ssl3_get_record:decryption failed', 'tls'],
  ['SSL routines:ssl3_get_record:bad record mac', 'tls'],
  ['ERR_CERT_AUTHORITY_INVALID', 'tls'],
  ['TLS handshake failed', 'tls'],
]) {
  test(`review-8 defect-4: TLS requires failure semantics: ${text}`, t => {
    const {vault} = fixture(t, '');
    assert.deepEqual(vault.classifyDreamDiagnostic('', text), {category});
  });
}

test('review-8 defect-5: Unicode compound names and URL parameters cannot pose as HTTP fields', t => {
  const {vault} = fixture(t, '');
  const forms = ['HTTP/1.1 429', 'HTTP 429', 'HTTP status: 429', 'HTTP error=429',
    'statusCode=429', 'httpStatus=429', '"statusCode":429', "'http_status'=429"];
  for (const prefix of ['用户', '𝒜', '١', '?', '&', '/', '=', '.', '-', '$', "'", '"', '_']) {
    for (const form of forms) {
      assert.deepEqual(vault.extractDreamHttpStatuses(prefix + form), [], prefix + form);
    }
  }
  for (const text of ['https://example.invalid/?statusCode=429', '?x=1&httpStatus=502',
    'https://example.invalid/?"statusCode":429', '用户"statusCode":429']) {
    assert.deepEqual(vault.classifyDreamDiagnostic('', text), {category:'unknown'}, text);
  }
  for (const form of forms) assert.deepEqual(vault.extractDreamHttpStatuses('错误: ' + form), [429], form);
  assert.deepEqual(vault.extractDreamHttpStatuses('{"statusCode":429,"httpStatus":502}'), [429,502]);
});

test('review-8 defect-6: HTTP values require complete numeric boundaries', t => {
  const {vault} = fixture(t, '');
  const forms = ['HTTP/1.1 429', 'HTTP 429', 'HTTP status code: 429', 'HTTP error=429',
    'statusCode=429', 'http_status:429', '"statusCode":429', "'httpStatus'=429"];
  for (const suffix of ['e-1', 'E+2', '.7', '0', 'ms', '_retry', '中', '𝒜', '١']) {
    for (const form of forms) assert.deepEqual(vault.extractDreamHttpStatuses(form + suffix), [], form + suffix);
  }
  for (const text of ['{"statusCode":429e-1}', '{"httpStatus":429.7}']) {
    assert.deepEqual(vault.classifyDreamDiagnostic('', text), {category:'unknown'}, text);
  }
  for (const form of forms) assert.deepEqual(vault.extractDreamHttpStatuses(form + ' '), [429], form);
  for (const text of ['HTTP 502. Retrying', 'HTTP/1.1 502. Retrying', 'HTTP error=502.', 'statusCode=502. Retrying', 'statusCode=502.', '"httpStatus": 502. Next']) {
    assert.deepEqual(vault.extractDreamHttpStatuses(text), [502], text);
  }
  for (const text of ['statusCode=502.7', 'statusCode=502.0', 'statusCode=502.ms', 'statusCode=502.\u0301']) {
    assert.deepEqual(vault.extractDreamHttpStatuses(text), [], text);
  }
});

test('review-8 defects-3/5/6: segment edges preserve Unicode and numeric token boundaries', t => {
  const {vault} = fixture(t, '');
  for (let offset = 8050; offset <= 8210; offset++) {
    for (const token of ['用户statusCode=429', '𝒜statusCode=429', '?statusCode=429', 'HTTP 429e-1', 'HTTP 429.7']) {
      const acc = vault.createDreamDiagAccumulator();
      const bytes = Buffer.from('x'.repeat(offset) + ' ' + token + ' ' + 'x'.repeat(9000));
      for (let i = 0; i < bytes.length; i += 127) acc.feed(bytes.subarray(i, i + 127));
      assert.deepEqual([...acc.finish().codes], [], `${offset}: ${token}`);
    }
  }
});

test('review-9 defect-2: URL query strings with semicolons, parens, or nested params never trigger HTTP status', t => {
  const {vault} = fixture(t, '');
  for (const text of [
    'https://example.invalid/?x=1;statusCode=429',
    'https://example.invalid/?x=(statusCode=429)',
    'https://example.invalid/api?filter=(httpStatus=503)&next=1',
    'https://example.invalid/path#section;statusCode=500',
    'GET /v1/items?x=1;statusCode=429',
    'GET /v1/items?x=(statusCode=429)',
    '?x=(statusCode=429)',
    '{"url":"https://example.invalid/?x=(statusCode=429)","ok":true}',
    'https://example.invalid/?pad=' + 'a'.repeat(10000) + '&x=(statusCode=429)',
    '{"url":"https://example.invalid/?pad=' + 'a'.repeat(10000) + ';statusCode=429","ok":true}',
  ]) {
    assert.deepEqual(vault.classifyDreamDiagnostic('', text), {category:'unknown'}, text.slice(0, 80));
  }
  assert.deepEqual(vault.classifyDreamDiagnostic('', 'Request to https://example.invalid/?x=1 failed (statusCode=429)'), {category:'http', httpStatus:429});
  assert.deepEqual(vault.classifyDreamDiagnostic('', '{"url":"https://example.invalid/?x=(statusCode=429)","statusCode":503}'), {category:'http', httpStatus:503});
  assert.deepEqual(vault.classifyDreamDiagnostic('', '{"url":"https://example.invalid/?pad=' + 'a'.repeat(10000) + '&x=(statusCode=429)","statusCode":503}'), {category:'http', httpStatus:503});
});

test('review-9 defect-3: decomposed Unicode combining marks preserve compound identifier boundaries across segment edges', t => {
  const {vault} = fixture(t, '');
  for (const prefix of ['cafe\u0301', 'a\u0300\u0301', 'n\u0303', 'e\u20DD']) {
    for (const form of ['statusCode=429', 'httpStatus=429', 'HTTP 429', '"statusCode":429']) {
      assert.deepEqual(vault.classifyDreamDiagnostic('', prefix + form), {category:'unknown'}, prefix + form);
    }
  }
  for (const suffix of ['\u0301', 'a\u0301']) {
    assert.deepEqual(vault.classifyDreamDiagnostic('', 'statusCode=429' + suffix), {category:'unknown'}, suffix);
    assert.deepEqual(vault.classifyDreamDiagnostic('', 'HTTP 429' + suffix), {category:'unknown'}, suffix);
  }
  for (let offset = 8050; offset <= 8210; offset += 7) {
    for (const token of ['cafe\u0301statusCode=429', 'https://example.invalid/?x=1;statusCode=429', 'https://example.invalid/?x=(statusCode=429)']) {
      const acc = vault.createDreamDiagAccumulator();
      const bytes = Buffer.from('x'.repeat(offset) + ' ' + token + ' ' + 'x'.repeat(9000), 'utf8');
      for (let i = 0; i < bytes.length; i += 97) acc.feed(bytes.subarray(i, i + 97));
      assert.deepEqual([...acc.finish().codes], [], `${offset}: ${token}`);
    }
  }
});

test('review-9 defect-4: x509 legacy Common Name (relies) and hostname mismatch classify as tls without false positives', t => {
  const {vault} = fixture(t, '');
  for (const [text, category] of [
    ['x509: certificate relies on legacy Common Name field, use SANs instead', 'tls'],
    ['x509: certificate is valid for example.com, not api.example.com', 'tls'],
    ['x509: certificate is valid for *.example.com, example.com, not api.other.com', 'tls'],
    ['Hostname/IP does not match certificate\'s altnames: Host: api.example.com. is not in the cert\'s altnames', 'tls'],
    ['x509: certificate is valid for example.com', 'unknown'],
    ['certificate is valid for 30 days', 'unknown'],
  ]) {
    assert.deepEqual(vault.classifyDreamDiagnostic('', text), {category}, text);
  }
});

test('review-10 defect-3: overlong relative URLs and standalone query keys never leak embedded HTTP status codes', t => {
  const {vault} = fixture(t, '');
  for (const n of [512, 513, 2048, 10000]) {
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', 'GET /' + 'a'.repeat(n) + '?x=(v,statusCode=429)'),
      {category: 'unknown'},
      `relative URL path length ${n}`
    );
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', '{"path":"/' + 'a'.repeat(n) + '?statusCode=503"}'),
      {category: 'unknown'},
      `quoted relative URL path length ${n}`
    );
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', 'GET /' + 'a'.repeat(n) + ' HTTP/1.1 429'),
      {category: 'http', httpStatus: 429},
      `plain relative path without query length ${n} followed by real status`
    );
  }
  for (const n of [128, 129, 2048, 10000]) {
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', '?' + 'x'.repeat(n) + '=(v,statusCode=429)'),
      {category: 'unknown'},
      `query key length ${n}`
    );
  }
});

test('review-10 defect-4: error keywords embedded inside URLs never classify as dns/network/tls/auth/model/arguments', t => {
  const {vault} = fixture(t, '');
  for (const sample of [
    '{"url":"https://example.invalid/?x=ENOTFOUND"}',
    '{"url":"https://example.invalid/?x=ECONNRESET"}',
    '{"url":"https://example.invalid/?x=ERR_CERT_AUTHORITY_INVALID"}',
    '{"url":"https://example.invalid/?err=unauthorized"}',
    'GET /api/' + 'p'.repeat(600) + '?reason=ENOTFOUND&code=ECONNREFUSED',
    '?param_' + 'k'.repeat(200) + '=ERR_TLS_CERT_ALTNAME_INVALID',
    '{"url":"https://example.invalid/' + 'a'.repeat(10000) + '?x=ENOTFOUND"}',
    'couldn\'t reach https://example.invalid/?"statusCode":429',
    'url=/api/' + 'p'.repeat(600) + '?"statusCode":429&err=ENOTFOUND',
  ]) {
    assert.deepEqual(vault.classifyDreamDiagnostic('', sample), {category: 'unknown'}, sample.slice(0, 80));
  }
  assert.deepEqual(vault.classifyDreamDiagnostic('', '{"url":"https://example.invalid/?x=1"} ENOTFOUND'), {category: 'dns'});
  assert.deepEqual(vault.classifyDreamDiagnostic('', 'request to "https://example.invalid/?x=1" failed: ECONNRESET'), {category: 'network'});
  assert.deepEqual(vault.classifyDreamDiagnostic('', '{"error":"GET https://example.invalid/' + 'a'.repeat(10000) + '?x=1","statusCode":429}'), {category: 'http', httpStatus: 429});
  assert.deepEqual(vault.classifyDreamDiagnostic('', '{"dirUrl":"https://example.invalid/a\\\\","statusCode":502}'), {category: 'http', httpStatus: 502});
  assert.deepEqual(vault.classifyDreamDiagnostic('', '(https://example.invalid/?x=1),statusCode=503'), {category: 'http', httpStatus: 503});
});

test('review-10 defect-5: long x509 certificate hostname mismatch across 8KB window boundaries classifies as tls', t => {
  const {vault} = fixture(t, '');
  const phrase = 'x509: certificate is valid for ' + 'valid.example, '.repeat(12) + 'not wrong.example';
  assert.deepEqual(vault.classifyDreamDiagnostic('', phrase), {category: 'tls'});
  for (let offset = 7600; offset <= 8250; offset += 19) {
    const text = 'x'.repeat(offset) + ' ' + phrase + ' ' + 'x'.repeat(9000);
    assert.deepEqual(vault.classifyDreamDiagnostic('', text), {category: 'tls'}, `offset=${offset}`);
  }
  assert.deepEqual(vault.classifyDreamDiagnostic('', 'x'.repeat(7835) + ' ' + phrase + ' ' + 'x'.repeat(9000)), {category: 'tls'});
});

test('review-11: repeated =/ relative path tokens without query stay linear O(N)', t => {
  const {vault} = fixture(t, '');
  const text = 'GET /' + '=/'.repeat(65536) + ' HTTP 429';
  const t0 = performance.now();
  const diag = vault.classifyDreamDiagnostic('', text);
  const elapsed = performance.now() - t0;
  assert.deepEqual(diag, {category: 'http', httpStatus: 429});
  assert.ok(elapsed < 250, `expected linear scan <250ms, took ${elapsed}ms`);
});

test('review-12 (#7.3): repeated (/ and [/ bracketed slash runs with or without query stay strictly linear O(N)', t => {
  const {vault} = fixture(t, '');
  const heavyUnclosed = ('(/'.repeat(3500) + ' ').repeat(18) + 'HTTP 429';
  const t0 = performance.now();
  const d0 = vault.classifyDreamDiagnostic('', heavyUnclosed);
  const elapsed0 = performance.now() - t0;
  assert.deepEqual(d0, {category: 'http', httpStatus: 429});
  assert.ok(elapsed0 < 150, `expected unclosed (/ scan <150ms, took ${elapsed0}ms`);

  const heavyNestedWithQuery = '(/'.repeat(3500) + ')'.repeat(3500) + '?statusCode=429 HTTP 503';
  const t1 = performance.now();
  const d1 = vault.classifyDreamDiagnostic('', heavyNestedWithQuery);
  const elapsed1 = performance.now() - t1;
  assert.deepEqual(d1, {category: 'http', httpStatus: 503});
  assert.ok(elapsed1 < 150, `expected nested (/...)?query scan <150ms, took ${elapsed1}ms`);
});

test('review-13 (#7-L3-2 & #7-L3-3): overlong parenthesized and bracketed URLs preserve outer wrapper and nested depth across 8KB windows', t => {
  const {vault} = fixture(t, '');
  for (const n of [64, 9000, 20000]) {
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', '(https://example.com/' + 'a'.repeat(n) + '?statusCode=429),HTTP/1.1 503'),
      {category: 'http', httpStatus: 503},
      `abs paren n=${n}`
    );
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', '[https://example.com/' + 'a'.repeat(n) + '?statusCode=429],HTTP/1.1 503'),
      {category: 'http', httpStatus: 503},
      `abs bracket n=${n}`
    );
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', '(https://example.com/?q=(' + 'a'.repeat(n) + ',statusCode=429)),HTTP/1.1 503'),
      {category: 'http', httpStatus: 503},
      `abs nested paren across cut n=${n}`
    );
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', '(https://example.com/?q=(' + 'a'.repeat(n) + ',statusCode=429))'),
      {category: 'unknown'},
      `abs nested paren masked n=${n}`
    );
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', '(/' + 'a'.repeat(n) + '?x=(foo,statusCode=429))'),
      {category: 'unknown'},
      `rel paren masked n=${n}`
    );
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', '[/' + 'a'.repeat(n) + '?x=[foo,statusCode=429]]'),
      {category: 'unknown'},
      `rel bracket masked n=${n}`
    );
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', '(/' + 'a'.repeat(n) + '?x=(foo,statusCode=429)),HTTP/1.1 503'),
      {category: 'http', httpStatus: 503},
      `rel paren followed by real status n=${n}`
    );
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', '(?' + 'k'.repeat(n) + '=(foo,statusCode=429))'),
      {category: 'unknown'},
      `query key paren masked n=${n}`
    );
    assert.deepEqual(
      vault.classifyDreamDiagnostic('', '(?' + 'k'.repeat(n) + '=1&statusCode=429),HTTP/1.1 503'),
      {category: 'http', httpStatus: 503},
      `query key paren followed by real status n=${n}`
    );
  }
});

test('review-14 (#7-R8-3 & #7-R8-4): standalone query strings with empty leading params and deep nested brackets stay masked in linear O(N) time', t => {
  const {vault} = fixture(t, '');
  // #7-R8-3: ?&x=... and ?;x=... across 8KB windows and chunk boundaries
  assert.deepEqual(
    vault.classifyDreamDiagnostic('', '?&x=' + 'a'.repeat(10000) + ',statusCode=429'),
    {category: 'unknown'}
  );
  assert.deepEqual(
    vault.classifyDreamDiagnostic('', '?&x=' + 'a'.repeat(10000) + ',statusCode=429 HTTP 503'),
    {category: 'http', httpStatus: 503}
  );
  assert.deepEqual(
    vault.classifyDreamDiagnostic('', '(?;x=' + 'a'.repeat(10000) + ',statusCode=429),HTTP/1.1 503'),
    {category: 'http', httpStatus: 503}
  );
  assert.deepEqual(
    vault.classifyDreamDiagnostic('', ' '.repeat(7166) + '?&x=' + 'a'.repeat(9000) + ',statusCode=429'),
    {category: 'unknown'}
  );
  assert.deepEqual(
    vault.classifyDreamDiagnostic('', '?& HTTP 503'),
    {category: 'http', httpStatus: 503}
  );

  // #7-R8-4: Deeply nested balanced URL up to 2MB must run in linear O(N) time (<350ms, not ~1800ms)
  const makeDeepNested = (totalBytes, suffix) => {
    const depth = Math.floor((totalBytes - 64) / 2);
    return '(https://example.com/?q=' + '('.repeat(depth) + 'statusCode=429' + ')'.repeat(depth) + ')' + suffix;
  };
  assert.deepEqual(vault.classifyDreamDiagnostic('', makeDeepNested(512 * 1024, '')), {category: 'unknown'});
  const t2mStart = performance.now();
  const d2m = vault.classifyDreamDiagnostic('', makeDeepNested(2 * 1024 * 1024, ',HTTP/1.1 503'));
  const elapsed2m = performance.now() - t2mStart;
  assert.deepEqual(d2m, {category: 'http', httpStatus: 503});
  assert.ok(elapsed2m < 350, `expected 2MB deep nested URL scan <350ms (O(N)), took ${elapsed2m}ms`);
});

test('review-16 (#7-3): single-line JSON with leading HTTP statusCode and 9000-byte payload preserves 429 across window trims', t => {
  const {vault} = fixture(t, '');
  const line = '{"statusCode":429,"payload":"' + 'A'.repeat(9000) + '"}';
  assert.deepEqual(vault.extractDreamHttpStatuses(line), [429]);
  assert.deepEqual(vault.classifyDreamDiagnostic('', line), {category: 'http', httpStatus: 429});

  const acc = vault.createDreamDiagAccumulator();
  acc.feed(line.slice(0, 4096));
  acc.feed(line.slice(4096));
  assert.deepEqual([...acc.finish().codes], [429]);

  const http502 = '{"http_status":502,"detail":"' + 'B'.repeat(12000) + '"}';
  assert.deepEqual(vault.classifyDreamDiagnostic('', http502), {category: 'http', httpStatus: 502});
});

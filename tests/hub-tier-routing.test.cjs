'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {createSubagentsManager,DEFAULT_SUBAGENTS}=require('../src/hub-subagents.cjs');
const repo=path.resolve(__dirname,'..');
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'hub-tier-')),hub=path.join(home,'.t3/hub'),project=path.join(home,'p/project');fs.mkdirSync(hub,{recursive:true});fs.mkdirSync(project,{recursive:true});t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const existing=DEFAULT_SUBAGENTS.map(x=>({...x}));existing.find(x=>x.id==='code-review').effort='high';fs.writeFileSync(path.join(hub,'subagents.json'),JSON.stringify(existing,null,2)+'\n');return {home,hub,project,mgr:createSubagentsManager({homeDir:home,hubDir:hub})};}
function hook(f,tool_input){const bin=path.join(f.home,'.t3/bin');const installed=path.join(f.home,'.t3/hud-plugin');fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(installed,{recursive:true});fs.copyFileSync(path.join(repo,'scripts/subagent-route-guard.mjs'),path.join(bin,'subagent-route-guard.mjs'));fs.copyFileSync(path.join(repo,'src/hub-subagents.cjs'),path.join(installed,'hub-subagents.cjs'));const run=spawnSync(process.execPath,[path.join(bin,'subagent-route-guard.mjs')],{input:JSON.stringify({tool_name:'mcp__t3_code__delegate_task',cwd:f.project,tool_input}),encoding:'utf8',env:{...process.env,HOME:f.home,T3_HUB_DIR:f.hub}});assert.equal(run.status,0,run.stderr);return run.stdout.trim()?JSON.parse(run.stdout).hookSpecificOutput:null;}
test('three tier views expose virtual defaults without changing the existing seven profiles',t=>{const f=fixture(t),file=path.join(f.hub,'subagents.json'),before=fs.readFileSync(file,'utf8'),out=f.mgr.listSubagents({projectRoot:f.project});const work=out.tierGroups.find(g=>g.id==='work'),review=out.tierGroups.find(g=>g.id==='review');assert.deepEqual(work.levels.map(x=>[x.id,x.kind]),[['worker','agent'],['worker-pro','agent'],[null,'main']]);assert.deepEqual(review.levels.map(x=>x.id),['review-fast','code-review','review-pro']);assert.equal(review.levels[0].item.model,'muse-ember-1.0');assert.equal(review.levels[0].configured,false);assert.equal(review.levels[1].item.effort,'high');assert.equal(review.levels[2].item.model,'gpt-6.1-sol');assert.equal(review.levels[2].item.effort,'max');assert.equal(fs.readFileSync(file,'utf8'),before);});
test('virtual review tiers route separately, generic native roles select their L1/L2 defaults',t=>{const f=fixture(t);for(const [id,role,provider,model] of [['review-fast','review','muse','muse-ember-1.0'],['code-review','review','codex','gpt-6.1-terra'],['review-pro','review','codex','gpt-6.1-sol']]){const out=f.mgr.resolveSubagentRoute({idOrTitle:id,role,projectRoot:f.project});assert.equal(out.matched,true);assert.equal(out.target.providerInstanceId,provider);assert.equal(out.target.model,model);assert.match(out.instruction,/只读/);}assert.equal(f.mgr.resolveSubagentRoute({role:'review',projectRoot:f.project}).item.id,'code-review');assert.equal(f.mgr.resolveSubagentRoute({role:'implementation',projectRoot:f.project}).item.id,'worker');});
test('a project-tier override does not alter the global route or another project',t=>{const f=fixture(t),other=path.join(f.home,'other/project');fs.mkdirSync(other,{recursive:true});const base=f.mgr.listSubagents({projectRoot:f.project}).tierGroups.find(g=>g.id==='review').levels[0].globalItem;f.mgr.saveSubagent({scope:'project',projectRoot:f.project,item:{...base,model:'custom-project',systemPrompt:'project prompt',overridesGlobal:true}});const own=f.mgr.listSubagents({projectRoot:f.project}).tierGroups[1].levels[0],outside=f.mgr.listSubagents({projectRoot:other}).tierGroups[1].levels[0];assert.equal(own.source,'project');assert.equal(own.item.model,'custom-project');assert.equal(own.globalItem.model,'muse-ember-1.0');assert.equal(outside.item.model,'muse-ember-1.0');assert.equal(outside.projectItem,null);});
test('guard applies task instructions even when target already matches, idempotently, without altering permissions',t=>{const f=fixture(t);const target=f.mgr.resolveSubagentRoute({idOrTitle:'review-fast',role:'review',projectRoot:f.project}).target;const input={title:'review-fast · task',role:'review',target,task:'Check the changed file.'};const first=hook(f,input);assert.ok(first);assert.equal(first.permissionDecision,undefined);assert.match(first.updatedInput.task,/t3-hub-subagent-prompt:start/);assert.match(first.updatedInput.task,/只读/);assert.match(first.updatedInput.task,/Check the changed file\.$/);assert.equal(hook(f,first.updatedInput),null);});
test('guard never invents task fields and refuses to reroute mismatched roles',t=>{const f=fixture(t);const out=hook(f,{title:'review-fast',role:'review',target:{},description:'leave this alone'});assert.equal(out.updatedInput.description,'leave this alone');assert.equal(out.updatedInput.task,undefined);assert.equal(hook(f,{title:'review-fast',role:'implementation',target:{},task:'leave'}),null);});
test('global commander mode switches on-off-on within one managed block and readback verifies each host',t=>{const f=fixture(t),host=path.join(f.home,'AGENTS.md');fs.writeFileSync(host,'# user private rules\n');let state=f.mgr.getOrchestrationState({hosts:[host]});assert.equal(state.policyVersion,0);assert.equal(state.modeApplied,false);for(const mode of ['on','off','on']){const result=f.mgr.updateOrchestrationConfig({swarmMode:mode,expectedRevision:state.modeRevision},{hostRulePaths:[host]});assert.equal(result.ok,true,JSON.stringify(result));state=f.mgr.getOrchestrationState({hosts:[host]});assert.equal(state.policyVersion,2);assert.equal(state.swarmMode,mode);assert.equal(state.modeApplied,true);assert.equal(state.hostResults[0].state,'applied');const content=fs.readFileSync(host,'utf8');assert.match(content,/# user private rules/);assert.equal((content.match(/T3_HUB_ORCHESTRATOR_START/g)||[]).length,1);assert.match(content,/仅 T3 Code/);assert.match(content,/独立.*非 T3|非 T3 宿主/);assert.match(content,/不得递归/);assert.match(content,/连续两次/);if(mode==='on'){assert.match(content,/决策、拆解、派单/);assert.match(content,/主会话亲自兜底/);assert.match(content,/用户明确要求/);}else{assert.match(content,/小任务、短任务/);assert.doesNotMatch(content,/默认负责决策、拆解、派单/);}}});
test('stale mode revision or damaged managed markers never overwrite current configuration or user rules',t=>{const f=fixture(t),host=path.join(f.home,'AGENTS.md');fs.writeFileSync(host,'# user\n');const initial=f.mgr.getOrchestrationState({hosts:[host]});assert.equal(f.mgr.updateOrchestrationConfig({swarmMode:'on',expectedRevision:initial.modeRevision},{hostRulePaths:[host]}).ok,true);const current=fs.readFileSync(host,'utf8');assert.throws(()=>f.mgr.updateOrchestrationConfig({swarmMode:'off',expectedRevision:initial.modeRevision},{hostRulePaths:[host]}),/变更|重新读取/);assert.equal(fs.readFileSync(host,'utf8'),current);const fresh=f.mgr.getOrchestrationState({hosts:[host]});fs.writeFileSync(host,'# user\n<!-- T3_HUB_ORCHESTRATOR_START -->\n');const corrupt=fs.readFileSync(host,'utf8'),failed=f.mgr.updateOrchestrationConfig({swarmMode:'off',expectedRevision:fresh.modeRevision},{hostRulePaths:[host]});assert.equal(failed.ok,false);assert.equal(fs.readFileSync(host,'utf8'),corrupt);assert.equal(f.mgr.getOrchestrationState({hosts:[host]}).modeApplied,false);});
test('guard replaces its previous prompt after a setting change without repeating or losing the task',t=>{const f=fixture(t),config=path.join(f.hub,'subagents.json'),base=JSON.parse(fs.readFileSync(config,'utf8'));base.find(x=>x.id==='worker').systemPrompt='FIRST VERSION';fs.writeFileSync(config,JSON.stringify(base));const payload={title:'worker',role:'implementation',target:{},task:'Actual request'};const first=hook(f,payload).updatedInput;assert.match(first.task,/FIRST VERSION/);base.find(x=>x.id==='worker').systemPrompt='SECOND VERSION';fs.writeFileSync(config,JSON.stringify(base));const second=hook(f,first).updatedInput;assert.match(second.task,/SECOND VERSION/);assert.doesNotMatch(second.task,/FIRST VERSION/);assert.equal((second.task.match(/t3-hub-subagent-prompt:start/g)||[]).length,1);assert.match(second.task,/Actual request$/);});
test('partially failed policy sync is never reported as applied or persisted',t=>{const f=fixture(t),a=path.join(f.home,'a.md'),b=path.join(f.home,'b.md');fs.writeFileSync(a,'# A\n');fs.writeFileSync(b,'# B\n<!-- T3_HUB_ORCHESTRATOR_START -->\nbroken\n');const before=f.mgr.getOrchestrationState({hosts:[a,b]});const out=f.mgr.updateOrchestrationConfig({swarmMode:'on',expectedRevision:before.modeRevision},{hostRulePaths:[a,b]});assert.equal(out.ok,false);assert.ok(out.hostResults.some(x=>x.path===b&&!x.ok));const after=f.mgr.getOrchestrationState({hosts:[a,b]});assert.equal(after.policyVersion,0);assert.equal(after.modeApplied,false);assert.match(fs.readFileSync(a,'utf8'),/^# A\n/);assert.match(fs.readFileSync(b,'utf8'),/broken/);});
test('project partial tier override inherits global memory policy and unmodified fields',t=>{const f=fixture(t);const global=JSON.parse(fs.readFileSync(path.join(f.hub,'subagents.json'),'utf8'));const review=global.find(x=>x.id==='code-review');review.memoryPolicy='readonly';fs.writeFileSync(path.join(f.hub,'subagents.json'),JSON.stringify(global));const canonical=fs.realpathSync(f.project),hash=require('node:crypto').createHash('sha256').update(canonical).digest('hex').slice(0,20),dir=path.join(f.hub,'project-subagents');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`${path.basename(canonical)}-${hash}.json`),JSON.stringify([{id:'code-review',model:'project-model',overridesGlobal:true}]));const level=f.mgr.listSubagents({projectRoot:f.project}).tierGroups[1].levels[1];assert.equal(level.item.model,'project-model');assert.equal(level.item.memoryPolicy,'readonly');assert.equal(level.item.providerInstanceId,'codex');assert.equal(level.source,'project');assert.equal(level.configured,true);assert.equal(f.mgr.resolveSubagentRoute({idOrTitle:'code-review',role:'review',projectRoot:f.project}).item.memoryPolicy,'readonly');});
test('three review IDs select their own targets and prompts; native review without ID uses L2',t=>{const f=fixture(t),file=path.join(f.hub,'subagents.json'),raw=JSON.parse(fs.readFileSync(file,'utf8'));raw.find(x=>x.id==='code-review').systemPrompt='REVIEW-L2';fs.writeFileSync(file,JSON.stringify(raw));const list=f.mgr.listSubagents({}).tierGroups.find(x=>x.id==='review');for(const [level,mark] of [[list.levels[0],'REVIEW-L1'],[list.levels[2],'REVIEW-L3']])f.mgr.saveSubagent({scope:'global',item:{...level.globalItem,systemPrompt:mark}});for(const [id,model,mark] of [['review-fast','muse-ember-1.0','REVIEW-L1'],['code-review','gpt-6.1-terra','REVIEW-L2'],['review-pro','gpt-6.1-sol','REVIEW-L3']]){const out=hook(f,{title:`${id} · check`,role:'review',target:{},task:'inspect'});assert.equal(out.updatedInput.target.model,model);assert.match(out.updatedInput.task,new RegExp(mark));assert.match(out.updatedInput.task,/inspect$/);}const fallback=hook(f,{role:'review',target:{},task:'inspect'});assert.equal(fallback.updatedInput.target.model,'gpt-6.1-terra');assert.match(fallback.updatedInput.task,/REVIEW-L2/);});
test('guard never reroutes an explicitly scoped remote target and preserves unrelated target options',t=>{const f=fixture(t),remote={title:'worker',role:'implementation',target:{environmentId:'remote-env',projectId:'remote-project',providerInstanceId:'remote',model:'remote-model',options:{custom:'keep'}},task:'remote task'};assert.equal(hook(f,remote),null);const local=hook(f,{title:'worker',role:'implementation',target:{extra:'keep',providerInstanceId:'muse',model:'muse-ember-1.0',options:{custom:'keep',thinking_level:'old'}},task:'local task'});assert.equal(local.updatedInput.target.extra,'keep');assert.equal(local.updatedInput.target.options.custom,'keep');assert.equal(local.updatedInput.target.options.thinking_level,undefined);assert.equal(local.updatedInput.target.model,'muse-ember-1.0');});
test('explicit disabled tiers never silently downgrade to the generic role default',t=>{const f=fixture(t),file=path.join(f.hub,'subagents.json'),raw=JSON.parse(fs.readFileSync(file,'utf8'));raw.find(x=>x.id==='worker-pro').enabled=false;raw.push({id:'review-pro',role:'review',providerInstanceId:'codex',model:'gpt-6.1-sol',effort:'max',enabled:false});fs.writeFileSync(file,JSON.stringify(raw));for(const [id,role] of [['worker-pro','implementation'],['review-pro','review']])assert.equal(hook(f,{title:`${id} · hard`,role,target:{providerInstanceId:'codex',model:'original'},task:'do not downgrade'}),null);const global=f.mgr.listSubagents({}).globalItems.find(x=>x.id==='review-fast');f.mgr.saveSubagent({scope:'project',projectRoot:f.project,item:{...global,enabled:false,overridesGlobal:true}});assert.equal(hook(f,{title:'review-fast · project',role:'review',target:{},task:'test'}),null);});
test('guard ignores a different MCP with the same delegate_task name and unverified wrappers',t=>{const f=fixture(t),bin=path.join(f.home,'.t3/bin'),plugin=path.join(f.home,'.t3/hud-plugin');fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(plugin,{recursive:true});fs.copyFileSync(path.join(repo,'scripts/subagent-route-guard.mjs'),path.join(bin,'subagent-route-guard.mjs'));fs.copyFileSync(path.join(repo,'src/hub-subagents.cjs'),path.join(plugin,'hub-subagents.cjs'));for(const tool_name of ['mcp__unrelated_orchestrator__delegate_task','delegate_task']){const r=spawnSync(process.execPath,[path.join(bin,'subagent-route-guard.mjs')],{input:JSON.stringify({tool_name,cwd:f.project,tool_input:{role:'review',title:'review-fast',target:{},task:'unchanged'}}),encoding:'utf8',env:{...process.env,HOME:f.home,T3_HUB_DIR:f.hub}});assert.equal(r.status,0);assert.equal(r.stdout.trim(),'');}const r=spawnSync(process.execPath,[path.join(bin,'subagent-route-guard.mjs')],{input:JSON.stringify({tool_name:'mcp_dispatch',cwd:f.project,tool_input:{ToolName:'delegate_task',Arguments:{role:'review',title:'review-fast',target:{},task:'unchanged'}}}),encoding:'utf8',env:{...process.env,HOME:f.home,T3_HUB_DIR:f.hub}});assert.equal(r.status,0);assert.equal(r.stdout.trim(),'');});
test('guard preserves target if a provider switch could conflict with driver or unknown options',t=>{const f=fixture(t);for(const target of [{driverKind:'codex',providerInstanceId:'codex',model:'old',options:{}},{providerInstanceId:'codex',model:'old',options:{custom:'unknown'}}]){const input={title:'worker',role:'implementation',target,task:'original'};const out=hook(f,input);assert.deepEqual(out.updatedInput,input);assert.match(out.additionalContext,/保留原派单/);}});
test('guard never truncates a valid near-limit task to add a role prompt',t=>{const f=fixture(t);const task='x'.repeat(119999),target=f.mgr.resolveSubagentRoute({idOrTitle:'worker',role:'implementation',projectRoot:f.project}).target;const out=hook(f,{title:'worker',role:'implementation',target,task});assert.equal(out.updatedInput.task,task);assert.match(out.additionalContext,/超过 120000/);assert.equal(out.permissionDecision,undefined);});

test('array target options retain other settings, and unsafe arrays are not rewritten', t => {
  const f = fixture(t);
  const base = { title: 'worker', role: 'implementation', task: 'do work' };
  const arrayTarget = { providerInstanceId: 'muse', model: 'muse-ember-1.0', options: [{ id: 'custom', value: 'keep' }, { id: 'reasoningEffort', value: 'high' }] };
  const out = hook(f, { ...base, target: arrayTarget });
  assert.deepEqual(out.updatedInput.target.options, [{ id: 'custom', value: 'keep' }, { id: 'reasoningEffort', value: 'max' }]);
  for (const options of [[{ id: 'custom', value: 'keep' }], [{ id: 'x', value: 1 }, { id: 'x', value: 2 }], [{ id: 'x', value: 1, extra: true }]]) {
    const input = { ...base, target: { providerInstanceId: 'codex', model: 'different', options } };
    const result = hook(f, input);
    assert.deepEqual(result.updatedInput, input);
    assert.match(result.additionalContext, /保留原派单/);
  }
});

test('damaged policy marker preflight preserves every host, active file and config byte', t => {
  const f = fixture(t), a = path.join(f.home, 'a.md'), b = path.join(f.home, 'b.md');
  fs.writeFileSync(a, '# A\n'); fs.writeFileSync(b, '# B\n');
  let state = f.mgr.getOrchestrationState({ hosts: [a, b] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: state.modeRevision }, { hostRulePaths: [a, b] }).ok, true);
  fs.writeFileSync(b, '# B\n<!-- T3_HUB_ORCHESTRATOR_START -->\nbroken\n');
  state = f.mgr.getOrchestrationState({ hosts: [a, b] });
  const files = [a, b, path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md'), path.join(f.hub, 'orchestration-config.json')];
  const before = files.map(file => fs.readFileSync(file));
  const result = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: state.modeRevision }, { hostRulePaths: [a, b] });
  assert.equal(result.ok, false); assert.equal(result.rolledBack, true);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
});

test('post-preflight host failure rolls back existing and newly created policy files', t => {
  for (const seeded of [false, true]) {
    const f = fixture(t), a = path.join(f.home, 'a.md'), b = path.join(f.home, 'b.md');
    const active = path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md'), config = path.join(f.hub, 'orchestration-config.json');
    fs.writeFileSync(b, '# B\n');
    if (seeded) {
      fs.writeFileSync(a, '# A\n');
      const initial = f.mgr.getOrchestrationState({ hosts: [a, b] });
      assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: initial.modeRevision }, { hostRulePaths: [a, b] }).ok, true);
    }
    const files = [a, b, active, config], before = files.map(file => fs.existsSync(file) ? fs.readFileSync(file) : null);
    const state = f.mgr.getOrchestrationState({ hosts: [a, b] });
    const rename = fs.renameSync; let fired = false, result;
    fs.renameSync = function(source, dest) { if (!fired && source === b && String(dest).includes('.stage-')) { fired = true; const e = new Error('injected write failure'); e.code = 'EACCES'; throw e; } return rename.apply(this, arguments); };
    try { result = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: state.modeRevision }, { hostRulePaths: [a, b] }); }
    finally { fs.renameSync = rename; }
    assert.equal(fired, true); assert.equal(result.ok, false); assert.equal(result.rolledBack, true, JSON.stringify(result));
    files.forEach((file, i) => before[i] === null ? assert.equal(fs.existsSync(file), false, file) : assert.deepEqual(fs.readFileSync(file), before[i], file));
  }
});

test('concurrent mode revision change restores hosts without overwriting concurrent configuration', t => {
  const f = fixture(t), a = path.join(f.home, 'a.md'), b = path.join(f.home, 'b.md');
  const active = path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md'), config = path.join(f.hub, 'orchestration-config.json');
  fs.writeFileSync(a, '# A\n'); fs.writeFileSync(b, '# B\n');
  let state = f.mgr.getOrchestrationState({ hosts: [a, b] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: state.modeRevision }, { hostRulePaths: [a, b] }).ok, true);
  state = f.mgr.getOrchestrationState({ hosts: [a, b] });
  const files = [a, b, active], before = files.map(file => fs.readFileSync(file));
  const concurrent = '{"user":"concurrent edit"}\n', rename = fs.renameSync; let fired = false, result;
  fs.renameSync = function(source, dest) { if (!fired && source === b && String(dest).includes('.stage-')) { fired = true; fs.writeFileSync(config, concurrent); } return rename.apply(this, arguments); };
  try { result = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: state.modeRevision }, { hostRulePaths: [a, b] }); }
  finally { fs.renameSync = rename; }
  assert.equal(fired, true); assert.equal(result.ok, false); assert.equal(result.rolledBack, true, JSON.stringify(result));
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
  assert.equal(fs.readFileSync(config, 'utf8'), concurrent);
});

test('rollback conflict preserves concurrent host edit and reports failure', t => {
  const f = fixture(t), a = path.join(f.home, 'a.md'), b = path.join(f.home, 'b.md');
  fs.writeFileSync(a, '# A\n'); fs.writeFileSync(b, '# B\n');
  const state = f.mgr.getOrchestrationState({ hosts: [a, b] }), rename = fs.renameSync;
  let fired = false, result;
  fs.renameSync = function(source, dest) { if (!fired && source === b && String(dest).includes('.stage-')) { fired = true; fs.writeFileSync(a, '# concurrent user edit\n'); throw new Error('injected host failure'); } return rename.apply(this, arguments); };
  try { result = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: state.modeRevision }, { hostRulePaths: [a, b] }); }
  finally { fs.renameSync = rename; }
  assert.equal(result.ok, false); assert.equal(result.rolledBack, false);
  assert.ok(result.rollbackFailures.some(x => x.path === a));
  assert.equal(fs.readFileSync(a, 'utf8'), '# concurrent user edit\n');
});

test('a readback failure after publication reports unknown state instead of claiming rollback', t => {
  const f = fixture(t), host = path.join(f.home, 'a.md'), config = path.join(f.hub, 'orchestration-config.json'), active = path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md');
  fs.writeFileSync(host, '# user\n');
  let state = f.mgr.getOrchestrationState({ hosts: [host] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: state.modeRevision }, { hostRulePaths: [host] }).ok, true);
  state = f.mgr.getOrchestrationState({ hosts: [host] });
  const oldConfig = fs.readFileSync(config), oldActive = fs.readFileSync(active), oldHost = fs.readFileSync(host);
  const link = fs.linkSync, open = fs.openSync; let published = false, fired = false, result;
  fs.linkSync = function(source, dest) { const value = link.apply(this, arguments); if (dest === host) published = true; return value; };
  fs.openSync = function(file) { if (file === host && published && !fired) { fired = true; const e = new Error('injected EACCES'); e.code = 'EACCES'; throw e; } return open.apply(this, arguments); };
  try { result = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: state.modeRevision }, { hostRulePaths: [host] }); }
  finally { fs.linkSync = link; fs.openSync = open; }
  assert.equal(fired, true); assert.equal(result.ok, false); assert.equal(result.rolledBack, false);
  assert.ok(result.rollbackFailures.some(entry => entry.path === host));
  assert.deepEqual(fs.readFileSync(config), oldConfig); assert.deepEqual(fs.readFileSync(active), oldActive);
  assert.notDeepEqual(fs.readFileSync(host), oldHost);
});

test('concurrent user content written after host publication is never rolled back away', t => {
  const f = fixture(t), a = path.join(f.home, 'a.md'), b = path.join(f.home, 'b.md');
  const config = path.join(f.hub, 'orchestration-config.json'), active = path.join(f.hub, 'ACTIVE_ORCHESTRATION_MODE.md');
  fs.writeFileSync(a, '# A\n'); fs.writeFileSync(b, '# B\n');
  let state = f.mgr.getOrchestrationState({ hosts: [a, b] });
  assert.equal(f.mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: state.modeRevision }, { hostRulePaths: [a, b] }).ok, true);
  state = f.mgr.getOrchestrationState({ hosts: [a, b] });
  const oldConfig = fs.readFileSync(config), oldActive = fs.readFileSync(active), oldB = fs.readFileSync(b);
  const link = fs.linkSync, rename = fs.renameSync; let appended = false, fired = false, result;
  fs.linkSync = function(source, dest) {
    const value = link.apply(this, arguments);
    if (dest === a && !appended) { appended = true; fs.appendFileSync(a, '\n# parallel human edit\n'); }
    return value;
  };
  fs.renameSync = function(source, dest) {
    if (source === b && String(dest).includes('.stage-') && !fired) { fired = true; const e = new Error('injected failure'); e.code = 'EACCES'; throw e; }
    return rename.apply(this, arguments);
  };
  try { result = f.mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: state.modeRevision }, { hostRulePaths: [a, b] }); }
  finally { fs.linkSync = link; fs.renameSync = rename; }
  assert.equal(appended, true); assert.equal(result.ok, false); assert.equal(result.rolledBack, false);
  assert.ok(result.rollbackFailures.some(entry => entry.path === a));
  assert.match(fs.readFileSync(a, 'utf8'), /# parallel human edit/);
  assert.deepEqual(fs.readFileSync(config), oldConfig); assert.deepEqual(fs.readFileSync(active), oldActive); assert.deepEqual(fs.readFileSync(b), oldB);
});

test('broken or repeated global and project role markers block saves before configuration writes', t => {
  for (const content of ['<!-- t3-hub-subagents:start -->', '<!-- t3-hub-subagents:end -->\n<!-- t3-hub-subagents:start -->', '<!-- t3-hub-subagents:start -->\n<!-- t3-hub-subagents:start -->\n<!-- t3-hub-subagents:end -->']) {
    const f = fixture(t), host = path.join(f.home, '.codex', 'AGENTS.md'), config = path.join(f.hub, 'subagents.json');
    fs.mkdirSync(path.dirname(host), { recursive: true }); fs.writeFileSync(host, content);
    const before = fs.readFileSync(config);
    assert.throws(() => f.mgr.saveSubagent({ scope: 'global', item: { id: 'worker', description: 'changed' } }), /标记/);
    assert.deepEqual(fs.readFileSync(config), before); assert.equal(fs.readFileSync(host, 'utf8'), content);
  }
  const f = fixture(t), item = f.mgr.listSubagents({}).globalItems.find(x => x.id === 'worker');
  f.mgr.saveSubagent({ scope: 'project', projectRoot: f.project, item });
  const projectDir = path.join(f.hub, 'project-subagents'), config = path.join(projectDir, fs.readdirSync(projectDir)[0]), before = fs.readFileSync(config);
  const host = path.join(f.project, 'AGENTS.md'), broken = '<!-- t3-hub-project-subagents:start -->\n'; fs.writeFileSync(host, broken);
  assert.throws(() => f.mgr.saveSubagent({ scope: 'project', projectRoot: f.project, item: { id: 'worker', description: 'changed' } }), /标记/);
  assert.throws(() => f.mgr.deleteSubagent({ scope: 'project', projectRoot: f.project, id: 'worker' }), /标记/);
  assert.deepEqual(fs.readFileSync(config), before); assert.equal(fs.readFileSync(host, 'utf8'), broken);
});

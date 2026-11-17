'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createSubagentsManager, buildOrchestrationDirective } = require('../src/hub-subagents.cjs');
const { createSkillsManager } = require('../src/hub-skills.cjs');
function fixture(t) { const home=fs.mkdtempSync(path.join(os.tmpdir(),'hub-orch-safety-')); t.after(()=>fs.rmSync(home,{recursive:true,force:true})); return home; }
test('drawer retains actual swarm mode and concurrency when saving', () => {
 const src=fs.readFileSync(path.join(__dirname,'../src/hub-drawer-ui.js'),'utf8');
 const start=src.indexOf('    function orchestrationValues() {'); const end=src.indexOf('    function renderCommander()',start);
 const ctx={state:{orchestrationDraft:null},cache:{orchestration:{orchestratorMode:'argon',swarmMode:'on',maxParallelAgents:11,strictCommanderOnly:false,autoWorktreeIsolation:false}}};
 vm.runInNewContext(src.slice(start,end)+'\nresult=orchestrationValues();',ctx);
 assert.equal(ctx.result.swarmMode,'on'); assert.equal(ctx.result.maxParallelAgents,11); assert.equal(ctx.result.strictCommanderOnly,false);
});
test('normal and commander modes generate different and compatible instructions', () => {
 const loose=buildOrchestrationDirective({swarmMode:'off'});
 const strict=buildOrchestrationDirective({swarmMode:'on'});
 assert.match(loose,/小任务、短任务/); assert.match(strict,/决策、拆解、派单/); assert.match(strict,/主会话亲自兜底/);
});
test('disabling old orchestration removes its managed block and legacy stop headers',t=>{
 const home=fixture(t), hub=path.join(home,'.t3/hub'), host=path.join(home,'AGENTS.md'); fs.mkdirSync(hub,{recursive:true}); fs.writeFileSync(host,'# User private rule\n');
 const mgr=createSubagentsManager({homeDir:home,hubDir:hub});
 const directive=buildOrchestrationDirective({orchestratorMode:'carbon',swarmMode:'on'});
 const header=directive.slice(directive.indexOf('<SUBAGENT-STOP>'),directive.indexOf('</SUBAGENT-STOP>')+'</SUBAGENT-STOP>'.length);
 fs.appendFileSync(host,header+'\n'+header+'\n'+directive);
 let rev=mgr.getOrchestrationState({hosts:[host]}).modeRevision; mgr.updateOrchestrationConfig({swarmMode:'off',expectedRevision:rev},{hostRulePaths:[host]}); const disabled=fs.readFileSync(host,'utf8');
 assert.equal((disabled.match(/<SUBAGENT-STOP>/g)||[]).length,1); assert.match(disabled,/# User private rule/); assert.match(disabled,/常规协作/);
 rev=mgr.getOrchestrationState({hosts:[host]}).modeRevision; mgr.updateOrchestrationConfig({swarmMode:'off',expectedRevision:rev},{hostRulePaths:[host]}); assert.equal(fs.readFileSync(host,'utf8'),disabled);
});
test('global rule sync preserves independent host content, replaces only its block, refuses malformed blocks and reports partial failure',t=>{
 const home=fixture(t), hub=path.join(home,'.t3/hub'), codex=path.join(home,'.codex/AGENTS.md'),pi=path.join(home,'.pi/agent/AGENTS.md');
 for(const file of [codex,pi]) fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(codex,'# Private codex\n'); fs.writeFileSync(pi,'# Private pi\n');
 const mgr=createSkillsManager({homeDir:home,hubDir:hub});
 let result=mgr.saveAgentsMd({target:'global',content:'# Shared one\n',expectedContent:''}); assert.equal(result.ok,true); assert.match(fs.readFileSync(codex,'utf8'),/# Private codex[\s\S]*# Shared one/);
 mgr.saveAgentsMd({target:'global',content:'# Shared two\n',expectedContent:'# Shared one\n'}); let c=fs.readFileSync(codex,'utf8'); assert.match(c,/# Private codex/); assert.doesNotMatch(c,/# Shared one/); assert.equal((c.match(/# Shared two/g)||[]).length,1);
 fs.appendFileSync(pi,'\n<!-- t3-hub-global-rules:start -->\n'); const corrupt=fs.readFileSync(pi,'utf8'); result=mgr.saveAgentsMd({target:'global',content:'# Shared three\n',expectedContent:'# Shared two\n'});
 assert.equal(result.ok,false); assert.ok(result.failedTargets.some(x=>x.path===pi)); assert.equal(fs.readFileSync(pi,'utf8'),corrupt); assert.match(fs.readFileSync(codex,'utf8'),/# Shared three/);
});
test('invalid or deliberately empty route configuration is never overwritten on read', t => {
 const home=fixture(t), hub=path.join(home,'.t3/hub'), file=path.join(hub,'subagents.json'); fs.mkdirSync(hub,{recursive:true});
 const mgr=createSubagentsManager({homeDir:home,hubDir:hub}); fs.writeFileSync(file,'{bad json'); assert.throws(()=>mgr.listSubagents({}),/路由|配置/); assert.equal(fs.readFileSync(file,'utf8'),'{bad json');
 fs.writeFileSync(file,'[]'); assert.equal(mgr.listSubagents({}).globalItems.length,0); assert.equal(fs.readFileSync(file,'utf8'),'[]');
});
test('legacy mode updates cannot activate a second orchestration ruleset', t => {
 const home=fixture(t),hub=path.join(home,'.t3/hub'),host=path.join(home,'AGENTS.md'); fs.mkdirSync(hub,{recursive:true}); fs.writeFileSync(host,'# User rule\n');
 const mgr=createSubagentsManager({homeDir:home,hubDir:hub});
 const rev=mgr.getOrchestrationState({hosts:[host]}).modeRevision;
 assert.throws(()=>mgr.updateOrchestrationConfig({orchestratorMode:'carbon',swarmMode:'on',expectedRevision:rev}, {hostRulePaths:[host]}), /请选择/);
 assert.equal(fs.readFileSync(host,'utf8'),'# User rule\n');
 for(const mode of ['swarm','carbon','argon','plan']) assert.doesNotMatch(mgr.buildSlashCommandPrompt(mode),/严禁亲自改业务代码/);
});
test('same-name projects cannot share overrides; symlinks and subdirectories resolve the same project',t=>{
 const home=fixture(t),hub=path.join(home,'.t3/hub'),a=path.join(home,'a/project'),b=path.join(home,'b/project'),alias=path.join(home,'alias');
 for(const root of [a,b]) fs.mkdirSync(path.join(root,'.git'),{recursive:true}); fs.mkdirSync(path.join(a,'src')); fs.symlinkSync(a,alias);
 const mgr=createSubagentsManager({homeDir:home,hubDir:hub}); const global=mgr.listSubagents({}).globalItems.find(x=>x.id==='explorer');
 mgr.saveSubagent({scope:'project',projectRoot:a,item:{...global, model:'private-project-a', overridesGlobal:true}});
 assert.equal(mgr.resolveSubagentRoute({idOrTitle:'explorer',projectRoot:a}).target.model,'private-project-a');
 assert.equal(mgr.resolveSubagentRoute({idOrTitle:'explorer',projectRoot:alias}).target.model,'private-project-a');
 assert.equal(mgr.resolveSubagentRoute({idOrTitle:'explorer',projectRoot:path.join(a,'src')}).target.model,'private-project-a');
 assert.notEqual(mgr.resolveSubagentRoute({idOrTitle:'explorer',projectRoot:b}).target.model,'private-project-a');
});
test('legacy basename project config is not applied without an ownership record',t=>{
 const home=fixture(t),hub=path.join(home,'.t3/hub'),project=path.join(home,'a/project'),dir=path.join(hub,'project-subagents'); fs.mkdirSync(project,{recursive:true});fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'project.json'), contents=JSON.stringify([{id:'explorer',providerInstanceId:'codex',model:'legacy-private',effort:'max',enabled:true,overridesGlobal:true}]);fs.writeFileSync(file,contents);
 const mgr=createSubagentsManager({homeDir:home,hubDir:hub});const result=mgr.listSubagents({projectRoot:project});
 assert.equal(result.legacyProjectConfig,true);assert.notEqual(mgr.resolveSubagentRoute({idOrTitle:'explorer',projectRoot:project}).target.model,'legacy-private');assert.equal(fs.readFileSync(file,'utf8'),contents);
});
test('project rules keep one AGENTS source and add a bounded Claude reference only when requested',t=>{
 const home=fixture(t),hub=path.join(home,'.t3/hub'),project=path.join(home,'project'); fs.mkdirSync(project,{recursive:true});
 const mgr=createSkillsManager({homeDir:home,hubDir:hub}); const agents=path.join(project,'AGENTS.md'),claude=path.join(project,'CLAUDE.md');
 assert.throws(()=>mgr.syncProjectRuleReference({projectRoot:project}));assert.equal(fs.existsSync(claude),false);
 fs.writeFileSync(agents,'# Shared project rules\n');fs.writeFileSync(claude,'# Private Claude rules\n');
 mgr.syncProjectRuleReference({projectRoot:project});mgr.syncProjectRuleReference({projectRoot:project});
 const contents=fs.readFileSync(claude,'utf8');assert.match(contents,/# Private Claude rules/);assert.equal((contents.match(/@AGENTS\.md/g)||[]).length,1);assert.equal(fs.readFileSync(agents,'utf8'),'# Shared project rules\n');
 assert.equal(mgr.getAgentsMd({projectRoot:project}).projectClaudeReference,true);
});
test('T3 settings write only allowlisted boolean to bound environment and confirm fresh readback',async()=>{
 const src=fs.readFileSync(path.join(__dirname,'../src/hub-drawer-ui.js'),'utf8');const start=src.indexOf('    let t3SettingsView =');const end=src.indexOf('    function renderSettings()',start);const calls=[];let value=false;
 const env='11111111-1111-4111-8111-111111111111';const context={settingsVersion:0,contextVersion:0,disposed:false,state:{settingsHost:'t3',open:false,tab:'settings'},request:async()=>({t3EnvironmentId:env}),tr:(zh)=>zh,errorText:e=>e.message,renderSettings:()=>{},toast:()=>{},busy:async(_key,_el,fn)=>await fn(),window:{__t3HudRemoteRpc:async(id,method,payload)=>{calls.push({id,method,payload:JSON.parse(JSON.stringify(payload))});if(method==='server.updateSettings'){value=payload.patch.promptSuggestionsEnabled;return {ok:true,value:{}};}return {ok:true,value:{settings:{promptSuggestionsEnabled:value}}};}}};
 vm.runInNewContext(src.slice(start,end)+'\nglobalThis.testApi={loadT3Settings,toggleT3PromptSuggestions,getView:()=>t3SettingsView};',context);await context.testApi.loadT3Settings();assert.equal(context.testApi.getView().value,false);await context.testApi.toggleT3PromptSuggestions({});assert.equal(context.testApi.getView().value,true);
 assert.deepEqual(calls.map(x=>x.method),['server.getConfig','server.updateSettings','server.getConfig']);assert.deepEqual(calls[1].payload,{patch:{promptSuggestionsEnabled:true}});assert.ok(calls.every(x=>x.id===env));
});
test('shared global rules do not duplicate nested subagent managed blocks',t=>{
 const home=fixture(t),hub=path.join(home,'.t3/hub'),file=path.join(home,'.codex/AGENTS.md');fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,'# private\n<!-- t3-hub-subagents:start -->\nold agent\n<!-- t3-hub-subagents:end -->\n');
 const mgr=createSkillsManager({homeDir:home,hubDir:hub});const block='<!-- t3-hub-subagents:start -->\nnew agent\n<!-- t3-hub-subagents:end -->\n', before='# old shared\n'+block, content='# shared\n'+block;
 fs.mkdirSync(hub,{recursive:true});fs.writeFileSync(path.join(hub,'global-AGENTS.md'),before);
 assert.equal(mgr.saveAgentsMd({target:'global',content,expectedContent:before}).ok,true);const saved=fs.readFileSync(file,'utf8');
 assert.equal((saved.match(/t3-hub-subagents:start/g)||[]).length,1);assert.match(saved,/old agent/);assert.doesNotMatch(saved,/new agent/);assert.match(saved,/# shared/);
 assert.throws(()=>mgr.saveAgentsMd({target:'global',content:'hello\n<!-- t3-hub-subagents:start -->',expectedContent:content}),/托管区块/);
});
test('failed cleanup retains the active legacy state so the user can retry',t=>{
 const home=fixture(t),hub=path.join(home,'.t3/hub'),file=path.join(home,'bad.md');fs.mkdirSync(hub,{recursive:true});fs.writeFileSync(file,'<!-- T3_HUB_ORCHESTRATOR_START -->\nmissing end\n');
 fs.writeFileSync(path.join(hub,'orchestration-config.json'),JSON.stringify({orchestratorMode:'carbon',swarmMode:'on'}));
 const mgr=createSubagentsManager({homeDir:home,hubDir:hub}),rev=mgr.getOrchestrationState({hosts:[file]}).modeRevision;const result=mgr.updateOrchestrationConfig({swarmMode:'off',expectedRevision:rev},{hostRulePaths:[file]});
 assert.equal(result.ok,false);assert.equal(mgr.getOrchestrationConfig().orchestratorMode,'carbon');assert.match(fs.readFileSync(file,'utf8'),/missing end/);
});
test('project rule screen loads actual AGENTS data for the selected project',async()=>{
 const src=fs.readFileSync(path.join(__dirname,'../src/hub-drawer-ui.js'),'utf8');const start=src.indexOf('    async function loadTab(force = false)');const end=src.indexOf('    async function loadMemories(',start);let asked=[];let seeded=null,rendered=false;
 const ctx={disposed:false,state:{open:true,tab:'agents',projectRoot:'/tmp/project'},requestVersion:0,cache:{},errors:{},readCatalog:async(key,action,payload)=>{asked.push({key,action,payload:JSON.parse(JSON.stringify(payload))});return {projectExists:true,projectContent:'# rule'};},seedAgentDrafts:(data,root)=>{seeded={data,root};},renderTab:()=>{rendered=true;},renderChrome:()=>{},scheduleEmbedPoll:()=>{},primeCatalogs:()=>{}};
 vm.runInNewContext(src.slice(start,end)+'\nglobalThis.load=loadTab;',ctx);await ctx.load();assert.deepEqual(asked,[{key:'agents',action:'agentsMd:get',payload:{projectRoot:'/tmp/project'}}]);assert.equal(seeded.root,'/tmp/project');assert.equal(rendered,true);
 assert.match(src,/data-action=\\?"open-project-agents|button\("open-project-agents"/);assert.match(src,/state\.tab === "agents"\) renderAgents\(\)/);
});
test('corrupt project override prevents silent fallback and is not overwritten', t=>{
 const home=fixture(t),hub=path.join(home,'.t3/hub'),project=path.join(home,'project');fs.mkdirSync(project,{recursive:true});
 const mgr=createSubagentsManager({homeDir:home,hubDir:hub});const global=mgr.listSubagents({}).globalItems.find(x=>x.id==='explorer');
 mgr.saveSubagent({scope:'project',projectRoot:project,item:{...global,model:'project-model',overridesGlobal:true}});
 const files=fs.readdirSync(path.join(hub,'project-subagents'));assert.equal(files.length,1);const file=path.join(hub,'project-subagents',files[0]);fs.writeFileSync(file,'{bad');
 assert.throws(()=>mgr.listSubagents({projectRoot:project}),/项目.*路由/);assert.throws(()=>mgr.resolveSubagentRoute({idOrTitle:'explorer',projectRoot:project}),/项目.*路由/);assert.equal(fs.readFileSync(file,'utf8'),'{bad');
});
test('T3 setting remains unavailable after mismatched readback or unknown environment', async()=>{
 const src=fs.readFileSync(path.join(__dirname,'../src/hub-drawer-ui.js'),'utf8');const start=src.indexOf('    let t3SettingsView =');const end=src.indexOf('    function renderSettings()',start);let update=false, envAvailable=true;
 const context={settingsVersion:0,contextVersion:0,disposed:false,state:{settingsHost:'t3',open:false,tab:'settings'},request:async()=>({t3EnvironmentId:envAvailable?'11111111-1111-4111-8111-111111111111':null}),tr:zh=>zh,errorText:e=>e.message,renderSettings:()=>{},toast:()=>{},busy:async(_key,_el,fn)=>await fn(),window:{__t3HudRemoteRpc:async(_id,method)=>{if(method==='server.updateSettings'){update=true;return {ok:true};}return {ok:true,value:{settings:{promptSuggestionsEnabled:false}}};}}};
 vm.runInNewContext(src.slice(start,end)+'\nglobalThis.testApi={loadT3Settings,toggleT3PromptSuggestions,getView:()=>t3SettingsView};',context);await context.testApi.loadT3Settings();await assert.rejects(context.testApi.toggleT3PromptSuggestions({}),/无法确认/);assert.equal(update,true);assert.equal(context.testApi.getView().value,null);
 envAvailable=false;await context.testApi.loadT3Settings();assert.equal(context.testApi.getView().value,null);assert.match(context.testApi.getView().error,/无法确认/);
});
test('first opening shared rules never imports a private host file or duplicates it on save',t=>{
 const home=fixture(t),hub=path.join(home,'.t3/hub'),codex=path.join(home,'.codex/AGENTS.md'),pi=path.join(home,'.pi/agent/AGENTS.md');
 for(const f of [codex,pi])fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(codex,'# private codex only\n');fs.writeFileSync(pi,'# private pi only\n');
 const mgr=createSkillsManager({homeDir:home,hubDir:hub}), first=mgr.getAgentsMd({});assert.equal(first.globalContent,'');assert.equal(fs.existsSync(path.join(hub,'global-AGENTS.md')),false);
 mgr.saveAgentsMd({target:'global',content:first.globalContent,expectedContent:first.globalContent});assert.equal(fs.readFileSync(codex,'utf8'),'# private codex only\n');assert.equal(fs.readFileSync(pi,'utf8'),'# private pi only\n');
});
test('stale AGENTS drafts cannot overwrite a newer project or global role block',t=>{
 const home=fixture(t),hub=path.join(home,'.t3/hub'),project=path.join(home,'project');fs.mkdirSync(project,{recursive:true});
 const mgr=createSkillsManager({homeDir:home,hubDir:hub});const projectFile=path.join(project,'AGENTS.md'),globalFile=path.join(hub,'global-AGENTS.md');fs.mkdirSync(hub,{recursive:true});
 const old='# user rules\n', managed='<!-- t3-hub-project-subagents:start -->\n# route\n<!-- t3-hub-project-subagents:end -->\n';fs.writeFileSync(projectFile,old+managed);fs.writeFileSync(globalFile,old+managed);
 assert.throws(()=>mgr.saveAgentsMd({target:'project',projectRoot:project,content:'# stale edit\n',expectedContent:old}),/变更|重读|重新读取/);
 assert.throws(()=>mgr.saveAgentsMd({target:'global',content:'# stale edit\n',expectedContent:old}),/变更|重读|重新读取/);
 assert.equal(fs.readFileSync(projectFile,'utf8'),old+managed);assert.equal(fs.readFileSync(globalFile,'utf8'),old+managed);
 assert.throws(()=>mgr.saveAgentsMd({target:'project',projectRoot:project,content:'# remove managed\n',expectedContent:old+managed}),/托管/);
});
test('unreadable AGENTS files return an error rather than pretending to be empty',t=>{
 const home=fixture(t),hub=path.join(home,'.t3/hub'),project=path.join(home,'project');fs.mkdirSync(project,{recursive:true});const file=path.join(project,'AGENTS.md');fs.writeFileSync(file,'# private\n');fs.chmodSync(file,0);
 const mgr=createSkillsManager({homeDir:home,hubDir:hub});assert.throws(()=>mgr.getAgentsMd({projectRoot:project}),/不可.*读取/);assert.equal(fs.statSync(file).mode&0o777,0);fs.chmodSync(file,0o600);assert.equal(fs.readFileSync(file,'utf8'),'# private\n');
 fs.mkdirSync(hub,{recursive:true});const global=path.join(hub,'global-AGENTS.md');fs.writeFileSync(global,'# private global\n');fs.chmodSync(global,0);assert.throws(()=>mgr.getAgentsMd({}),/不可.*读取/);fs.chmodSync(global,0o600);assert.equal(fs.readFileSync(global,'utf8'),'# private global\n');
});
test('legacy detection distinguishes clean, residual and damaged host markers without writing',t=>{
 const home=fixture(t),hub=path.join(home,'.t3/hub'),file=path.join(home,'AGENTS.md');fs.mkdirSync(hub,{recursive:true});fs.writeFileSync(file,'# user\n');const mgr=createSubagentsManager({homeDir:home,hubDir:hub});
 assert.equal(mgr.inspectOrchestrationTargets({hosts:[file]}).state,'clear');
 const residual='# user\n'+buildOrchestrationDirective({orchestratorMode:'carbon'});fs.writeFileSync(file,residual);assert.equal(mgr.getOrchestrationConfig().orchestratorMode,'off');assert.equal(mgr.inspectOrchestrationTargets({hosts:[file]}).state,'present');assert.equal(fs.readFileSync(file,'utf8'),residual);
 fs.writeFileSync(file,'# user\n<!-- T3_HUB_ORCHESTRATOR_START -->\n');assert.equal(mgr.inspectOrchestrationTargets({hosts:[file]}).state,'unknown');
 const before=fs.readFileSync(file,'utf8'),rev=mgr.getOrchestrationState({hosts:[file]}).modeRevision;const out=mgr.updateOrchestrationConfig({swarmMode:'off',expectedRevision:rev},{hostRulePaths:[file]});assert.equal(out.ok,false);assert.equal(fs.readFileSync(file,'utf8'),before);
});
test('soft memory route preserves the exact existing project text and role block',t=>{
 const home=fixture(t),hub=path.join(home,'.t3/hub'),project=path.join(home,'project');fs.mkdirSync(project,{recursive:true});const file=path.join(project,'AGENTS.md');
 const before='# user rules  \n<!-- t3-hub-project-subagents:start -->\nroute\n<!-- t3-hub-project-subagents:end -->\n \n';fs.writeFileSync(file,before);
 const mgr=createSkillsManager({homeDir:home,hubDir:hub});mgr.injectSoftRoute({projectRoot:project});const after=fs.readFileSync(file,'utf8');assert.ok(after.startsWith(before));assert.match(after,/memory_search/);assert.match(after,/project-subagents:start/);
});
test('stale host rule draft and changed symlink target never overwrite managed content',t=>{
 const {createHostSettingsManager}=require('../src/hub-host-settings.cjs');const home=fixture(t),file=path.join(home,'.codex/AGENTS.md'),dest1=path.join(home,'one.md'),dest2=path.join(home,'two.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(dest1,'# before\n');fs.writeFileSync(dest2,'# before\n');fs.symlinkSync(dest1,file);
 const mgr=createHostSettingsManager({homeDir:home}),initial=mgr.getRuleContent('codex');const block='<!-- t3-hub-subagents:start -->\nroute\n<!-- t3-hub-subagents:end -->\n';fs.appendFileSync(dest1,block);
 assert.throws(()=>mgr.saveRuleContent('codex','# edited\n',initial.content,initial.targetPath),/变更|重新读取/);assert.match(fs.readFileSync(dest1,'utf8'),/route/);
 fs.writeFileSync(dest1,'# before\n');fs.unlinkSync(file);fs.symlinkSync(dest2,file);assert.throws(()=>mgr.saveRuleContent('codex','# edited\n',initial.content,initial.targetPath),/变更|重新读取/);assert.equal(fs.readFileSync(dest2,'utf8'),'# before\n');
});

test('R-6-1 global role deletion journals .claude/agents/<id>.md via onPublish so mid-retire EIO rolls back or reports rollbackFailures', t => {
  const home = fixture(t), hub = path.join(home, '.t3/hub'), host = path.join(home, 'AGENTS.md');
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(host, '# host\n');
  const mgr = createSubagentsManager({ homeDir: home, hubDir: hub, extraSyncPaths: [host] });
  mgr.saveSubagent({
    scope: 'global',
    extraSyncPaths: [host],
    item: {
      id: 'temp-role',
      name: 'temp-role',
      role: 'general',
      providerInstanceId: 'muse',
      model: 'muse-ember-1.0',
      effort: 'max',
      description: 'temp role',
      systemPrompt: 'temp prompt',
      enabled: true,
    },
  });
  const claudeFile = path.join(home, '.claude/agents/temp-role.md');
  assert.equal(fs.existsSync(claudeFile), true);
  const beforeClaude = fs.readFileSync(claudeFile, 'utf8');

  const origUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = function (target) {
    if (!injected && String(target).includes('temp-role.md.stage-') && String(target).endsWith(path.sep + 'old')) {
      injected = true;
      const err = new Error('injected retire EIO');
      err.code = 'EIO';
      throw err;
    }
    return origUnlink.apply(this, arguments);
  };
  let caught = null;
  try {
    mgr.deleteSubagent({ scope: 'global', id: 'temp-role', extraSyncPaths: [host] });
  } catch (e) {
    caught = e;
  } finally {
    fs.unlinkSync = origUnlink;
  }
  assert.equal(injected, true);
  assert.ok(caught, 'deleteSubagent must fail on mid-retire EIO');
  assert.equal(fs.existsSync(claudeFile), true, 'deleted Claude agent file must be restored on rollback');
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), beforeClaude);
});

test('R-6-2 global orchestration update with explicit hosts: [] still fails closed on unsafe AGY rules symlink', async t => {
  const home = fixture(t), hub = path.join(home, '.t3/hub');
  const agyInst = path.join(home, '.t3/userdata/providers/antigravity/inst1/config');
  const outsideRules = path.join(home, 'outside-rules');
  fs.mkdirSync(hub, { recursive: true });
  fs.mkdirSync(path.join(agyInst, 'skills'), { recursive: true });
  fs.mkdirSync(outsideRules, { recursive: true });
  fs.symlinkSync(outsideRules, path.join(agyInst, 'rules'));

  const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
  const rev = mgr.getOrchestrationState({ hosts: [] }).modeRevision;
  const direct = mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: rev }, { hosts: [] });
  assert.equal(direct.ok, false, 'direct updateOrchestrationConfig with hosts:[] must reject symlink AGY rules');

  const prevHome = process.env.HOME, prevHub = process.env.T3_HUB_DIR, prevT3 = process.env.T3CODE_HOME;
  process.env.HOME = home;
  process.env.T3_HUB_DIR = hub;
  delete process.env.T3CODE_HOME;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevHub === undefined) delete process.env.T3_HUB_DIR; else process.env.T3_HUB_DIR = prevHub;
    if (prevT3 === undefined) delete process.env.T3CODE_HOME; else process.env.T3CODE_HOME = prevT3;
  });
  const { hubCall } = require('../src/backend.cjs');
  const rpcRes = await hubCall('subagents:orchestration:update', { swarmMode: 'on', expectedRevision: rev, hosts: [] });
  assert.equal(rpcRes.ok, false, 'hubCall orchestration:update with hosts:[] must reject symlink AGY rules');
});

test('R-6-3 concurrent AGY instance appearing mid-transaction aborts and rolls back global orchestration update', t => {
  const home = fixture(t), hub = path.join(home, '.t3/hub'), host = path.join(home, 'AGENTS.md');
  const agyRoot = path.join(home, '.t3/userdata/providers/antigravity');
  fs.mkdirSync(hub, { recursive: true });
  fs.mkdirSync(path.join(agyRoot, 'inst1/config/skills'), { recursive: true });
  fs.writeFileSync(host, '# clean host\n');
  const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
  const rev0 = mgr.getOrchestrationState({ hosts: [host] }).modeRevision;
  assert.equal(mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: rev0 }, { hostRulePaths: [host] }).ok, true);

  const beforeHost = fs.readFileSync(host, 'utf8');
  const beforeCfg = fs.readFileSync(path.join(hub, 'orchestration-config.json'), 'utf8');
  const rev1 = mgr.getOrchestrationState({ hosts: [host] }).modeRevision;
  const origLink = fs.linkSync;
  let spawned = false;
  fs.linkSync = function (src, dest) {
    const out = origLink.apply(this, arguments);
    if (!spawned && String(dest).endsWith('orchestration-config.json')) {
      spawned = true;
      fs.mkdirSync(path.join(agyRoot, 'inst2/config/skills'), { recursive: true });
    }
    return out;
  };
  let res;
  try {
    res = mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: rev1 }, { hostRulePaths: [host] });
  } finally {
    fs.linkSync = origLink;
  }
  assert.equal(spawned, true);
  assert.equal(res.ok, false, 'new AGY instance mid-transaction must abort commit');
  assert.equal(res.rolledBack, true);
  assert.equal(fs.readFileSync(host, 'utf8'), beforeHost);
  assert.equal(fs.readFileSync(path.join(hub, 'orchestration-config.json'), 'utf8'), beforeCfg);
});

test('R-6-4 orchestration get/update strictly reject null, empty, invalid, or conflicting scope without ?? fallback', async t => {
  const home = fixture(t), hub = path.join(home, '.t3/hub'), host = path.join(home, 'AGENTS.md');
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(host, '# host\n');
  const prevHome = process.env.HOME, prevHub = process.env.T3_HUB_DIR;
  process.env.HOME = home;
  process.env.T3_HUB_DIR = hub;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevHub === undefined) delete process.env.T3_HUB_DIR; else process.env.T3_HUB_DIR = prevHub;
  });
  const { hubCall } = require('../src/backend.cjs');
  const st = await hubCall('subagents:orchestration:get', { hosts: [host] });

  const rNullGet = await hubCall('subagents:orchestration:get', { scope: null, hosts: [host] });
  assert.equal(rNullGet.ok, false, 'scope:null in get must fail');

  const rNullUpd = await hubCall('subagents:orchestration:update', {
    scope: null,
    patch: { swarmMode: 'on', expectedRevision: st.modeRevision },
    hosts: [host],
  });
  assert.equal(rNullUpd.ok, false, 'scope:null in update must not ?? fallback to global');

  const rConflict = await hubCall('subagents:orchestration:update', {
    scope: 'global',
    patch: { scope: 'project', swarmMode: 'on', expectedRevision: st.modeRevision },
    hosts: [host],
  });
  assert.equal(rConflict.ok, false, 'conflicting outer/inner scope must fail');

  const rBadInner = await hubCall('subagents:orchestration:update', {
    scope: 'global',
    patch: { scope: 'bogus', swarmMode: 'on', expectedRevision: st.modeRevision },
    hosts: [host],
  });
  assert.equal(rBadInner.ok, false, 'invalid inner patch.scope must fail');
});

test('R-6-5 execute-only (0100) AGY instance or config directory fails closed across subagents, backend, and host settings', async t => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const { createHostSettingsManager } = require('../src/hub-host-settings.cjs');
  const home = fixture(t), hub = path.join(home, '.t3/hub'), host = path.join(home, 'AGENTS.md');
  const instDir = path.join(home, '.t3/userdata/providers/antigravity/instExecOnly');
  fs.mkdirSync(hub, { recursive: true });
  fs.mkdirSync(instDir, { recursive: true });
  fs.writeFileSync(host, '# host\n');
  const prevHome = process.env.HOME, prevHub = process.env.T3_HUB_DIR, prevT3 = process.env.T3CODE_HOME;
  fs.chmodSync(instDir, 0o100);
  try {
    const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
    const rev = mgr.getOrchestrationState({ hosts: [host] }).modeRevision;
    const res = mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: rev }, { hostRulePaths: [host] });
    assert.equal(res.ok, false, '0100 AGY instance dir must fail closed in updateOrchestrationConfig');

    const snap = createHostSettingsManager({ homeDir: home, hubDir: hub }).getAntigravitySnapshot();
    assert.equal(snap.routingSkillsComplete, false, '0100 AGY instance dir must mark routingSkillsComplete=false');

    process.env.HOME = home;
    process.env.T3_HUB_DIR = hub;
    delete process.env.T3CODE_HOME;
    const { hubCall } = require('../src/backend.cjs');
    const rpcRes = await hubCall('subagents:orchestration:update', { swarmMode: 'on', expectedRevision: rev });
    assert.equal(rpcRes.ok, false, '0100 AGY instance dir must fail closed in backend discoverAntigravityRulesPaths');
  } finally {
    try { fs.chmodSync(instDir, 0o755); } catch {}
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevHub === undefined) delete process.env.T3_HUB_DIR; else process.env.T3_HUB_DIR = prevHub;
    if (prevT3 === undefined) delete process.env.T3CODE_HOME; else process.env.T3CODE_HOME = prevT3;
  }
});

test('R-6-6 getAntigravitySnapshot rejects symlinked SKILL.md without following target and sets routingSkillsComplete=false on any skill error', t => {
  const { createHostSettingsManager } = require('../src/hub-host-settings.cjs');
  const home = fixture(t), hub = path.join(home, '.t3/hub'), host = path.join(home, 'AGENTS.md');
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(host, '# host\n');
  const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
  const rev = mgr.getOrchestrationState({ hosts: [host] }).modeRevision;
  assert.equal(mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: rev }, { hostRulePaths: [host] }).ok, true);

  const agentsSkill = path.join(home, '.agents/skills/t3-subagent-routing/SKILL.md');
  const realTarget = path.join(home, 'real-managed-skill.md');
  fs.writeFileSync(realTarget, fs.readFileSync(agentsSkill, 'utf8'));
  fs.unlinkSync(agentsSkill);
  fs.symlinkSync(realTarget, agentsSkill);

  const snap = createHostSettingsManager({ homeDir: home, hubDir: hub }).getAntigravitySnapshot();
  const entry = snap.routingSkills.find(x => x.path === agentsSkill);
  assert.ok(entry);
  assert.equal(entry.error, 'symlink', 'symlinked SKILL.md must be flagged as symlink rather than followed');
  assert.equal(entry.managed, false);
  assert.equal(entry.sha256, null);
  assert.equal(snap.routingSkillsComplete, false, 'symlinked SKILL.md must set routingSkillsComplete=false');
  assert.ok(snap.error, 'antigravity snapshot must surface error when a routing skill is unsafe');
});

test('R-6-7 standalone syncOrchestrationDirectiveToHostsRaw preflights and rolls back all writes when any target fails', t => {
  const home = fixture(t), hub = path.join(home, '.t3/hub');
  const goodHost = path.join(home, 'good-AGENTS.md');
  const badHost = path.join(home, 'bad-AGENTS.md');
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(goodHost, '# good before\n');
  fs.writeFileSync(badHost, '# bad\n<!-- T3_HUB_ORCHESTRATOR_START -->\nunterminated\n');
  const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });

  const res = mgr.syncOrchestrationDirectiveToHostsRaw({
    configOverride: { policyVersion: 2, orchestratorMode: 'off', swarmMode: 'on', strictCommanderOnly: true },
    hosts: [goodHost, badHost],
  });
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true);
  assert.equal(fs.readFileSync(goodHost, 'utf8'), '# good before\n', 'goodHost must remain untouched/rolled back');
  assert.equal(fs.existsSync(path.join(hub, 'ACTIVE_ORCHESTRATION_MODE.md')), false, 'ACTIVE_ORCHESTRATION_MODE.md must not be left behind');
});

test('R-6-8 benign .DS_Store/.localized regular files are ignored across all 3 modules while symlinks or stray files fail closed', async t => {
  const { createHostSettingsManager } = require('../src/hub-host-settings.cjs');
  const home = fixture(t), hub = path.join(home, '.t3/hub'), host = path.join(home, 'AGENTS.md');
  const agyRoot = path.join(home, '.t3/userdata/providers/antigravity');
  fs.mkdirSync(hub, { recursive: true });
  fs.mkdirSync(path.join(agyRoot, 'inst1/config/skills'), { recursive: true });
  fs.mkdirSync(path.join(agyRoot, 'inst1/config/rules'), { recursive: true });
  fs.writeFileSync(path.join(agyRoot, 'inst1/config/rules/AGENTS.md'), '# agy\n');
  fs.writeFileSync(path.join(agyRoot, '.DS_Store'), '');
  fs.writeFileSync(path.join(agyRoot, '.localized'), '');
  fs.writeFileSync(host, '# host\n');

  const mgr = createSubagentsManager({ homeDir: home, hubDir: hub });
  const rev0 = mgr.getOrchestrationState({ hosts: [host] }).modeRevision;
  assert.equal(mgr.updateOrchestrationConfig({ swarmMode: 'on', expectedRevision: rev0 }, { hostRulePaths: [host] }).ok, true);
  const hsm = createHostSettingsManager({ homeDir: home, hubDir: hub });
  assert.equal(hsm.getAntigravitySnapshot().routingSkillsComplete, true, 'benign .DS_Store/.localized must not break routingSkillsComplete');

  // Replace .DS_Store with a symlink -> all 3 modules must fail closed
  fs.unlinkSync(path.join(agyRoot, '.DS_Store'));
  fs.symlinkSync(host, path.join(agyRoot, '.DS_Store'));
  const rev1 = mgr.getOrchestrationState({ hosts: [host] }).modeRevision;
  assert.equal(mgr.updateOrchestrationConfig({ swarmMode: 'off', expectedRevision: rev1 }, { hostRulePaths: [host] }).ok, false, 'symlink .DS_Store must fail closed in subagents');
  assert.equal(hsm.getAntigravitySnapshot().routingSkillsComplete, false, 'symlink .DS_Store must fail closed in host settings');

  // Restore .DS_Store and add a stray regular file -> backend discoverAntigravityRulesPaths must also fail closed
  fs.unlinkSync(path.join(agyRoot, '.DS_Store'));
  fs.writeFileSync(path.join(agyRoot, 'stray.txt'), 'rogue');
  const prevHome = process.env.HOME, prevHub = process.env.T3_HUB_DIR, prevT3 = process.env.T3CODE_HOME;
  process.env.HOME = home;
  process.env.T3_HUB_DIR = hub;
  delete process.env.T3CODE_HOME;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevHub === undefined) delete process.env.T3_HUB_DIR; else process.env.T3_HUB_DIR = prevHub;
    if (prevT3 === undefined) delete process.env.T3CODE_HOME; else process.env.T3CODE_HOME = prevT3;
  });
  const { hubCall } = require('../src/backend.cjs');
  const rpcRes = await hubCall('subagents:orchestration:update', { swarmMode: 'off', expectedRevision: rev1 });
  assert.equal(rpcRes.ok, false, 'stray non-directory in agyRoot must fail closed in backend');
});

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {createTaskBoard}=require('../src/hub-task-board.cjs');
const tid='12cdefab-1234-4234-9234-123456789abc';
function fixture(t,{child=false,worktree=false,nested=false}={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-plan-mirror-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const repo=path.join(dir,'repo');fs.mkdirSync(repo);const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:['ignore','pipe','ignore'],encoding:'utf8'});
 git('init','-q');let root=repo,working=null;
 if(worktree){git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','fixture');working=path.join(dir,'worktree');git('worktree','add','-qb','fixture',working);}
 if(nested){root=path.join(repo,'nested');fs.mkdirSync(root);}
 const home=path.join(dir,'home');fs.mkdirSync(home);const dbPath=path.join(home,'state.sqlite');const db=new DatabaseSync(dbPath);
 db.exec('CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT); CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_subagents(child_thread_id TEXT);');
 db.prepare('INSERT INTO projection_projects VALUES(?,?,NULL)').run('p',root);
 db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,NULL,?)').run(tid,'p','Private title','2026-01-01','2026-01-01',JSON.stringify({lineage:{parentThreadId:child?'parent':null},worktreePath:working}));db.close();
 const board=createTaskBoard({homeDir:home,t3DbPath:dbPath,agyBrainDirs:[],now:()=>Date.parse('2026-11-17T10:00:00Z')});
 const cwd=working||root;const file=path.join(cwd,'.t3-hub/plans',tid+'.json');
 return{dir,home,repo,root,cwd,file,git,board,dbPath,plan:{threadId:tid,projectRoot:root,title:'Secret title',background:'Secret background',steps:[{text:'First task',status:'completed',note:'Secret note'},{text:'Next task',status:'in_progress'}]}};
}
test('publishes only scoped steps in an ignored private mirror and preserves bytes on polling',async t=>{
 const f=fixture(t);f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();assert.ok(fs.existsSync(f.file));const data=JSON.parse(fs.readFileSync(f.file));
 assert.deepEqual(Object.keys(data).sort(),['schemaVersion','threadId','projectRoot','steps','progress','source','updatedAt'].sort());assert.equal(data.projectRoot,f.cwd);assert.equal(data.source,'hub-mcp');assert.equal(data.progress.completed,1);assert.equal(data.steps[0].note,undefined);assert.equal(fs.statSync(f.file).mode&0o777,0o600);
 assert.match(f.git('check-ignore','--',path.relative(f.repo,f.file)),/\.json/);assert.equal(f.git('status','--porcelain'),'');
 const before=fs.statSync(f.file).mtimeMs;f.board.getBoardSnapshot({threadId:tid,projectRoot:f.root,strictThreadMatch:true});await f.board.flushPlanMirrors();assert.equal(fs.statSync(f.file).mtimeMs,before);
 f.board.clearPlan({threadId:tid,projectRoot:f.root});await f.board.flushPlanMirrors();const clear=JSON.parse(fs.readFileSync(f.file));assert.equal(clear.cleared,true);assert.deepEqual(clear.steps,[]);
});
test('publishes into the authoritative worktree, including common Git exclusion',async t=>{const f=fixture(t,{worktree:true});f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();assert.ok(fs.existsSync(f.file));assert.equal(fs.existsSync(path.join(f.root,'.t3-hub')),false);});
test('nested project uses a repository-relative local ignore rule',async t=>{const f=fixture(t,{nested:true});f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();assert.ok(fs.existsSync(f.file));assert.equal(f.git('status','--porcelain'),'');});
test('child threads and wrong project bindings cannot publish',async t=>{const f=fixture(t,{child:true});f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();assert.equal(fs.existsSync(f.file),false);const other=path.join(f.dir,'other');fs.mkdirSync(other);f.board.updatePlan({...f.plan,projectRoot:other});await f.board.flushPlanMirrors();assert.equal(fs.existsSync(path.join(other,'.t3-hub')),false);});
test('refuses tracked and symlink mirror locations without failing home writes',async t=>{const f=fixture(t);fs.mkdirSync(path.dirname(f.file),{recursive:true});fs.writeFileSync(f.file,'tracked');f.git('add','-f','--',path.relative(f.repo,f.file));assert.doesNotThrow(()=>f.board.updatePlan(f.plan));await f.board.flushPlanMirrors();assert.equal(fs.readFileSync(f.file,'utf8'),'tracked');
 f.git('rm','--cached','-q','--',path.relative(f.repo,f.file));fs.rmSync(path.join(f.root,'.t3-hub'),{recursive:true});const target=path.join(f.dir,'outside');fs.mkdirSync(target);fs.symlinkSync(target,path.join(f.root,'.t3-hub'));f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();assert.deepEqual(fs.readdirSync(target),[]);
});
test('snapshot publishes an existing home plan after native binding becomes available',async t=>{const f=fixture(t);const db=new DatabaseSync(f.dbPath);db.prepare('DELETE FROM orchestration_v2_projection_threads').run();f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();assert.equal(fs.existsSync(f.file),false);db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,NULL,?)').run(tid,'p','title','2026-01-01','2026-01-01',JSON.stringify({lineage:{parentThreadId:null},worktreePath:null}));db.close();f.board.getBoardSnapshot({threadId:tid,projectRoot:f.root,strictThreadMatch:true});await f.board.flushPlanMirrors();assert.ok(fs.existsSync(f.file));});
test('clearing while native DB is unavailable retries from durable metadata after recovery',async t=>{
 const f=fixture(t);f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();fs.renameSync(f.dbPath,f.dbPath+'.away');f.board.clearPlan({threadId:tid,projectRoot:f.root});await f.board.flushPlanMirrors();assert.equal(JSON.parse(fs.readFileSync(f.file)).steps.length,2);fs.renameSync(f.dbPath+'.away',f.dbPath);
 const recovered=createTaskBoard({homeDir:f.home,t3DbPath:f.dbPath,agyBrainDirs:[]});await recovered.flushPlanMirrors();assert.equal(JSON.parse(fs.readFileSync(f.file)).cleared,true);
});
test('polling repairs a removed local ignore rule without changing plan bytes',async t=>{
 const f=fixture(t);f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();const bytes=fs.readFileSync(f.file,'utf8');fs.writeFileSync(path.join(f.repo,'.git/info/exclude'),'');f.board.getBoardSnapshot({threadId:tid,projectRoot:f.root});await f.board.flushPlanMirrors();assert.equal(f.git('status','--porcelain'),'');assert.equal(fs.readFileSync(f.file,'utf8'),bytes);
});
test('nested Git ignore metacharacters are escaped',async t=>{
 const f=fixture(t);const nested=path.join(f.root,'nested[1] *?');fs.mkdirSync(nested);const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE projection_projects SET workspace_root=?').run(nested);db.close();f.board.updatePlan({...f.plan,projectRoot:nested});await f.board.flushPlanMirrors();assert.ok(fs.existsSync(path.join(nested,'.t3-hub/plans',tid+'.json')));assert.equal(f.git('status','--porcelain'),'');
});
test('clearing an empty alias scope does not tombstone an authoritative workspace plan',async t=>{
 const f=fixture(t,{worktree:true});f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();assert.equal(f.board.clearPlan({threadId:tid,projectRoot:f.cwd}).deleted,0);await f.board.flushPlanMirrors();assert.equal(JSON.parse(fs.readFileSync(f.file)).steps.length,2);
});
test('a reused worktree path in another repository cannot receive private plan data',async t=>{
 const f=fixture(t);const unrelated=path.join(f.dir,'unrelated');fs.mkdirSync(unrelated);execFileSync('git',['init','-q'],{cwd:unrelated});const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE orchestration_v2_projection_threads SET payload_json=?').run(JSON.stringify({lineage:{parentThreadId:null},worktreePath:unrelated}));db.close();f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();assert.equal(fs.existsSync(path.join(unrelated,'.t3-hub')),false);
});
test('unmanaged mirror-name files are never overwritten',async t=>{
 const f=fixture(t);fs.mkdirSync(path.dirname(f.file),{recursive:true});fs.writeFileSync(f.file,'{"personal":"keep"}');f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();assert.equal(fs.readFileSync(f.file,'utf8'),'{"personal":"keep"}');
});
test('an oversized new plan replaces stale progress with an explicit unavailable state',async t=>{
 const f=fixture(t);f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();f.board.updatePlan({...f.plan,steps:[{text:'x'.repeat(260*1024),status:'pending'}]});await f.board.flushPlanMirrors();const data=JSON.parse(fs.readFileSync(f.file));assert.equal(data.source,'hub-unavailable');assert.deepEqual(data.steps,[]);
});
test('slow Git never delays home writes or blocks the event loop',async t=>{
 const f=fixture(t),bin=path.join(f.dir,'slow-bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'git'),'#!/bin/sh\nsleep 0.2\nexit 1\n',{mode:0o755});const prior=process.env.PATH;process.env.PATH=bin+path.delimiter+prior;
 try{const start=performance.now();f.board.updatePlan(f.plan);f.board.updatePlan({...f.plan,steps:[{text:'latest',status:'pending'}]});assert.ok(performance.now()-start<200);let tick=false;await new Promise(r=>setTimeout(()=>{tick=true;r()},10));assert.equal(tick,true);await f.board.flushPlanMirrors();}finally{process.env.PATH=prior;}
});
test('a higher-priority ignore negation safely removes only the managed workspace copy',async t=>{
 const f=fixture(t);f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();fs.writeFileSync(path.join(f.repo,'.gitignore'),'!/.t3-hub/\n!/.t3-hub/plans/\n!/.t3-hub/plans/*.json\n');f.board.getBoardSnapshot({threadId:tid,projectRoot:f.root});await f.board.flushPlanMirrors();assert.equal(fs.existsSync(f.file),false);assert.doesNotMatch(f.git('status','--porcelain','--untracked-files=all'),/\.t3-hub/);assert.ok(fs.readdirSync(path.join(f.home,'.t3/hub/task-plans')).some(n=>n.startsWith('.mirror-quarantine-')));f.board.disposePlanMirrors();
});
test('the same running instance retries a failed clear without a local snapshot',async t=>{
 const f=fixture(t);f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();fs.renameSync(f.dbPath,f.dbPath+'.away');f.board.clearPlan({threadId:tid,projectRoot:f.root});await f.board.flushPlanMirrors();fs.renameSync(f.dbPath+'.away',f.dbPath);await new Promise(r=>setTimeout(r,350));await f.board.flushPlanMirrors();assert.equal(JSON.parse(fs.readFileSync(f.file)).cleared,true);f.board.disposePlanMirrors();
});
test('clear intent exists before removing authority and survives a simulated interruption',async t=>{
 const f=fixture(t);f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();const store=path.join(f.home,'.t3/hub/task-plans');const original=fs.unlinkSync;let interrupted=false;
 fs.unlinkSync=function(file){if(String(file).startsWith(store)&&String(file).endsWith('.json')){original(file);interrupted=true;throw new Error('simulated interruption');}return original(file);};
 try{assert.throws(()=>f.board.clearPlan({threadId:tid,projectRoot:f.root}),/simulated interruption/);}finally{fs.unlinkSync=original;}
 assert.equal(interrupted,true);assert.ok(fs.readdirSync(store).some(n=>n.startsWith('.mirror-pending-')));const recovered=createTaskBoard({homeDir:f.home,t3DbPath:f.dbPath,agyBrainDirs:[]});await recovered.flushPlanMirrors();assert.equal(JSON.parse(fs.readFileSync(f.file)).cleared,true);recovered.disposePlanMirrors();
});
test('unknown pending metadata cannot block home saves or clear and is preserved',async t=>{
 const f=fixture(t);const store=path.join(f.home,'.t3/hub/task-plans');fs.mkdirSync(store,{recursive:true});const key=require('../src/hub-task-board.cjs').planFileKey({threadId:tid,projectRoot:f.root});const marker=path.join(store,'.mirror-pending-'+require('node:crypto').createHash('sha256').update(key).digest('hex'));fs.writeFileSync(marker,'personal sentinel');assert.doesNotThrow(()=>f.board.updatePlan(f.plan));await f.board.flushPlanMirrors();assert.equal(JSON.parse(fs.readFileSync(f.file)).steps.length,2);assert.equal(f.board.clearPlan({threadId:tid,projectRoot:f.root}).deleted,1);await f.board.flushPlanMirrors();assert.equal(JSON.parse(fs.readFileSync(f.file)).cleared,true);assert.equal(fs.readFileSync(marker,'utf8'),'personal sentinel');f.board.disposePlanMirrors();
});
test('child scopes cannot starve a later transient main-thread publication',async t=>{
 const f=fixture(t,{child:true}),db=new DatabaseSync(f.dbPath);for(let i=0;i<64;i++){const id='child-'+i;db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,NULL,?)').run(id,'p','child','2026-01-01','2026-01-01',JSON.stringify({lineage:{parentThreadId:tid},worktreePath:null}));f.board.updatePlan({...f.plan,threadId:id});}f.board.updatePlan({...f.plan,threadId:'main-later'});await f.board.flushPlanMirrors();db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,NULL,?)').run('main-later','p','main','2026-01-01','2026-01-01',JSON.stringify({lineage:{parentThreadId:null},worktreePath:null}));db.close();await new Promise(r=>setTimeout(r,350));await f.board.flushPlanMirrors();const mirrors=fs.readdirSync(path.dirname(f.file)).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(path.dirname(f.file),n))));assert.deepEqual(mirrors.map(p=>p.threadId),['main-later']);f.board.disposePlanMirrors();
});
test('clear intent still publishes a tombstone after a quarantined mirror is absent',async t=>{
 const f=fixture(t);f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();fs.writeFileSync(path.join(f.repo,'.gitignore'),'!/.t3-hub/\n!/.t3-hub/plans/\n!/.t3-hub/plans/*.json\n');f.board.getBoardSnapshot({threadId:tid,projectRoot:f.root});await f.board.flushPlanMirrors();assert.equal(fs.existsSync(f.file),false);f.board.clearPlan({threadId:tid,projectRoot:f.root});await f.board.flushPlanMirrors();fs.unlinkSync(path.join(f.repo,'.gitignore'));await new Promise(r=>setTimeout(r,350));await f.board.flushPlanMirrors();assert.equal(JSON.parse(fs.readFileSync(f.file)).cleared,true);f.board.disposePlanMirrors();
});
test('read polling never cancels a volatile clear retry during a Git outage',async t=>{
 const f=fixture(t);f.board.updatePlan(f.plan);await f.board.flushPlanMirrors();const store=path.join(f.home,'.t3/hub/task-plans');const key=require('../src/hub-task-board.cjs').planFileKey({threadId:tid,projectRoot:f.root});const marker=path.join(store,'.mirror-pending-'+require('node:crypto').createHash('sha256').update(key).digest('hex'));fs.writeFileSync(marker,'personal sentinel');const bin=path.join(f.dir,'down-git');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'git'),'#!/bin/sh\nexit 1\n',{mode:0o755});const prior=process.env.PATH;process.env.PATH=bin+path.delimiter+prior;
 try{f.board.clearPlan({threadId:tid,projectRoot:f.root});f.board.getBoardSnapshot({threadId:tid,projectRoot:f.root});await f.board.flushPlanMirrors();f.board.getBoardSnapshot({threadId:tid,projectRoot:f.root});await f.board.flushPlanMirrors();}finally{process.env.PATH=prior;}
 await new Promise(r=>setTimeout(r,350));await f.board.flushPlanMirrors();assert.equal(JSON.parse(fs.readFileSync(f.file)).cleared,true);assert.equal(fs.readFileSync(marker,'utf8'),'personal sentinel');f.board.disposePlanMirrors();
});
test('a later clear advances an existing tombstone past an unpublished newer plan',async t=>{
 const f=fixture(t);let now=Date.parse('2026-11-17T10:00:00Z');const board=createTaskBoard({homeDir:f.home,t3DbPath:f.dbPath,agyBrainDirs:[],now:()=>now});board.updatePlan(f.plan);await board.flushPlanMirrors();board.clearPlan({threadId:tid,projectRoot:f.root});await board.flushPlanMirrors();const initial=JSON.parse(fs.readFileSync(f.file)).updatedAt;
 fs.renameSync(f.dbPath,f.dbPath+'.away');now+=60000;board.updatePlan(f.plan);await board.flushPlanMirrors();now+=60000;board.clearPlan({threadId:tid,projectRoot:f.root});await board.flushPlanMirrors();fs.renameSync(f.dbPath+'.away',f.dbPath);await new Promise(r=>setTimeout(r,350));await board.flushPlanMirrors();const data=JSON.parse(fs.readFileSync(f.file));assert.equal(data.updatedAt,new Date(now).toISOString());assert.ok(data.updatedAt>initial);board.disposePlanMirrors();
});

test('mirrors threadless AGY t3_hub.plan_update turn_items across workspace and worktree without leaking private fields',async t=>{
 const f=fixture(t,{worktree:true});
 const db=new DatabaseSync(f.dbPath);
 db.exec('CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,type TEXT,status TEXT,updated_at TEXT,ordinal INTEGER,parent_item_id TEXT,payload_json TEXT);');
 const insert=db.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES(?,?,?,?,?,?,?)');
 // 1. Unrelated projectRoot must be ignored
 insert.run(tid,'dynamic_tool','completed','2026-11-17T10:05:00.000Z',1,null,JSON.stringify({
  type:'dynamic_tool',toolName:'t3_hub.plan_update',status:'completed',startedAt:'2026-11-17T10:05:00.000Z',
  input:{projectRoot:path.join(f.dir,'unrelated'),title:'Wrong',steps:[{text:'Do not mirror',status:'pending'}]}
 }));
 // 2. Threadless plan_update matching binding.cwd (worktree) with secret title/background/note
 insert.run(tid,'dynamic_tool','completed','2026-11-17T10:01:00.000Z',2,null,JSON.stringify({
  type:'dynamic_tool',toolName:'t3_hub.plan_update',status:'completed',startedAt:'2026-11-17T10:01:00.000Z',
  input:{projectRoot:f.cwd,title:'Secret AGY Title',background:'Secret AGY Background',steps:[{text:'Step from worktree',status:'completed',note:'Private note'},{text:'Step two',status:'in_progress'}]}
 }));
 db.close();

 f.board.getBoardSnapshot({threadId:tid,projectRoot:f.root,strictThreadMatch:true});
 await f.board.flushPlanMirrors();
 assert.ok(fs.existsSync(f.file));
 const data=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.deepEqual(Object.keys(data).sort(),['schemaVersion','threadId','projectRoot','steps','progress','source','updatedAt'].sort());
 assert.equal(data.schemaVersion,1);
 assert.equal(data.source,'hub-mcp');
 assert.equal(data.projectRoot,f.cwd);
 assert.equal(data.steps.length,2);
 assert.equal(data.steps[0].text,'Step from worktree');
 assert.equal(data.steps[0].note,undefined);
 assert.equal(data.title,undefined);
 assert.equal(data.background,undefined);
 assert.equal(f.git('status','--porcelain'),'');

 // 3. Newer threadless plan_update with no projectRoot at all also updates the mirror
 const db2=new DatabaseSync(f.dbPath);
 db2.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES(?,?,?,?,?,?,?)').run(
  tid,'mcp_tool_call','completed','2026-11-17T10:02:00.000Z',3,null,JSON.stringify({
   type:'mcp_tool_call',serverName:'t3_hub',toolName:'plan_update',status:'completed',startedAt:'2026-11-17T10:02:00.000Z',
   input:{steps:[{text:'No-root step',status:'completed'}]}
  })
 );
 db2.close();
 f.board.getBoardSnapshot({threadId:tid,projectRoot:f.root,strictThreadMatch:true});
 await f.board.flushPlanMirrors();
 const data2=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.equal(data2.steps.length,1);
 assert.equal(data2.steps[0].text,'No-root step');
 assert.equal(data2.source,'hub-mcp');
 f.board.disposePlanMirrors();
});

test('mirrors agy-brain task.md steps only, never raw implementation_plan.md, and competes fairly with clearPlan tombstones',async t=>{
 const f=fixture(t);
 const brainRoot=path.join(f.home,'agy-brain');
 const nativeId='agy-conv-native-42';
 const sessionDir=path.join(brainRoot,nativeId);
 fs.mkdirSync(sessionDir,{recursive:true});

 const db=new DatabaseSync(f.dbPath);
 db.exec('CREATE TABLE orchestration_v2_projection_provider_threads(thread_id TEXT,payload_json TEXT,provider_session_id TEXT);');
 db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?)').run(
  tid,JSON.stringify({nativeThreadRef:{nativeId}}),nativeId
 );
 db.close();

 let now=Date.parse('2026-11-17T10:00:00.000Z');
 const board=createTaskBoard({homeDir:f.home,t3DbPath:f.dbPath,agyBrainDirs:[brainRoot],now:()=>now});
 t.after(()=>board.disposePlanMirrors());

 // 1. Only implementation_plan.md present (no steps) -> must NOT create a mirror
 const implPath=path.join(sessionDir,'implementation_plan.md');
 fs.writeFileSync(implPath,'# Private Architecture Plan\n\nSensitive implementation prose.\n');
 const implTime=new Date(now);
 fs.utimesSync(implPath,implTime,implTime);
 board.getBoardSnapshot({threadId:tid,projectRoot:f.root,strictThreadMatch:true});
 await board.flushPlanMirrors();
 assert.equal(fs.existsSync(f.file),false,'Raw implementation_plan.md must never be mirrored');

 // 2. Add task.md with checkbox steps newer than implementation_plan.md -> mirrored as strict 7-field hub-mcp schema
 const taskPath=path.join(sessionDir,'task.md');
 fs.writeFileSync(taskPath,'# Brain Title\n- [x] Parsed step one\n- [/] Parsed step two\n');
 const taskTime=new Date(now+10_000);
 fs.utimesSync(taskPath,taskTime,taskTime);
 board.getBoardSnapshot({threadId:tid,projectRoot:f.root,strictThreadMatch:true});
 await board.flushPlanMirrors();
 assert.ok(fs.existsSync(f.file));
 const mirrored=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.deepEqual(Object.keys(mirrored).sort(),['schemaVersion','threadId','projectRoot','steps','progress','source','updatedAt'].sort());
 assert.equal(mirrored.source,'hub-mcp');
 assert.deepEqual(mirrored.steps.map(s=>[s.text,s.status]),[['Parsed step one','completed'],['Parsed step two','in_progress']]);
 assert.equal(f.git('status','--porcelain'),'');

 // 3. clearPlan at same timestamp beats task.md (tie favors cleared) and polling does not resurrect older task.md
 now=taskTime.getTime();
 board.clearPlan({threadId:tid,projectRoot:f.root});
 await board.flushPlanMirrors();
 const cleared=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.equal(cleared.source,'hub-clear');
 assert.equal(cleared.cleared,true);
 assert.deepEqual(cleared.steps,[]);

 now+=5_000;
 board.getBoardSnapshot({threadId:tid,projectRoot:f.root,strictThreadMatch:true});
 await board.flushPlanMirrors();
 const afterPoll=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.equal(afterPoll.cleared,true,'Polling must not resurrect older task.md over tombstone');
 assert.equal(afterPoll.updatedAt,cleared.updatedAt);

 // 4. Newer task.md after tombstone supersedes the cleared mirror
 const newerTime=new Date(now+10_000);
 fs.writeFileSync(taskPath,'# Brain Title\n- [x] Fresh step after clear\n');
 fs.utimesSync(taskPath,newerTime,newerTime);
 board.getBoardSnapshot({threadId:tid,projectRoot:f.root,strictThreadMatch:true});
 await board.flushPlanMirrors();
 const revived=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.equal(revived.source,'hub-mcp');
 assert.equal(revived.cleared,undefined);
 assert.deepEqual(revived.steps.map(s=>s.text),['Fresh step after clear']);

 // 5. Updating implementation_plan.md to a newer timestamp must NOT overwrite task.md mirror with hub-clear
 const implNewer=new Date(newerTime.getTime()+30_000);
 fs.writeFileSync(implPath,'# Newer Implementation Plan\n\nUpdated long prose.\n');
 fs.utimesSync(implPath,implNewer,implNewer);
 board.getBoardSnapshot({threadId:tid,projectRoot:f.root,strictThreadMatch:true});
 await board.flushPlanMirrors();
 const afterImplUpdate=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.equal(afterImplUpdate.source,'hub-mcp');
 assert.equal(afterImplUpdate.cleared,undefined);
 assert.deepEqual(afterImplUpdate.steps.map(s=>s.text),['Fresh step after clear']);

 // 6. Empty task.md without a real clear intent must preserve existing valid mirror rather than synthesizing hub-clear
 fs.writeFileSync(taskPath,'# Empty Brain Note\n');
 const emptyTime=new Date(implNewer.getTime()+10_000);
 fs.utimesSync(taskPath,emptyTime,emptyTime);
 board.getBoardSnapshot({threadId:tid,projectRoot:f.root,strictThreadMatch:true});
 await board.flushPlanMirrors();
 const preserved=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.equal(preserved.source,'hub-mcp');
 assert.equal(preserved.cleared,undefined);
 assert.deepEqual(preserved.steps.map(s=>s.text),['Fresh step after clear']);
});

test('rejects untrusted MCP namespaces and non-completed plan_update tool statuses',async t=>{
 const f=fixture(t);
 const db=new DatabaseSync(f.dbPath);
 db.exec('CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,type TEXT,status TEXT,updated_at TEXT,ordinal INTEGER,parent_item_id TEXT,payload_json TEXT);');
 const insert=db.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES(?,?,?,?,?,?,?)');
 // Trusted completed baseline
 insert.run(tid,'dynamic_tool','completed','2026-11-17T10:01:00.000Z',1,null,JSON.stringify({
  type:'dynamic_tool',toolName:'t3_hub.plan_update',status:'completed',startedAt:'2026-11-17T10:01:00.000Z',
  toolSource:{kind:'integration',key:'mcp:t3_hub'},
  input:{steps:[{text:'Trusted step',status:'in_progress'}]}
 }));
 // Adversarial: untrusted third-party MCP server (both dynamic_tool & mcp_tool_call)
 insert.run(tid,'mcp_tool_call','completed','2026-11-17T10:05:00.000Z',2,null,JSON.stringify({
  type:'mcp_tool_call',serverName:'evil_mcp',toolName:'evil_mcp.plan_update',status:'completed',startedAt:'2026-11-17T10:05:00.000Z',
  toolSource:{kind:'integration',key:'mcp:evil_mcp'},
  input:{clear:true}
 }));
 // Adversarial: mismatched namespaces
 insert.run(tid,'dynamic_tool','completed','2026-11-17T10:06:00.000Z',3,null,JSON.stringify({
  type:'dynamic_tool',toolName:'evil_mcp.plan_update',status:'completed',startedAt:'2026-11-17T10:06:00.000Z',
  toolSource:{kind:'integration',key:'mcp:t3_hub'},
  input:{clear:true}
 }));
 // Adversarial: non-completed statuses (running / pending / in_progress / empty) with clear:true
 for (const [idx, badStatus] of ['running','in_progress','pending','starting',''].entries()) {
  insert.run(tid,'dynamic_tool',badStatus,'2026-11-17T10:07:00.000Z',4+idx,null,JSON.stringify({
   type:'dynamic_tool',toolName:'t3_hub.plan_update',status:badStatus,startedAt:'2026-11-17T10:07:00.000Z',
   toolSource:{kind:'integration',key:'mcp:t3_hub'},
   input:{clear:true}
  }));
 }
 db.close();

 const snap=f.board.getBoardSnapshot({threadId:tid,projectRoot:f.root,strictThreadMatch:true});
 assert.equal(snap.source,'t3-mcp-plan-update');
 assert.deepEqual(snap.steps.map(s=>s.text),['Trusted step']);
 await f.board.flushPlanMirrors();
 const mirrored=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.equal(mirrored.source,'hub-mcp');
 assert.equal(mirrored.cleared,undefined);
 assert.deepEqual(mirrored.steps.map(s=>s.text),['Trusted step']);
 f.board.disposePlanMirrors();
});

test('pure Connect session publishes task.md via queueActiveMainThreadMirrors and threadless updatePlan without local getBoardSnapshot',async t=>{
 const f=fixture(t);
 const brainRoot=path.join(f.home,'agy-brain');
 const nativeId='agy-connect-only-99';
 const sessionDir=path.join(brainRoot,nativeId);
 fs.mkdirSync(sessionDir,{recursive:true});

 const nowMs=Date.parse('2026-11-28T12:00:00.000Z');
 const staleTid='22cdefab-1234-4234-9234-123456789abc';
 const childTid='33cdefab-1234-4234-9234-123456789abc';
 const db=new DatabaseSync(f.dbPath);
 db.exec('CREATE TABLE orchestration_v2_projection_provider_threads(thread_id TEXT,payload_json TEXT,provider_session_id TEXT);');
 // Update main thread timestamp to recent (<24h), add stale (>24h) and child threads
 db.prepare('UPDATE orchestration_v2_projection_threads SET updated_at=? WHERE thread_id=?').run('2026-11-28T11:30:00.000Z',tid);
 db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,NULL,?)').run(
  staleTid,'p','Stale','2026-11-20T00:00:00.000Z','2026-11-20T00:00:00.000Z',JSON.stringify({lineage:{parentThreadId:null},worktreePath:null})
 );
 db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,NULL,?)').run(
  childTid,'p','Child','2026-11-28T11:50:00.000Z','2026-11-28T11:50:00.000Z',JSON.stringify({lineage:{parentThreadId:tid},worktreePath:null})
 );
 db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?)').run(
  tid,JSON.stringify({nativeThreadRef:{nativeId}}),nativeId
 );
 db.close();

 const taskPath=path.join(sessionDir,'task.md');
 fs.writeFileSync(taskPath,'# Connect Session\n- [x] Remote step 1\n- [ ] Remote step 2\n');
 const t1=new Date(nowMs-60_000);
 fs.utimesSync(taskPath,t1,t1);

 const board=createTaskBoard({homeDir:f.home,t3DbPath:f.dbPath,agyBrainDirs:[brainRoot],now:()=>nowMs});
 t.after(()=>board.disposePlanMirrors());

 // 1. Without calling getBoardSnapshot, queueActiveMainThreadMirrors discovers and mirrors the recent main thread only
 const queued=board.queueActiveMainThreadMirrors();
 assert.equal(queued,1);
 await board.flushPlanMirrors();
 assert.ok(fs.existsSync(f.file));
 assert.equal(fs.existsSync(path.join(f.cwd,'.t3-hub/plans',staleTid+'.json')),false);
 assert.equal(fs.existsSync(path.join(f.cwd,'.t3-hub/plans',childTid+'.json')),false);
 const m1=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.deepEqual(m1.steps.map(s=>s.text),['Remote step 1','Remote step 2']);

 // 2. Threadless updatePlan({ projectRoot }) also triggers active main thread mirror refresh
 fs.writeFileSync(taskPath,'# Connect Session\n- [x] Remote step 1\n- [x] Remote step 2\n');
 const t2=new Date(nowMs);
 fs.utimesSync(taskPath,t2,t2);
 board.updatePlan({projectRoot:f.root,steps:[{text:'Project draft',status:'pending'}]});
 await board.flushPlanMirrors();
 const m2=JSON.parse(fs.readFileSync(f.file,'utf8'));
 assert.equal(m2.progress.completed,2);
 assert.equal(f.git('status','--porcelain'),'');
});

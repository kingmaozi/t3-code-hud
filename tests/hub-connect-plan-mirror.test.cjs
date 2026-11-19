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

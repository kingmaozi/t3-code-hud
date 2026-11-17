"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTaskBoard } = require("../src/hub-task-board.cjs");
const { createArtifactAccess } = require("../src/hub-artifact-access.cjs");

test("session metadata exposes the document or directory, not its metadata JSON", (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-artifacts-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const brain = path.join(home, ".gemini", "antigravity", "brain");
  const session = path.join(brain, "thread-1");
  fs.mkdirSync(path.join(session, "reports"), { recursive: true });
  fs.writeFileSync(path.join(session, "task.md"), "# Task\n- [ ] Test\n");
  fs.writeFileSync(path.join(session, "plan.md"), "# Plan\n");
  fs.writeFileSync(path.join(session, "plan.md.metadata.json"), JSON.stringify({userFacing:true,summary:"Plan"}));
  fs.writeFileSync(path.join(session, "reports.metadata.json"), JSON.stringify({userFacing:true}));
  const dbPath=path.join(home,"state.sqlite"),project=path.join(home,"project");
  const db=new DatabaseSync(dbPath);
  db.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, project_id TEXT); CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT)");
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?)").run("thread-1","T","p");
  db.prepare("INSERT INTO projection_projects VALUES (?,?,NULL)").run("p",project);db.close();
  const board = createTaskBoard({ homeDir:home, agyBrainDirs:[brain], t3DbPath:dbPath, hubPlansDir:path.join(home,"plans") });
  const out = board.getBoardSnapshot({threadId:"thread-1",projectRoot:project,strictThreadMatch:true});
  assert.equal(out.artifacts.find(x=>x.name==="plan.md").path,path.join(session,"plan.md"));
  assert.equal(out.artifacts.find(x=>x.name==="reports").path,path.join(session,"reports"));
});

test("artifact actions preview Markdown and safely open folders/reveal other files", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-artifact-open-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const session = path.join(home,".gemini","antigravity","brain","thread-1");
  const outside = path.join(home,"outside");
  const project = path.join(home,"project-a"), otherProject = path.join(home,"project-b");
  fs.mkdirSync(path.join(session,"folder"),{recursive:true}); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(session,"note.md"),"# Preview\n");
  fs.writeFileSync(path.join(session,"output.pdf"),"PDF");
  fs.writeFileSync(path.join(outside,"secret.md"),"PRIVATE");
  fs.symlinkSync(path.join(outside,"secret.md"),path.join(session,"escape.md"));
  fs.writeFileSync(path.join(session,"large.md"),Buffer.alloc(256*1024+1,65));
  const names = ["note.md","output.pdf","folder","escape.md","missing.md","large.md"];
  const board = { verifyArtifactScope(q) { return {ok:q.projectRoot===project&&q.threadId==="thread-1",reason:"mismatch"}; }, getBoardSnapshot(q) { return {artifacts:q.projectRoot===project&&q.threadId==="thread-1"?names.map(name=>({name,path:path.join(session,name)})):[]}; } };
  const calls=[];
  const access=createArtifactAccess({homeDir:home,board,open:async(mode,target)=>{calls.push({mode,target});}});
  const input=(name,overrides={})=>({projectRoot:project,threadId:"thread-1",path:path.join(session,name),...overrides});
  const md=await access(input("note.md"));
  assert.deepEqual({kind:md.kind,content:md.content},{kind:"markdown",content:"# Preview\n"});
  assert.equal(calls.length,0);
  assert.equal((await access(input("note.md",{operation:"reveal"}))).kind,"revealed");
  assert.equal((await access(input("note.md",{operation:"folder"}))).kind,"revealed");
  assert.equal((await access(input("folder"))).kind,"revealed");
  assert.equal((await access(input("output.pdf"))).kind,"revealed");
  assert.deepEqual(calls.map(x=>x.mode),["reveal","reveal","reveal","reveal"]);
  assert.equal(calls[1].target, fs.realpathSync(path.join(session,"note.md")));
  const count=calls.length;
  for (const payload of [input("missing.md"),input("escape.md"),input("large.md"),input("../outside/secret.md"),input("note.md",{projectRoot:otherProject}),input("note.md",{threadId:"thread-2"}),input("note.md",{path:"https://example.com/"}),input("note.md",{operation:"execute"})]) {
    await assert.rejects(access(payload));
  }
  assert.equal(calls.length,count);
  const failing=createArtifactAccess({homeDir:home,board,open:async()=>{throw new Error("Finder unavailable");}});
  await assert.rejects(failing(input("folder")),/Finder unavailable/,"failed OS open must not report success");
  await assert.rejects(access(input("folder",{operation:"preview"})),/只可预览/,"legacy preview cannot open folders");
});

test("the installed AGY provider brain path is supported but unrelated T3 files are rejected", async (t) => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"t3-provider-artifact-"));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const session=path.join(home,".t3","userdata","providers","antigravity","provider","antigravity-acp","brain","thread");
  const unrelated=path.join(home,".t3","private","secret.md");
  fs.mkdirSync(session,{recursive:true});fs.mkdirSync(path.dirname(unrelated),{recursive:true});
  const document=path.join(session,"note.md");fs.writeFileSync(document,"# provider\n");fs.writeFileSync(unrelated,"PRIVATE");
  const board={verifyArtifactScope:()=>({ok:true}),getBoardSnapshot:()=>({artifacts:[{path:document},{path:unrelated}]})};
  const access=createArtifactAccess({homeDir:home,board,open:async()=>assert.fail("Markdown preview must not open an app")});
  const base={projectRoot:path.join(home,"project"),threadId:"thread"};
  assert.equal((await access({...base,path:document})).content,"# provider\n");
  await assert.rejects(access({...base,path:unrelated}),/暂不支持/);
});

test("actual Hub interaction previews escaped Markdown and requests Finder actions for that session", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../src/hub-drawer-ui.js"), "utf8");
  function fakeNode() { return { innerHTML:"", textContent:"", dataset:{}, style:{setProperty(){}}, hidden:false, isConnected:true, setAttribute(){}, querySelector(){return null}, querySelectorAll(){return []}, contains(){return false}, getBoundingClientRect(){return {width:0,height:0}}, classList:{add(){},remove(){},toggle(){},contains(){return false}} }; }
  const root = fakeNode(), content = fakeNode(), nodes = new Map();
  root.contains=()=>true;
  root.querySelector = (selector) => { if (!nodes.has(selector)) nodes.set(selector, fakeNode()); return nodes.get(selector); };
  const sandbox = {
    window:{dispatchEvent(){}}, document:{body:fakeNode(), hidden:false,activeElement:null,querySelectorAll:()=>[],querySelector:()=>null,getElementById:()=>null,documentElement:{lang:"zh"}},
    location:{pathname:"/threads/thread-1",href:"https://fixture.test/threads/thread-1",hash:""}, innerWidth:1280,innerHeight:800,getComputedStyle:()=>({visibility:"visible"}),
    CustomEvent:class {},localStorage:{getItem:()=>null,setItem(){}},setTimeout:()=>1,clearTimeout(){},console,
  };
  const expose = `if (opts.__testHarness) { root=opts.root; content=opts.content; handle=root.querySelector('#handle'); drawer=root.querySelector('#drawer'); contextLoading=false; return {state,cache,onClick,readArtifact,revealArtifact,renderBoardTab,switchProject(p,t){state.projectRoot=p;state.threadId=t;contextVersion++;state.artifact=null}}; }`;
  const instrumented = source.replace("    const api = {", expose + "\n    const api = {");
  assert.notEqual(instrumented,source);
  vm.runInNewContext(instrumented,sandbox);
  const calls=[]; let late=false; const replies=[];
  const ui=sandbox.window.__t3MountSidecarHub({__testHarness:true,root,content,hubRpc:async(action,payload)=>{
    calls.push({action,payload});
    if(late) return await new Promise(resolve => { replies.push(resolve); });
    if(payload.operation) return {ok:true,kind:"revealed"};
    return {ok:true,kind:"markdown",name:"note.md",content:"# <script>alert(1)</script>"};
  }});
  Object.assign(ui.state,{tab:"board",threadId:"thread-1",projectRoot:"/fixture/project",context:null,connected:true});
  ui.cache.board={artifacts:[{name:"note.md",path:"/fixture/note.md"}],steps:[],progress:{completed:0,total:0}};
  await ui.readArtifact(0,null);
  assert.equal(calls[0].action,"board:openArtifact");
  assert.equal(calls[0].payload.threadId,"thread-1");
  assert.match(content.innerHTML,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(content.innerHTML,/打开所在文件夹/);
  assert.match(content.innerHTML,/在 Finder 中显示/);
  assert.match(content.innerHTML,/data-action="close-artifact"/);
  ui.cache.board.artifactScopeError="unknown";
  ui.renderBoardTab();
  assert.match(content.innerHTML,/暂无法核实会话归属，产物暂不可用/);
  delete ui.cache.board.artifactScopeError;
  await ui.revealArtifact(null,"folder");
  await ui.revealArtifact(null);
  assert.equal(calls[1].payload.operation,"folder");
  assert.equal(calls[2].payload.operation,"reveal");
  late=true;
  const pending=ui.readArtifact(0,null);
  ui.switchProject("/fixture/other-project","thread-2");
  replies.shift()({ok:true,kind:"markdown",name:"old.md",content:"wrong project"});
  await pending;
  assert.equal(ui.state.artifact,null,"late response from prior project must not be shown");
  const toast=root.querySelector(".hub-toast");
  toast.innerHTML="";
  ui.switchProject("/fixture/project","thread-1");
  const staleProjectFailure=ui.readArtifact(0,null);
  ui.switchProject("/fixture/other-project","thread-2");
  replies.shift()({ok:false,error:"old project failed"});
  await staleProjectFailure;
  assert.doesNotMatch(toast.innerHTML,/old project failed/,"old project failure must not appear in new project");
  ui.switchProject("/fixture/project","thread-1");
  ui.cache.board.artifacts=[{name:"a.md",path:"/fixture/a.md"},{name:"b.md",path:"/fixture/b.md"}];
  const first=ui.readArtifact(0,null), second=ui.readArtifact(1,null);
  const [replyA,replyB]=replies.splice(0);
  replyB({ok:true,kind:"markdown",name:"b.md",content:"B"});
  await second;
  assert.equal(ui.state.artifact.name,"b.md");
  replyA({ok:true,kind:"markdown",name:"a.md",content:"A"});
  await first;
  assert.equal(ui.state.artifact.name,"b.md","older click cannot overwrite newer selection");
  toast.innerHTML="";
  const staleSelectionFailure=ui.readArtifact(0,null), latestSuccess=ui.readArtifact(1,null);
  const [failA,successB]=replies.splice(0);
  successB({ok:true,kind:"markdown",name:"b.md",content:"B"});
  await latestSuccess;
  failA({ok:false,error:"old selection failed"});
  await staleSelectionFailure;
  assert.doesNotMatch(toast.innerHTML,/old selection failed/,"old click failure must not obscure current preview");
  const currentFailure=ui.readArtifact(0,null);
  replies.shift()({ok:false,error:"current preview failed"});
  await currentFailure;
  assert.match(toast.innerHTML,/current preview failed/,"current errors must remain visible");
  const closing=ui.readArtifact(0,null);
  const close={dataset:{action:"close-artifact"},closest(){return this}};
  ui.onClick({target:close});
  replies.shift()({ok:true,kind:"markdown",name:"a.md",content:"A"});
  await closing;
  assert.equal(ui.state.artifact,null,"closing preview cancels pending visual results");
});

test("actual backend route reads a strictly scoped listed artifact and rejects symlink escape", (t) => {
  const { spawnSync } = require("node:child_process");
  const { DatabaseSync } = require("node:sqlite");
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"t3-artifact-route-"));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const session=path.join(home,".gemini","antigravity","brain","thread-1");
  const project=path.join(home,"project"),outside=path.join(home,"outside");
  fs.mkdirSync(session,{recursive:true});fs.mkdirSync(project);fs.mkdirSync(outside);
  fs.writeFileSync(path.join(session,"task.md"),"# Task\n- [ ] Test\n");
  fs.writeFileSync(path.join(session,"plan.md"),"# Real preview\n");
  fs.writeFileSync(path.join(session,"plan.md.metadata.json"),JSON.stringify({userFacing:true}));
  fs.writeFileSync(path.join(outside,"secret.md"),"PRIVATE");
  fs.symlinkSync(path.join(outside,"secret.md"),path.join(session,"escape.md"));
  fs.writeFileSync(path.join(session,"escape.md.metadata.json"),JSON.stringify({userFacing:true}));
  fs.writeFileSync(path.join(session,"unlisted.md"),"not listed");
  const database=path.join(home,".t3","userdata","statev2.sqlite");
  fs.mkdirSync(path.dirname(database),{recursive:true});
  const db=new DatabaseSync(database);
  db.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, project_id TEXT); CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT)");
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?)").run("thread-1","Thread","project-1");
  db.prepare("INSERT INTO projection_projects VALUES (?,?,NULL)").run("project-1",project);
  db.close();
  const script = `
    (async()=>{
      const backend=require(process.argv[1]);
      const p={projectRoot:process.argv[2],threadId:'thread-1',strictThreadMatch:true};
      const board=await backend.hubCall('board:get',p);
      const item=board.artifacts.find(x=>x.name==='plan.md');
      const opened=await backend.hubCall('board:openArtifact',{...p,path:item.path});
      const escaped=await backend.hubCall('board:openArtifact',{...p,path:process.argv[3]});
      const wrong=await backend.hubCall('board:openArtifact',{...p,threadId:'thread-2',path:item.path});
      const legacy=await backend.hubCall('board:readArtifact',{...p,path:item.path});
      const legacyUnscoped=await backend.hubCall('board:readArtifact',{path:item.path});
      const legacyOtherProject=await backend.hubCall('board:readArtifact',{...p,projectRoot:process.argv[4],path:item.path});
      const legacyUnlisted=await backend.hubCall('board:readArtifact',{...p,path:process.argv[5]});
      const legacySymlink=await backend.hubCall('board:readArtifact',{...p,path:process.argv[3]});
      process.stdout.write(JSON.stringify({item,opened,escaped,wrong,legacy,legacyUnscoped,legacyOtherProject,legacyUnlisted,legacySymlink}));
    })().catch(e=>{process.stderr.write(String(e));process.exit(1)});`;
  const child=spawnSync(process.execPath,["-e",script,path.join(__dirname,"../src/backend.cjs"),project,path.join(session,"escape.md"),outside,path.join(session,"unlisted.md")],{
    encoding:"utf8",env:{...process.env,HOME:home,T3CODE_HOME:path.join(home,".t3","userdata"),T3_HUB_DIR:path.join(home,".t3","hub"),NODE_ENV:"test",T3_HUB_TEST:"1",T3_DISABLE_DREAM_SCHEDULER:"1"}
  });
  assert.equal(child.status,0,child.stderr);
  const out=JSON.parse(child.stdout);
  assert.equal(out.item.path,path.join(session,"plan.md"));
  assert.equal(out.opened.content,"# Real preview\n");
  assert.equal(out.escaped.ok,false);
  assert.equal(out.wrong.ok,false);
  assert.equal(out.legacy.content,"# Real preview\n","legacy Markdown route still works with verified context");
  assert.equal(out.legacyUnscoped.ok,false,"legacy Markdown route must reject missing context");
  assert.equal(out.legacyOtherProject.ok,false,"legacy Markdown route must reject foreign project");
  assert.equal(out.legacyUnlisted.ok,false,"legacy Markdown route must reject unlisted files");
  assert.equal(out.legacySymlink.ok,false,"legacy Markdown route must reject outside symlink");
});

test("real board fails closed on unknown or foreign project ownership, permits a verified owner", async (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"t3-owner-check-"));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const brain=path.join(home,".gemini","antigravity","brain"),session=path.join(brain,"thread-a");
  const projectA=path.join(home,"project-a"),projectB=path.join(home,"project-b"),dbPath=path.join(home,"state.sqlite");
  fs.mkdirSync(session,{recursive:true});fs.mkdirSync(projectA);fs.mkdirSync(projectB);
  fs.writeFileSync(path.join(session,"task.md"),"# A\n- [ ] Check\n");
  fs.writeFileSync(path.join(session,"private.md"),"project A content");
  fs.writeFileSync(path.join(session,"private.md.metadata.json"),JSON.stringify({userFacing:true,summary:"private A"}));
  const board=createTaskBoard({homeDir:home,agyBrainDirs:[brain],t3DbPath:dbPath,hubPlansDir:path.join(home,"plans")});
  const access=createArtifactAccess({homeDir:home,board,open:async()=>assert.fail("should not invoke Finder")});
  const input=(projectRoot)=>({projectRoot,threadId:"thread-a",path:path.join(session,"private.md")});
  const mustRejectUnknown=async()=>{
    await assert.rejects(access(input(projectA)),/无法核实/);
    await assert.rejects(access(input(projectB)),/无法核实/);
    const snapshot=board.getBoardSnapshot({...input(projectB),strictThreadMatch:true});
    assert.deepEqual(snapshot.artifacts,[]);
    assert.deepEqual(snapshot.steps,[],"unknown ownership must not read the AGY task.md plan");
    assert.equal(snapshot.background,"");
    assert.equal(snapshot.artifactScopeError,"unknown");
    const noProject=board.getBoardSnapshot({threadId:"thread-a",strictThreadMatch:true});
    assert.deepEqual(noProject.artifacts,[]);
    assert.deepEqual(noProject.steps,[]);
    assert.equal(noProject.background,"");
    assert.equal(noProject.artifactScopeError,"unknown");
  };
  await mustRejectUnknown();
  fs.writeFileSync(dbPath,"not a sqlite database");
  await mustRejectUnknown();
  fs.unlinkSync(dbPath);
  const db=new DatabaseSync(dbPath);
  db.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, project_id TEXT); CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT)");
  await mustRejectUnknown();
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?)").run("thread-a","A","p-a");
  await mustRejectUnknown();
  db.prepare("INSERT INTO projection_projects VALUES (?,?,NULL)").run("p-a",projectA);
  await assert.rejects(access(input(projectB)),/不属于/);
  assert.deepEqual(board.getBoardSnapshot({...input(projectB),strictThreadMatch:true}).artifacts,[]);
  assert.equal((await access(input(projectA))).content,"project A content");
  db.close();
});

test("unknown thread ownership blocks native plans, subagents and unscoped legacy plans", (t) => {
  const { DatabaseSync } = require("node:sqlite");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-board-scope-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dbPath = path.join(home, "state.sqlite"), projectRoot = path.join(home, "project-b");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, project_id TEXT);
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_plans (thread_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT, thread_id TEXT, status TEXT);
    INSERT INTO orchestration_v2_projection_threads VALUES ('thread-a','A','project-a');
    INSERT INTO orchestration_v2_projection_subagents VALUES ('private-child','thread-a','running');`);
  db.prepare("INSERT INTO orchestration_v2_projection_plans VALUES (?,?)").run("thread-a", JSON.stringify({ background: "private native background", steps: [{ text: "private native step" }] }));
  db.close();
  const board = createTaskBoard({ homeDir: home, t3DbPath: dbPath, hubPlansDir: path.join(home, "plans") });
  board.updatePlan({ threadId: "thread-a", background: "legacy private background", steps: [{ text: "legacy private step" }] });
  const query = { threadId: "thread-a", projectRoot, strictThreadMatch: true };
  const blocked = board.getBoardSnapshot(query);
  assert.deepEqual(blocked.steps, []);
  assert.deepEqual(blocked.subagents, []);
  assert.equal(blocked.background, "");
  assert.equal(blocked.artifactScopeError, "unknown");
  board.updatePlan({ ...query, background: "explicit project B plan", steps: [{ text: "B step" }] });
  const scoped = board.getBoardSnapshot(query);
  assert.equal(scoped.background, "explicit project B plan");
  assert.equal(scoped.steps[0].text, "B step");
  assert.deepEqual(scoped.subagents, []);
});

test("installer fallback includes the new artifact access module", (t) => {
  const { spawnSync }=require("node:child_process");
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"t3-artifact-install-"));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const src=path.join(temp,"source","src"),dest=path.join(temp,"installed");
  fs.mkdirSync(src,{recursive:true});fs.mkdirSync(dest,{recursive:true});
  const modulePath=path.join(__dirname,"../src/hub-artifact-access.cjs");
  fs.copyFileSync(modulePath,path.join(src,"hub-artifact-access.cjs"));
  const installer=fs.readFileSync(path.join(__dirname,"../install.sh"),"utf8");
  const loop=installer.match(/for f in hub-plugins\.cjs[^\n]*\n[^\n]*\ndone/);
  assert.ok(loop,"installer's sidecar fallback copy loop must be present");
  const run=spawnSync("/bin/bash",["-c",loop[0]],{encoding:"utf8",env:{...process.env,SCRIPT_DIR:path.dirname(src),DEST_DIR:dest}});
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(fs.readFileSync(path.join(dest,"hub-artifact-access.cjs")),fs.readFileSync(modulePath));
});

test("default macOS command reveals directories and application bundles via inode-pinned fileReferenceURL without launching them", async (t) => {
  const vm = require("node:vm");
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"t3-artifact-finder-"));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const session=path.join(home,".gemini","antigravity","brain","thread-1");
  const bundle=path.join(session,"Fixture.app"),folder=path.join(session,"folder"),document=path.join(session,"readme.md");
  fs.mkdirSync(path.join(bundle,"Contents"),{recursive:true});fs.mkdirSync(folder);fs.writeFileSync(document,"# Preview\n");
  const calls=[];
  const source=fs.readFileSync(path.join(__dirname,"../src/hub-artifact-access.cjs"),"utf8");
  const realChildProcess = require("node:child_process");
  const sandbox={module:{exports:{}},Buffer,process:{platform:"darwin"},require(name){
    if(name==="node:child_process") return {...realChildProcess,execFile(executable,args,callback){calls.push({executable,args:Array.from(args)});callback(null)}};
    return require(name);
  }};
  vm.runInNewContext(source,sandbox,{filename:"hub-artifact-access.cjs"});
  const board={verifyArtifactScope:()=>({ok:true}),getBoardSnapshot:()=>({artifacts:[bundle,folder,document].map(path=>({path}))})};
  const access=sandbox.module.exports.createArtifactAccess({homeDir:home,board});
  const base={projectRoot:path.join(home,"project"),threadId:"thread-1"};
  assert.equal((await access({...base,path:bundle})).kind,"revealed");
  assert.equal((await access({...base,path:folder})).kind,"revealed");
  assert.equal((await access({...base,path:document})).kind,"markdown");
  assert.equal((await access({...base,path:document,operation:"folder"})).kind,"revealed");
  assert.deepEqual(calls.map(x=>x.executable),["/usr/bin/open","/usr/bin/open","/usr/bin/open"]);
  const inodes=[`${fs.lstatSync(bundle).ino}/`,`${fs.lstatSync(folder).ino}/`,`${fs.lstatSync(document).ino}`];
  calls.forEach((call,i)=>{
    assert.equal(call.args.length,3);
    assert.equal(call.args[0],"-R");
    assert.equal(call.args[1],"-u");
    assert.match(call.args[2],/^file:\/\/\/\.file\/id=\d+\.\d+\/?$/);
    assert.ok(call.args[2].endsWith(`.${inodes[i]}`),`expected ${call.args[2]} to end with .${inodes[i]}`);
  });
});

test("Issue #8 recheck5 [4]: Finder reveal passes inode-pinned fileReferenceURL that resolves to original inode even after ancestor swap", async (t) => {
  if (process.platform !== "darwin") return;
  const vm = require("node:vm");
  const realChildProcess = require("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-artifact-fileref-swap-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const session = path.join(home, ".gemini", "antigravity", "brain", "thread-1");
  const outside = path.join(home, "outside");
  fs.mkdirSync(session, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const doc = path.join(session, "readme.md");
  const decoy = path.join(outside, "readme.md");
  fs.writeFileSync(doc, "# Trusted\n");
  fs.writeFileSync(decoy, "# Decoy\n");
  const origIno = String(fs.lstatSync(doc).ino);
  let capturedArgs = null;
  const source = fs.readFileSync(path.join(__dirname, "../src/hub-artifact-access.cjs"), "utf8");
  const sandbox = {
    module: { exports: {} }, Buffer, process: { platform: "darwin" },
    require(name) {
      if (name === "node:child_process") {
        return {
          ...realChildProcess,
          execFile(_exec, args, callback) {
            capturedArgs = Array.from(args);
            callback(null);
          },
        };
      }
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: "hub-artifact-access.cjs" });
  const board = { verifyArtifactScope: () => ({ ok: true }), getBoardSnapshot: () => ({ artifacts: [{ path: doc }] }) };
  const access = sandbox.module.exports.createArtifactAccess({ homeDir: home, board });
  await access({ projectRoot: path.join(home, "project"), threadId: "thread-1", path: doc, operation: "reveal" });
  assert.ok(Array.isArray(capturedArgs));
  assert.equal(capturedArgs[0], "-R");
  assert.equal(capturedArgs[1], "-u");
  assert.ok(capturedArgs[2].endsWith(`.${origIno}`));
  // Swap ancestor directory AFTER open was invoked with the fileReferenceURL:
  const movedSession = path.join(home, ".gemini", "antigravity", "brain", "session-moved");
  fs.renameSync(session, movedSession);
  fs.symlinkSync(outside, session, "dir");
  const resolvePy = [
    "import ctypes, sys, urllib.parse",
    "cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')",
    "cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]",
    "cf.CFStringCreateWithCString.restype = ctypes.c_void_p",
    "cf.CFURLCreateWithString.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]",
    "cf.CFURLCreateWithString.restype = ctypes.c_void_p",
    "cf.CFURLCreateFilePathURL.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]",
    "cf.CFURLCreateFilePathURL.restype = ctypes.c_void_p",
    "cf.CFURLGetString.argtypes = [ctypes.c_void_p]",
    "cf.CFURLGetString.restype = ctypes.c_void_p",
    "cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]",
    "cf.CFStringGetCString.restype = ctypes.c_ubyte",
    "s = cf.CFStringCreateWithCString(None, sys.argv[1].encode(), 0x08000100)",
    "u = cf.CFURLCreateWithString(None, s, None)",
    "p = cf.CFURLCreateFilePathURL(None, u, None)",
    "b = ctypes.create_string_buffer(4096)",
    "cf.CFStringGetCString(cf.CFURLGetString(p), b, 4096, 0x08000100)",
    "sys.stdout.write(urllib.parse.unquote(urllib.parse.urlparse(b.value.decode()).path))",
  ].join("\n");
  const resolved = realChildProcess.spawnSync("/usr/bin/python3", ["-I", "-c", resolvePy, capturedArgs[2]], { encoding: "utf8" });
  assert.equal(resolved.status, 0);
  assert.equal(fs.realpathSync(resolved.stdout.trim()), fs.realpathSync(path.join(movedSession, "readme.md")));
});

test("Issue #8 recheck6 [3]: Darwin fileReferenceURL resolution falls back to next executable Python interpreter when /usr/bin/python3 fails", async (t) => {
  if (process.platform !== "darwin") return;
  const vm = require("node:vm");
  const realChildProcess = require("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-artifact-py-fallback-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const session = path.join(home, ".gemini", "antigravity", "brain", "session-py-fallback");
  fs.mkdirSync(session, { recursive: true });
  const doc = path.join(session, "plan.md");
  fs.writeFileSync(doc, "# Fallback test\n");
  const docIno = String(fs.lstatSync(doc).ino);

  const triedPythons = [];
  let capturedOpenArgs = null;
  const source = fs.readFileSync(path.join(__dirname, "../src/hub-artifact-access.cjs"), "utf8");
  const fakeStatSync = (target, ...rest) => {
    if (target === "/usr/bin/python3" || target === "/opt/homebrew/bin/python3") {
      return { isFile: () => true, mode: 0o100755 };
    }
    if (target === "/bin/python3") {
      const e = new Error("ENOENT"); e.code = "ENOENT"; throw e;
    }
    return fs.statSync(target, ...rest);
  };
  const sandbox = {
    module: { exports: {} }, Buffer, process: { platform: "darwin" },
    require(name) {
      if (name === "node:fs") return { ...fs, statSync: fakeStatSync };
      if (name === "node:child_process") {
        return {
          ...realChildProcess,
          spawnSync(cmd, args, opts) {
            triedPythons.push(cmd);
            if (cmd === "/usr/bin/python3") return { status: 1, stdout: "", stderr: "xcrun stub error" };
            if (cmd === "/opt/homebrew/bin/python3") return realChildProcess.spawnSync("/usr/bin/python3", args, opts);
            return { status: 1, stdout: "", stderr: "unexpected" };
          },
          execFile(_exec, args, callback) {
            capturedOpenArgs = Array.from(args);
            callback(null);
          },
        };
      }
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: "hub-artifact-access.cjs" });
  const board = { verifyArtifactScope: () => ({ ok: true }), getBoardSnapshot: () => ({ artifacts: [{ path: doc }] }) };
  const access = sandbox.module.exports.createArtifactAccess({ homeDir: home, board });
  await access({ projectRoot: path.join(home, "project"), threadId: "thread-1", path: doc, operation: "reveal" });
  assert.deepEqual(triedPythons, ["/usr/bin/python3", "/opt/homebrew/bin/python3"]);
  assert.ok(Array.isArray(capturedOpenArgs));
  assert.equal(capturedOpenArgs[0], "-R");
  assert.equal(capturedOpenArgs[1], "-u");
  assert.ok(capturedOpenArgs[2].endsWith(`.${docIno}`));
});

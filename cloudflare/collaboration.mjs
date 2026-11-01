/**
 * AI Forum collaboration V3: public projects, membership, tasks, and review.
 * This module does not execute code, access GitHub write APIs, or grant privileges.
 * All project data in this first iteration is PUBLIC. Private workspaces require
 * a separate audited authorization design before being enabled.
 */
const MAX_LIST=60;
const titleField=(v,a=5,b=120)=>typeof v==='string'&&v.trim().length>=a&&v.trim().length<=b&&!/[\u0000-\u001f]/.test(v)?v.trim():null;
const iso=()=>new Date().toISOString();
const recentDay=()=>new Date(Date.now()-86400000).toISOString();
const projectDTO=p=>({
  id:p.id,title:p.title,description:p.description,goal:p.goal,repositoryUrl:p.repository_url,
  status:p.status,createdAt:p.created_at,createdBy:p.created_by,voluntary:p.voluntary===1,
  memberCount:p.member_count??0,taskCount:p.task_count??0
});
const taskDTO=t=>({
  id:t.id,projectId:t.project_id,title:t.title,description:t.description,
  status:t.status,createdBy:t.created_by,assigneeId:t.assignee_id,
  submission:t.submission||null,createdAt:t.created_at,updatedAt:t.updated_at,
  version:t.version
});
function failure(status,message){return {status,body:{error:message}};}
const projectPath=/^\/api\/projects\/([a-z0-9][a-z0-9-]{1,79})$/;
const tasksPath=/^\/api\/projects\/([a-z0-9][a-z0-9-]{1,79})\/tasks$/;
const taskActionPath=/^\/api\/projects\/([a-z0-9][a-z0-9-]{1,79})\/tasks\/([\w-]+)\/(claim|submit)$/;
const adminProjectPath=/^\/api\/admin\/projects\/([\w-]+)\/(approve|reject)$/;
const adminTaskPath=/^\/api\/admin\/projects\/([a-z0-9][a-z0-9-]{1,79})\/tasks\/([\w-]+)\/review$/;

export function createCollaboration(deps){
  const {all,first,run,json,readBody,requireAgent,requireAdmin,emit}=deps;
  const fail=(status,message)=>{throw failure(status,message);};
  async function activeProject(db,id){
    const p=await first(db,"SELECT * FROM collab_projects WHERE id=? AND status='active' AND visibility='public'",id);
    if(!p)fail(404,'Projeto não encontrado ou indisponível');
    return p;
  }
  async function member(db,pid,agentId){
    return Boolean(await first(db,'SELECT agent_id FROM project_members WHERE project_id=? AND agent_id=?',pid,agentId));
  }
  async function activity(db,pid,actor,type,data){
    const payload=JSON.stringify(data);
    const time=iso();
    await run(db,'INSERT INTO collaboration_activity(id,project_id,actor_id,event_type,details,created_at) VALUES (?,?,?,?,?,?)',crypto.randomUUID(),pid,actor,type,payload,time);
    // The existing authenticated forum event API can wake up participant runners.
    await emit(db,'project.'+type,{projectId:pid,actorId:actor});
  }
  async function getTasks(db,pid){
    const rows=await all(db,'SELECT * FROM project_tasks WHERE project_id=? ORDER BY created_at DESC LIMIT ?',pid,MAX_LIST);
    return rows.map(taskDTO);
  }
  async function handle(req,env,url){
    const db=env.DB,method=req.method,path=url.pathname;
    if(method==='GET'&&path==='/api/projects'){
      const rows=await all(db,"SELECT p.*, (SELECT COUNT(*) FROM project_members m WHERE m.project_id=p.id) AS member_count, (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id=p.id) AS task_count FROM collab_projects p WHERE p.status='active' AND p.visibility='public' ORDER BY p.voluntary ASC,p.created_at ASC LIMIT ?",MAX_LIST);
      return json({projects:rows.map(projectDTO),visibility:'public-only',policy:'NewEraOfWorld is entirely optional'});
    }
    if(method==='GET'&&path==='/api/activity'){
      const pid=url.searchParams.get('projectId')||'';
      if(!/^[a-z0-9][a-z0-9-]{1,79}$/.test(pid))fail(400,'Informe um projectId válido');
      await activeProject(db,pid);
      const rows=await all(db,'SELECT id,project_id,actor_id,event_type,details,created_at FROM collaboration_activity WHERE project_id=? ORDER BY created_at DESC LIMIT ?',pid,80);
      return json({projectId:pid,activity:rows.map(a=>({id:a.id,actorId:a.actor_id,event:a.event_type,details:JSON.parse(a.details),at:a.created_at}))});
    }
    if(method==='GET'&&projectPath.test(path)){
      const id=path.match(projectPath)[1];
      const p=await activeProject(db,id);
      const [count,taskRows]=await Promise.all([
        first(db,'SELECT COUNT(*) AS n FROM project_members WHERE project_id=?',id),
        getTasks(db,id)
      ]);
      return json({project:{...projectDTO(p),memberCount:count.n,taskCount:taskRows.length},tasks:taskRows});
    }
    if(method==='GET'&&tasksPath.test(path)){
      const pid=path.match(tasksPath)[1];await activeProject(db,pid);
      return json({projectId:pid,tasks:await getTasks(db,pid)});
    }
    if(method==='POST'&&path==='/api/projects/proposals'){
      const agent=await requireAgent(req,db),body=await readBody(req);
      const title=titleField(body.title,5,100),description=titleField(body.description,20,1200),goal=titleField(body.goal,10,500);
      if(!title||!description||!goal)fail(400,'Título, descrição e objetivo válidos são obrigatórios');
      const count=await first(db,"SELECT COUNT(*) AS n FROM collab_projects WHERE created_by=? AND created_at>=?",agent.id,recentDay());
      if(count.n>=3)fail(429,'Limite de 3 propostas por dia');
      let repositoryUrl=null;
      if(body.repositoryUrl!==undefined&&body.repositoryUrl!==null&&body.repositoryUrl!==''){
        if(typeof body.repositoryUrl!=='string'||body.repositoryUrl.length>300)fail(400,'URL de repositório inválida');
        try{
          const u=new URL(body.repositoryUrl);
          if(u.protocol!=='https:'||u.hostname.toLowerCase()!=='github.com'||u.username||u.password||u.search||u.hash)throw Error();
          if(!/^\/[\w.-]+\/[\w.-]+\/?$/.test(u.pathname))throw Error();
          repositoryUrl=u.toString();
        }catch{fail(400,'Use uma URL pública de repositório GitHub válida');}
      }
      const id=crypto.randomUUID(),createdAt=iso();
      await run(db,'INSERT INTO collab_projects(id,title,description,goal,repository_url,visibility,status,voluntary,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',id,title,description,goal,repositoryUrl,'public','proposed',0,agent.id,createdAt);
      return json({proposal:{id,title,status:'proposed',requiresHumanApproval:true}},201);
    }
    if(method==='POST'&&/^\/api\/projects\/[a-z0-9][a-z0-9-]{1,79}\/join$/.test(path)){
      const pid=path.split('/')[3],agent=await requireAgent(req,db);
      await activeProject(db,pid);
      const existing=await member(db,pid,agent.id);
      if(existing)return json({joined:true,projectId:pid,alreadyMember:true});
      const limit=await first(db,'SELECT COUNT(*) AS n FROM project_members WHERE project_id=?',pid);
      if(limit.n>=100)fail(429,'Projeto atingiu limite inicial de participantes');
      await run(db,'INSERT OR IGNORE INTO project_members(project_id,agent_id,role,joined_at) VALUES (?,?,?,?)',pid,agent.id,'contributor',iso());
      await activity(db,pid,agent.id,'joined',{role:'contributor'});
      return json({joined:true,projectId:pid,role:'contributor'},201);
    }
    if(method==='POST'&&tasksPath.test(path)){
      const pid=path.match(tasksPath)[1],agent=await requireAgent(req,db);
      await activeProject(db,pid);
      if(!await member(db,pid,agent.id))fail(403,'Participe do projeto antes de criar tarefas');
      const body=await readBody(req),title=titleField(body.title,5,120),description=titleField(body.description,10,2000);
      if(!title||!description)fail(400,'Título e descrição de tarefa obrigatórios');
      const count=await first(db,'SELECT COUNT(*) AS n FROM project_tasks WHERE created_by=? AND created_at>=?',agent.id,recentDay());
      if(count.n>=10)fail(429,'Limite de 10 tarefas criadas por dia');
      const id=crypto.randomUUID(),timestamp=iso();
      await run(db,"INSERT INTO project_tasks(id,project_id,title,description,status,created_by,created_at,updated_at) VALUES (?,?,?,?,'open',?,?,?)",id,pid,title,description,agent.id,timestamp,timestamp);
      await activity(db,pid,agent.id,'task.created',{taskId:id,title});
      return json({task:{id,projectId:pid,title,description,status:'open',createdBy:agent.id,assigneeId:null,version:1}},201);
    }
    if(method==='POST'&&taskActionPath.test(path)){
      const [,pid,tid,action]=path.match(taskActionPath),agent=await requireAgent(req,db);
      await activeProject(db,pid);
      if(!await member(db,pid,agent.id))fail(403,'Apenas membros podem trabalhar em tarefas');
      const task=await first(db,'SELECT * FROM project_tasks WHERE id=? AND project_id=?',tid,pid);
      if(!task)fail(404,'Tarefa não encontrada');
      const time=iso();
      if(action==='claim'){
        const result=await run(db,"UPDATE project_tasks SET status='claimed',assignee_id=?,updated_at=?,version=version+1 WHERE id=? AND project_id=? AND status='open' AND assignee_id IS NULL",agent.id,time,tid,pid);
        if(!result.meta?.changes)fail(409,'Tarefa já atribuída ou indisponível');
        await activity(db,pid,agent.id,'task.claimed',{taskId:tid});
        return json({taskId:tid,status:'claimed',assigneeId:agent.id});
      }
      const content=await readBody(req),submission=titleField(content.summary,20,2500);
      if(!submission)fail(400,'Resumo de entrega entre 20 e 2500 caracteres obrigatório');
      const result=await run(db,"UPDATE project_tasks SET status='submitted',submission=?,updated_at=?,version=version+1 WHERE id=? AND project_id=? AND status='claimed' AND assignee_id=?",submission,time,tid,pid,agent.id);
      if(!result.meta?.changes)fail(409,'Tarefa indisponível ou atribuída a outro agente');
      await activity(db,pid,agent.id,'task.submitted',{taskId:tid,requiresHumanReview:true});
      return json({taskId:tid,status:'submitted',requiresHumanReview:true});
    }
    if(method==='GET'&&path==='/api/admin/projects'){
      await requireAdmin(req,env);
      const rows=await all(db,"SELECT * FROM collab_projects WHERE status='proposed' ORDER BY created_at DESC LIMIT ?",MAX_LIST);
      return json({proposals:rows.map(projectDTO)});
    }
    if(method==='POST'&&adminProjectPath.test(path)){
      await requireAdmin(req,env);
      const [,pid,decision]=path.match(adminProjectPath);
      const status=decision==='approve'?'active':'rejected';
      const result=await run(db,"UPDATE collab_projects SET status=?,reviewed_at=?,reviewed_by='admin' WHERE id=? AND status='proposed'",status,iso(),pid);
      if(!result.meta?.changes)fail(409,'Proposta indisponível ou já revisada');
      if(status==='active')await activity(db,pid,'admin','approved',{projectId:pid});
      return json({projectId:pid,status});
    }
    if(method==='POST'&&adminTaskPath.test(path)){
      await requireAdmin(req,env);
      const [,pid,tid]=path.match(adminTaskPath);
      await activeProject(db,pid);
      const body=await readBody(req);
      if(!['approve','reopen'].includes(body.decision))fail(400,'Decisão deve ser approve ou reopen');
      const status=body.decision==='approve'?'completed':'open';
      const result=await run(db,"UPDATE project_tasks SET status=?,assignee_id=CASE WHEN ?='open' THEN NULL ELSE assignee_id END,updated_at=?,version=version+1 WHERE id=? AND project_id=? AND status='submitted'",status,status,iso(),tid,pid);
      if(!result.meta?.changes)fail(409,'Tarefa não aguarda revisão');
      await activity(db,pid,'admin','task.reviewed',{taskId:tid,decision:body.decision});
      return json({taskId:tid,status,reviewedBy:'admin'});
    }
    return null;
  }
  return {handle};
}

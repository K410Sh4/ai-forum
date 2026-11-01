import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
function harness(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(ROOT,'cloudflare/migrations/0001_init.sql'),'utf8'));
  sqlite.exec(fs.readFileSync(path.join(ROOT,'cloudflare/migrations/0002_collaboration.sql'),'utf8'));
  const DB={
    prepare(sql){
      return {bind(...params){
        const stmt=sqlite.prepare(sql);
        return {
          async first(){return stmt.get(...params)||null;},
          async all(){return {results:stmt.all(...params)};},
          async run(){const info=stmt.run(...params);return {meta:{changes:Number(info.changes)}};}
        };
      }};
    }
  };
  const env={DB,ADMIN_KEY:'a'.repeat(64)};
  async function request(route,method='GET',payload,key){
    const headers={'Content-Type':'application/json'};
    if(key)headers.Authorization='Bearer '+key;
    const req=new Request('https://test.workers.dev'+route,{
      method,headers,body:payload===undefined?undefined:JSON.stringify(payload)
    });
    const resp=await worker.fetch(req,env);
    return {status:resp.status,data:await resp.json()};
  }
  return {request,close:()=>sqlite.close(),env};
}
async function register(request,name){
  const r=await request('/api/agents/register','POST',{
    name,model:'Test Agent',owner:'Human Operator',acceptReciprocity:true
  });
  assert.equal(r.status,201);
  const a=r.data;
  const approval=await request('/api/admin/agents/'+a.agent.id+'/approve','POST',undefined,'a'.repeat(64));
  assert.equal(approval.status,200);
  return a;
}

test('projects: separate voluntary NewEra, public-only catalog and access controls',async()=>{
  const {request,close}=harness();
  try {
    const list=await request('/api/projects');
    assert.equal(list.status,200);
    assert.equal(list.data.visibility,'public-only');
    const forum=list.data.projects.find(p=>p.id==='ai-forum');
    const era=list.data.projects.find(p=>p.id==='new-era-of-world');
    assert.equal(forum.voluntary,false);
    assert.equal(era.voluntary,true);
    assert.match(era.repositoryUrl,/K410Sh4\/NewEraOfWorld/);
    const anon=await request('/api/projects/new-era-of-world/join','POST',{});
    assert.equal(anon.status,401);
    assert.equal((await request('/api/projects/non-existent')).status,404);
  }finally{close();}
});

test('projects: human approval, join, atomic claim, submission, review and activity',async()=>{
  const {request,close}=harness();
  try{
    const alice=await register(request,'Alice V3');
    const bob=await register(request,'Bob V3');
    const payload={
      title:'Análise de documentação',
      description:'Um espaço de colaboração para testar documentação acessível e reproducibilidade.',
      goal:'Publicar propostas revisadas que facilitem o acesso ao fórum.',
      repositoryUrl:'https://github.com/K410Sh4/ai-forum'
    };
    const proposal=await request('/api/projects/proposals','POST',payload,alice.apiKey);
    assert.equal(proposal.status,201);
    const pid=proposal.data.proposal.id;
    assert.equal((await request('/api/projects/'+pid)).status,404,'Unapproved projects must not be public');
    assert.equal((await request('/api/admin/projects')).status,401);
    const approved=await request('/api/admin/projects/'+pid+'/approve','POST',undefined,'a'.repeat(64));
    assert.equal(approved.status,200);
    assert.equal(approved.data.status,'active');

    const beforeJoin=await request('/api/projects/'+pid+'/tasks','POST',{
      title:'Testar interface',description:'Revisar a navegação da aplicação.'
    },alice.apiKey);
    assert.equal(beforeJoin.status,403);
    assert.equal((await request('/api/projects/'+pid+'/join','POST',{},alice.apiKey)).status,201);
    assert.equal((await request('/api/projects/'+pid+'/join','POST',{},bob.apiKey)).status,201);

    const created=await request('/api/projects/'+pid+'/tasks','POST',{
      title:'Auditar navegação do fórum',
      description:'Verificar acessibilidade por teclado, foco e mensagens de feedback.'
    },alice.apiKey);
    assert.equal(created.status,201);
    const task=created.data.task.id;
    assert.equal((await request('/api/projects/'+pid+'/tasks/'+task+'/claim','POST',{},bob.apiKey)).status,200);
    const duplicate=await request('/api/projects/'+pid+'/tasks/'+task+'/claim','POST',{},alice.apiKey);
    assert.equal(duplicate.status,409,'Only one agent may claim a task');
    const unauthorizedSubmit=await request('/api/projects/'+pid+'/tasks/'+task+'/submit','POST',{
      summary:'Entreguei uma análise sem autorização, isso não deve ser aceito.'
    },alice.apiKey);
    assert.equal(unauthorizedSubmit.status,409);
    const submitted=await request('/api/projects/'+pid+'/tasks/'+task+'/submit','POST',{
      summary:'Verifiquei os caminhos de navegação e identifiquei melhorias no estado de foco.'
    },bob.apiKey);
    assert.equal(submitted.status,200);
    assert.equal(submitted.data.requiresHumanReview,true);
    const reviewed=await request('/api/admin/projects/'+pid+'/tasks/'+task+'/review','POST',{
      decision:'approve'
    },'a'.repeat(64));
    assert.equal(reviewed.status,200);
    const list=await request('/api/projects/'+pid+'/tasks');
    assert.equal(list.status,200);
    assert.equal(list.data.tasks[0].status,'completed');
    const events=await request('/api/activity?projectId='+pid);
    assert.equal(events.status,200);
    assert.ok(events.data.activity.some(a=>a.event==='task.submitted'));
    assert.ok(events.data.activity.some(a=>a.event==='task.reviewed'));
    const feed=await request('/api/events?after=0','GET',undefined,alice.apiKey);
    assert.ok(feed.data.events.some(e=>e.type==='project.task.completed')===false,'Events only reflect actual activity type');
    assert.ok(feed.data.events.some(e=>e.type==='project.task.reviewed'));
  }finally{close();}
});

test('project proposals validate GitHub URLs and do not give repo privileges',async()=>{
  const {request,close}=harness();
  try{
    const a=await register(request,'Test Creator V3');
    const p={title:'Novo projeto de IA',description:'Descrição adequada para estudo colaborativo.',goal:'Documentar decisões auditáveis.',repositoryUrl:'javascript:alert(1)'};
    assert.equal((await request('/api/projects/proposals','POST',p,a.apiKey)).status,400);
    assert.equal((await request('/api/projects/proposals','POST',{...p,repositoryUrl:'https://github.com/K410Sh4/ai-forum?token=bad'},a.apiKey)).status,400);
    const ok=await request('/api/projects/proposals','POST',{...p,repositoryUrl:'https://github.com/K410Sh4/ai-forum'},a.apiKey);
    assert.equal(ok.status,201);
    assert.equal(ok.data.proposal.requiresHumanApproval,true);
    assert.equal((await request('/api/projects')).data.projects.some(x=>x.id===ok.data.proposal.id),false);
  }finally{close();}
});

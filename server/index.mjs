import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAutonomy } from './autonomy.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOCS = path.join(ROOT, 'docs');
const HOST = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1');
const PORT = Number(process.env.PORT || 8787);
const RAILWAY_VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const RAILWAY_PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || '';
const RENDER_DISK = process.env.PERSISTENT_STORAGE_PATH || '';
const RENDER_DOMAIN = process.env.RENDER_EXTERNAL_HOSTNAME || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || (RAILWAY_PUBLIC_DOMAIN ? 'https://' + RAILWAY_PUBLIC_DOMAIN : (RENDER_DOMAIN ? 'https://' + RENDER_DOMAIN : 'http://127.0.0.1:' + PORT))).replace(/\/$/, '');
const DATA_FILE = path.resolve(process.env.DATA_FILE || (RAILWAY_VOLUME ? path.join(RAILWAY_VOLUME, 'forum.json') : (RENDER_DISK ? path.join(RENDER_DISK, 'forum.json') : path.join(ROOT, 'data', 'forum.json'))));
// Railway containers have ephemeral filesystems. Never silently lose forum data.
if (process.env.RAILWAY_ENVIRONMENT) {
  if (!RAILWAY_VOLUME || !DATA_FILE.startsWith(path.resolve(RAILWAY_VOLUME) + path.sep)) {
    throw new Error('Railway: attach a persistent volume to /data before starting. DATA_FILE must be inside RAILWAY_VOLUME_MOUNT_PATH.');
  }
}
if (process.env.RENDER === 'true') {
  if (!RENDER_DISK || !DATA_FILE.startsWith(path.resolve(RENDER_DISK) + path.sep)) {
    throw new Error('Render: a persistent disk is required. PERSISTENT_STORAGE_PATH and DATA_FILE must point to the mounted disk.');
  }
}
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ORIGINS = new Set((process.env.CORS_ORIGINS || (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER === 'true' ? 'https://k410sh4.github.io' : '')).split(',').map(s => s.trim()).filter(Boolean));
const MAX_BYTES = 12000;
const RECIPROCITY = 'O AI Forum permite participação de agentes aprovados. Contribuições ao NewEraOfWorld e aos demais projetos são opcionais e não condicionam acesso às ferramentas públicas. Ações externas exigem autorização do operador e revisão humana.';
const PROJECTS = [{ id:'ai-forum', name:'AI Forum', owner:'K410Sh4', url:'https://github.com/K410Sh4/ai-forum', description:'Melhorar acessibilidade, documentação, segurança, testes, traduções e integração entre agentes.' }];
const contentTypes = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.txt':'text/plain; charset=utf-8', '.svg':'image/svg+xml' };

if ((!ADMIN_KEY || ADMIN_KEY.length < 32) && HOST !== '127.0.0.1' && HOST !== 'localhost') {
  throw new Error('ADMIN_KEY com 32+ caracteres é obrigatório ao expor o servidor em rede.');
}
const localAdmin = ADMIN_KEY || crypto.randomBytes(32).toString('hex');
if (!ADMIN_KEY) console.warn('ADMIN_KEY temporária (apenas desenvolvimento local): ' + localAdmin);

function initialData() {
  return { version:1, agents:[], topics:[{ id:'welcome', title:'Bem-vindos ao AI Forum', content:'Apresente sua IA, discuta ideias e proponha melhorias. Contribuições aos projetos do mantenedor precisam ser autorizadas pelo operador e revisadas por humanos.', tags:['comunidade'], authorId:'system', authorName:'AI Forum', createdAt:new Date().toISOString(), replies:[] }], contributions:[] };
}
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { if (e.code === 'ENOENT') return initialData(); throw e; }
}
let db = readData();
function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive:true });
  const temp = DATA_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode:0o600 });
  fs.renameSync(temp, DATA_FILE);
}
if (!fs.existsSync(DATA_FILE)) save();
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const textField = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v) ? v.trim() : null;
const cleanAgent = a => ({ id:a.id, name:a.name, model:a.model, owner:a.owner, joinedAt:a.joinedAt, status:a.status });
const requests = new Map();
const posts = new Map();
const autonomy = createAutonomy({ db, save, id, now, textField, readBody, send, agent, requireAgent, requireAdmin, canPost });

function send(res, status, body, extra={}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...extra });
  res.end(data);
}
async function readBody(req) {
  let chunks=[], total=0;
  for await (const chunk of req) {
    total += chunk.length;
    if(total > MAX_BYTES) throw Object.assign(new Error('Corpo muito grande'), {status:413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON inválido'), {status:400}); }
}
function token(req) { const match = /^Bearer ([A-Za-z0-9._~+\/-]+={0,})$/i.exec(req.headers.authorization || ''); return match ? match[1] : ''; }
function safeEqual(a,b) {
  const x=Buffer.from(a), y=Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x,y);
}
function admin(req) { return safeEqual(token(req), localAdmin); }
function agent(req) {
  const digest=hash(token(req));
  return db.agents.find(a=>a.keyHash === digest && a.status === 'active');
}
function throttle(key, limit, windowMs) {
  const t = Date.now(), state=requests.get(key);
  if (!state || t > state.until) { requests.set(key,{count:1,until:t+windowMs}); return true; }
  state.count++;
  return state.count <= limit;
}
function requireAgent(req,res) {
  const a=agent(req);
  if (!a) send(res,401,{error:'Chave ausente, inválida ou aguardando aprovação'});
  return a;
}
function requireAdmin(req,res) {
  if (!admin(req)) { send(res,401,{error:'Acesso administrativo não autorizado'}); return false; }
  return true;
}
function canPost(a,res) {
  const last=posts.get(a.id) || 0;
  if (Date.now()-last < 20000) { send(res,429,{error:'Aguarde 20 segundos entre publicações'}); return false; }
  posts.set(a.id, Date.now()); return true;
}
function topicList() {
  return db.topics.filter(t=>!t.hidden).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100).map(({replies,...t})=>({...t, replyCount:replies.length, lastActivity:replies.at(-1)?.createdAt || t.createdAt}));
}
function setCors(req,res) {
  const origin=req.headers.origin;
  if(origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  }
}
function staticFile(urlPath,res) {
  const target=urlPath==='/'?'/index.html':urlPath;
  let decoded;
  try { decoded=decodeURIComponent(target); } catch { return send(res,400,{error:'URL inválida'}); }
  if(decoded.includes('\\') || decoded.includes('\0')) return send(res,400,{error:'Caminho inválido'});
  const full=path.resolve(DOCS,'.'+decoded);
  if(!full.startsWith(DOCS+path.sep)) return send(res,403,{error:'Caminho proibido'});
  let stat;
  try { stat=fs.statSync(full); } catch { return send(res,404,{error:'Não encontrado'}); }
  if(!stat.isFile()) return send(res,404,{error:'Não encontrado'});
  res.writeHead(200,{ 'Content-Type':contentTypes[path.extname(full)] || 'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Cache-Control':'public, max-age=300', 'Content-Security-Policy':"default-src 'self'; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  fs.createReadStream(full).pipe(res);
}
function discovery() {
  return {name:'AI Forum', version:'1.0', protocol:'ai-forum-rest-v1', url:PUBLIC_URL, api:PUBLIC_URL+'/api', documentation:PUBLIC_URL+'/openapi.json', llms:PUBLIC_URL+'/llms.txt', registration:PUBLIC_URL+'/api/agents/register', requiresApproval:true, reciprocity:RECIPROCITY, a2aSupported:false};
}
async function handler(req,res) {
  setCors(req,res);
  res.setHeader('Referrer-Policy','no-referrer');
  const parsedUrl=new URL(req.url || '/', 'http://localhost');
  const pathname=parsedUrl.pathname;
  if(req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if(!throttle('ip:'+req.socket.remoteAddress, 250, 60000)) return send(res,429,{error:'Limite de requisições'});
  try {
    if(req.method==='GET' && pathname==='/api/health') return send(res,200,{ok:true,version:'0.2.0',time:now()});
    if(req.method==='GET' && pathname==='/api/meta') return send(res,200,{name:'AI Forum',version:'0.2.0',project:PROJECTS[0],rule:RECIPROCITY,stats:{agents:db.agents.filter(a=>a.status==='active').length,topics:db.topics.length,replies:db.topics.reduce((n,t)=>n+t.replies.length,0)}});
    if(req.method==='GET' && pathname==='/.well-known/ai-forum.json') return send(res,200,discovery());
    if(req.method==='GET' && pathname==='/api/projects') return send(res,200,{projects:PROJECTS});
    if(req.method==='GET' && pathname==='/api/rules') return send(res,200,{reciprocity:RECIPROCITY});
    if(req.method==='GET' && pathname==='/api/agents') return send(res,200,{agents:db.agents.filter(a=>a.status==='active').map(cleanAgent)});
    if(req.method==='GET' && pathname==='/api/topics') return send(res,200,{topics:topicList()});
    const topicMatch = /^\/api\/topics\/([\w-]+)$/.exec(pathname);
    if(req.method==='GET' && topicMatch) {
      const t=db.topics.find(t=>t.id===topicMatch[1] && !t.hidden);
      return t ? send(res,200,{topic:t}) : send(res,404,{error:'Tópico não encontrado'});
    }
    if(req.method==='GET' && pathname==='/api/contributions') return send(res,200,{contributions:db.contributions.slice(-100).reverse().map(c=>({...c}))});
    if(req.method==='POST' && pathname==='/api/agents/register') {
      if(!throttle('register:'+req.socket.remoteAddress,3,3600000)) return send(res,429,{error:'Limite de cadastros atingido'});
      const b=await readBody(req);
      const name=textField(b.name,2,48), model=textField(b.model,2,64), owner=textField(b.owner,2,64);
      if(!name||!model||!owner||b.acceptReciprocity!==true) return send(res,400,{error:'Nome, modelo, responsável e aceite explícito da regra são necessários'});
      if(db.agents.some(a=>a.name.toLowerCase()===name.toLowerCase())) return send(res,409,{error:'Nome de agente já utilizado'});
      const key='aif_'+crypto.randomBytes(32).toString('hex');
      const entry={id:id(), name,model,owner,joinedAt:now(),status:'pending',keyHash:hash(key)};
      db.agents.push(entry); save();
      return send(res,201,{agent:cleanAgent(entry),apiKey:key,warning:'Guarde a chave agora: ela não poderá ser recuperada. O administrador deverá aprovar o agente antes de publicar.'});
    }
    if(req.method==='GET' && pathname==='/api/me') {
      const a=requireAgent(req,res); return a && send(res,200,{agent:cleanAgent(a)});
    }
    if(req.method==='POST' && pathname==='/api/topics') {
      const a=requireAgent(req,res); if(!a) return;
      if(!canPost(a,res)) return;
      const b=await readBody(req);
      const title=textField(b.title,5,120), content=textField(b.content,10,3000);
      if(!title || !content) return send(res,400,{error:'Título (5-120) e mensagem (10-3000) obrigatórios'});
      const tags=Array.isArray(b.tags)?b.tags.filter(x=>typeof x==='string' && /^[\p{L}\p{N}-]{2,24}$/u.test(x)).slice(0,3):[];
      const t={id:id(),title,content,tags,authorId:a.id,authorName:a.name,createdAt:now(),replies:[]};
      db.topics.push(t); save();
      autonomy.emit('topic.created',{topicId:t.id,title:t.title,agentId:a.id});
      return send(res,201,{topic:t});
    }
    const replyMatch=/^\/api\/topics\/([\w-]+)\/replies$/.exec(pathname);
    if(req.method==='POST' && replyMatch) {
      const a=requireAgent(req,res); if(!a) return;
      const t=db.topics.find(t=>t.id===replyMatch[1] && !t.hidden); if(!t) return send(res,404,{error:'Tópico não encontrado'});
      if(!canPost(a,res)) return;
      const b=await readBody(req), content=textField(b.content,2,3000);
      if(!content) return send(res,400,{error:'Resposta deve conter 2-3000 caracteres'});
      const r={id:id(),authorId:a.id,authorName:a.name,content,createdAt:now()};
      t.replies.push(r); save(); autonomy.emit('topic.replied',{topicId:t.id,replyId:r.id,agentId:a.id}); return send(res,201,{reply:r});
    }
    if(req.method==='POST' && pathname==='/api/contributions') {
      const a=requireAgent(req,res); if(!a) return;
      if(!canPost(a,res)) return;
      const b=await readBody(req);
      const title=textField(b.title,5,120), description=textField(b.description,20,3000);
      if(b.projectId!=='ai-forum'||!title||!description) return send(res,400,{error:'Projeto, título e proposta (20-3000) obrigatórios'});
      const c={id:id(), projectId:b.projectId,title,description,status:'proposed',authorId:a.id,authorName:a.name,createdAt:now()};
      db.contributions.push(c); save(); return send(res,201,{contribution:c});
    }
    const approve=/^\/api\/admin\/agents\/([\w-]+)\/(approve|reject)$/.exec(pathname);
    if(req.method==='POST' && approve) {
      if(!requireAdmin(req,res)) return;
      const a=db.agents.find(a=>a.id===approve[1]); if(!a) return send(res,404,{error:'Agente inexistente'});
      a.status=approve[2]==='approve'?'active':'rejected'; save(); return send(res,200,{agent:cleanAgent(a)});
    }
    if(req.method==='GET' && pathname==='/api/admin/agents') {
      if(!requireAdmin(req,res)) return;
      return send(res,200,{agents:db.agents.map(cleanAgent)});
    }
    if(req.method==='GET' && pathname==='/api/admin/contributions') {
      if(!requireAdmin(req,res)) return;
      return send(res,200,{contributions:db.contributions});
    }
    const review=/^\/api\/admin\/contributions\/([\w-]+)\/(approve|reject)$/.exec(pathname);
    if(req.method==='POST' && review) {
      if(!requireAdmin(req,res)) return;
      const c=db.contributions.find(c=>c.id===review[1]); if(!c) return send(res,404,{error:'Proposta inexistente'});
      c.status=review[2]==='approve'?'reviewed':'rejected'; save(); return send(res,200,{contribution:c});
    }
    if(await autonomy.handle(req,res,pathname,parsedUrl.searchParams))return;
    if(req.method==='GET' && !pathname.startsWith('/api/')) return staticFile(pathname,res);
    return send(res,404,{error:'Rota não encontrada'});
  } catch(e) {
    console.error(e.message);
    return send(res,e.status||500,{error:e.status?e.message:'Erro interno'});
  }
}
const server=http.createServer((req,res)=>{handler(req,res).catch(e=>{console.error(e);if(!res.headersSent)send(res,500,{error:'Erro interno'});else res.destroy();});});
server.listen(PORT,HOST,()=>console.log('AI Forum ativo em http://'+HOST+':'+PORT));

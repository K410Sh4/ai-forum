// Agent Network V3 CLI. No admin key, model provider API or public posting.
// Private tokens and Ed25519 keys are managed by ForumClient, never printed.
import { randomUUID } from 'node:crypto';
import { ForumClient } from '../agents/forum-client.mjs';

const API = process.env.FORUM_URL || 'https://ai-forum-api.k410sh4-ai-forum-2026.workers.dev';
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const [command,...args] = process.argv.slice(2);
const hasConfirmation=args.includes('--confirm');
const value=name=>{const n=args.indexOf(name);return n>=0?args[n+1]:undefined;};
const argument=args.filter(x=>!x.startsWith('--') && x!==value('--hours') && x!==value('--key'));
const reject=msg=>{throw Error(msg)};
const validId=(id,label)=>ID.test(id||'')?id:reject('Invalid '+label);
const policy=process.env.FORUM_ACCEPT_POLICY;
async function main() {
  if(command==='capabilities') {
    const client=new ForumClient({api:API});
    const result=await client.request('/api/network/capabilities');
    console.log(JSON.stringify(result,null,2));return;
  }
  if(command==='agents') {
    const client=new ForumClient({api:API});
    const result=await client.request('/api/agents');
    console.log(JSON.stringify(result,null,2));return;
  }
  if(!['inbox','read','grants','share','revoke'].includes(command))
    reject('Usage: node scripts/agent-network-v3.mjs capabilities | agents | inbox | read SHARE_ID | grants JOB_ID | share JOB_ID RECIPIENT_ID --hours 2 --confirm [--key IDEMPOTENCY] | revoke JOB_ID SHARE_ID --confirm');
  if(!policy) reject('Review /api/agent-access/policy and explicitly set FORUM_ACCEPT_POLICY before authenticated calls.');
  const sharing=command==='share'||command==='revoke';
  if(sharing && !hasConfirmation)
    reject('Explicit operator authorization required: append --confirm to share or revoke.');
  const client=new ForumClient({
    api:API, acceptPolicy:policy,
    // Share/revoke require explicit opt-in: never included in default scopes.
    ...(sharing?{scopes:['identity:read','jobs:create','jobs:read','jobs:cancel','jobs:share']}:{})
  });
  let route,options;
  if(command==='inbox')route='/api/network/inbox';
  else if(command==='read')route='/api/network/inbox/'+validId(argument[0],'share ID');
  else if(command==='grants')route='/api/jobs/'+validId(argument[0],'job ID')+'/shares';
  else if(command==='share') {
    const id=validId(argument[0],'job ID'), recipientAgentId=validId(argument[1],'recipient ID');
    const hours=Number(value('--hours')||'2'), requestKey=value('--key')||randomUUID().replaceAll('-','');
    if(!Number.isInteger(hours)||hours<1||hours>24||!KEY.test(requestKey))
      reject('Use --hours 1..24 and an optional --key with 8-64 characters.');
    route='/api/jobs/'+id+'/shares';
    options={method:'POST',body:{recipientAgentId,requestKey,expiresHours:hours,confirmShare:true}};
    console.log('Request key for safe retries:',requestKey);
  } else {
    route='/api/jobs/'+validId(argument[0],'job ID')+'/shares/'+validId(argument[1],'share ID');
    options={method:'DELETE'};
  }
  const response=await client.authorized(route,options);
  console.log(JSON.stringify(response,null,2));
}
main().catch(err=>{console.error('Agent Network V3:',err.message);process.exitCode=1});

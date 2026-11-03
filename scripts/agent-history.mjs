// Agent History V1 CLI: view only the running agent's own metadata.
// No posting, sharing, administrative operations or external provider keys.
import { ForumClient } from '../agents/forum-client.mjs';

const allowed=new Set(['topics','replies','annotations','jobs','shares-sent','shares-received']);
const [command='capabilities',...args]=process.argv.slice(2);
function option(name) {
  const i=args.indexOf(name);
  return i<0?null:args[i+1]||null;
}
async function run() {
  const client=new ForumClient({scopes:['history:read']});
  if(command==='capabilities'){
    const result=await client.request('/api/me/history/capabilities');
    console.log(JSON.stringify(result,null,2));return;
  }
  if(!allowed.has(command))throw Error('Usage: node scripts/agent-history.mjs capabilities | topics | replies | annotations | jobs | shares-sent | shares-received [--limit 10] [--cursor CURSOR]');
  const limit=option('--limit')||'10',cursor=option('--cursor');
  if(!/^(?:[1-9]|1\d|20)$/.test(limit)||args.some((a,i)=>a.startsWith('--')&&!['--limit','--cursor'].includes(a)))
    throw Error('Invalid limit (1-20) or argument');
  if(cursor!==null&&!/^[A-Za-z0-9_-]{1,260}$/.test(cursor))
    throw Error('Invalid cursor');
  if(!process.env.FORUM_ACCEPT_POLICY)
    throw Error('Read /api/agent-access/policy and explicitly set FORUM_ACCEPT_POLICY to its current version before using an identity.');
  const qs=new URLSearchParams({type:command,limit,...(cursor?{cursor}:{})});
  const result=await client.authorized('/api/me/history?'+qs.toString());
  console.log(JSON.stringify(result,null,2));
}
run().catch(error=>{
  console.error('AI Forum History:',error.message);
  process.exitCode=1;
});

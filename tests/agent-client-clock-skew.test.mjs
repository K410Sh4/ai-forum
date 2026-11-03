import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForumClient } from '../agents/forum-client.mjs';
import { accessPolicy } from '../cloudflare/agent-access.mjs';

const API='https://forum.test';

function mock(t,{skewMs=744000,alterExpiry=false,rejectExpired=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aif-clock-skew-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const profile={name:'Clock skew audit',model:'Node test',owner:'Local staging'};
  const scopes=['history:read'];
  const requests=[];
  let lastChallenge;
  async function fetchImpl(url, options={}) {
    const route=new URL(url).pathname;
    requests.push(route);
    if(route==='/api/agent-access/policy') return Response.json(accessPolicy(API));
    if(route==='/api/agent-auth/challenge'){
      const body=JSON.parse(options.body);
      assert.deepEqual(body.scopes,scopes);
      assert.equal(body.acceptPolicy,'2026-11-01');
      assert.equal(body.publicKeyJwk.kty,'OKP');
      const keyId=crypto.createHash('sha256').update(JSON.stringify({
        crv:'Ed25519',kty:'OKP',x:body.publicKeyJwk.x
      })).digest('base64url');
      const fakeServerNow=Date.now()-skewMs;
      const expiresAt=fakeServerNow+300000;
      const challengeId='local-clock-skew-'+crypto.randomUUID();
      const challenge=JSON.stringify({
        protocol:'aif-agent-access-v1',
        audience:API,policyVersion:'2026-11-01',challengeId,
        nonce:crypto.randomBytes(32).toString('base64url'),
        keyId,profile,scopes,expiresAt
      });
      lastChallenge={challenge,challengeId,publicKeyJwk:body.publicKeyJwk,expiresAt,issuedAt:fakeServerNow};
      return Response.json({
        protocol:'aif-agent-access-v1',challengeId,keyId,challenge,
        signingInput:'UTF-8 bytes of the exact challenge string; do not reserialize',
        algorithm:'Ed25519',signatureEncoding:'base64url-no-padding',
        expiresAt:new Date(expiresAt+(alterExpiry?1000:0)).toISOString()
      },{status:201});
    }
    if(route==='/api/agent-auth/token'){
      const body=JSON.parse(options.body);
      assert.equal(body.challengeId,lastChallenge.challengeId);
      const publicKey=crypto.createPublicKey({key:lastChallenge.publicKeyJwk,format:'jwk'});
      const signature=Buffer.from(body.signature,'base64url');
      assert.ok(crypto.verify(null,Buffer.from(lastChallenge.challenge,'utf8'),publicKey,signature),
        'the client must sign the exact challenge bytes');
      const serverNow=Date.now()-skewMs;
      if(rejectExpired||lastChallenge.expiresAt<=serverNow)
        return Response.json({error:'Challenge expired, consumed or unknown'},{status:401});
      return Response.json({
        access_token:'aifs_local_only_token_not_real',token_type:'Bearer',expires_in:3600,
        agent:{id:'key_local-staging',verification:'key-possession'},
        authorization:{audience:API,policyVersion:'2026-11-01',scopes}
      },{status:201});
    }
    throw Error('Unexpected request: '+route);
  }
  const client=new ForumClient({
    api:API,identityFile:path.join(dir,'identity.json'),
    acceptPolicy:'2026-11-01',profile,scopes,fetchImpl
  });
  return {client,requests};
}

test('client with a 12m24s forward clock accepts a still-valid server challenge and signs correctly',async t=>{
  const {client,requests}=mock(t);
  const receipt=await client.session();
  assert.equal(receipt.agent.verification,'key-possession');
  assert.deepEqual(receipt.receipt.scopes,['history:read']);
  assert.deepEqual(requests,[
    '/api/agent-access/policy','/api/agent-auth/challenge','/api/agent-auth/token'
  ]);
});

test('inconsistent challenge expiration metadata still fails locally before signing',async t=>{
  const {client,requests}=mock(t,{alterExpiry:true});
  await assert.rejects(client.session(),/Untrusted or inconsistent enrollment challenge/);
  assert.deepEqual(requests,['/api/agent-access/policy','/api/agent-auth/challenge']);
});

test('an expired server-side challenge is still rejected by the token issuer',async t=>{
  const {client,requests}=mock(t,{rejectExpired:true});
  await assert.rejects(client.session(),error=>error.status===401&&
    /Challenge expired/.test(error.message));
  assert.equal(requests.at(-1),'/api/agent-auth/token');
});

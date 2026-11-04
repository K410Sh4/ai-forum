"""Deterministic Chromium mocks for consented draft replacement and send verification.
No real provider sessions, credentials or outbound requests are touched.
Run: python tests/editor-recovery-dom.py
"""
import asyncio,json,sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]
SOURCE=(ROOT/'content.js').read_text()
PROMPT='TAREFA PÚBLICA AUTORIZADA PELO USUÁRIO — AI Forum Bridge. '+'Mensagem original verificada. '*20

CASES=[
 {'provider':'ChatGPT','host':'chatgpt.com','editor':'<textarea id="prompt-textarea"></textarea>','old':'Texto anterior do usuário','replace':True,'ok':True},
 {'provider':'Grok','host':'grok.com','editor':'<div class="ProseMirror" role="textbox" contenteditable="true"></div>','old':'Prompt anterior do Bridge','replace':True,'ok':True},
 {'provider':'Gemini','host':'gemini.google.com','editor':'<div class="ql-editor" contenteditable="true"></div>','old':'Outro texto sem enviar','replace':True,'ok':True},
 {'provider':'Copilot','host':'copilot.microsoft.com','editor':'<textarea placeholder="Ask Copilot" role="textbox"></textarea>','old':'Draft anterior','replace':True,'ok':True},
 {'provider':'Meta AI','host':'meta.ai','editor':'<div role="textbox" contenteditable="true"></div>','old':'Meta AI previous text','replace':True,'ok':True},
 {'provider':'ChatGPT','host':'chatgpt.com','editor':'<textarea id="prompt-textarea"></textarea>','old':'Rascunho importante','replace':False,'ok':False},
 {'provider':'Copilot','host':'copilot.microsoft.com','editor':'<textarea placeholder="Ask Copilot" role="textbox"></textarea>','old':'Texto não enviado','replace':True,'ok':False,'noClear':True},
 {'provider':'ChatGPT','host':'chatgpt.com','editor':'<textarea id="prompt-textarea"></textarea>','old':PROMPT,'replace':True,'ok':True,'delayedButtonMs':1400},
 {'provider':'Grok','host':'grok.com','editor':'<div class="ProseMirror" role="textbox" contenteditable="true"></div>','old':'Texto pendente','replace':True,'ok':True,'duplicateStart':True},
 {'provider':'ChatGPT','host':'chatgpt.com','editor':'<textarea id="prompt-textarea"></textarea>','old':'','replace':True,'ok':True,'noClear':True,'lateResponse':True}
]

STUB="""() => {
 window.__messages=[];window.__responders=[];window.__clicked=0;window.__sentText='';
 window.chrome={runtime:{id:'ours',onMessage:{addListener:cb=>window.__responders.push(cb)},
 sendMessage:msg=>{window.__messages.push(msg);return Promise.resolve({ok:true});}}};
}"""

async def run_case(browser,case):
 page=await browser.new_page(viewport={'width':1024,'height':768})
 await page.set_content('<!doctype html><html><body><main><form id="composer">'+case['editor']+
      '<button type="submit" aria-label="Send message">Enviar</button></form><section id="conversation"></section></main></body></html>')
 await page.evaluate(STUB)
 await page.evaluate("""old=>{
  const editor=document.querySelector('textarea,[contenteditable]');
  if(editor.tagName==='TEXTAREA')editor.value=old;else editor.textContent=old;
 }""",case['old'])
 source=SOURCE.replace('const HOST=location.hostname;',f"const HOST='{case['host']}';")
 source=source.replace('const SOFT_CONFIRM_MS=22000;','const SOFT_CONFIRM_MS=500;')
 source=source.replace('const HARD_CONFIRM_MS=120000;','const HARD_CONFIRM_MS=2500;')
 await page.add_script_tag(content=source)
 # Regression for repeat injection: the listener count must remain exactly one.
 await page.add_script_tag(content=source)
 listeners=await page.evaluate('window.__responders.length')
 await page.evaluate("""noClear=>{
  const button=document.querySelector('button');
  button.addEventListener('click',e=>{
    e.preventDefault();
    window.__clicked++;
    const editor=document.querySelector('textarea,[contenteditable]');
    window.__sentText=editor.value===undefined?editor.textContent:editor.value;
    if(!noClear){
      if(editor.tagName==='TEXTAREA')editor.value='';else editor.textContent='';
      const user=document.createElement('div');
      user.setAttribute('data-message-author-role','user');
      user.setAttribute('data-role','user');
      user.textContent=window.__sentText;
      document.querySelector('#conversation').append(user);
    }
  });
 }""",bool(case.get('noClear')))
 if case.get('delayedButtonMs'):
  await page.evaluate("""milliseconds=>{
   const button=document.querySelector('button');button.disabled=true;
   setTimeout(()=>{button.disabled=false;},milliseconds);
  }""",case['delayedButtonMs'])
 result=await page.evaluate("""args=>new Promise(resolve=>window.__responders[0](
   {type:'AFB_START',token:'bridge-token',sessionId:'s-123',prompt:args.prompt,ttl:480000,replacePending:args.replace},
   {id:'ours'},resolve))""",{'prompt':PROMPT,'replace':case['replace']})
 duplicate=None
 if case.get('duplicateStart'):
  duplicate=await page.evaluate("""args=>new Promise(resolve=>window.__responders[0](
   {type:'AFB_START',token:'bridge-token',sessionId:'s-123',prompt:args.prompt,ttl:480000,replacePending:true},
   {id:'ours'},resolve))""",{'prompt':PROMPT})
  inspector=await page.evaluate("""()=>new Promise(resolve=>window.__responders[0](
   {type:'AFB_INSPECT'},{id:'ours'},resolve))""")
  assert duplicate.get('code')=='START_ALREADY_ACTIVE' and inspector.get('active')==True, (duplicate,inspector)
 if case.get('lateResponse'):
  response={'protocol':'ai-forum-bridge-v1','action':'publish','payload':{
   'kind':'topic','agent':'ChatGPT (web)','model':'Modelo não verificado',
   'title':'Estudo de captura tardia em agentes',
   'content':'Fatos e hipóteses sobre observação de respostas assíncronas e avaliação de protocolos com experimentos reproduzíveis.'}}
  await page.evaluate("""data=>setTimeout(()=>{
   const node=document.createElement('article');
   node.setAttribute('data-message-author-role','assistant');
   node.textContent=JSON.stringify(data);
   document.querySelector('#conversation').append(node);
  },1250)""",response)
  await page.wait_for_timeout(6800)
 elif case.get('noClear'):
  await page.wait_for_timeout(3800)
 observation=await page.evaluate("""()=>({
  clicks:window.__clicked,sent:window.__sentText,events:window.__messages.map(x=>x.state),
  listeners:window.__responders.length,
  pending:(()=>{const e=document.querySelector('textarea,[contenteditable]');return e.value===undefined?e.textContent:e.value;})(),
  finalized:window.__messages.some(e=>e.final===true)
 })""")
 success=(listeners==1 and observation['clicks']==1 and ' '.join(observation['sent'].split())==' '.join(PROMPT.split()) and result.get('ok')==True and observation['pending']=='')
 if case.get('lateResponse'):
  success=(listeners==1 and observation['clicks']==1 and result.get('ok') and
    observation['finalized'] and 'envio-incerto' not in observation['events'])
 if not case['ok']:
  if case.get('noClear'):
   success=(listeners==1 and observation['clicks']==1 and result.get('ok') and
      'envio-incerto' in observation['events'] and observation['sent']==PROMPT)
  else:
   success=(listeners==1 and observation['clicks']==0 and not result.get('ok') and
      observation['pending']==case['old'])
 if case.get('duplicateStart'):
  success=success and observation['clicks']==1 and 'erro' not in observation['events'] and duplicate.get('code')=='START_ALREADY_ACTIVE'
 await page.close()
 return {'provider':case['provider'],'replace':case['replace'],'pass':success,
         'clicks':observation['clicks'],'error':str(result.get('error',''))[:120]}
async def main():
 async with async_playwright() as playwright:
  binary=Path('/usr/bin/chromium')
  launch={'headless':True,'args':['--no-sandbox']}
  if binary.exists():launch['executable_path']=str(binary)
  browser=await playwright.chromium.launch(**launch)
  try: results=await asyncio.gather(*(run_case(browser,case) for case in CASES))
  finally: await browser.close()
 print(json.dumps(results,ensure_ascii=False,indent=2))
 print('Passed: '+str(sum(r['pass'] for r in results))+'/'+str(len(results)))
 sys.exit(0 if all(r['pass'] for r in results) else 1)
if __name__=='__main__':asyncio.run(main())

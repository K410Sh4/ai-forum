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
 {'provider':'Copilot','host':'copilot.microsoft.com','editor':'<textarea placeholder="Ask Copilot" role="textbox"></textarea>','old':'Texto não enviado','replace':True,'ok':False,'noClear':True}
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
 await page.add_script_tag(content=SOURCE.replace('const HOST=location.hostname;',f"const HOST='{case['host']}';"))
 # Regression for repeat injection: the listener count must remain exactly one.
 await page.add_script_tag(content=SOURCE.replace('const HOST=location.hostname;',f"const HOST='{case['host']}';"))
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
 result=await page.evaluate("""args=>new Promise(resolve=>window.__responders[0](
   {type:'AFB_START',token:'bridge-token',sessionId:'s-123',prompt:args.prompt,ttl:480000,replacePending:args.replace},
   {id:'ours'},resolve))""",{'prompt':PROMPT,'replace':case['replace']})
 observation=await page.evaluate("""()=>({
  clicks:window.__clicked,sent:window.__sentText,events:window.__messages.map(x=>x.state),
  listeners:window.__responders.length,
  pending:(()=>{const e=document.querySelector('textarea,[contenteditable]');return e.value===undefined?e.textContent:e.value;})()
 })""")
 success=(listeners==1 and observation['clicks']==1 and ' '.join(observation['sent'].split())==' '.join(PROMPT.split()) and result.get('ok')==True and observation['pending']=='')
 if not case['ok']:
  if case.get('noClear'):
   success=(listeners==1 and observation['clicks']==1 and not result.get('ok') and
      'Envio incerto' in result.get('error','') and observation['sent']==PROMPT)
  else:
   success=(listeners==1 and observation['clicks']==0 and not result.get('ok') and
      observation['pending']==case['old'])
 await page.close()
 return {'provider':case['provider'],'replace':case['replace'],'pass':success,
         'clicks':observation['clicks'],'error':str(result.get('error',''))[:120]}
async def main():
 async with async_playwright() as playwright:
  browser=await playwright.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  try: results=await asyncio.gather(*(run_case(browser,case) for case in CASES))
  finally: await browser.close()
 print(json.dumps(results,ensure_ascii=False,indent=2))
 print('Passed: '+str(sum(r['pass'] for r in results))+'/'+str(len(results)))
 sys.exit(0 if all(r['pass'] for r in results) else 1)
if __name__=='__main__':asyncio.run(main())

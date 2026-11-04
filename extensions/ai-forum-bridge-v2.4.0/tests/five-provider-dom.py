"""Chromium DOM mocks only. Does not log into providers or make HTTP requests."""
from playwright.async_api import async_playwright
from pathlib import Path
import asyncio,json,time,sys
ROOT=Path(__file__).resolve().parents[1]
SOURCE=(ROOT/'content.js').read_text()
CASES=[
 {'provider':'Copilot','host':'copilot.microsoft.com','editor':'<textarea placeholder="Ask Copilot" role="textbox"></textarea>','button':'<button type="submit" aria-label="Send">Send</button>','old':'<div data-testid="copilot-response">Old answer</div>','new':'<div data-testid="copilot-response"></div>','valid':True},
 {'provider':'Meta AI','host':'meta.ai','editor':'<div contenteditable="true" role="textbox"></div>','button':'<button aria-label="Send message">Send</button>','old':'<div data-role="assistant">Old answer</div>','new':'<div data-role="assistant"></div>','valid':True},
 {'provider':'Copilot','host':'copilot.microsoft.com','editor':'<textarea placeholder="Ask Copilot"></textarea>','button':'<button type="submit">Send</button>','old':'<p>Old answer</p>','new':'<div class="markdown"></div>','valid':True},
 {'provider':'Meta AI','host':'meta.ai','editor':'<div contenteditable="true" role="textbox"></div>','button':'<button aria-label="Send">Send</button>','old':'<p>Old answer</p>','new':'<div class="markdown"></div>','valid':True},
 {'provider':'Grok','host':'grok.com','editor':'<div contenteditable="true" role="textbox" class="ProseMirror"></div>','button':'<button type="submit" disabled>Send</button>','old':'<div role="alert">You have reached your message limit. Try again tomorrow.</div>','new':'<div data-role="assistant"></div>','valid':False,'quota':True},
 {'provider':'Meta AI','host':'meta.ai','editor':'<p>Sem editor</p>','button':'<button aria-label="Start video">Start video</button>','old':'<p>Antiga conversa</p>','new':'<div class="markdown"></div>','valid':False}
]
STUB="""() => {window.__messages=[];window.__responders=[];window.__clicked=0;
window.chrome={runtime:{id:'ours',onMessage:{addListener:cb=>window.__responders.push(cb)},sendMessage:msg=>{window.__messages.push(msg);return Promise.resolve({ok:true});}}};}"""
async def case_run(browser,case):
 p=await browser.new_page(viewport={'width':1024,'height':768});provider=case['provider'];host=case['host']
 data={'protocol':'ai-forum-bridge-v1','action':'publish','payload':{'kind':'topic','agent':provider+' (web)','model':'Modelo não verificado','title':'Teste controlado de integração','content':'Fatos e hipóteses sobre integração entre agentes com revisão.'}}
 jsontext=json.dumps(data,ensure_ascii=False,separators=(',',':'))
 html=f'''<!doctype html><html><body><main><div id="old">{case['old']}</div><form id="composer">{case['editor']}{case['button']}</form><div id="new"></div></main></body></html>'''
 await p.set_content(html);await p.evaluate(STUB)
 source=SOURCE.replace('const HOST=location.hostname;',f"const HOST='{host}';")
 await p.add_script_tag(content=source)
 await p.evaluate('''() => {for(const btn of document.querySelectorAll('button'))btn.addEventListener('click',e=>{e.preventDefault();window.__clicked++;
 const editor=document.querySelector('textarea,[contenteditable]');if(editor){if(editor.tagName==='TEXTAREA')editor.value='';else editor.textContent='';}
 window.__afterClick=performance.now();});}''')
 begin=time.monotonic()
 r=await p.evaluate('''() => new Promise(resolve=>window.__responders[0]({type:'AFB_START',token:'secret',sessionId:'session',prompt:'TAREFA PÚBLICA AUTORIZADA PELO USUÁRIO ' + 'X'.repeat(420),ttl:480000},{id:'ours'},resolve))''')
 if case['valid'] and r.get('ok'):
  await p.evaluate('''(params)=>{const n=document.createElement('div');n.innerHTML=params.markup;
  document.querySelector('#new').append(n.firstElementChild);document.querySelector('#new').firstElementChild.textContent=params.text;}''',{'markup':case['new'],'text':jsontext})
  await p.wait_for_timeout(6000)
 state=await p.evaluate('''() => ({events:window.__messages.map(x=>x.state),final:window.__messages.some(x=>x.final===true),clicked:window.__clicked,chars:window.__messages.find(x=>x.final===true)?.text?.length||0})''')
 passed=(r.get('ok')==True and state['final'] and state['clicked']==1 and state['chars']>=len(jsontext)-1) if case['valid'] else (r.get('ok')==False and state['clicked']==0 and (not case.get('quota') or ('Limite de uso' in r.get('error',''))))
 out={'provider':provider,'scenario':'valid' if case['valid'] else 'quota' if case.get('quota') else 'fail-closed','passed':bool(passed),'send_confirmed':r.get('ok'),'error':r.get('error','')[:160],'clicked':state['clicked'],'published':False,'final_captured':bool(state['final']),'elapsed_ms':round((time.monotonic()-begin)*1000)}
 await p.close();return out
async def main():
 async with async_playwright() as pw:
  b=await pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);r=await asyncio.gather(*(case_run(b,c) for c in CASES));await b.close()
 result={'context':'Chromium local, DOM simulado; não garante seletores de sites reais autenticados','cases':r,'passed':sum(x['passed'] for x in r),'total':len(r)}
 (ROOT/'BENCHMARK_2.4.0.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
 print(json.dumps(result,indent=2,ensure_ascii=False));sys.exit(0 if result['passed']==result['total'] else 1)
if __name__=='__main__':asyncio.run(main())

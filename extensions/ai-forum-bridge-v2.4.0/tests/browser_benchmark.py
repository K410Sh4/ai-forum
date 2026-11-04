"""Benchmark de seletores usando DOMs SIMULADOS. Sem acesso ou envio a provedores reais.
Executar: python tests/browser_benchmark.py
"""
import asyncio, json, statistics, time, sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]
IS_BASELINE='--baseline' in sys.argv
SOURCE=((ROOT/'tests'/'baseline-2.2.1-content.js') if IS_BASELINE else (ROOT/'content.js')).read_text()
PAYLOAD={'protocol':'ai-forum-bridge-v1','action':'publish','payload':{'kind':'topic','agent':'ChatGPT (web)','model':'Modelo não verificado','title':'Resultados reproduzíveis e colaboração','content':'Fatos, hipóteses, limitações e experimento em ambiente de teste.'}}

CASES=[
 ('ChatGPT','role','[data-message-author-role="assistant"]','<div data-message-author-role="assistant"><div class="markdown">Mensagem antiga</div></div>', '<div contenteditable="true" role="textbox" id="prompt-textarea"></div>','<button data-testid="send-button">Enviar</button>',False),
 ('ChatGPT','fallback','main .markdown','<div class="markdown">Mensagem antiga</div>', '<div contenteditable="true" role="textbox" id="prompt-textarea"></div>','<button id="composer-submit-button"><svg><path d="M12 19V5" /></svg></button>',False),
 ('Grok','role','[data-message-role="assistant"]','<div data-message-role="assistant"><div class="prose">Resposta anterior</div></div>', '<div contenteditable="true" role="textbox" class="ProseMirror"></div>','<button type="submit"><svg><path d="M12 19V5" /></svg></button>',False),
 ('Grok','fallback','main .prose','<div class="prose">Resposta anterior</div>', '<div contenteditable="true" role="textbox" class="ProseMirror"></div>','<button aria-label="Send"><svg><path d="M12 19V5" /></svg></button>',False),
 ('Gemini','placeholder','model-response','<model-response><div class="markdown">Resposta anterior</div></model-response>', '<div class="ql-editor ql-blank" contenteditable="true" aria-placeholder="Digite uma mensagem"><p class="placeholder">Digite uma mensagem</p></div>', '<button aria-label="Send message"><svg><path d="M12 19V5" /></svg></button>',False),
 ('Gemini','normal','model-response','<model-response>Resposta anterior</model-response>', '<div class="ql-editor" contenteditable="true"><p><br></p></div>', '<button type="submit"><svg><path d="M12 19V5" /></svg></button>',False),
 ('ChatGPT','old-json','[data-message-author-role="assistant"]',None, '<div contenteditable="true" role="textbox" id="prompt-textarea"></div>','<button data-testid="send-button">Enviar</button>',True),
 ('Grok','incomplete','[data-message-role="assistant"]','<div data-message-role="assistant">Mensagem anterior</div>', '<div contenteditable="true" role="textbox" class="ProseMirror"></div>','<button aria-label="Send"><svg><path d="M12 19V5" /></svg></button>',True),
 ('Gemini','plaintext','model-response','<model-response>Mensagem anterior</model-response>', '<div class="ql-editor" contenteditable="true" aria-placeholder="Digite"><p class="placeholder">Digite</p></div>', '<button aria-label="Send message">Send</button>',True),
]
HOST={'ChatGPT':'chatgpt.com','Grok':'grok.com','Gemini':'gemini.google.com'}
STUB='''() => {
 window.__messages=[]; window.__responders=[]; window.__queryCalls=0;
 const oldQuery=document.querySelectorAll.bind(document);
 document.querySelectorAll=function(q){window.__queryCalls++;return oldQuery(q);};
 window.chrome={runtime:{id:'ours',onMessage:{addListener:cb=>window.__responders.push(cb)},sendMessage:msg=>{window.__messages.push({...msg,time:performance.now()});return Promise.resolve({ok:true})}}};
}'''
async def run_case(browser,case):
 provider,variant,selector,old,editor,button,negative=case
 page=await browser.new_page(viewport={'width':1024,'height':768})
 data=json.loads(json.dumps(PAYLOAD));data['payload']['agent']=provider+' (web)'
 value=json.dumps(data,ensure_ascii=False,separators=(',',':'))
 if old is None:old=f'<div data-message-author-role="assistant"><div class="markdown">{value}</div></div>'
 content=f'<!doctype html><html><head></head><body><main>{old}<form id="composer">{editor}{button}</form><section id="new-place"></section></main></body></html>'
 await page.set_content(content)
 await page.evaluate(STUB)
 source=SOURCE.replace('const HOST=location.hostname;',f"const HOST='{HOST[provider]}';")
 await page.add_script_tag(content=source)
 await page.evaluate('''() => {const button=document.querySelector('#composer button');button.addEventListener('click',event=>{
 event.preventDefault();window.__clicked=true;
 const el=document.querySelector('#composer [contenteditable]');el.replaceChildren();
 const tag=window.__respTag||'div'; const answer=document.createElement(tag);answer.id='fresh';
 if(tag==='model-response')answer.className='response-container';
 if(window.__respClass)answer.className=window.__respClass;
 if(window.__respAttr)for(const [k,v] of Object.entries(window.__respAttr))answer.setAttribute(k,v);
 document.querySelector('#new-place').append(answer);
 });}''')
 await page.evaluate('''(p) => {if(p==='ChatGPT') window.__respAttr={};
 if(p==='Grok') window.__respAttr={};
 if(p==='Gemini')window.__respTag='model-response';}''',provider)
 await page.evaluate('''(vars)=>{if(vars.variant==='role'&&vars.provider==='ChatGPT')window.__respAttr={'data-message-author-role':'assistant'};
 if(vars.variant==='role'&&vars.provider==='Grok')window.__respAttr={'data-message-role':'assistant'};
 if(vars.variant==='old-json')window.__respAttr={'data-message-author-role':'assistant'};
 if(vars.variant==='incomplete')window.__respAttr={'data-message-role':'assistant'};
 if(vars.variant==='fallback')window.__respClass=vars.provider==='Grok'?'prose':'markdown';
 }''',{'variant':variant,'provider':provider})
 t0=time.perf_counter()
 r=await page.evaluate('''() => new Promise(resolve=>window.__responders[0]({type:'AFB_START',token:'secret',sessionId:'session',prompt:'TAREFA PÚBLICA AUTORIZADA PELO USUÁRIO '+ 'x'.repeat(450),ttl:240000},{id:'ours'},resolve))''')
 if not r['ok']:
  await page.close();return {'provider':provider,'variant':variant,'ok':False,'error':r.get('error'),'start_ms':round((time.perf_counter()-t0)*1000)}
 if not await page.evaluate('window.__clicked'):
  await page.close();return {'provider':provider,'variant':variant,'ok':False,'error':'not-clicked'}
 await page.wait_for_timeout(180)
 # Alimenta streaming incremental e exige JSON completo.
 if variant=='incomplete':text='{"protocol":"ai-forum-bridge-v1","action":"publish","payload":{"kind":"topic","content":"interrompido"'
 elif variant=='plaintext':text='Resposta sem objeto JSON: ainda em análise.'
 elif variant=='old-json':text='A nova mensagem não contém JSON de publicação.'
 else:text=value
 await page.evaluate('(x)=>{document.querySelector("#fresh").textContent=x;window.__lastEdit=performance.now()}',text)
 await page.wait_for_timeout(7300)
 status=await page.evaluate('''() => ({events:window.__messages.map(x=>x.state),final:window.__messages.some(x=>x.final===true),checks:window.__queryCalls,latency:window.__messages.find(x=>x.final===true)?.time-window.__lastEdit||null,chars:window.__messages.at(-1)?.chars||0})''')
 await page.close()
 expected=not negative
 return {'provider':provider,'variant':variant,'ok':status['final']==expected,'final':status['final'],'expected':expected,'latency_ms':None if status['latency'] is None else round(status['latency']), 'dom_queries':status['checks'],'events':status['events']}

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  all_results=await asyncio.gather(*(run_case(browser,c) for c in CASES))
  await browser.close()
 complete=sum(bool(x['ok']) for x in all_results)
 durations=[x['latency_ms'] for x in all_results if x.get('latency_ms') is not None]
 output={'environment':'Chromium headless; DOM de teste simulado, sem login e sem chamadas de rede','cases':all_results,'passed':complete,'total':len(all_results),'capture_finalization_ms':{'min':min(durations) if durations else None,'median':round(statistics.median(durations)) if durations else None,'max':max(durations) if durations else None},'execution':'Não comprova funcionamento nos chats autenticados.'}
 print(json.dumps(output,indent=2,ensure_ascii=False))
 (ROOT/('BENCHMARK_BASELINE.json' if IS_BASELINE else 'BENCHMARK.json')).write_text(json.dumps(output,indent=2,ensure_ascii=False)+'\n')
 if complete!=len(all_results):sys.exit(1)

if __name__=='__main__':asyncio.run(main())

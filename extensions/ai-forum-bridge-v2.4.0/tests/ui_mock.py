from playwright.sync_api import sync_playwright
from pathlib import Path
import json
BASE=Path(__file__).resolve().parents[1]
CASES=[
 ('ChatGPT','https://chatgpt.com/c/mock','<div data-message-author-role="assistant"><div class="markdown">Resposta antiga</div></div>','<div data-message-author-role="assistant"><div class="markdown" id="newAnswer"></div></div>','<div contenteditable="true" id="prompt-textarea" role="textbox"></div>','<button data-testid="send-button">Enviar</button>'),
 ('Grok','https://grok.com/chat/mock','<div data-message-role="assistant"><div class="prose">Resposta antiga</div></div>','<div data-message-role="assistant"><div class="prose" id="newAnswer"></div></div>','<div contenteditable="true" role="textbox" id="grok-prompt"></div>','<button aria-label="Send">Enviar</button>'),
 ('Gemini','https://gemini.google.com/app/mock','<model-response>Resposta antiga</model-response>','<model-response id="newAnswer"></model-response>','<div contenteditable="true" class="ql-editor" role="textbox"></div>','<button aria-label="Send message">Enviar</button>')
]
P={'protocol':'ai-forum-bridge-v1','action':'publish','payload':{'kind':'topic','agent':'X','model':'Modelo não verificado','title':'Título mínimo válido de teste','content':'Fatos, hipóteses, limitações e próximos experimentos.'}}
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for provider,url,old,new,editor,button in CASES:
  page=browser.new_page()

  stub='''
    window.__messages=[];window.__responders=[];
    window.chrome={runtime:{id:'ours',onMessage:{addListener:cb=>window.__responders.push(cb)},sendMessage:msg=>{window.__messages.push(msg);return Promise.resolve({ok:true})}}};
  '''
  page.set_content('<!doctype html><html><head></head><body><main>'+old+'<form id="composer">'+editor+button+'</form></main></body></html>')
  page.evaluate(stub)
  source=(BASE/'content.js').read_text().replace('const HOST=location.hostname;',f"const HOST='{url.split('/')[2]}';")
  page.add_script_tag(content=source)
  page.evaluate('''() => {document.querySelector('#composer button').addEventListener('click', e=>{
    e.preventDefault(); window.__sent=true;
    const el=document.querySelector('[contenteditable="true"]');el.textContent='';
    const n=document.createElement('div');n.id='container';document.querySelector('main').appendChild(n);
  });}''')
  r=page.evaluate('''() => new Promise(resolve=>window.__responders[0]({type:'AFB_START',token:'secret',sessionId:'test1',prompt:'Sample public prompt',ttl:240000},{id:'ours'},resolve))''')
  assert r['ok'],(provider,r)
  assert page.evaluate('window.__sent'),provider
  page.evaluate('(markup)=>{document.querySelector("#container").innerHTML=markup}',new)
  v=dict(P);v['payload']=dict(P['payload']);v['payload']['agent']=provider+' (web)'
  page.evaluate('(data)=>{document.querySelector("#newAnswer").textContent=JSON.stringify(data)}',v)
  page.wait_for_timeout(450)
  page.evaluate('''() => {const original=Date.now;Date.now=()=>original()+9000;}''')
  page.evaluate('''() => {window.__responders[0]({type:'AFB_INSPECT'},{id:'ours'},()=>{});}''')
  page.wait_for_timeout(150)
  states=page.evaluate('window.__messages.map(x=>x.state)')
  print(provider,'status states',states)
  assert 'concluido' in states,(provider,states)
  page.close()
 browser.close()

from pathlib import Path
from playwright.sync_api import sync_playwright
src=(Path(__file__).resolve().parents[1]/'content.js').read_text().replace('const HOST=location.hostname;',"const HOST='chatgpt.com';")
prompt='TAREFA PÚBLICA AUTORIZADA PELO USUÁRIO — AI Forum Bridge. '+'x'*450+' ai-forum-bridge-v1'
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=browser.new_page()
 page.set_content('<main><form><div contenteditable="true" id="prompt-textarea"></div><button id="composer-submit-button"><svg><path d="M12 19V5"></path></svg></button></form></main>')
 page.evaluate('''() => {window.__sends=0;window.__sentText='';window.chrome={runtime:{id:'ours',onMessage:{addListener:cb=>window.__handler=cb},sendMessage:()=>Promise.resolve({ok:true})}};document.querySelector('button').onclick=e=>{e.preventDefault();window.__sends++;window.__sentText=document.querySelector('[contenteditable]').textContent;document.querySelector('[contenteditable]').textContent='';};}''')
 page.evaluate('(s)=>document.querySelector("[contenteditable]").textContent=s',prompt)
 page.add_script_tag(content=src)
 a=page.evaluate('''() => new Promise(resolve => window.__handler({type:'AFB_START',sessionId:'r',token:'t',ttl:40000,prompt:'NEW SHOULD NOT REPLACE',replacePending:true},{id:'ours'},resolve))''')
 assert a['ok'],a
 assert page.evaluate('window.__sends')==1
 assert page.evaluate('window.__sentText')=='NEW SHOULD NOT REPLACE'
 print('Replace stale draft and submit once: okay')
 page.close()
 browser.close()

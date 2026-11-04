from pathlib import Path
from playwright.sync_api import sync_playwright
BASE=Path(__file__).resolve().parents[1]
CASES=[
 ('ChatGPT','chatgpt.com','<button id="composer-submit-button"><svg><path d="M12 19V5"></path></svg></button>'),
 ('Grok','grok.com','<button type="submit"><svg><path d="m5 12 7-7 7 7"></path></svg></button>'),
 ('Gemini','gemini.google.com','<button><mat-icon>arrow_upward</mat-icon></button>'),
]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for provider,host,send in CASES:
  page=browser.new_page()
  page.set_content(f'''<html><body><main><form><div contenteditable="true" role="textbox" id="prompt-textarea"></div><button type="button" aria-label="Add files">+</button><button type="button" aria-label="Start dictation">mic</button>{send}</form></main></body></html>''')
  page.evaluate('''() => {
   window.__sent=false;window.__clickedWrong=false;window.chrome={runtime:{id:'ours',onMessage:{addListener:cb=>window.__handler=cb},sendMessage:()=>Promise.resolve({ok:true})}};
   document.querySelectorAll('button').forEach(b=>b.addEventListener('click', e=>{
    e.preventDefault();if(/add|dictation/i.test(b.getAttribute('aria-label')||'')){window.__clickedWrong=true;return;}
    window.__sent=true;document.querySelector('[contenteditable]').textContent='';
   }));
  }''')
  source=(BASE/'content.js').read_text().replace('const HOST=location.hostname;',f"const HOST='{host}';")
  page.add_script_tag(content=source)
  data=page.evaluate('''() => new Promise(resolve => window.__handler({type:'AFB_START',sessionId:'test123',token:'abc',ttl:40000,prompt:'TAREFA PÚBLICA TESTE'}, {id:'ours'},resolve))''')
  assert data['ok'],(provider,data)
  assert page.evaluate('window.__sent && !window.__clickedWrong'),provider
  print(provider,'unlabeled send passed')
  page.close()
 # Negative test: no send button, must preserve prompt and not click voice
 page=browser.new_page()
 page.set_content('<form><div contenteditable="true" id="prompt-textarea"></div><button aria-label="Start dictation">Mic</button><button aria-label="Add files">Files</button></form>')
 page.evaluate('''() => {window.__wrong=0;window.chrome={runtime:{id:'ours',onMessage:{addListener:cb=>window.__handler=cb},sendMessage:()=>Promise.resolve({ok:true})}};document.querySelectorAll('button').forEach(b=>b.onclick=()=>window.__wrong++);}''')
 page.add_script_tag(content=(BASE/'content.js').read_text().replace('const HOST=location.hostname;',"const HOST='chatgpt.com';"))
 result=page.evaluate('''() => new Promise(resolve => window.__handler({type:'AFB_START',sessionId:'test456',token:'abc',ttl:40000,prompt:'TAREFA PÚBLICA TESTE'}, {id:'ours'},resolve))''')
 assert result['ok'] is False,result
 assert page.evaluate('window.__wrong')==0
 assert page.evaluate('document.querySelector("[contenteditable]").textContent')=='TAREFA PÚBLICA TESTE'
 print('No send button safely stopped without clicking other controls')
 page.close()
 browser.close()

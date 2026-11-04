"""Dedicated browser benchmark for a ChatGPT response with no conventional assistant selectors.
Uses synthetic pages only. Never opens a live account or publishes.
"""
import asyncio, json, statistics, sys
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
BASELINE='--baseline' in sys.argv
SOURCE=(ROOT/'tests'/'baseline-2.2.1-content.js' if BASELINE else ROOT/'content.js').read_text()
if BASELINE: # Main baseline for this bug is actual v2.2.2, not 2.2.1
    SOURCE=(ROOT/'tests'/'baseline-2.2.2-content.js').read_text()
PAYLOAD={'protocol':'ai-forum-bridge-v1','action':'publish','payload':{'kind':'topic','agent':'ChatGPT (web)','model':'Modelo não verificado','title':'Experimento verificável sobre mensagens','content':'Esta é uma contribuição sintética de testes com mais de dez caracteres.'}}
FULL=json.dumps(PAYLOAD,ensure_ascii=False,separators=(',',':'))
EXAMPLE=json.dumps({**PAYLOAD,'payload':{**PAYLOAD['payload'],'title':'Título de exemplo do prompt','content':'Texto de exemplo sem evidência real, não deve ser publicado.'}},ensure_ascii=False,separators=(',',':'))
PROMPT='TAREFA PÚBLICA AUTORIZADA PELO USUÁRIO — AI Forum Bridge. Marcador de correlação: AFB-synthetic-only. Não inclua marcador. Exemplo de JSON: '+EXAMPLE+'; somente a resposta gerada pode ser publicada.'
CASES=[
    ('unclassified-div', 'plain', True),
    ('unclassified-span-tree', 'split', True),
    ('unclassified-code', 'code', True),
    ('unclassified-old-json', 'old', False),
    ('unclassified-echo', 'echo', False),
    ('unclassified-echo-fragment', 'echo-fragment', False),
    ('unclassified-incomplete', 'incomplete', False),
]
async def run_case(browser, case):
    name,mode,expected=case
    page=await browser.new_page(viewport={'width':1100,'height':760})
    old=('<div class="assistant-output"><pre><code>'+FULL+'</code></pre></div>') if mode=='old' else '<div class="thread-text">Conversa anterior sem marcadores</div>'
    html=f'''<!doctype html><html><body><main><div class="thread" id="thread">{old}</div>
    <form id="composer"><div contenteditable="true" id="prompt-textarea" role="textbox"></div><button type="submit" id="composer-submit-button" aria-label="Send">Send</button></form>
    </main></body></html>'''
    await page.set_content(html)
    await page.evaluate('''() => {window.__msgs=[];window.__listeners=[];window.__queryCalls=0;const original=document.querySelectorAll.bind(document);document.querySelectorAll=function(sel){window.__queryCalls++;return original(sel);};window.chrome={runtime:{id:'ours',onMessage:{addListener:cb=>window.__listeners.push(cb)},sendMessage:msg=>{window.__msgs.push({...msg,now:performance.now()});return Promise.resolve({ok:true});}}};}''')
    await page.add_script_tag(content=SOURCE.replace('const HOST=location.hostname;',"const HOST='chatgpt.com';"))
    await page.evaluate('''(mode)=>{document.querySelector('#composer button').addEventListener('click',ev=>{ev.preventDefault();document.querySelector('#prompt-textarea').textContent='';const thread=document.querySelector('#thread');if(mode==='echo'||mode==='echo-fragment'){const e=document.createElement('div');e.className='user-echo';e.textContent=mode==='echo'?window.__thePrompt:window.__exampleJson;thread.append(e);}else if(mode!=='old'){const e=document.createElement('div');e.className='assistant-output';e.id='new-answer';thread.append(e);}window.__clicked=true;});}''',mode)
    await page.evaluate('(x)=>{window.__thePrompt=x;window.__exampleJson='+json.dumps(EXAMPLE,ensure_ascii=False)+';}',PROMPT)
    r=await page.evaluate('''(p)=>new Promise(resolve=>window.__listeners[0]({type:'AFB_START',token:'secret',sessionId:'s',prompt:p,ttl:240000},{id:'ours'},resolve))''',PROMPT)
    if not r.get('ok'):
        await page.close();return {'case':name,'passed':False,'error':r.get('error'),'final':False}
    if mode=='plain': await page.evaluate('(x)=>{document.querySelector("#new-answer").textContent=x;window.__answerAt=performance.now()}',FULL)
    if mode=='split': await page.evaluate('''(x)=>{const div=document.querySelector('#new-answer');for(const part of [x.slice(0,40),x.slice(40,120),x.slice(120)]){const span=document.createElement('span');span.textContent=part;div.append(span);}window.__answerAt=performance.now();}''',FULL)
    if mode=='code': await page.evaluate('''(x)=>{const e=document.querySelector('#new-answer');const pre=document.createElement('pre');const code=document.createElement('code');code.textContent=x;pre.append(code);e.append(pre);window.__answerAt=performance.now();}''',FULL)
    if mode=='incomplete': await page.evaluate('''(x)=>{document.querySelector('#new-answer').textContent=x.slice(0,-18);window.__answerAt=performance.now()}''',FULL)
    await page.wait_for_timeout(6600)
    result=await page.evaluate('''() => {let res;window.__listeners[0]({type:'AFB_INSPECT'},{id:'ours'},r=>res=r);return {final:window.__msgs.some(x=>x.final),states:window.__msgs.map(x=>x.state),calls:window.__queryCalls,checks:window.__msgs.length, latency_ms:window.__msgs.find(x=>x.final)?.now-window.__answerAt||null, deepScans:res?.deepScans||0, nodesScanned:res?.deepTextNodes||0};}''')
    await page.close()
    return {'case':name,'passed':result['final']==expected,'expected':expected,**result}
async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        cases=await asyncio.gather(*(run_case(browser,c) for c in CASES))
        await browser.close()
    result={'environment':'Chromium headless, synthetic DOM, no logged-in ChatGPT and no publishing', 'baseline':'v2.2.2' if BASELINE else 'v2.2.3', 'passed':sum(x['passed'] for x in cases),'total':len(cases),'cases':cases}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    dest=ROOT/('BENCHMARK_CHATGPT_BASELINE.json' if BASELINE else 'BENCHMARK_CHATGPT.json')
    dest.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    if result['passed']!=len(cases):sys.exit(1)
if __name__=='__main__':asyncio.run(main())

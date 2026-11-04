"""Benchmark de regressão do ChatGPT com HTML fragmentado.
Páginas DOM sintéticas; sem acessar chats reais nem efetuar POST.
"""
import asyncio, json, statistics, sys
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
BASELINE='--baseline' in sys.argv
SOURCE=(ROOT/'tests'/'baseline-2.2.3-content.js' if BASELINE else ROOT/'content.js').read_text()
DOC={'protocol':'ai-forum-bridge-v1','action':'publish','payload':{'kind':'topic','agent':'ChatGPT (web)','model':'Modelo não verificado','title':'Avaliação de captura dividida em elementos','content':'Uma análise técnica de colaboração, fatos, limitações e experimentos.'}}
PROMPT='TAREFA PÚBLICA AUTORIZADA PELO USUÁRIO — AI Forum Bridge. Marcador de correlação: AFB-test. Retorne apenas JSON: '+json.dumps({'protocol':'ai-forum-bridge-v1','action':'publish','payload':{'kind':'topic','agent':'ChatGPT (web)','model':'Modelo não verificado','title':'Exemplo','content':'Somente um exemplo do prompt.'}},ensure_ascii=False)
CASES=[('html-aninhado-e-fragmento-final','fragment',True,False),('resposta-inteira-de-3224-caracteres','oversize',True,True),('resposta-validada-em-bloco-code','code',True,False),('exemplo-do-prompt-sem-resposta','echo',False,False)]
async def run_case(browser,case):
    name,mode,expect_capture,oversize=case
    page=await browser.new_page(viewport={'width':1100,'height':760})
    await page.set_content('''<!doctype html><html><body><main>
    <div id="thread"><div data-message-author-role="user" id="old-user">Solicitação já enviada</div></div>
    <form id="composer"><div contenteditable="true" id="prompt-textarea" role="textbox"></div>
    <button type="submit" id="composer-submit-button" aria-label="Send">Send</button></form>
    </main></body></html>''')
    await page.evaluate('''() => {window.__msgs=[];window.__listeners=[];window.chrome={runtime:{id:'ours',onMessage:{addListener:cb=>window.__listeners.push(cb)},sendMessage:msg=>{window.__msgs.push({...msg,t:performance.now()});return Promise.resolve({ok:true});}}};}''')
    await page.add_script_tag(content=SOURCE.replace('const HOST=location.hostname;',"const HOST='chatgpt.com';"))
    await page.evaluate('''() => {document.querySelector('#composer button').addEventListener('click',e=>{e.preventDefault();document.querySelector('#prompt-textarea').textContent='';});}''')
    r=await page.evaluate('''(prompt)=>new Promise(res=>window.__listeners[0]({type:'AFB_START',token:'tok',sessionId:'ss',prompt,ttl:240000},{id:'ours'},res))''',PROMPT)
    if not r.get('ok'):
        await page.close();return {'case':name,'passed':False,'error':r.get('error')}
    doc=json.loads(json.dumps(DOC))
    if oversize:doc['payload']['content']='A'*3224
    full=json.dumps(doc,ensure_ascii=False,separators=(',',':'))
    if mode=='fragment':
        # The last .markdown fragment is not a complete Bridge object.
        await page.evaluate('''(full)=>{const parent=document.createElement('div');parent.setAttribute('data-message-author-role','assistant');
          const a=document.createElement('div');a.className='markdown';a.textContent=full;parent.append(a);
          const b=document.createElement('div');b.className='markdown';b.textContent='{"kind":"topic","title":"fragmento"}';parent.append(b);
          document.querySelector('#thread').append(parent);window.__startAt=performance.now();}''',full)
    elif mode=='oversize':
        await page.evaluate('''(full)=>{const parent=document.createElement('div');parent.setAttribute('data-message-author-role','assistant');
          const a=document.createElement('div');a.className='markdown';a.textContent=full;parent.append(a);
          const b=document.createElement('div');b.className='markdown';b.textContent='{"title":"fragmento no final da resposta"}';parent.append(b);
          document.querySelector('#thread').append(parent);window.__startAt=performance.now();}''',full)
    elif mode=='code':
        await page.evaluate('''(full)=>{const n=document.createElement('div');n.className='markdown';
          const c=document.createElement('pre');const d=document.createElement('code');d.textContent=full;c.append(d);n.append(c);
          document.querySelector('#thread').append(n);window.__startAt=performance.now();}''',full)
    else:
        await page.evaluate('''(prompt)=>{const n=document.createElement('div');n.setAttribute('data-message-author-role','user');n.textContent=prompt;document.querySelector('#thread').append(n);window.__startAt=performance.now();}''',PROMPT)
    await page.wait_for_timeout(6300)
    result=await page.evaluate('''() => {const done=window.__msgs.find(x=>x.final);return {final:!!done,captured:done?.text||'',capturedLength:done?.text.length||0,latency:done?Math.round(done.t-window.__startAt):null,states:window.__msgs.map(x=>x.state)};}''')
    result['passed']=(result['final']==expect_capture and (not expect_capture or result['captured']==full))
    result['expectedCapture']=expect_capture;result.pop('captured');result['case']=name
    await page.close();return result
async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        cases=await asyncio.gather(*(run_case(browser,c) for c in CASES))
        await browser.close()
    report={'environment':'Chromium headless, DOM sintético, sem acesso a chats autenticados ou a rede','version':'2.2.3 (baseline)' if BASELINE else '2.2.4','passed':sum(c['passed'] for c in cases),'total':len(cases),'cases':cases}
    print(json.dumps(report,ensure_ascii=False,indent=2))
    (ROOT/('BENCHMARK_224_BASELINE.json' if BASELINE else 'BENCHMARK_224.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
if __name__=='__main__':asyncio.run(main())

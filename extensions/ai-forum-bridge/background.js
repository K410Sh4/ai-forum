import { createBridgeService, isTrustedPage } from './service.js';
import { captureText } from './protocol.js';
import { readSelectedText } from './capture.js';
import { createCaptureController } from './stream.js';
const service = createBridgeService({storage:chrome.storage.session});
const streams = createCaptureController({storage:chrome.storage.session,tabs:chrome.tabs,scripting:chrome.scripting,runtime:chrome.runtime});
const MENU='ai-forum-selection';
chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
async function openReview(text='', tab, error='') {
  const id=crypto.randomUUID();
  let origin='';
  try { const url=new URL(tab?.url); if (['https:','http:'].includes(url.protocol)) origin=url.origin; } catch { /* no URL stored */ }
  try { text=captureText(text); } catch (e) {text='';error=e.message;}
  const saved=await chrome.storage.session.get(null);
  const captures=Object.entries(saved).filter(([k])=>k.startsWith('capture:')).sort((a,b)=>(b[1]?.at||0)-(a[1]?.at||0));
  await chrome.storage.session.remove(captures.filter(([,v],i)=>i>=9||Date.now()-(v?.at||0)>3600000).map(([k])=>k));
  await chrome.storage.session.set({['capture:'+id]:{text,origin,at:Date.now(),error,sourceTabId:tab?.id}});
  await chrome.tabs.create({url:chrome.runtime.getURL('bridge.html')+'?capture='+encodeURIComponent(id)});
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({id:MENU,title:'Revisar seleção no AI-Forum Bridge',contexts:['selection'],documentUrlPatterns:['https://*/*','http://*/*']});
  });
});
chrome.action.onClicked.addListener(async tab => {
  let text='', error='';
  try {
    const result=await chrome.scripting.executeScript({target:{tabId:tab.id},func:readSelectedText,world:'ISOLATED'});
    text=result[0]?.result || '';
  } catch { error='Não foi possível ler a seleção nesta página. Cole o texto manualmente.'; }
  await openReview(text,tab,error);
});
chrome.contextMenus.onClicked.addListener(async (info,tab) => {
  if(info.menuItemId===MENU) await openReview(info.selectionText||'',tab);
});
chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if(message?.type==='BRIDGE_CAPTURE'){
    streams.receive(message,sender).then(ok=>sendResponse({ok}),()=>sendResponse({ok:false}));return true;
  }
  if(!isTrustedPage(sender,chrome.runtime)) {sendResponse({ok:false,error:'Origem não autorizada.'});return false;}
  const operation=message?.type?.startsWith('STREAM_')?streams.handle(message):
    message?.type==='CLEAR'?streams.clear().then(()=>service.handle(message)):service.handle(message);
  operation.then(data=>sendResponse({ok:true,data}),error=>sendResponse({ok:false,error:error?.message||'Operação recusada.'}));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId=>{streams.stop(tabId).catch(()=>{});});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='loading')streams.stop(tabId).catch(()=>{});});

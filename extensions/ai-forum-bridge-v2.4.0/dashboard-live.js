// Single responsibility: connect the Bridge dashboard to session storage and
// tab lifecycle changes. The panel never reads chat DOM or publishes on its own.
const SESSION_KEY='afb-session';
export function watchBridgeActivity({chromeApi,onSession,onTabs,onReconnect,debounceMs=180}){
  if(!chromeApi?.storage?.onChanged || !chromeApi?.tabs?.onCreated)
    throw Error('Os eventos do Chrome necessários ao acompanhamento não estão disponíveis.');
  let disposed=false,tabTimer=null,pending=false,latest=null;
  const deliver=()=>{
    pending=false;
    if(!disposed)onSession(latest);
  };
  const storage=(changes,area)=>{
    if(disposed||area!=='session'||!Object.prototype.hasOwnProperty.call(changes,SESSION_KEY))return;
    latest=changes[SESSION_KEY]?.newValue??null;
    if(!pending){pending=true;queueMicrotask(deliver);}
  };
  const tabs=()=>{
    if(disposed || tabTimer!==null)return;
    tabTimer=setTimeout(()=>{tabTimer=null;if(!disposed)onTabs();},debounceMs);
  };
  const updated=(_tabId,change)=>{
    if(change.url!==undefined||change.status!==undefined||change.discarded!==undefined||change.frozen!==undefined)tabs();
  };
  const reconnect=()=>{if(!disposed){onReconnect();tabs();}};
  chromeApi.storage.onChanged.addListener(storage);
  chromeApi.tabs.onCreated.addListener(tabs);
  chromeApi.tabs.onRemoved.addListener(tabs);
  chromeApi.tabs.onUpdated.addListener(updated);
  const onFocus=()=>reconnect();
  const onVisible=()=>{if(document.visibilityState==='visible')reconnect();};
  window.addEventListener('focus',onFocus);
  document.addEventListener('visibilitychange',onVisible);
  return ()=>{
    disposed=true;
    if(tabTimer!==null)clearTimeout(tabTimer);
    chromeApi.storage.onChanged.removeListener(storage);
    chromeApi.tabs.onCreated.removeListener(tabs);
    chromeApi.tabs.onRemoved.removeListener(tabs);
    chromeApi.tabs.onUpdated.removeListener(updated);
    window.removeEventListener('focus',onFocus);
    document.removeEventListener('visibilitychange',onVisible);
  };
}

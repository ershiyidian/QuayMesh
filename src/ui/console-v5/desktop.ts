import { ib } from './presentation.js';

interface DesktopBridge { postMessage(value:unknown):void }
function bridge():DesktopBridge|undefined {
  return (window as unknown as {chrome?:{webview?:DesktopBridge}}).chrome?.webview;
}
export function notifyDesktop(type:'theme'|'session'|'external'|'settings',value?:unknown):void {
  bridge()?.postMessage({type,value});
}
export function desktopActions():string {
  return bridge() ? ib('external','desktop-browser','在浏览器中打开')+ib('network','desktop-settings','窗口连接设置') : '';
}

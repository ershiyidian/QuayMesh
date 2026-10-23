import type {ServerConfig} from '../config.js';
import type {FederationRuntime} from '../federation/runtime.js';
import {rootHandle,workspaceHandle} from '../federation/routing.js';
import {readLocalMetadata} from './local-queries.js';

// 编辑表单读取持久配置及其版本；运行配置可能仍等待空闲时应用。
export async function readWorkbenchMetadata(config:ServerConfig,runtime?:FederationRuntime) {
  const metadata=readLocalMetadata(config);
  if(!runtime||!metadata.settings)return metadata;
  const node=config.federation?.nodeId??'local';
  try{
    const saved=await runtime.request<Record<string,any>>(node,'settings.get',{});
    if(!Number.isSafeInteger(saved.revision))throw new Error('节点持久设置没有有效修订号');
    const egress=saved.egress;
    if(!egress||!Array.isArray(saved.roots))throw new Error('节点持久设置缺少根目录或出网配置');
    const pending=typeof saved.pending==='boolean'?saved.pending:typeof saved.appliedRevision==='number'?saved.appliedRevision!==saved.revision:null;
    metadata.settings={revision:saved.revision,savedRevision:saved.savedRevision??saved.revision,appliedRevision:saved.appliedRevision??null,
      pending,error:typeof saved.applicationError==='string'?saved.applicationError:null,
      nickname:saved.nickname,priority:saved.priority,
      egress:{enabled:egress.enabled,config:egress.mihomoConfig??null,port:Number(new URL(egress.proxyUrl).port)||80,
        probe:egress.probeUrl,recovery:egress.recoveryDelayMs/1000,inherit:egress.inheritProxy}};
    metadata.roots=saved.roots.map(root=>({id:workspaceHandle(node,root.id),reference:rootHandle(node,root.id),localId:root.id,nodeId:node,
      name:root.nickname,path:root.path,description:root.description??'',tags:root.tags??[],enabled:root.enabled!==false,readOnly:false,
      revision:saved.revision,settingsPending:pending,settingsError:metadata.settings!.error}));
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    metadata.settings={...metadata.settings,revision:null,savedRevision:null,appliedRevision:null,pending:null,error:message};
    metadata.roots=metadata.roots.map(root=>({...root,revision:0,settingsPending:null,settingsError:message}));
  }
  return metadata;
}

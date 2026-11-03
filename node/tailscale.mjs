import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile);
const cacheMs=5000, maxResponseBytes=1024*1024;
const states=["NoState","InUseOtherUser","NeedsLogin","NeedsMachineAuth","Stopped","Starting","Running"];
const socketFailures=new Set(["ENOENT","ECONNREFUSED","ECONNRESET","EPIPE","ETIMEDOUT","ENOTCONN"]);
const controlWarnings=new Set(["mapresponse-timeout","not-in-map-poll"]);

function failure(code,message,recoverable=false) {
  const error=new Error(`${code}: ${message}`);
  error.code=code;
  if(recoverable)error.recoveryEligible=true;
  return error;
}
function record(value) {
  return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
function hostname(value) {
  return typeof value==="string"?value.toLowerCase().replace(/\.$/,""):"";
}

// 初始健康快照按换行分隔 JSON；收到后立即断开，空闲通知流没有心跳。
function localJSON(socketPath,path,timeoutMs,initialHealth=false) {
  return new Promise((resolve,reject)=>{
    let request,response,settled=false,body="",bytes=0;
    const finish=(error,value)=>{
      if(settled)return;
      settled=true; clearTimeout(timer);
      response?.destroy(); request?.destroy();
      if(error)reject(error); else resolve(value);
    };
    const timer=setTimeout(()=>finish(failure("TAILSCALE_LOCALAPI_TIMEOUT","本地 Tailscale API 未在时限内响应",true)),timeoutMs);
    const decode=text=>{
      try{return JSON.parse(text);}
      catch{throw failure("TAILSCALE_LOCALAPI_INVALID_JSON","本地 Tailscale API 返回了无效 JSON");}
    };
    const consumeHealth=line=>{
      if(!line.trim())return;
      const message=decode(line);
      if(record(message)&&message.Health!=null) {
        if(!record(message.Health))throw failure("TAILSCALE_HEALTH_INVALID","健康快照格式无效");
        finish(null,{state:message.State,health:message.Health});
      }
    };
    request=http.request({socketPath,path,method:"GET",agent:false,
      headers:{host:"local-tailscaled.sock",connection:"close"}},res=>{
      response=res;
      if(res.statusCode!==200) {
        finish(failure("TAILSCALE_LOCALAPI_HTTP",`本地 Tailscale API 返回 HTTP ${res.statusCode}`));return;
      }
      res.setEncoding("utf8");
      res.on("data",chunk=>{
        if(settled)return;
        bytes+=Buffer.byteLength(chunk);
        if(bytes>maxResponseBytes) {
          finish(failure("TAILSCALE_LOCALAPI_TOO_LARGE","本地 Tailscale API 响应超出大小限制"));return;
        }
        body+=chunk;
        if(initialHealth) {
          try {
            let newline;
            while(!settled&&(newline=body.indexOf("\n"))!==-1) {
              const line=body.slice(0,newline);body=body.slice(newline+1);
              consumeHealth(line);
            }
          } catch(error){finish(error);}
        }
      });
      res.on("end",()=>{
        if(settled)return;
        try {
          if(!initialHealth)finish(null,decode(body));
          else {
            consumeHealth(body);
            if(!settled)finish(failure("TAILSCALE_HEALTH_UNAVAILABLE","IPN 通知结束前未提供初始健康快照"));
          }
        } catch(error){finish(error);}
      });
      res.on("aborted",()=>finish(failure("TAILSCALE_LOCALAPI_CLOSED","本地 Tailscale API 提前断开",true)));
      res.on("error",()=>finish(failure("TAILSCALE_LOCALAPI_CLOSED","本地 Tailscale API 读取失败",true)));
    });
    request.on("error",error=>finish(failure("TAILSCALE_LOCALAPI_UNREACHABLE",
      `无法连接专用 Tailscale socket（${error.code||"连接失败"}）`,socketFailures.has(error.code))));
    request.end();
  });
}

function assertRunning(state) {
  if(state!=="Running")throw failure("TAILSCALE_NOT_RUNNING",`Tailscale 当前状态为 ${state||"未知"}`);
}
function funnelReady(config,host,target) {
  if(config==null)return false;
  if(!record(config))throw failure("TAILSCALE_FUNNEL_INVALID","Funnel 配置格式无效");
  const key=`${host}:443`,tcp=config.TCP?.["443"],handler=config.Web?.[key]?.Handlers?.["/"];
  const foreground=Object.values(config.Foreground||{}).some(value=>value?.TCP?.["443"]||value?.Web?.[key]);
  if(foreground||tcp&&(tcp.HTTP||tcp.TCPForward||tcp.TerminateTLS)||
    handler&&(handler.Proxy!==target||handler.Path||handler.Text||handler.Redirect))
    throw failure("TAILSCALE_FUNNEL_CONFLICT","443 或根路径已有不同的转发配置，请先处理配置冲突");
  return tcp?.HTTPS===true&&handler?.Proxy===target&&config.AllowFunnel?.[key]===true;
}

export function createTailscaleProbe({socketPath,publicUrl,port,command,timeoutMs=2500,recoveryMs=120000}) {
  let url;
  try{url=new URL(publicUrl);}
  catch{throw failure("TAILSCALE_PUBLIC_URL_INVALID","公网入口必须是有效的 HTTPS 地址");}
  if(url.protocol!=="https:"||url.port&&url.port!=="443"||url.username||url.password)
    throw failure("TAILSCALE_PUBLIC_URL_INVALID","Funnel 公网入口需要使用 HTTPS 443，且地址不能含凭据");
  if(typeof socketPath!=="string"||!socketPath)
    throw failure("TAILSCALE_SOCKET_INVALID","需要专用 Tailscale socket 路径");
  if(!Number.isInteger(port)||port<1||port>65535)
    throw failure("TAILSCALE_TARGET_PORT_INVALID","本地 MCP 端口无效");
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isFinite(recoveryMs)||recoveryMs<0)
    throw failure("TAILSCALE_TIMEOUT_INVALID","探测和恢复时限无效");
  const host=hostname(url.hostname),target=`http://127.0.0.1:${port}`;
  let generation;

  async function inspect(pid) {
    const status=await localJSON(socketPath,"/localapi/v0/status?peers=false",timeoutMs);
    if(!record(status))throw failure("TAILSCALE_STATUS_INVALID","Tailscale 状态格式无效");
    assertRunning(status.BackendState);
    if(hostname(status.Self?.DNSName)!==host)
      throw failure("TAILSCALE_IDENTITY_MISMATCH","专用 Tailscale 节点域名与配置的公网入口不一致");
    const initial=await localJSON(socketPath,"/localapi/v0/watch-ipn-bus?mask=130",timeoutMs,true);
    if(initial.state!=null)assertRunning(typeof initial.state==="number"?states[initial.state]:initial.state);
    const warnings=initial.health.Warnings??{};
    if(!record(warnings))throw failure("TAILSCALE_HEALTH_INVALID","Tailscale 健康告警格式无效");
    const codes=Object.keys(warnings);
    if(codes.includes("network-status"))
      throw failure("TAILSCALE_NETWORK_DOWN","Tailscale 报告网络不可用，等待网络恢复");
    if(codes.includes("wantrunning-false")||codes.includes("login-state")||codes.includes("warming-up"))
      throw failure("TAILSCALE_NOT_READY",`Tailscale 尚未就绪（${codes.join(", ")}）`);
    const stalled=codes.filter(code=>controlWarnings.has(code));
    if(stalled.length)
      throw failure("TAILSCALE_CONTROL_STALLED",`协调连接持续异常（${stalled.join(", ")}）`,true);
    if(status.Self?.Online!==true)
      throw failure("TAILSCALE_OFFLINE","Tailscale 正在运行，但节点尚未在线");
    const connectivity=codes.filter(code=>warnings[code]?.ImpactsConnectivity===true);
    if(connectivity.length)
      throw failure("TAILSCALE_CONNECTIVITY_UNHEALTHY",`Tailscale 连接未就绪（${connectivity.join(", ")}）`);
    const config=await localJSON(socketPath,"/localapi/v0/serve-config",timeoutMs);
    if(!funnelReady(config,host,target)) {
      if(typeof command!=="string"||!command)
        throw failure("TAILSCALE_CLI_MISSING","Funnel 配置缺失，且未配置配套 Tailscale CLI");
      try {
        await execFileAsync(command,[`--socket=${socketPath}`,"funnel","--bg","--https=443",target],
          {timeout:timeoutMs,maxBuffer:64*1024,windowsHide:true});
      } catch(error) {
        throw failure("TAILSCALE_FUNNEL_SETUP_FAILED",`配置 Funnel 失败（${error.killed?"命令超时":error.code||"命令失败"}）`);
      }
      const configured=await localJSON(socketPath,"/localapi/v0/serve-config",timeoutMs);
      if(!funnelReady(configured,host,target))
        throw failure("TAILSCALE_FUNNEL_NOT_CONFIGURED","Tailscale CLI 已结束，但 Funnel 配置仍未生效");
    }
    return {ready:true,pid,backendState:status.BackendState,online:true,dnsName:host,
      publicUrl:url.href,funnel:{port:443,target},health:initial.health,observedAt:Date.now()};
  }

  return async function probe(child) {
    if(!Number.isInteger(child?.pid)||child.pid<=0||child.exitCode!=null||child.signalCode!=null)
      throw failure("TAILSCALE_PROCESS_NOT_RUNNING","受管 Tailscale 进程未运行");
    if(generation?.pid!==child.pid)
      generation={pid:child.pid,nextReadAt:0,pending:null,value:null,error:null,recoverableSince:null};
    const current=generation;
    if(!current.pending&&Date.now()>=current.nextReadAt) {
      current.nextReadAt=Date.now()+cacheMs;
      current.pending=inspect(child.pid).then(value=>{
        current.value=value;current.error=null;current.recoverableSince=null;
      },error=>{
        current.error=error;
        if(error.recoveryEligible)current.recoverableSince??=Date.now();
        else current.recoverableSince=null;
      }).finally(()=>{current.pending=null;});
    }
    if(current.pending)await current.pending;
    if(current.error) {
      const error=failure(current.error.code||"TAILSCALE_PROBE_FAILED",
        current.error.message.replace(/^[A-Z_]+: /,""));
      if(current.error.recoveryEligible&&Date.now()-current.recoverableSince>=recoveryMs)
        error.restartComponent=true;
      throw error;
    }
    return current.value;
  };
}


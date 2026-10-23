import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connectSocket } from "./network.mjs";

const execFileAsync=promisify(execFile);

// `netstat -ano` lists listeners with a wildcard peer and port zero. It omits
// bound, non-listening sockets (those require -q). Use numeric endpoints rather
// than the localized state label, which is e.g. ABHÖREN on German Windows.
export function windowsTcpListenerOwners(output,port) {
  const owners=new Set();
  for(const line of output.split(/\r?\n/)) {
    const columns=line.trim().split(/\s+/);
    if(columns.length!==5||columns[0].toUpperCase()!=="TCP"||!/^(?:0\.0\.0\.0|\[::\]):0$/.test(columns[2]))continue;
    const local=columns[1].match(/:(\d+)$/),pid=Number(columns[4]);
    if(local&&Number(local[1])===port&&Number.isSafeInteger(pid)&&pid>0)owners.add(pid);
  }
  return [...owners];
}

export async function assertMeshPortFree(port) {
  const occupied=await connectSocket("127.0.0.1",port,{timeoutMs:500}).then(socket=>{
    socket.destroy();return true;
  },error=>{
    if(error.code==="ECONNREFUSED")return false;
    throw error;
  });
  if(occupied)throw new Error(`EASYTIER_PORT_OCCUPIED: 127.0.0.1:${port} 已由其他进程监听，请先停用旧 EasyTier`);
}

export async function assertManagedMeshListener(pid,port) {
  if(!Number.isInteger(pid)||pid<=0)throw new Error("EASYTIER_PROCESS_NOT_RUNNING");
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error("EASYTIER_RPC_PORT_INVALID");
  if(process.platform!=="win32")return;
  // Windows TUN 由系统网络管理器维护，管理端口必须归启动的 EasyTier 子进程。
  const {stdout}=await execFileAsync("netstat.exe",["-ano"],
    {timeout:5000,windowsHide:true,maxBuffer:4*1024*1024});
  const owners=windowsTcpListenerOwners(stdout,port);
  if(!owners.includes(pid))throw new Error(`EASYTIER_RPC_OWNER_MISMATCH: 端口 ${port} 由 PID ${owners.join(",")} 监听，受管进程为 ${pid}`);
}

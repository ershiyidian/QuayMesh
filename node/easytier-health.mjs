import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connectSocket } from "./network.mjs";

const execFileAsync=promisify(execFile);

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
  if(process.platform!=="win32")return;
  // Windows TUN 由系统网络管理器维护，管理端口必须归启动的 EasyTier 子进程。
  const command=`(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess) -join ','`;
  const {stdout}=await execFileAsync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],
    {timeout:5000,windowsHide:true,maxBuffer:16*1024});
  const owners=stdout.trim().split(",").map(value=>Number(value.trim()));
  if(!owners.includes(pid))throw new Error(`EASYTIER_RPC_OWNER_MISMATCH: 端口 ${port} 由 PID ${owners.join(",")} 监听，受管进程为 ${pid}`);
}

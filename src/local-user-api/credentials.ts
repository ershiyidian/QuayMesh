import {constants} from "node:fs";
import {lstat,open,realpath} from "node:fs/promises";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {isAbsolute,join,resolve,win32} from "node:path";
import {homedir} from "node:os";
import {LOCAL_USER_API_PROTOCOL,identifier} from "./protocol.js";
import {LocalUserClientError,validLocalEndpoint,type LocalUserConnection} from "./client.js";

export interface LocalUserDiscovery {protocol:typeof LOCAL_USER_API_PROTOCOL;endpoint:string;}
export interface LocalCredentialVault {read(target:string):Promise<string|null>;write(target:string,value:string):Promise<void>;}
interface StoredCredential {audience:string;endpoint:string;clientId:string;grantId:string;credential:string;expiresAt:number;}
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const failure=(code:string,message:string)=>new LocalUserClientError(code,message);
const credentialValid=(value:unknown):value is string=>typeof value==="string"&&/^qml1_[A-Za-z0-9_-]{43}$/.test(value);
const secureStoreError=()=>failure("LOCAL_API_SECURE_STORAGE_UNAVAILABLE","Configure or unlock Windows Credential Manager or a desktop Secret Service before importing this client. No plaintext credential was saved.");

export function localUserConfigDirectory(explicit?:string,env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform,home=homedir()):string{
  const paths=platform==="win32"?win32:{join,resolve,isAbsolute};
  let value=explicit??env.QUAYMESH_LOCAL_API_CONFIG_DIR??env.QUAYMESH_CONFIG_DIR;
  if(value===undefined){
    value=platform==="win32"?paths.join(env.LOCALAPPDATA||paths.join(home,"AppData","Local"),"QuayMesh","config")
      :paths.join(env.XDG_CONFIG_HOME||paths.join(home,".config"),"quaymesh");
  }
  if(typeof value!=="string"||!value||value.length>4096||/[\x00-\x1f\x7f]/.test(value))
    throw failure("LOCAL_API_INVALID_CONFIG_DIR","Provide a valid local installation config directory.");
  if(value==="~")value=home;else if(value.startsWith("~/")||value.startsWith("~\\"))value=paths.join(home,value.slice(2));
  return paths.resolve(value);
}

export function localClientAlias(value:unknown):string{
  if(typeof value!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))
    throw failure("LOCAL_API_INVALID_CLIENT","Use a client alias of 1–64 letters, digits, dots, underscores or hyphens.");
  return value;
}
export function localCredentialTarget(client:string,endpoint:string):string{
  return `QuayMesh.LocalUser.v1/${createHash("sha256").update(endpoint).digest("hex")}/${localClientAlias(client)}`;
}

/** Reads only the public IPC discovery file. It never loads auth.json or the
 * administrator/cluster configuration. The server owns its private directory. */
export async function readLocalUserDiscovery(configDir:string,options:{platform?:NodeJS.Platform;env?:NodeJS.ProcessEnv;run?:SecretProcessRunner}={}):Promise<LocalUserDiscovery>{
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
    const platform=options.platform??process.platform,path=join(configDir,"local-user-api.json");
    const directory=await lstat(configDir);
    if(!directory.isDirectory()||directory.isSymbolicLink())
      throw failure("LOCAL_API_DISCOVERY_UNSAFE","The local API discovery directory must not be a link.");
    if(platform==="win32")await verifyWindowsDiscoveryAcl(configDir,path,options);
    else if(directory.uid!==process.getuid?.()||(directory.mode&0o022)!==0||await realpath(configDir)!==resolve(configDir))
      throw failure("LOCAL_API_DISCOVERY_UNSAFE","The local API discovery directory must belong to this OS user and not be writable by other users.");
    file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>16*1024||platform!=="win32"&&((stat.mode&0o077)!==0||stat.uid!==process.getuid?.()))
      throw failure("LOCAL_API_DISCOVERY_UNSAFE","The local API discovery file must belong to this OS user and be private.");
    const bytes=Buffer.alloc(16*1024+1),read=await file.read(bytes,0,bytes.length,0);
    if(read.bytesRead>16*1024)throw failure("LOCAL_API_DISCOVERY_INVALID","The local API discovery file is invalid.");
    const value:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,read.bytesRead)).replace(/^\uFEFF/,""));
    const [after,afterDirectory]=await Promise.all([lstat(path),lstat(configDir)]);
    if(after.isSymbolicLink()||after.dev!==stat.dev||after.ino!==stat.ino||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs
      ||afterDirectory.dev!==directory.dev||afterDirectory.ino!==directory.ino)
      throw failure("LOCAL_API_DISCOVERY_UNSAFE","The local API discovery changed while it was read.");
    if(!object(value)||value.protocol!==LOCAL_USER_API_PROTOCOL||!validLocalEndpoint(value.endpoint,platform))
      throw failure("LOCAL_API_DISCOVERY_INVALID","The local API discovery file does not describe a supported local endpoint.");
    return {protocol:LOCAL_USER_API_PROTOCOL,endpoint:value.endpoint};
  }catch(error){
    if(error instanceof LocalUserClientError)throw error;
    throw failure("LOCAL_API_DISCOVERY_UNAVAILABLE","Local API discovery is unavailable. Check that this installation supports the local API and its service is running.");
  }finally{await file?.close();}
}

function storedCredential(value:unknown,endpoint:string):StoredCredential{
  if(!object(value)||value.audience!==LOCAL_USER_API_PROTOCOL||value.endpoint!==endpoint||!credentialValid(value.credential)
    ||!identifier(value.clientId)||!identifier(value.grantId)||!Number.isSafeInteger(value.expiresAt))
    throw failure("LOCAL_API_INVALID_CREDENTIAL","The stored credential does not match this local API installation.");
  if((value.expiresAt as number)<=Date.now())throw failure("LOCAL_API_CREDENTIAL_EXPIRED","This local client credential has expired. Ask the owner to register or rotate it.");
  return {audience:LOCAL_USER_API_PROTOCOL,endpoint,clientId:value.clientId,grantId:value.grantId,credential:value.credential,expiresAt:value.expiresAt as number};
}

export async function importLocalUserEnrollment(client:string,value:unknown,discovery:LocalUserDiscovery,vault:LocalCredentialVault=createPlatformCredentialVault()){
  localClientAlias(client);
  const stored=storedCredential(value,discovery.endpoint);
  const enrollment=value as Record<string,unknown>,allowed=new Set(["status:read","tasks:read","events:read","peer:send","peer:read","peer:ack"]);
  const validIds=(ids:unknown)=>ids===null||Array.isArray(ids)&&ids.length>0&&ids.length<=256&&ids.every(identifier)&&new Set(ids).size===ids.length;
  if(typeof enrollment.clientName!=="string"||!enrollment.clientName.trim()||enrollment.clientName.length>128||/[\x00-\x1f\x7f]/.test(enrollment.clientName)
    ||!Array.isArray(enrollment.capabilities)||!enrollment.capabilities.length
    ||enrollment.capabilities.some(scope=>typeof scope!=="string"||!allowed.has(scope))
    ||new Set(enrollment.capabilities).size!==enrollment.capabilities.length
    ||!validIds(enrollment.taskIds)||enrollment.peerTaskIds!==undefined&&!validIds(enrollment.peerTaskIds)
    ||enrollment.sourceTaskId!==null&&!identifier(enrollment.sourceTaskId)
    ||enrollment.capabilities.some(scope=>String(scope).startsWith("peer:"))&&!identifier(enrollment.sourceTaskId)
    ||typeof enrollment.sourceTaskId==="string"&&Array.isArray(enrollment.taskIds)&&!enrollment.taskIds.includes(enrollment.sourceTaskId)
    ||typeof enrollment.sourceTaskId==="string"&&Array.isArray(enrollment.peerTaskIds)&&!enrollment.peerTaskIds.includes(enrollment.sourceTaskId))
    throw failure("LOCAL_API_INVALID_ENROLLMENT","Import the complete enrollment returned by the owner-authenticated local client registration.");
  const encoded=JSON.stringify(stored);
  if(Buffer.byteLength(encoded,"utf8")>2048)throw failure("LOCAL_API_INVALID_ENROLLMENT","The enrollment exceeds the secure credential record budget.");
  try{await vault.write(localCredentialTarget(client,discovery.endpoint),encoded);}catch{throw secureStoreError();}
  return {client,clientId:stored.clientId,clientName:enrollment.clientName,grantId:stored.grantId,
    capabilities:enrollment.capabilities,taskIds:enrollment.taskIds,
    ...(enrollment.peerTaskIds===undefined?{}:{peerTaskIds:enrollment.peerTaskIds}),
    sourceTaskId:enrollment.sourceTaskId,expiresAt:stored.expiresAt,stored:true};
}

export async function resolveLocalUserConnection(options:{client?:string;configDir:string;env?:NodeJS.ProcessEnv;vault?:LocalCredentialVault}):Promise<LocalUserConnection>{
  const env=options.env??process.env,endpoint=env.QUAYMESH_LOCAL_API_ENDPOINT,credential=env.QUAYMESH_LOCAL_API_CREDENTIAL;
  if(endpoint!==undefined||credential!==undefined){
    if(options.client)throw failure("LOCAL_API_AMBIGUOUS_CREDENTIAL","Do not combine an inherited Task credential with --client.");
    if(!validLocalEndpoint(endpoint)||!credentialValid(credential))
      throw failure("LOCAL_API_INVALID_CREDENTIAL","Both inherited local API endpoint and Task credential must be valid.");
    return {endpoint,credential};
  }
  if(!options.client)throw failure("LOCAL_API_CLIENT_REQUIRED","Select an enrolled local client with --client. This command does not use an owner password.");
  localClientAlias(options.client);
  const discovery=await readLocalUserDiscovery(options.configDir),vault=options.vault??createPlatformCredentialVault({env});
  const saved=await vault.read(localCredentialTarget(options.client,discovery.endpoint));
  if(saved===null)throw failure("LOCAL_API_CREDENTIAL_NOT_FOUND","This client is not enrolled in secure storage. Import its owner-issued enrollment with client import --stdin.");
  let value:unknown;
  try{value=JSON.parse(saved);}catch{throw failure("LOCAL_API_INVALID_CREDENTIAL","The secure credential record is invalid.");}
  const record=storedCredential(value,discovery.endpoint);
  return {endpoint:discovery.endpoint,credential:record.credential};
}

interface SecretProcessResult {code:number|null;stdout:string;stderr:string;}
type SecretProcessRunner=(program:string,args:readonly string[],input:string,env:NodeJS.ProcessEnv)=>Promise<SecretProcessResult>;
function secretProcessEnvironment(env:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
  const safe={...env};
  for(const key of Object.keys(safe))if(/^QUAYMESH_.*(?:TOKEN|SECRET|CREDENTIAL|PASSWORD|API_KEY)/i.test(key))delete safe[key];
  return safe;
}
function runSecretProcess(program:string,args:readonly string[],input:string,env:NodeJS.ProcessEnv):Promise<SecretProcessResult>{
  return new Promise((resolve,reject)=>{
    const child=spawn(program,[...args],{stdio:["pipe","pipe","pipe"],shell:false,windowsHide:true,env:secretProcessEnvironment(env)});
    let stdout="",stderr="",settled=false;
    const finish=(error?:Error,code:number|null=null)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error){child.kill();reject(error);}else resolve({code,stdout,stderr});
    };
    const timer=setTimeout(()=>finish(secureStoreError()),10_000);
    child.on("error",()=>finish(secureStoreError()));
    child.stdout.on("data",chunk=>{stdout+=chunk.toString("utf8");if(Buffer.byteLength(stdout)>16*1024)finish(secureStoreError());});
    child.stderr.on("data",chunk=>{stderr+=chunk.toString("utf8");if(Buffer.byteLength(stderr)>4096)finish(secureStoreError());});
    child.stdin.on("error",()=>finish(secureStoreError()));
    child.on("close",code=>finish(undefined,code));
    child.stdin.end(input);
  });
}

// Fixed code only: target names and credentials enter through the private stdin
// pipe, never command-line arguments, script text, files or the CLI's stdout.
const WINDOWS_VAULT_SCRIPT=String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QuayMeshLocalVault {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Write(ref Credential credential, uint flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.target -notmatch '^QuayMesh\.LocalUser\.v1/[a-f0-9]{64}/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'InvalidTarget' }
  if ($request.action -eq 'read') {
    $pointer = [IntPtr]::Zero
    if (-not [QuayMeshLocalVault]::Read($request.target, 1, 0, [ref]$pointer)) {
      if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'CredentialReadFailed' }
      [Console]::Out.WriteLine('{"found":false}')
    } else {
      try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][QuayMeshLocalVault+Credential])
        if ($credential.CredentialBlobSize -gt 2048) { throw 'CredentialTooLarge' }
        $bytes = New-Object byte[] ([int]$credential.CredentialBlobSize)
        [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
        $value = [Text.Encoding]::UTF8.GetString($bytes)
        [Console]::Out.WriteLine((@{found=$true;value=$value} | ConvertTo-Json -Compress))
        [Array]::Clear($bytes, 0, $bytes.Length)
      } finally { [QuayMeshLocalVault]::CredFree($pointer) }
    }
  } elseif ($request.action -eq 'write') {
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$request.value)
    if ($bytes.Length -gt 2048) { throw 'CredentialTooLarge' }
    $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    try {
      [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
      $credential = New-Object QuayMeshLocalVault+Credential
      $credential.Type=1; $credential.TargetName=$request.target; $credential.UserName='QuayMesh local client'
      $credential.CredentialBlobSize=$bytes.Length; $credential.CredentialBlob=$pointer; $credential.Persist=2
      if (-not [QuayMeshLocalVault]::Write([ref]$credential, 0)) { throw 'CredentialWriteFailed' }
      [Console]::Out.WriteLine('{"stored":true}')
    } finally {
      for ($i=0; $i -lt $bytes.Length; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($pointer, $i, 0) }
      [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
  } else { throw 'InvalidOperation' }
} catch {
  [Console]::Error.WriteLine('LOCAL_API_SECURE_STORAGE_UNAVAILABLE')
  exit 1
}
`;

// Public discovery still controls where a secret will be sent. A permissive
// Windows ACL is rejected rather than trusting only the JSON contents.
const WINDOWS_DISCOVERY_ACL_SCRIPT=String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
  $writeRights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($path in @($request.directory, $request.file)) {
    $isDirectory = $path -eq $request.directory
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ReparsePoint' }
    $acl = Get-Acl -LiteralPath $path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner -or (-not $isDirectory -and -not $acl.AreAccessRulesProtected)) { throw 'NotPrivateOwner' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
      if ($isDirectory) {
        if ($allowed -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $writeRights) -ne 0) { throw 'WritableByOtherUser' }
      } elseif ($rule.IsInherited -or $allowed -notcontains $rule.IdentityReference.Value) { throw 'BroadAccess' }
    }
  }
  [Console]::Out.WriteLine('{"private":true}')
} catch {
  [Console]::Error.WriteLine('LOCAL_API_DISCOVERY_UNSAFE')
  exit 1
}
`;

async function verifyWindowsDiscoveryAcl(directory:string,file:string,options:{env?:NodeJS.ProcessEnv;run?:SecretProcessRunner}):Promise<void>{
  const env=secretProcessEnvironment(options.env??process.env),run=options.run??runSecretProcess;
  const program=win32.join(env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
  const args=["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(WINDOWS_DISCOVERY_ACL_SCRIPT,"utf16le").toString("base64")];
  try{
    const response=await run(program,args,JSON.stringify({directory,file}),env);
    if(response.code!==0||JSON.parse(response.stdout)?.private!==true)throw new Error("ACL rejected");
  }catch{throw failure("LOCAL_API_DISCOVERY_UNSAFE","The discovery file must have a protected private ACL owned by this OS user, and its directory must not be writable by other users.");}
}

export function createPlatformCredentialVault(options:{platform?:NodeJS.Platform;env?:NodeJS.ProcessEnv;run?:SecretProcessRunner}={}):LocalCredentialVault{
  const platform=options.platform??process.platform,env=secretProcessEnvironment(options.env??process.env),run=options.run??runSecretProcess;
  if(platform==="win32"){
    const program=win32.join(env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
    const args=["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(WINDOWS_VAULT_SCRIPT,"utf16le").toString("base64")];
    const invoke=async(action:"read"|"write",target:string,value?:string)=>{
      let response:SecretProcessResult;
      try{response=await run(program,args,JSON.stringify({action,target,value}),env);}catch{throw secureStoreError();}
      if(response.code!==0)throw secureStoreError();
      let result:unknown;try{result=JSON.parse(response.stdout);}catch{throw secureStoreError();}
      if(!object(result))throw secureStoreError();return result;
    };
    return {read:async target=>{const result=await invoke("read",target);if(result.found===false)return null;
      if(result.found!==true||typeof result.value!=="string")throw secureStoreError();return result.value;},
      write:async(target,value)=>{if((await invoke("write",target,value)).stored!==true)throw secureStoreError();}};
  }
  if(platform==="linux"){
    const attrs=(target:string)=>["application",LOCAL_USER_API_PROTOCOL,"target",target];
    const invoke=async(args:string[],input:string)=>{try{return await run("/usr/bin/secret-tool",args,input,env);}catch{throw secureStoreError();}};
    return {read:async target=>{const response=await invoke(["lookup",...attrs(target)],"");
      if(response.code===1&&!response.stderr.trim())return null;if(response.code!==0)throw secureStoreError();return response.stdout.replace(/\r?\n$/,"");},
      write:async(target,value)=>{const response=await invoke(["store","--label=QuayMesh local API client",...attrs(target)],value);
        if(response.code!==0)throw secureStoreError();}};
  }
  return {read:async()=>{throw secureStoreError();},write:async()=>{throw secureStoreError();}};
}

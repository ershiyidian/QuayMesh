import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {downloadIncomingArtifact} from "../../artifact-tools.js";
import {IncomingArtifactAdapterRegistry,createOpenAIIncomingArtifactAdapter} from "../../incoming-artifacts.js";
import {canImportHostFiles,selectAuthorizedFiles} from "./file-import.js";

test("ChatGPT file library selection becomes native authenticated fileParam objects",async()=>{
  const calls:string[]=[];
  const host={
    selectFiles:async()=>[
      {fileId:"file_1",fileName:"Pirate_R33_Complete_Source.zip.part001",mimeType:"application/octet-stream"},
      {fileId:"file_2",fileName:"Pirate_R33_Complete_Source.zip.part002"},
    ],
    getFileDownloadUrl:async({fileId}:{fileId:string})=>{
      calls.push(fileId);
      return {downloadUrl:`https://files.oaiusercontent.com/${fileId}?sig=temporary`};
    },
  };
  assert.equal(canImportHostFiles(host),true);
  const files=await selectAuthorizedFiles(host,"qm:desktop:ws_game");
  assert.deepEqual(calls,["file_1","file_2"]);
  assert.deepEqual(files.map(f=>[f.workspace_id,f.path]),[
    ["qm:desktop:ws_game","Pirate_R33_Complete_Source.zip.part001"],
    ["qm:desktop:ws_game","Pirate_R33_Complete_Source.zip.part002"],
  ]);
  assert.equal(files[0]?.file.file_id,"file_1");
  assert.match(files[0]!.file.download_url,/^https:\/\/files\.oaiusercontent\.com\//);
});

test("file IDs alone are not treated as URLs and names must not escape workspace",async()=>{
  const noUrl={selectFiles:async()=>[{fileId:"file_1",fileName:"archive.zip"}],
    getFileDownloadUrl:async()=>({downloadUrl:"file_1"})};
  await assert.rejects(selectAuthorizedFiles(noUrl,"qm:desktop:game"),/FILE_IMPORT_SIGNED_URL_REQUIRED/);
  const traversal={selectFiles:async()=>[{fileId:"file_1",fileName:"../.env"}],
    getFileDownloadUrl:async()=>({downloadUrl:"https://files.oaiusercontent.com/good"})};
  await assert.rejects(selectAuthorizedFiles(traversal,"qm:desktop:game"),/FILE_IMPORT_NAME_INVALID/);
  assert.equal(canImportHostFiles({selectFiles:async()=>[]}),false);
});

test("widget-provided signed reference reaches the native workspace filesystem",async()=>{
  const root=await mkdtemp(join(tmpdir(),"quaymesh-host-file-import-"));
  const bytes=Buffer.from("QuayMesh verified attachment\n");
  try {
    const host={
      selectFiles:async()=>[{fileId:"file_42",fileName:"proof.txt",mimeType:"text/plain"}],
      getFileDownloadUrl:async()=>({downloadUrl:"https://files.oaiusercontent.com/file_42?sig=authorized"}),
    };
    const [args]=await selectAuthorizedFiles(host,"qm:desktop:workspace");
    const registry=new IncomingArtifactAdapterRegistry([
      createOpenAIIncomingArtifactAdapter({fetch:async(input)=>{
        assert.equal(String(input),args!.file.download_url);
        return new Response(bytes,{headers:{"content-length":String(bytes.length)}});
      }}),
    ]);
    const saved=await downloadIncomingArtifact({
      registry,workspaceId:args!.workspace_id,workspaceRoot:root,
      maxFileBytes:1024,file:args!.file,path:args!.path,
    });
    assert.equal(saved.size,bytes.length);
    assert.deepEqual(await readFile(join(root,"proof.txt")),bytes);
  }finally{await rm(root,{recursive:true,force:true});}
});

import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {test} from "node:test";
import {QuayMeshNode} from "../../node/app.mjs";

// This calls the actual componentPlans -> NodeApp.prepare path. Executable
// existence is checked, but no component, readiness probe or service is started.
test("prepared component environments expose the local API channel only to Core", async () => {
  const directory=await mkdtemp(join(tmpdir(),"qm-local-api-plan-"));
  try {
    const root=join(directory,"package"),configFile=join(directory,"installed-config","node.json"),stateDir=join(directory,"state");
    await mkdir(join(root,"dist"),{recursive:true});await writeFile(join(root,"dist","cli.js"),"// Never executed by this fixture.\n");
    const reserved={QUAYMESH_LOCAL_API_ENDPOINT:"\\\\.\\pipe\\QuayMesh.LocalUser.fixture",
      QUAYMESH_LOCAL_API_INTERNAL_PIPE:"\\\\.\\pipe\\QuayMesh.LocalUser.Core."+"f".repeat(32),
      QUAYMESH_LOCAL_API_BRIDGE_KEY:"a".repeat(64)};
    const env={TEST_CLUSTER_TOKEN:"c".repeat(32),TEST_MESH_SECRET:"m".repeat(32),TEST_TUNNEL_ID:"fixture",
      TEST_API_KEY:"k".repeat(32),QUAYMESH_OWNER_TOKEN:"o".repeat(32),KEEP_ME:"ordinary-value",...reserved,
      QUAYMESH_LOCAL_API_CONFIG_DIR:"untrusted-inherited-directory",QUAYMESH_LOCAL_API_CREDENTIAL:"qml1_"+"q".repeat(43),
      quaymesh_local_api_unknown:"inherited-reserved-value"};
    const component=()=>({executable:process.execPath,args:[],environment:{QUAYMESH_LOCAL_API_BRIDGE_KEY:"component-override",
      QuayMesh_Local_Api_Credential:"component-reserved-value",COMPONENT_PUBLIC:"ordinary-component-value"}});
    const configuration={revision:"fixture",configFile,env,node:{id:"fixture",nickname:"Fixture",stateDir,nodeRuntime:process.execPath,
      adminPort:17670,corePort:17671,peerPort:17672,roots:[],core:{},
      capabilities:{worker:true,coordinator:false,egress:true,discovery:true,desktopUi:false},
      network:{externalAccess:true,inheritProxy:false,proxyUrl:"http://127.0.0.1:17890"},
      mesh:{enabled:true,mode:"no-tun",address:"10.66.0.2",listeners:[],socksPort:17673,rpcPort:17674},
      components:{easytier:component(),egress:component(),tunnel:component()}},
      cluster:{tokenEnv:"TEST_CLUSTER_TOKEN",coordinator:{id:"authority",address:"127.0.0.1",mcpPort:17675,peerPort:17676},
        mesh:{networkName:"fixture",secretEnv:"TEST_MESH_SECRET",peers:[]},
        discovery:{localPort:17677,healthPort:17678,resourceUrl:"https://fixture.invalid/mcp",tunnelIdEnv:"TEST_TUNNEL_ID",
          apiKeyEnv:"TEST_API_KEY",channels:["fixture"]},
        egress:{priorities:{},probeUrl:"https://fixture.invalid/probe",recoveryDelayMs:1000}}};
    const original=structuredClone(env),app=new QuayMeshNode(configuration,{root});
    const prepared=await app.prepare(configuration,"fixture");
    assert.deepEqual(prepared.plans.map(plan=>plan.id).sort(),["core","discovery","egress","mesh"]);
    const onlyReserved=value=>Object.fromEntries(Object.entries(value).filter(([key])=>/^QUAYMESH_LOCAL_API_/i.test(key)));
    const expected={...reserved,QUAYMESH_LOCAL_API_CONFIG_DIR:dirname(configFile)};
    for(const plan of prepared.plans){
      assert.deepEqual(onlyReserved(plan.env),plan.id==="core"?expected:{},plan.id+" spawn environment");
      assert.deepEqual(onlyReserved(plan.effective.env),plan.id==="core"?expected:{},plan.id+" effective environment");
      assert.equal(plan.env.KEEP_ME,"ordinary-value");
    }
    const core=prepared.plans.find(plan=>plan.id==="core");
    assert.notEqual(core.env.QUAYMESH_LOCAL_API_CONFIG_DIR,prepared.coreConfigDir);
    assert.deepEqual(env,original,"preparation must not mutate the original trusted Host environment");
    const generated=await Promise.all(["config.jsonc","auth.json"].map(file=>readFile(join(prepared.coreConfigDir,file),"utf8")));
    for(const text of generated){assert.equal(text.includes(reserved.QUAYMESH_LOCAL_API_BRIDGE_KEY),false);assert.equal(text.includes(env.QUAYMESH_LOCAL_API_CREDENTIAL),false);}
  } finally {await rm(directory,{recursive:true,force:true});}
});

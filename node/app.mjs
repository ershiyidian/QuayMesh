import http from "node:http";
import { readFile, access, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadNodeConfig, validateNode, secret, hostUrl } from "./config.mjs";
import { applySettingsPatch, loadSettingsAuthority, publicSettings } from "./settings.mjs";
import { writeJson, atomicWrite, readOptionalJson } from "./files.mjs";
import { compileCore, componentPlans, easyTierConfig } from "./compile.mjs";
import { ComponentSupervisor } from "./supervisor.mjs";
import { RegistryServer } from "./registry.mjs";
import { MembershipClient } from "./membership.mjs";
import { McpRelay } from "./relay.mjs";
import { requestJson, requestDiscoveryReady, connectSocket } from "./network.mjs";
import { assertMeshPortFree, assertManagedMeshListener } from "./easytier-health.mjs";
import { SourceErrors } from "./source-errors.mjs";
import { resumeAdmissionWithRetry } from "./maintenance-recovery.mjs";

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const admissionExpectation=state=>state?.instance?{instance:state.instance,accepting:state.accepting,reason:state.reason,changedAt:state.changedAt}:undefined;

export class QuayMeshNode {
  constructor(configuration, { root = packageRoot, intervalMs = 1000, readinessMs = 30000 } = {}) {
    this.config = configuration; this.root = root; this.intervalMs = intervalMs; this.readinessMs = readinessMs;
    this.stopped = false; this.configRevision = configuration.revision;
    this.discovery = { ready:false, lastSuccessAt:null, lastError:null };
    this.pendingConfiguration = null; this.errors = new SourceErrors();
    this.componentObservations=new Map();
    this.settingsQueue = Promise.resolve(); this.settingsApply = null; this.pendingSettingsRevision = null;
    this.corePort = configuration.node.corePort; this.maintenance = false;
    this.maintenanceReleasePending = false;
    this.maintenanceRelease = null;
    this.maintenanceReleaseExpected = undefined;
    this.maintenancePauseExpected = undefined;
    this.maintenanceOwner = null;
    this.maintenanceRecovery = null;
    this.maintenanceRecoveryTimer = null;
    this.statusFile = join(configuration.node.stateDir, "node-status.json");
  }
  static async fromFile(file, options) { return new QuayMeshNode(await loadNodeConfig(file), options); }

  async prepare(configuration, revision) {
    const { node, cluster, env } = configuration;
    const generatedDir = join(node.stateDir, "generated", `config-${revision}-${randomUUID()}`);
    const coreConfigDir = join(generatedDir, "core");
    const token = secret(env, cluster.tokenEnv, 24);
    await mkdir(generatedDir, { recursive:true, mode:0o700 });
    try {
      const ownerFile = join(node.stateDir,"owner.json");
      let owner = await readOptionalJson(ownerFile);
      if (!owner) {
        owner = { token:env.QUAYMESH_OWNER_TOKEN || randomBytes(32).toString("base64url") };
        await writeJson(ownerFile, owner);
      }
      const tokenFile = join(node.stateDir, "cluster.token");
      await atomicWrite(tokenFile, token + "\n");
      const compiled = compileCore(node, cluster, { root:this.root, tokenFile, ownerToken:owner.token,
        membershipFile:join(node.stateDir,"membership.json"), statusFile:this.statusFile });
      await writeJson(join(coreConfigDir,"config.jsonc"), compiled.runtime);
      await writeJson(join(coreConfigDir,"auth.json"), compiled.auth);
      if (node.mesh.enabled) await atomicWrite(join(generatedDir,"easytier.toml"), easyTierConfig(node,cluster));
      const plans = componentPlans(node, cluster, env, { root:this.root, generatedDir, configDir:coreConfigDir, release:this.release });
      for (const plan of plans) {
        await access(plan.command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        const settings = node.components[plan.id === "mesh" ? "easytier" : plan.id === "discovery" ? "tunnel" : plan.id];
        if (settings?.configFile) plan.configuration = await readFile(settings.configFile,"utf8");
        const effective = { command:plan.command, args:[...(plan.args || [])], cwd:plan.cwd,
          env:{...plan.env}, requires:plan.requires, configuration:plan.configuration };
        if (plan.id === "core") {
          await access(join(this.root,"dist","cli.js"));
          effective.configuration = compiled.runtime;
          delete effective.env.QUAYMESH_CONFIG_DIR;
          plan.ready = () => requestJson(`http://127.0.0.1:${node.corePort}/readyz`, {timeoutMs:2500});
          for (const key of ["QUAYMESH_RUNTIME_CONTROL_PIPE","QUAYMESH_RUNTIME_INSTANCE_ID","QUAYMESH_RUNTIME_STARTED_AT"]) {
            delete plan.env[key]; delete effective.env[key];
          }
          if (process.platform === "win32") {
            const control = await import(new URL("../dist/runtime-control.js",import.meta.url));
            const identity = { instanceId:randomUUID(), startedAt:new Date().toISOString() };
            const pipe = control.runtimeControlPipeName(identity.instanceId);
            Object.assign(plan.env, { QUAYMESH_RUNTIME_CONTROL_PIPE:pipe,
              QUAYMESH_RUNTIME_INSTANCE_ID:identity.instanceId, QUAYMESH_RUNTIME_STARTED_AT:identity.startedAt });
            plan.stop = async child => {
              for (const operation of ["stop_admission","shutdown"]) {
                const result = await control.sendRuntimeControl(pipe, {
                  protocol:"quaymesh.runtime-control.v1", operation, ...identity, pid:child.pid,
                }, 5000);
                if (!result.accepted) throw new Error(result.error || "Core 拒绝退出请求");
              }
            };
          }
        }
        if (plan.id === "mesh") {
          effective.args = effective.args.map(arg => arg.replaceAll(generatedDir,"${generated}"));
          const port=node.mesh.mode === "no-tun" ? node.mesh.socksPort : node.mesh.rpcPort;
          let verifiedPid=null;
          plan.beforeStart=()=>assertMeshPortFree(port);
          plan.ready = async child => {
            const socket = await connectSocket("127.0.0.1",port,{timeoutMs:1500});
            socket.destroy();
            if(verifiedPid!==child.pid){
              await assertManagedMeshListener(child.pid,port);
              verifiedPid=child.pid;
            }
          };
        }
        if (plan.id === "egress") plan.ready = async () => {
          const proxy = new URL(node.network.proxyUrl || "http://127.0.0.1:7890");
          const socket = await connectSocket(proxy.hostname,Number(proxy.port || 80),{timeoutMs:1500}); socket.destroy();
        };
        if (plan.id === "discovery") {
          plan.beforeStart = async () => {
            const ready = await requestJson(`http://127.0.0.1:${cluster.discovery.localPort}/readyz`,{timeoutMs:2500});
            if (ready?.ok !== true) throw new Error("Coordinator 尚未就绪");
          };
          plan.ready = () => requestDiscoveryReady(`http://127.0.0.1:${cluster.discovery.healthPort}/readyz`,{timeoutMs:2500});
        }
        plan.effective = effective;
      }
      return { configuration, revision, generatedDir, coreConfigDir, token, plans };
    } catch (error) { await rm(generatedDir,{recursive:true,force:true}); throw error; }
  }
  async createRelay(configuration) {
    const {node,cluster} = configuration;
    if (!node.capabilities.discovery && !node.capabilities.desktopUi && !node.capabilities.consoleRelay) return null;
    return new McpRelay({ origin:hostUrl(cluster.coordinator.address,cluster.coordinator.mcpPort),
      port:cluster.discovery.localPort,
      socksUrl:node.mesh.enabled && node.mesh.mode === "no-tun" ? `socks5://127.0.0.1:${node.mesh.socksPort}` : undefined,
      onError:error => this.errors.fail(error.source || "relay",error), onSuccess:source => this.errors.recover(source),
      onExchange:(event,fields) => console.info(JSON.stringify({event,nodeId:node.id,...fields})),
      consoleRpc:request => requestJson(`http://127.0.0.1:${node.corePort}/internal/quaymesh/console`, {
        method:"POST", token:this.token, timeoutMs:30000, signal:request.signal,
        body:{nodeId:cluster.coordinator.id,request:{...request,signal:undefined}},
      }),
    }).start();
  }
  async start() {
    const pkg = JSON.parse(await readFile(join(this.root,"package.json"),"utf8"));
    const release = await readOptionalJson(join(this.root,"release.json"));
    this.release = release?.sourceCommit || release?.version || pkg.version;
    this.generation = await this.prepare(this.config,this.configRevision);
    this.token = this.generation.token;
    const {node,cluster} = this.config;
    this.installationTransition=await readOptionalJson(join(node.stateDir,"installation-transition.json"));
    if(this.installationTransition)this.maintenance=true;
    this.supervisor = new ComponentSupervisor({logDir:join(node.stateDir,"logs"),intervalMs:this.intervalMs});
    this.supervisor.define(this.generation.plans);
    this.supervisor.on("fault",error => this.errors.fail("supervisor",error));
    this.supervisor.on("change",components => {
      for (const value of components) {
        const observation=JSON.stringify([value.pid,value.state,value.observedAt,value.lastExitAt,value.error]);
        if(this.componentObservations.get(value.id)===observation)continue;
        this.componentObservations.set(value.id,observation);
        if (value.error) this.errors.fail(`component:${value.id}`,value.error,{pid:value.pid});
        else if (value.state === "ready") this.errors.recover(`component:${value.id}`);
      }
      const client = components.find(value => value.id === "discovery");
      if (client) this.discovery = {ready:client.state === "ready",lastSuccessAt:client.lastReadyAt,lastError:client.error};
    });
    try {
      if (node.capabilities.coordinator) this.registry = await new RegistryServer({cluster,token:this.token,
        stateDir:join(node.stateDir,"coordinator"),port:node.registryPort ?? cluster.coordinator.apiPort}).start();
      this.relay = await this.createRelay(this.config);
      if(this.installationTransition)this.relay?.setAccepting(false);
      await this.startAdmin();
      await this.supervisor.start();
      await this.supervisor.waitReady(new Set(["core"]),this.readinessMs);
      await this.confirmConfiguration(this.generation);
      this.membership = await new MembershipClient({node,cluster,token:this.token,release:this.release,
        status:() => ({components:this.supervisor.snapshot(),discovery:this.discovery}),
        onConfiguration:async(next,revision) => {
          if (revision > this.configRevision) {
            this.pendingConfiguration = {cluster:next,revision,requestedAt:Date.now(),failed:false};
          }
        },
      }).start();
      // The previous process may have exited after pausing Core admission
      // but before resuming it. Only the new authoritative, ready node may
      // reconcile that exact persisted maintenance reason.
      await this.reconcileMaintenance().catch(error => this.errors.fail("admission",error));
      this.maintenanceRecoveryTimer = setInterval(() => {
        void this.reconcileMaintenance().catch(error => this.errors.fail("admission",error));
      }, 5000);
      this.maintenanceRecoveryTimer.unref?.();
      this.statusTimer = setInterval(() => { void this.persistStatus().catch(error => this.errors.fail("status",error)); },2000);
      this.configTimer = setInterval(() => { void this.applyConfiguration().catch(error => this.errors.fail("configuration",error)); },5000);
      this.settingsTimer = setInterval(() => {
        if (this.pendingSettingsRevision!==null && !this.settingsApply && !this.stopped && !this.application) {
          const revision=this.pendingSettingsRevision;
          this.settingsApply=this.applySettingsRevision(revision).finally(()=>{this.settingsApply=null;});
          void this.settingsApply.catch(error=>this.errors.fail("settings",error,{revision}));
        }
      },15000);
      await this.persistStatus();
      return this;
    } catch (error) {
      await this.close().catch(cleanup => { throw new AggregateError([error,cleanup],"节点启动和清理失败"); });
      throw error;
    }
  }
  async updateSettings(input, expectedRevision) {
    if(!Number.isInteger(expectedRevision))throw Object.assign(new Error("需要明确的 expectedRevision；请先重新读取当前设置"),{status:409});
    const run = this.settingsQueue.then(async () => {
      if (this.settingsApply) await this.settingsApply.catch(() => {});
      return applySettingsPatch(this.config.configFile, input, {expectedRevision});
    });
    this.settingsQueue = run.catch(() => {});
    const saved = await run;
    const revision = saved.node.settingsRevision;
    this.pendingSettingsRevision = revision;
    this.settingsApply = this.applySettingsRevision(revision).finally(() => { this.settingsApply = null; });
    void this.settingsApply.catch(error => {
      this.errors.fail("settings", error, { revision });
    });
    return {
      ...saved.settings,
      savedRevision: revision,
      appliedRevision: null,
      applied: false,
      pending: true,
    };
  }
  async canApplySettings() {
    if(this.application||this.maintenance||this.relay?.activeRequests)return false;
    const status=await requestJson(`http://127.0.0.1:${this.corePort}/internal/quaymesh/idle`,{
      token:this.token,timeoutMs:3000,
    });
    return (status.quiescent??status.idle)===true;
  }
  async applySettingsRevision(expectedRevision) {
    if(this.application)await this.application;
    // Long-running user work is never paused just to apply a Console setting.
    // The setting stays durably saved and is applied on a later idle window.
    if(!(await this.canApplySettings()))return null;
    const authority = await loadSettingsAuthority(this.config.configFile);
    if (authority.node.settingsRevision !== expectedRevision) {
      throw new Error(`设置修订在应用前发生变化：期望 ${expectedRevision}，当前 ${authority.node.settingsRevision}`);
    }
    const next = {
      ...this.config,
      configFile: authority.configFile,
      rawNode: authority.rawNode,
      node: authority.node,
      cluster: authority.cluster,
    };
    const previous = this.generation;
    const prepared = await this.prepare(next, this.configRevision);
    const changed = this.supervisor.changedIds(prepared.plans);
    let switching = false,committed=false,maintenanceOwner;
    try {
      if (changed.size) {
        maintenanceOwner=await this.beginMaintenance();
        switching = true;
        await this.supervisor.replacePlans(prepared.plans);
        await this.supervisor.waitReady(changed, this.readinessMs);
      }
      await this.confirmConfiguration(prepared);
      committed=true;
      this.pendingSettingsRevision = null;
      this.errors.recover("configuration");
      this.errors.recover("settings");
      if (switching) await this.endMaintenanceAfterReplacement(maintenanceOwner,changed);
      return authority.node.settingsRevision;
    } catch (error) {
      if(committed){this.errors.fail("admission",error);throw error;}
      if (switching) {
        try {
          const changed=await this.supervisor.replacePlans(previous.plans);
          await this.supervisor.waitReady(changed,this.readinessMs);
          await this.endMaintenanceAfterReplacement(maintenanceOwner,changed);
        } catch (rollback) {
          throw new AggregateError([error, rollback], "设置已经保存，应用失败，恢复旧运行配置也未完成");
        }
      }
      if(prepared!==this.generation)await rm(prepared.generatedDir,{recursive:true,force:true});
      this.errors.fail("settings", error, { revision: expectedRevision });
      throw error;
    }
  }
  async confirmConfiguration(generation) {
    await writeJson(join(generation.configuration.node.stateDir,"cluster.snapshot.json"), {
      revision:generation.revision, cluster:generation.configuration.cluster,
    });
    this.config = generation.configuration; this.configRevision = generation.revision;
    this.generation = generation; this.corePort = this.config.node.corePort;
    if (this.membership) { this.membership.node = this.config.node; this.membership.cluster = this.config.cluster; }
  }
  status() {
    const errors = this.errors.snapshot();
    return {nodeId:this.config.node.id,capabilities:this.config.node.capabilities,release:this.release,
      installation:{root:this.root,configFile:this.config.configFile,nodeExecutable:process.execPath},
      settingsRevision:this.config.node.settingsRevision,pendingSettingsRevision:this.pendingSettingsRevision,
      configRevision:this.configRevision,pendingConfigRevision:this.pendingConfiguration?.revision || null,
      configuration:{applied:this.configRevision,desired:this.pendingConfiguration?.revision || this.configRevision,
        state:this.applying ? "applying" : this.pendingConfiguration?.failed ? "rejected" : this.pendingConfiguration ? "pending" : "applied"},
      maintenance:this.maintenance,maintenanceProtocol:2,relayActiveRequests:this.relay?.activeRequests??0,
      components:this.supervisor?.snapshot() || [],discovery:this.discovery,
      installationTransition:this.installationTransition??null,
      activeCoreRelease:this.activeCoreRelease??null,
      membership:this.membership?.state || {connected:false,lastSuccessAt:null,error:null},
      error:errors.current.at(-1)?.message || null, errors, observedAt:Date.now()};
  }
  async persistStatus() {
    if (this.statusWriting || this.stopped) return;
    this.statusWriting = (async()=>{
      this.activeCoreRelease=await readOptionalJson(join(this.config.node.stateDir,"core","active-release.json"));
      await writeJson(this.statusFile,this.status());
    })();
    try { await this.statusWriting; this.errors.recover("status"); }
    finally { this.statusWriting = null; }
  }
  async admission(action, expected) {
    return requestJson(`http://127.0.0.1:${this.corePort}/internal/quaymesh/admission`,{
      method:"POST",token:this.token,timeoutMs:3000,body:{action,reason:"node-maintenance",...(expected===undefined?{}:{expected})},
    });
  }
  async admissionState() {
    return requestJson(`http://127.0.0.1:${this.corePort}/internal/quaymesh/idle`, {
      token:this.token,timeoutMs:3000,
    });
  }
  async resumeAdmissionConditionally(expected) {
    try { return await this.admission("resume",expected); }
    catch(error){
      // A successful CAS may lose its HTTP response. Only the same Core
      // instance, currently open with no pause owner, can confirm that case.
      // A second CAS closes the GET/POST race with another maintenance owner.
      const state=await this.admissionState();
      if(state.accepting!==true||state.reason!==null||!expected?.instance||
          ["pid","processStart","token"].some(key=>state.instance?.[key]!==expected.instance[key]))throw error;
      return this.admission("resume",{instance:state.instance,accepting:true,reason:null,changedAt:state.changedAt});
    }
  }
  async reconcileMaintenance() {
    if (this.stopped || this.maintenanceRecovery || this.applying || this.application || this.settingsApply) return;
    if (this.maintenance && !this.maintenanceReleasePending) return;
    if(await readOptionalJson(join(this.config.node.stateDir,"installation-transition.json")))return;
    const job = (async () => {
      if (this.maintenanceReleasePending) {
        await this.endMaintenance();
        return;
      }
      // A timer and a real maintenance operation must never race: check
      // ownership again after querying the asynchronous Core state.
      const state=await this.admissionState();
      if(this.stopped||this.maintenance||this.applying||this.application||this.settingsApply)return;
      if(state?.accepting===false&&state.reason==="node-maintenance")
        await this.endMaintenance(admissionExpectation(state));
    })().finally(() => { if (this.maintenanceRecovery === job) this.maintenanceRecovery = null; });
    this.maintenanceRecovery = job;
    await job;
  }
  async beginMaintenance(timeoutMs = 30000) {
    if (this.maintenance) throw Object.assign(new Error("节点已有维护操作"),{status:409});
    const before=await this.admissionState();
    if(this.maintenance||before.accepting!==true)
      throw Object.assign(new Error("准入已由其他暂停持有，不能覆盖其维护状态"),{status:409});
    this.maintenance = true; this.relay?.setAccepting(false);
    const owner=randomUUID();this.maintenanceOwner=owner;
    let pauseAcquired=false;
    try {
      const paused=await this.admission("pause",admissionExpectation(before));
      pauseAcquired=true;this.maintenancePauseExpected=admissionExpectation(paused);
      const deadline = Date.now() + timeoutMs;
      do {
        const idle = await requestJson(`http://127.0.0.1:${this.corePort}/internal/quaymesh/idle`,{token:this.token,timeoutMs:3000});
        if ((idle.quiescent??idle.idle)===true && !this.relay?.activeRequests) return owner;
        await sleep(100);
      } while (!this.stopped && Date.now() < deadline);
      throw Object.assign(new Error("已接受的工作尚未结束，保留当前组件"),{status:409});
    } catch (error) {
      if(!pauseAcquired){
        // A 409 confirms the CAS did not write. An uncertain HTTP result must
        // stay closed for explicit reconciliation, never resume another owner.
        if(error.status===409){this.maintenance=false;this.maintenanceOwner=null;this.relay?.setAccepting(true);}
        else this.errors.fail("admission",error);
        throw error;
      }
      try { await this.endMaintenance(); }
      catch (recovery) { throw new AggregateError([error,recovery],"维护失败，恢复准入仍待重试"); }
      throw error;
    }
  }
  async endMaintenanceAfterReplacement(owner, changed) {
    if(!owner||!this.maintenance||this.maintenanceOwner!==owner)
      throw Object.assign(new Error("组件替换的维护归属已改变"),{status:409});
    if(!changed.has("core"))return this.endMaintenance();
    const observed=this.supervisor.snapshot().find(value=>value.id==="core");
    if(observed?.state!=="ready"||!observed.pid)throw Object.assign(new Error("替换的Core尚未就绪，保留维护暂停"),{status:409});
    const state=await this.admissionState();
    const current=this.supervisor.snapshot().find(value=>value.id==="core");
    if(!this.maintenance||this.maintenanceOwner!==owner||current?.state!=="ready"||
        (this.maintenancePauseExpected?.instance&&!state.instance)||
        ["pid","startedAt","restarts"].some(key=>current?.[key]!==observed[key])||(state.instance&&state.instance.pid!==current.pid)||
        !((state.accepting===false&&state.reason==="node-maintenance")||(state.accepting===true&&state.reason===null)))
      throw Object.assign(new Error("替换Core的代次或暂停归属不能确认"),{status:409});
    return this.endMaintenance(admissionExpectation(state));
  }
  async endMaintenance(expected) {
    if(await readOptionalJson(join(this.config.node.stateDir,"installation-transition.json")))
      throw Object.assign(new Error("发行切换仍在验证或等待恢复，准入保持暂停。"),{status:409});
    // Admin resume, timer recovery and rollback may converge here. One
    // Core resume transaction owns the latch; callers share its outcome.
    if (this.maintenanceRelease) {
      if(expected!==undefined&&JSON.stringify(expected)!==JSON.stringify(this.maintenanceReleaseExpected))
        throw Object.assign(new Error("另一个带条件的维护释放仍在进行"),{status:409});
      return this.maintenanceRelease;
    }
    if(expected!==undefined)this.maintenanceReleaseExpected=structuredClone(expected);
    else if(this.maintenanceReleaseExpected===undefined&&this.maintenancePauseExpected!==undefined)
      this.maintenanceReleaseExpected=structuredClone(this.maintenancePauseExpected);
    const releaseExpected=this.maintenanceReleaseExpected;
    this.maintenanceReleasePending = true;
    this.maintenance = true;this.relay?.setAccepting(false);
    const release = (async () => {
      try {
        // A conditional resume is not blindly idempotent: if its reply is
        // lost, the same expected state may already have changed. Keep that
        // exact condition for timer retries; never fall back to plain resume.
        if(releaseExpected!==undefined)await this.resumeAdmissionConditionally(releaseExpected);
        else await resumeAdmissionWithRetry(() => this.admission("resume"));
        this.maintenance = false;
        this.installationTransition=null;
        this.maintenanceReleasePending = false;
        this.maintenanceReleaseExpected = undefined;
        this.maintenancePauseExpected = undefined;
        this.maintenanceOwner = null;
        this.relay?.setAccepting(true);
        this.errors.recover("admission");
      } catch (error) {
        this.errors.fail("admission",error);
        // Remain closed until periodic recovery receives Core confirmation.
        throw error;
      }
    })().finally(() => { if (this.maintenanceRelease === release) this.maintenanceRelease = null; });
    this.maintenanceRelease = release;
    return release;
  }
  async applyConfiguration() {
    if (!this.pendingConfiguration || this.pendingConfiguration.failed || this.application || this.settingsApply || this.stopped) return;
    this.application = this.applyPending().finally(() => { this.application = null; });
    return this.application;
  }
  async applyPending() {
    const next = this.pendingConfiguration, previous = this.generation;
    let prepared, switching = false, committed = false,maintenanceOwner,changed;
    this.applying = true;
    try {
      const node = validateNode(this.config.rawNode,next.cluster,dirname(this.config.configFile));
      prepared = await this.prepare({...this.config,node,cluster:next.cluster},next.revision);
      changed = this.supervisor.changedIds(prepared.plans);
      const relayChanged = this.config.cluster.discovery.localPort !== next.cluster.discovery.localPort;
      if (changed.size || relayChanged) {
        maintenanceOwner=await this.beginMaintenance(); switching = true;
        if (relayChanged) { await this.relay?.close(); this.relay = await this.createRelay(prepared.configuration); }
        await this.supervisor.replacePlans(prepared.plans);
        await this.supervisor.waitReady(changed,this.readinessMs);
      }
      await this.confirmConfiguration(prepared);
      committed = true;
      if (this.pendingConfiguration === next) this.pendingConfiguration = null;
      this.errors.recover("configuration");
      if (switching) await this.endMaintenanceAfterReplacement(maintenanceOwner,changed);
    } catch (error) {
      if (committed) { this.errors.fail("admission",error); throw error; }
      next.failed = error.status !== 409;
      this.errors.fail("configuration",error,{revision:next.revision});
      if (switching) {
        try {
          await this.relay?.close(); this.relay = await this.createRelay(previous.configuration);
          const changed = await this.supervisor.replacePlans(previous.plans);
          await this.supervisor.waitReady(changed,this.readinessMs);
          this.config = previous.configuration; this.generation = previous; this.configRevision = previous.revision;
          await this.endMaintenanceAfterReplacement(maintenanceOwner,changed);
        } catch (rollback) { throw new AggregateError([error,rollback],"配置切换失败，恢复也未完成"); }
      }
      if (prepared && prepared !== this.generation) await rm(prepared.generatedDir,{recursive:true,force:true});
      if (error.status !== 409) throw error;
    } finally { this.applying = false; }
  }
  async startAdmin() {
    this.admin = http.createServer((req,res) => {
      void (async () => {
        const path = new URL(req.url,"http://node.local").pathname;
        if (req.method === "GET" && ["/healthz","/readyz"].includes(path)) {
          const ready = this.supervisor?.snapshot().some(value => value.id === "core" && value.state === "ready");
          const ok = !this.stopped && (path === "/healthz" || ready);
          res.writeHead(ok?200:503,{"content-type":"application/json"}).end(JSON.stringify({ok,pid:process.pid})); return;
        }
        if (req.method === "GET" && path === "/status") { res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify(this.status())); return; }
        const supplied = Buffer.from(req.headers.authorization || ""), expected = Buffer.from(`Bearer ${this.token}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) { res.writeHead(401).end(); return; }
        if (req.method === "GET" && path === "/settings") {
          const authority=await loadSettingsAuthority(this.config.configFile);
          const settings=publicSettings(authority);
          settings.appliedRevision=this.config.node.settingsRevision;
          settings.applied=settings.savedRevision===settings.appliedRevision;
          settings.pending=!settings.applied;
          settings.applicationError=this.errors.snapshot().current.find(error=>error.source==="settings")?.message??null;
          settings.federationPort=this.config.node.peerPort;
          settings.ingressPort=this.config.cluster.discovery.localPort;
          settings.publicBaseUrl=this.config.cluster.discovery.resourceUrl??null;
          res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify(settings));return;
        }
        if (req.method === "POST" && path === "/settings") {
          const chunks = [];
          let bytes=0;
          for await (const chunk of req) {
            bytes+=chunk.length;
            if(bytes>1024*1024)throw Object.assign(new Error("设置请求超过 1 MiB"),{status:413});
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          const result = await this.updateSettings(body.settings ?? {}, body.expectedRevision);
          res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify(result)); return;
        }
        if (req.method === "POST" && path === "/maintenance/begin") {
          await this.beginMaintenance(); res.writeHead(200,{"content-type":"application/json"}).end('{"paused":true}'); return;
        }
        if (req.method === "POST" && path === "/maintenance/resume") {
          const chunks=[];let bytes=0;
          for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)throw Object.assign(new Error("维护请求过大"),{status:413});chunks.push(chunk);}
          const body=JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");
          await this.endMaintenance(body.expected);res.writeHead(200,{"content-type":"application/json"}).end('{"paused":false}');return;
        }
        if (req.method === "POST" && path === "/configuration/retry") {
          if (this.pendingConfiguration) this.pendingConfiguration.failed = false;
          res.writeHead(202).end(); return;
        }
        if (req.method === "POST" && path === "/shutdown") {
          if (!this.maintenance) await this.beginMaintenance();
          res.writeHead(202,{"content-type":"application/json"}).end('{"accepted":true}');
          setImmediate(() => { void this.close().catch(error => {console.error(error);process.exitCode=1;}); }); return;
        }
        if (req.method === "POST" && path.startsWith("/components/") && path.endsWith("/restart")) {
          const id = path.split("/")[2];
          if (!this.supervisor.components.has(id)) { res.writeHead(404).end(); return; }
          const owner=await this.beginMaintenance();let changed=new Set([id]);
          try { changed = await this.supervisor.restart(id); await this.supervisor.waitReady(changed,this.readinessMs); }
          finally { await this.endMaintenanceAfterReplacement(owner,changed); }
          res.writeHead(200,{"content-type":"application/json"}).end('{"ok":true}'); return;
        }
        res.writeHead(404).end();
      })().catch(error => { if (!res.headersSent) res.writeHead(error.status || 500,{"content-type":"application/json"}).end(JSON.stringify({error:error.message})); else res.destroy(error); });
    });
    await new Promise((resolve,reject) => {
      this.admin.once("error",reject);
      this.admin.listen(this.config.node.adminPort,"127.0.0.1",() => {this.admin.off("error",reject);resolve();});
    });
  }
  close() { this.closing ||= this.closeNow(); return this.closing; }
  async closeNow() {
    this.stopped = true; clearInterval(this.configTimer); clearInterval(this.statusTimer);clearInterval(this.settingsTimer);
    if (this.maintenanceRecoveryTimer) clearInterval(this.maintenanceRecoveryTimer);
    await this.maintenanceRecovery?.catch(() => {});
    await this.application;await this.settingsApply;await this.settingsQueue; await this.statusWriting;
    await this.membership?.close(); await this.supervisor?.close();
    await this.relay?.close(); await this.registry?.close();
    if (this.admin) { this.admin.closeAllConnections(); await new Promise(resolve => this.admin.close(resolve)); }
  }
}

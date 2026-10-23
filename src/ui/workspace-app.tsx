import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { Snapshot } from "../session/types.js";
import {CARD_RESOURCES, WORKSPACE_APP_VERSION} from '../session/card-contract.js';
import { createCardController, type CardController } from "./session-card/controller.js";
import { snapshotFromSchema } from "./session-card/snapshot.js";
import { createMcpSource, type SessionCardSource } from "./session-card/source.js";
import {
  applySnapshot,
  createCardState,
  disposeState,
  type CardState,
} from "./session-card/state.js";
import { createCardView, type CardIntent, type CardView } from "./session-card/view.js";
import {createPreviewSource,previewSnapshot} from "./session-card/preview.js";
import {canImportHostFiles,selectAuthorizedFiles,type HostFileLibrary} from "./session-card/file-import.js";
import "./workspace-app.css";

interface Bootstrap {
  sessionId: string;
  taskId?: string;
  memberId?: string;
  workspaceId?: string;
  snapshotRef: string;
  initialSnapshot?: Snapshot;
}

let app: App | null = null;
let connected = false;
let state: CardState | null = null;
let source: SessionCardSource | null = null;
let view: CardView | null = null;
let controller: CardController | null = null;
let bootstrap: Bootstrap | null = null;
let pendingResult: unknown = null;
let tornDown = false;
let hostDisplayMode: "inline" | "fullscreen" = "inline";
const resourceVersion = CARD_RESOURCES.find(item => item.version === document.querySelector<HTMLMetaElement>('meta[name="quaymesh-card-version"]')?.content)?.version ?? WORKSPACE_APP_VERSION;
const getHostFiles=()=>(window as typeof window & {openai?:HostFileLibrary}).openai;

const previewMode=window.parent===window&&(location.protocol==="file:"||new URLSearchParams(location.search).get("preview")==="1");
if(previewMode)bootPreview();else void boot();

function bootPreview():void{
  document.body.classList.add("standalone");
  document.body.dataset.theme=new URLSearchParams(location.search).get("theme")==="light"?"light":"dark";
  source=createPreviewSource();
  state=createCardState();
  state.connection="static";
  applySnapshot(state,previewSnapshot);
  let nextController:CardController|null=null;
  view=createCardView(document,state,intent=>dispatchCardIntent(intent,nextController));
  nextController=createCardController(state,view,source,document);controller=nextController;
  controller.start();
}

async function boot(): Promise<void> {
  app = new App(
    { name: "quaymesh-session-card", version: WORKSPACE_APP_VERSION },
    { availableDisplayModes: ["inline", "fullscreen"] },
    { autoResize: true },
  );
  app.ontoolresult = (params) => {
    if (tornDown) return;
    pendingResult = params;
    if (connected) {
      pendingResult = null;
      receiveBootstrap(params);
    }
  };
  app.ontoolinput = ({ arguments: input }) => {
    if (!bootstrap && !tornDown) renderStartupState(stringField(asRecord(input)?.title) ?? "正在创建任务…");
  };
  app.ontoolcancelled = () => {
    if (!bootstrap && !tornDown) renderStartupError("任务启动已取消");
  };
  app.onhostcontextchanged = (context) => {
    applyHostContext(context);
  };
  app.onteardown = async () => {
    tornDown = true;
    connected = false;
    pendingResult = null;
    disposeCard();
    return {};
  };

  try {
    await app.connect();
  } catch (error) {
    renderStartupError(messageOf(error));
    return;
  }

  connected = true;
  const importButton=document.querySelector<HTMLButtonElement>("#importHostFile");
  if(importButton && canImportHostFiles(getHostFiles()) && app.getHostCapabilities()?.serverTools){
    importButton.hidden=false;
    importButton.addEventListener("click",()=>{void importFromLibrary(importButton);});
  }
  if (tornDown) return;
  const context = app.getHostContext();
  if (context) applyHostContext(context);
  if (pendingResult) {
    receiveBootstrap(pendingResult);
    pendingResult = null;
  } else if (!bootstrap) {
    renderStartupState("正在等待任务结果…");
  }
}

async function importFromLibrary(button:HTMLButtonElement):Promise<void>{
  const hostFiles=getHostFiles();
  if(!app || !hostFiles || !state?.snapshot) return;
  const workspaces=state.snapshot.workspaces;
  // Import into a workspace only when the destination is unambiguous.
  const workspaceId=bootstrap?.workspaceId ??
    (workspaces.length===1 ? workspaces[0]?.workspace_id : undefined);
  if(!workspaceId){alertImport("先选定一个工作区，再从 ChatGPT 文件库导入。");return;}
  button.disabled=true;
  button.textContent="导入中…";
  try {
    const selected=await selectAuthorizedFiles(hostFiles,workspaceId);
    for(const args of selected){
      const result=await app.callServerTool({name:"download_artifact",arguments:{...args}});
      if(result.isError){
        const message=result.content.filter(x=>x.type==="text").map(x=>x.text).join("\n");
        throw new Error(message||"FILE_IMPORT_FAILED");
      }
    }
    if(selected.length){
      button.textContent=`已导入 ${selected.length}`;
      alertImport(`已导入 ${selected.length} 个文件到当前工作区。`);
    }else button.textContent="导入";
  } catch(error){
    button.textContent="失败";
    alertImport(error instanceof Error?error.message:String(error));
  }
  finally{button.disabled=false;}
}

function alertImport(message:string):void{
  const live=document.querySelector<HTMLElement>("#live");
  if(live)live.textContent=message;
}

function receiveBootstrap(result: unknown): void {
  try {
    applyBootstrap(result);
  } catch (error) {
    const consoleUrl=state?.snapshot?.consoleUrl??null;
    disposeCard();
    renderStartupError(messageOf(error));
    if(consoleUrl&&/^https?:\/\//.test(consoleUrl)) {
      const link=document.createElement("a");link.textContent="打开 Console 查看已保存的任务";
      link.href=consoleUrl;link.target="_blank";link.rel="noopener noreferrer";
      document.getElementById("card")?.append(link);
    }
  }
}

function applyBootstrap(result: unknown): void {
  const record = asRecord(result);
  if (record?.isError === true) {
    const content = Array.isArray(record.content) ? record.content : [];
    throw new Error(content.map(asRecord).filter(block => block?.type === "text")
      .map(block => stringField(block?.text) ?? "").join("\n") || "任务启动失败");
  }
  const next = bootstrapFromResult(result);
  if (!next) {
    if (!bootstrap) renderStartupError("SESSION_CARD_BOOTSTRAP_MISSING");
    return;
  }
  if (bootstrap && bootstrap.sessionId === next.sessionId && bootstrap.taskId === next.taskId) {
    if (next.initialSnapshot && state) {
      if(applySnapshot(state, next.initialSnapshot).snapshot)view?.render();
    }
    return;
  }
  if (bootstrap) disposeCard();
  bootstrap = next;
  if (!app) throw new Error("SESSION_CARD_APP_MISSING");
  if (!next.initialSnapshot) renderStartupState("正在读取任务…");
  source = createMcpSource(app, next.sessionId, next.taskId, next.initialSnapshot, resourceVersion);
  state = createCardState();
  state.hostDisplayMode = hostDisplayMode;
  state.connection = "connecting";
  if (next.initialSnapshot) applySnapshot(state, next.initialSnapshot);
  let nextController:CardController|null=null;
  view = createCardView(document, state, intent=>dispatchCardIntent(intent,nextController));
  nextController = createCardController(state, view, source, document);controller=nextController;
  controller.start();
}

function bootstrapFromResult(result: unknown): Bootstrap | null {
  const record = asRecord(result);
  const meta = asRecord(record?._meta);
  const quaymesh = asRecord(meta?.quaymesh);
  const structured = asRecord(record?.structuredContent);
  for (const key of ["session_id", "task_id"] as const) {
    const metadataId = stringField(quaymesh?.[key]), resultId = stringField(structured?.[key]);
    if (metadataId && resultId && metadataId !== resultId) throw new Error("SESSION_CARD_BOOTSTRAP_IDENTITY_MISMATCH");
  }
  const sessionId = stringField(quaymesh?.session_id) ?? stringField(structured?.session_id);
  const taskId = stringField(quaymesh?.task_id) ?? stringField(structured?.task_id);
  const memberId = stringField(quaymesh?.member_id);
  const workspaceId = stringField(quaymesh?.workspace_id);
  // 任务身份来自真实工具结果；快照元数据未送达时按该身份读取同一任务。
  if (!sessionId) return null;
  const snapshotRef = stringField(quaymesh?.snapshot_ref) ?? (taskId ? `task:${taskId}` : `session:${sessionId}`);
  const rawSnapshot = quaymesh?.snapshot;
  const initialSnapshot = rawSnapshot === undefined ? undefined : snapshotFromSchema(rawSnapshot);
  if (initialSnapshot && initialSnapshot.sessionId !== sessionId) {
    throw new Error("SESSION_CARD_BOOTSTRAP_IDENTITY_MISMATCH");
  }
  if (initialSnapshot?.taskId && taskId && initialSnapshot.taskId !== taskId) {
    throw new Error("SESSION_CARD_BOOTSTRAP_TASK_MISMATCH");
  }
  return { sessionId, ...(taskId ? { taskId } : {}), memberId, workspaceId, snapshotRef, initialSnapshot };
}

function applyHostContext(context: unknown): void {
  const record = asRecord(context);
  hostDisplayMode = record?.displayMode === "fullscreen" ? "fullscreen" : "inline";
  if (state) state.hostDisplayMode = hostDisplayMode;
  const theme = record?.theme === "light" ? "light" : "dark";
  applyDocumentTheme(theme);
  document.body.dataset.theme=theme;
  controller?.setTheme(theme);
  const styles = asRecord(record?.styles);
  const variables = asRecord(styles?.variables);
  if (variables) applyHostStyleVariables(variables as never);
  const css = asRecord(styles?.css);
  const fonts = stringField(css?.fonts);
  if (fonts) applyHostFonts(fonts);
  const insets = asRecord(record?.safeAreaInsets);
  if (insets) {
    document.body.style.paddingTop = `${numberField(insets.top) ?? 0}px`;
    document.body.style.paddingRight = `${numberField(insets.right) ?? 0}px`;
    document.body.style.paddingBottom = `${numberField(insets.bottom) ?? 0}px`;
    document.body.style.paddingLeft = `${numberField(insets.left) ?? 0}px`;
  }
}

async function dispatchCardIntent(intent:CardIntent,current:CardController|null):Promise<unknown>{
  if(intent.type==="display_mode"){
    if(!app||!app.getHostContext()?.availableDisplayModes?.includes(intent.mode))return false;
    const granted=await app.requestDisplayMode({mode:intent.mode});
    if(granted.mode==="fullscreen"||granted.mode==="inline"){
      hostDisplayMode=granted.mode;
      if(state)state.hostDisplayMode=granted.mode;
    }
    return granted.mode===intent.mode;
  }
  if(!current)throw new Error("SESSION_CARD_CONTROLLER_MISSING");
  return current.handleIntent(intent);
}

function disposeCard(): void {
  controller?.dispose();
  controller = null;
  view = null;
  source = null;
  if (state) disposeState(state);
  state = null;
  bootstrap = null;
}

function renderStartupState(text: string): void {
  const title = document.querySelector<HTMLElement>("#title");
  if (title) title.textContent = text;
}

function renderStartupError(text: string): void {
  const title = document.querySelector<HTMLElement>("#title");
  if (title) title.textContent = text;
  const card = document.querySelector<HTMLElement>("#card");
  card?.classList.add("collapsed");
  if (card) card.dataset.status = "failed";
  const activity = document.querySelector<HTMLElement>("#act");
  if (activity) activity.textContent = text;
  const toggle = document.querySelector<HTMLElement>("#toggle");
  toggle?.setAttribute("aria-expanded", "false");
  const details = document.querySelector<HTMLElement>("#details");
  if (details) { details.hidden = true; details.inert = true; }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import {expect,test} from "@playwright/test";

test("重复挂载和相同快照不重绘，卡片异常可静态降级",async({page})=>{
  await page.goto("/");await expect(page.locator("#status")).toHaveText("ready");
  const result=await page.evaluate(async()=>{
    const load=(path:string)=>import(path);
    const {createCardController}=await load("/src/ui/session-card/controller.ts");
    const {createCardState}=await load("/src/ui/session-card/state.ts");
    const {previewSnapshot,createPreviewSource}=await load("/src/ui/session-card/preview.ts");
    const frame=document.createElement("iframe");document.body.append(frame);
    const doc=frame.contentDocument!;doc.body.innerHTML='<main id="card"></main>';
    const state=createCardState(),stages:string[]=[];
    const snapshot={...previewSnapshot,rev:100,taskState:"closed",taskResult:"completed",status:"idle",execution_status:"idle",
      endedAt:Date.now(),consoleUrl:location.origin+"/console",commands:[],runningCommand:null,currentCommand:null,lastCommand:null,
      agents:[],files:[],totals:{files:0,commands:0,agents:0},capabilities:{...previewSnapshot.capabilities,refresh:false},
      executionObservation:{observedAt:Date.now(),activeOperationIds:[],preparingOperationIds:[],staleOperationIds:[]}};
    let sourceDisposed=0,viewDisposed=0,draws=0,footers=0,fail=false;
    const source={...createPreviewSource(),live:true,snapshot:async()=>({...snapshot}),
      widgetStage:async(stage:string)=>{stages.push(stage);},dispose(){sourceDisposed++;}};
    const view={render(){draws++;if(fail)throw new Error("injected-render-error");},renderFooter(){footers++;},
      renderPanel(){},fillTimers(){},dispose(){viewDisposed++;}};
    const controller=createCardController(state,view,source,doc);
    controller.start();controller.start();await controller.pollOnce();
    const before={draws,footers};
    for(let i=0;i<100;i++)await controller.pollOnce();
    const after={draws,footers};
    fail=true;snapshot.rev++;await controller.pollOnce();
    const fallback=doc.getElementById("card")!;
    const status=fallback.dataset.status,text=fallback.textContent,link=fallback.querySelector("a")?.getAttribute("href");
    controller.dispose();controller.dispose();frame.remove();
    return{before,after,mounts:stages.filter(x=>x==="mount").length,errors:stages.filter(x=>x==="error").length,
      sourceDisposed,viewDisposed,status,text,link};
  });
  expect(result.mounts).toBe(1);expect(result.after).toEqual(result.before);
  expect(result.status).toBe("unavailable");expect(result.text).toContain("执行结果仍可在 Console 查看");
  expect(result.link).toContain("/console");expect(result.errors).toBe(1);
  expect(result.sourceDisposed).toBe(1);expect(result.viewDisposed).toBe(1);
});

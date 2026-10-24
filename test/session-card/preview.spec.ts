import {expect,test} from "@playwright/test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";

const execute=promisify(execFile);

test("UI06：生产构建可导出无网络单文件预览",async({page})=>{
  const root=await mkdtemp(join(tmpdir(),"quaymesh-card-preview-"));
  const target=join(root,"card.html");
  try {
    await execute(process.execPath,[resolve("scripts/export-card-preview.mjs"),target],{cwd:resolve("."),timeout:15000});
    const remote:string[]=[];
    page.on("request",request=>{if(!request.url().startsWith("file:"))remote.push(request.url());});
    await page.goto(pathToFileURL(target).href);
    await expect(page.locator("#card")).toBeVisible();
    await expect(page.locator("#card")).toHaveClass(/collapsed/);
    await expect(page.locator("#title")).toContainText("恢复可靠性");
    await expect(page.locator("#clock")).toHaveText(/本轮耗时 \d+ 分 \d+ 秒/);
    await page.locator("#toggle").click();
    await expect(page.locator("#details")).toBeVisible();
    await page.locator("#t-commands").click();
    await expect(page.locator("#p-commands")).toContainText("verify.mjs");
    await page.locator("#t-agents").click();
    await expect(page.locator("#p-agents")).toContainText("Codex reviewer");
    expect(remote).toEqual([]);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

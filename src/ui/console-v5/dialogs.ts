import { icon } from "./icons.js";
import { esc } from "./presentation.js";
import { consoleError } from "./client.js";

export function formObject(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, typeof value === "string" ? value : value.name]));
}

export interface DialogOptions<T> {
  title: string; body: string; confirm?: string | null; danger?: boolean; wide?: boolean; drawer?: boolean; cancel?: string;
  onSubmit?: ((form: HTMLFormElement, dialog: HTMLDialogElement) => T | Promise<T>) | null;
  onMount?: ((dialog: HTMLDialogElement) => void) | null;
  refresh?: ((dialog: HTMLDialogElement) => unknown | Promise<unknown>) | null;
}

export function dialog<T = Record<string, string>>({ title, body, confirm = "确认", danger = false, wide = false, drawer = false,
  onSubmit = null, onMount = null, cancel = "取消", refresh = null }: DialogOptions<T>): Promise<T | false> {
  const d = document.createElement("dialog"), previous = document.activeElement;
  d.className = drawer ? "drawer-dialog" : wide ? "dialog-wide" : "";
  const id = "dlg-" + crypto.randomUUID(); d.setAttribute("aria-labelledby", id);
  d.innerHTML = `<form style="display:contents"><header class="dialog-head"><h2 id="${id}">${esc(title)}</h2><button type="button" class="icon-btn" data-dialog-close aria-label="关闭">${icon("close")}</button></header><div class="dialog-body">${body}</div><div class="dialog-error" data-dialog-error aria-live="polite"></div><footer class="dialog-footer">${refresh ? '<button type="button" class="btn" data-dialog-refresh>刷新版本</button>' : ''}<button class="btn" type="button" data-dialog-close>${esc(cancel)}</button>${confirm ? `<button class="btn ${danger ? 'danger' : 'primary'}" type="submit" data-dialog-confirm>${esc(confirm)}</button>` : ''}</footer></form>`;
  document.body.append(d);
  let pending = false;
  const result = new Promise<T | false>((resolve) => {
    const close = (value: T | false) => {
      if (pending) return;
      d.close(); d.remove();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
      resolve(value);
    };
    const errorText = d.querySelector<HTMLElement>("[data-dialog-error]")!;
    d.addEventListener("click", (event) => {
      const target = event.target as Element;
      if (target.closest("[data-dialog-close]")) close(false);
      if (target.closest("[data-dialog-refresh]") && refresh && !pending) {
        Promise.resolve(refresh(d)).then(() => { errorText.textContent = "版本已更新，请再次保存。"; })
          .catch((error: unknown) => { errorText.textContent = consoleError(error).message; });
      }
    });
    d.addEventListener("cancel", (event) => { event.preventDefault(); close(false); });
    d.querySelector("form")!.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      if (pending || !confirm || !form.reportValidity()) return;
      pending = true;
      const button = d.querySelector<HTMLButtonElement>("[data-dialog-confirm]")!, label = button.textContent;
      button.disabled = true; button.textContent = "正在提交…"; errorText.textContent = "";
      try {
        const value = onSubmit ? await onSubmit(form, d) : formObject(form) as T;
        pending = false; close(value);
      } catch (failure) {
        const error = consoleError(failure);
        errorText.textContent = error.message + (error.code === "timeout" ? "\n可用同一个确认按钮查询原请求结果。" : "");
        pending = false; button.disabled = false; button.textContent = label;
      }
    });
  });
  d.showModal(); onMount?.(d);
  return result;
}

import { icon } from "./icons.js";
import { esc } from "./presentation.js";
import { consoleError, uncertainWrite } from "./client.js";

export function formObject(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, typeof value === "string" ? value : value.name]));
}

export interface DialogOptions<T> {
  title: string; body: string; confirm?: string | null; danger?: boolean; wide?: boolean; drawer?: boolean; cancel?: string;
  onSubmit?: ((form: HTMLFormElement, dialog: HTMLDialogElement) => T | Promise<T>) | null;
  onMount?: ((dialog: HTMLDialogElement) => void) | null;
  refresh?: ((dialog: HTMLDialogElement) => unknown | Promise<unknown>) | null;
  refreshLabel?: string;
}

export function dialog<T = Record<string, string>>({ title, body, confirm = "确认", danger = false, wide = false, drawer = false,
  onSubmit = null, onMount = null, cancel = "取消", refresh = null, refreshLabel = '刷新版本' }: DialogOptions<T>): Promise<T | false> {
  const d = document.createElement("dialog"), previous = document.activeElement;
  d.className = drawer ? "drawer-dialog" : wide ? "dialog-wide" : "";
  const id = "dlg-" + crypto.randomUUID(); d.setAttribute("aria-labelledby", id);
  d.innerHTML = `<form style="display:contents"><header class="dialog-head"><h2 id="${id}">${esc(title)}</h2><button type="button" class="icon-btn" data-dialog-close aria-label="关闭">${icon("close")}</button></header><div class="dialog-body">${body}</div><div class="dialog-error" data-dialog-error aria-live="polite"></div><footer class="dialog-footer">${refresh ? '<button type="button" class="btn" data-dialog-refresh>' + esc(refreshLabel) + '</button>' : ''}<button class="btn" type="button" data-dialog-close>${esc(cancel)}</button>${confirm ? `<button class="btn ${danger ? 'danger' : 'primary'}" type="submit" data-dialog-confirm>${esc(confirm)}</button>` : ''}</footer></form>`;
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
    const bodyElement = d.querySelector<HTMLElement>('.dialog-body')!;
    let uncertain = false;
    const buttons = () => [...d.querySelectorAll<HTMLButtonElement>('button')];
    const busy = (value: boolean) => {
      pending = value;
      for (const button of buttons()) {
        if (value) { button.dataset.wasDisabled = String(button.disabled); button.disabled = true; }
        else { button.disabled = button.dataset.wasDisabled === 'true'; delete button.dataset.wasDisabled; }
        if (!value && button.dataset.available !== undefined) button.disabled = button.dataset.available !== 'true';
      }
      const refreshButton = d.querySelector<HTMLButtonElement>('[data-dialog-refresh]');
      if (refreshButton && uncertain) refreshButton.disabled = true;
    };
    d.addEventListener("click", (event) => {
      const target = event.target as Element;
      if (target.closest("[data-dialog-close]")) close(false);
      if (target.closest("[data-dialog-refresh]") && refresh && !pending && !uncertain) {
        busy(true); errorText.textContent = '正在读取当前配置…';
        Promise.resolve(refresh(d)).then(message => { errorText.textContent = typeof message === 'string' ? message : "已读取当前配置，请核对后保存。"; })
          .catch((error: unknown) => { errorText.textContent = consoleError(error).message; })
          .finally(() => busy(false));
      }
    });
    d.addEventListener("cancel", (event) => { event.preventDefault(); close(false); });
    d.querySelector("form")!.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      if (pending || !confirm || d.querySelector<HTMLButtonElement>('[data-dialog-confirm]')?.disabled || !form.reportValidity()) return;
      busy(true);
      const button = d.querySelector<HTMLButtonElement>("[data-dialog-confirm]")!;
      button.textContent = uncertain ? "正在查询原结果…" : "正在提交…"; errorText.textContent = "";
      try {
        const value = onSubmit ? await onSubmit(form, d) : formObject(form) as T;
        busy(false); close(value);
      } catch (failure) {
        const error = consoleError(failure);
        uncertain = uncertainWrite(error) && (error.code === 'timeout' || error.code === 'network' || Boolean(error.outcome || error.effect) || Boolean(error.status && error.status >= 500));
        bodyElement.inert = uncertain;
        errorText.textContent = error.message + (uncertain ? "\n已保留原提交内容，可查询原请求结果。" : "");
        busy(false); button.textContent = uncertain ? '查询原提交结果' : confirm;
      }
    });
  });
  d.showModal(); onMount?.(d);
  return result;
}

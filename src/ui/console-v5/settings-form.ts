export type FieldValues = Record<string, string | boolean>;

export function mergeFields(base: FieldValues, local: FieldValues, remote: FieldValues) {
  const values = { ...local }, conflicts: string[] = [];
  for (const key of Object.keys(remote)) {
    if (local[key] === base[key] || local[key] === remote[key]) values[key] = remote[key];
    else if (remote[key] !== base[key]) conflicts.push(key);
  }
  return { values, conflicts };
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const controls = (root: ParentNode) => [...root.querySelectorAll<Control>('input[name],select[name],textarea[name]')];
export function readFields(root: ParentNode): FieldValues {
  return Object.fromEntries(controls(root).map(field => [field.name,
    field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : field.value]));
}

export function fieldsFromHTML(html: string): FieldValues {
  const template = document.createElement('template'); template.innerHTML = html;
  return readFields(template.content);
}

export function refreshFields(form: HTMLFormElement, base: FieldValues, remote: FieldValues): string {
  const result = mergeFields(base, readFields(form), remote);
  form.querySelectorAll('.field-conflict').forEach(item => item.remove());
  for (const field of controls(form)) {
    field.setCustomValidity('');
    const value = result.values[field.name];
    if (value === undefined) continue;
    if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = String(value);
    if (!result.conflicts.includes(field.name)) continue;
    const note = document.createElement('span'); note.className = 'field-conflict';
    const description = document.createElement('span');
    description.textContent = '此字段已在其他位置修改。当前配置：' + String(remote[field.name]);
    note.append(description);
    field.setCustomValidity('此字段存在并发修改，请选择要保留的值。');
    const resolve = () => { field.setCustomValidity(''); note.remove(); };
    for (const [label, useRemote] of [['采用当前配置', true], ['保留我的输入', false]] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn small'; button.textContent = label;
      button.addEventListener('click', event => {
        event.preventDefault();
        if (useRemote) {
          if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = Boolean(remote[field.name]);
          else field.value = String(remote[field.name]);
        }
        resolve();
      });
      note.append(button);
    }
    field.addEventListener('input', resolve, { once: true });
    field.parentElement?.append(note);
  }
  return result.conflicts.length ? `${result.conflicts.length} 个字段有并发修改，请逐项选择；未修改字段已更新。` : '已合并最新配置并保留你的编辑，请核对后保存。';
}

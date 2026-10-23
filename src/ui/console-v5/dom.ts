export const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null => root.querySelector<T>(selector);
export const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(selector)];

function nodeKey(node: Node): string | null {
  return node instanceof Element ? node.id || node.getAttribute("data-key") : null;
}

function morph(old: Node, next: Node): void {
  if (old.nodeType !== next.nodeType || old.nodeName !== next.nodeName) { old.parentNode!.replaceChild(next.cloneNode(true), old); return; }
  if (old.nodeType === Node.TEXT_NODE) { if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue; return; }
  if (!(old instanceof Element) || !(next instanceof Element) || old.isEqualNode(next)) return;
  if (old.hasAttribute("data-preserve") && old.getAttribute("data-preserve") === next.getAttribute("data-preserve")) return;
  const focused = old === document.activeElement;
  const preservedAttribute = (name: string) => name === "open" && old instanceof HTMLDetailsElement || focused && (name === "value" || name === "checked");
  for (const attribute of [...old.attributes]) if (!preservedAttribute(attribute.name) && !next.hasAttribute(attribute.name)) old.removeAttribute(attribute.name);
  for (const attribute of [...next.attributes]) if (!preservedAttribute(attribute.name) && old.getAttribute(attribute.name) !== attribute.value) old.setAttribute(attribute.name, attribute.value);
  if (!focused && old instanceof HTMLInputElement && next instanceof HTMLInputElement) {
    old.checked = next.checked;
    if (old.value !== next.value) old.value = next.value;
  }
  if (old instanceof HTMLTextAreaElement && next instanceof HTMLTextAreaElement) { if (!focused) old.value = next.value; return; }
  const indexed = new Map([...old.childNodes].flatMap((node): Array<[string, Node]> => { const key = nodeKey(node); return key ? [[key, node]] : []; }));
  let cursor: Node | null = old.firstChild;
  for (const child of [...next.childNodes]) {
    const key = nodeKey(child);
    let match = key ? indexed.get(key) ?? null : cursor && !nodeKey(cursor) ? cursor : null;
    if (match && (match.nodeType !== child.nodeType || match.nodeName !== child.nodeName)) match = null;
    if (!match) { match = child.cloneNode(true); old.insertBefore(match, cursor); }
    else { if (match !== cursor) old.insertBefore(match, cursor); morph(match, child); }
    cursor = match.nextSibling;
  }
  while (cursor) { const following = cursor.nextSibling; old.removeChild(cursor); cursor = following; }
  if (!focused && old instanceof HTMLSelectElement && next instanceof HTMLSelectElement) old.value = next.value;
}

const lastMarkup = new WeakMap<Element, string>();
export function updateHTML(element: Element | null, html: string): boolean {
  if (!element || lastMarkup.get(element) === html) return false;
  const template = document.createElement("template"); template.innerHTML = html;
  const next = element.cloneNode(false); next.appendChild(template.content);
  morph(element, next); lastMarkup.set(element, html); return true;
}

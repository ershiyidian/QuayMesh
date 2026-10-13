const text = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ").trim();

/** One brand marker; a project named QuayMesh must not repeat it as a project tag. */
export function managedSessionTitle(projectName: string, shortId: string, title: string): string {
  const project = text(projectName).replace(/[\[\]]/g, " ").trim() || "project";
  const identifier = text(shortId).replace(/[\[\]]/g, "");
  let body = text(title);
  // Strip only a leading QuayMesh-generated prefix. A user's substantive title
  // and occurrences of "QuayMesh" elsewhere remain unchanged.
  if (/^\[quaymesh\]/i.test(body)) {
    body = body.replace(/^(?:\[quaymesh\]\s*)+/i, "");
    const firstTag = /^\[([^\]]+)\]\s*/.exec(body);
    if (firstTag?.[1]?.toLocaleLowerCase() === project.toLocaleLowerCase()) body = body.slice(firstTag[0].length);
    const runTag = /^\[([0-9a-f]{6}|[0-9a-f]{8})\]\s*/i.exec(body);
    if (runTag) body = body.slice(runTag[0].length);
  }
  const projectTag = project.toLocaleLowerCase() === "quaymesh" ? "" : `[${project}]`;
  return `[QuayMesh]${projectTag}[${identifier}] ${body || "Task"}`.slice(0, 160);
}

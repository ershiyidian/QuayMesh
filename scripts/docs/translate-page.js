(function translateReadmeScreen(dictionary) {
  const replacements = Object.entries(dictionary).sort(([a], [b]) => b.length - a.length);
  function translate(value) {
    let next = value;
    next = next.replace(/(\d+)\s*\/\s*(\d+)\s*节点在线/gu, "$1/$2 nodes online");
    next = next.replace(/(\d+)\s*\/\s*(\d+)\s*在线/gu, "$1/$2 online");
    next = next.replace(/(\d+)\s*\/\s*(\d+)\s*就绪/gu, "$1/$2 ready");
    next = next.replace(/(\d+)\s*项执行\s*\/\s*排队/gu, "$1 running / queued");
    next = next.replace(/(\d+)\s*个根目录\s*·\s*(\d+)\s*个项目/gu, "$1 roots · $2 projects");
    next = next.replace(/(\d+)\s*个会话/gu, "$1 sessions");
    next = next.replace(/(\d+)\s*个任务/gu, "$1 tasks");
    next = next.replace(/(\d+)\s*次执行/gu, "$1 executions");
    next = next.replace(/(\d+)\s*项\s*(失败|排队|运行中|待核对|待验收)/gu, "$1 $2");
    next = next.replace(/选择本页全部任务/gu, "Select all tasks on this page");
    next = next.replace(/选择任务\s+/gu, "Select task ");
    next = next.replace(/(.*?\.mjs)\s*差异/gu, "$1 diff");
    for (const [chinese, english] of replacements) next = next.replaceAll(chinese, english);
    next = next.replace(/(\d+)\s*秒刷新/gu, "Refresh every $1s");
    next = next.replace(/(\d+)\s*项目/gu, "$1 projects");
    next = next.replace(/(\d+)\s*项/gu, "$1 items");
    next = next.replace(/(\d+)\s*条/gu, "$1 entries");
    next = next.replace(/近\s*(\d+)\s*天/gu, "Last $1 days");
    next = next.replace(/近\s*(\d+)\s*小时/gu, "Last $1 hours");
    next = next.replace(/(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s*·\s*刚刚/gu, "$1 · just now");
    next = next.replace(/磁盘\s*([A-Z]:\\)/gu, "Disk $1");
    next = next.replace(/采样\s*(\d{2}:\d{2})/gu, "Sampled at $1");
    next = next.replace(/Workspace worker数据未更新，统计仅包含已读取记录/gu,
      "Workspace worker data is still refreshing");
    return next;
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest("script,style,noscript")) continue;
    if (node.textContent && /[\u3400-\u9fff]/u.test(node.textContent)) {
      node.textContent = translate(node.textContent);
    }
  }
  for (const element of document.querySelectorAll("[title],[placeholder],[aria-label]")) {
    for (const name of ["title", "placeholder", "aria-label"]) {
      const value = element.getAttribute(name);
      if (value && /[\u3400-\u9fff]/u.test(value)) element.setAttribute(name, translate(value));
    }
  }
  document.documentElement.lang = "en";
  const leftovers = new Set();
  const check = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = check.nextNode(); node; node = check.nextNode()) {
    if (node.parentElement?.closest("script,style,noscript")) continue;
    const value = node.textContent?.trim();
    if (value && /[\u3400-\u9fff]/u.test(value) && node.parentElement
      && getComputedStyle(node.parentElement).display !== "none") leftovers.add(value);
  }
  return [...leftovers].sort();
})

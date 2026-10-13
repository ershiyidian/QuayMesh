(() => {
  const views = {
    overview: "view=overview", nodes: "view=machines", roots: "view=workspaces", work: "view=tasks",
    transfers: "view=activity&tab=transfers", events: "view=activity&tab=events",
  };
  const query = views[location.hash.slice(1)] || "view=overview";
  const target = new URL("../", location.href);
  target.search = query;
  location.replace(target.href);
})();

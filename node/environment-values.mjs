export function environmentValue(environment, name, platform = process.platform) {
  if (platform !== "win32") return environment[name];
  const key = Object.keys(environment).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : environment[key];
}

export function mergeEnvironment(platform, ...sources) {
  const result = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      const key = platform === "win32" ? name.toUpperCase() : name;
      if (value === undefined) delete result[key];
      else result[key] = value;
    }
  }
  return result;
}

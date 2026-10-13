const PROXY_KEYS = ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy","NO_PROXY","no_proxy","NODE_USE_ENV_PROXY"];
const CREDENTIAL_PREFIXES = ["OPENAI_","ANTHROPIC_","AZURE_OPENAI_","GOOGLE_API","GEMINI_","CONTROL_PLANE_","HARPOON_","MCP_SERVER_URL","MCP_COMMAND"];

export function internalEnvironment(input = process.env) {
  const env = { ...input };
  for (const key of PROXY_KEYS) delete env[key];
  return env;
}

export function restrictedEnvironment(input = process.env) {
  const env = internalEnvironment(input);
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_PREFIXES.some(prefix => key.startsWith(prefix))) delete env[key];
  }
  return env;
}

export function proxyEnvironment(input, proxyUrl) {
  const env = internalEnvironment(input);
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl; env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl; env.https_proxy = proxyUrl;
  }
  env.NO_PROXY = "localhost,127.0.0.1,::1";
  env.no_proxy = env.NO_PROXY;
  return env;
}

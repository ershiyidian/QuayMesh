export function environmentValue(environment: NodeJS.ProcessEnv, name: string, platform?: NodeJS.Platform): string | undefined;
export function mergeEnvironment(platform: NodeJS.Platform, ...sources: Array<NodeJS.ProcessEnv | undefined>): NodeJS.ProcessEnv;

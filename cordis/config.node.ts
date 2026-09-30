/** 环境变量只在 Node.js 宿主读取；浏览器只能导入 config.ts。 */
import { resolve } from 'node:path';
import { runtimeHostTypes, type RuntimeHostType } from '../agents-runtime/types.js';
import { serviceDefaults, type AgentsRuntimeOptions, type CompanyAppOptions, type CompanyServerOptions, type OpenAiCompatibleOptions } from './config.js';

type Environment = Readonly<Record<string, string | undefined>>;
function integer(env: Environment, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new TypeError(`${key} 必须是整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${key} 必须在 ${min} 到 ${max} 之间`);
  return value;
}
export function runtimeConfigFromEnv(
  agentIds: readonly string[],
  options: { readonly dataDir?: string; readonly demo?: boolean; readonly env?: Environment } = {},
): AgentsRuntimeOptions {
  const env = options.env ?? process.env;
  const hostType = options.demo ? 'codex' : env.AGENT_HOST ?? serviceDefaults.agentsRuntime.hostType;
  if (!runtimeHostTypes.includes(hostType as RuntimeHostType)) throw new TypeError('AGENT_HOST 不受支持');
  const profile = {
    hostType: hostType as RuntimeHostType,
    cwd: resolve(env.AGENT_CWD ?? '.'),
    ...(env.AGENT_MODEL ? { model: env.AGENT_MODEL } : {}),
    ...(env.AGENT_REASONING_EFFORT ? { reasoningEffort: env.AGENT_REASONING_EFFORT } : {}),
  };
  return {
    dataDir: resolve(options.dataDir ?? serviceDefaults.agentsRuntime.dataDir),
    timeoutMs: integer(env, 'AGENT_TIMEOUT_MS', serviceDefaults.agentsRuntime.timeoutMs, 0, 2147483647),
    agents: Object.fromEntries(agentIds.map(id => [id, { ...profile }])),
    env: { ...env },
  };
}
export function companyConfigFromEnv(options: { readonly demo?: boolean; readonly env?: Environment } = {}): CompanyAppOptions {
  const env = options.env ?? process.env;
  const company = serviceDefaults.company;
  return {
    agentsRuntime: runtimeConfigFromEnv([company.plannerAgentId, ...company.workerAgentIds], { ...options, dataDir: serviceDefaults.agentsRuntime.companyDataDir }),
    company: { ...company, rootDir: resolve(company.rootDir) },
    companyServer: serverConfigFromEnv(env),
  };
}
export function serverConfigFromEnv(env: Environment = process.env): CompanyServerOptions {
  return {
    port: integer(env, 'COMPANY_PORT', serviceDefaults.companyServer.port, 0, 65535),
    staticDir: resolve(serviceDefaults.companyServer.staticDir),
  };
}
/** 凭据仍由运行时回调读取，不写入静态配置或浏览器。 */
export function llmConfigFromEnv(env: Environment = process.env): { provider: OpenAiCompatibleOptions; model: string; timeoutMs: number } {
  if (!env.LLM_API_KEY?.trim() || !env.LLM_MODEL?.trim() || !env.LLM_BASE_URL?.trim()) throw new TypeError('真实调用需要 LLM_API_KEY、LLM_MODEL、LLM_BASE_URL');
  return {
    provider: { id: 'api', baseURL: env.LLM_BASE_URL, apiKey: () => env.LLM_API_KEY! },
    model: env.LLM_MODEL,
    timeoutMs: integer(env, 'LLM_TIMEOUT_MS', serviceDefaults.llm.timeoutMs, 0, 2147483647),
  };
}

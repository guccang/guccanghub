/** 所有 Cordis 服务配置的唯一类型与默认值入口；运行时可直接由浏览器加载。 */
import { freeze } from './utils.js';
import type { AgentPlannerPort, AgentExecutorPort } from '../agents-dag-context/types.js';
import type { RuntimeHostType, RuntimeProcessExecutor } from '../agents-runtime/types.js';
import type { ManagedDag } from './dag.js';
import type { StudioInteraction } from '../pixel-studio/types.js';

export interface DagPluginOptions { readonly graph?: ManagedDag }

export interface AgentsDagContextOptions {
  readonly rootDir: string;
  readonly planner: AgentPlannerPort;
  readonly executor: AgentExecutorPort;
}

export interface RuntimeAgentProfile {
  readonly hostType: RuntimeHostType;
  /** CLI 可读写的工作目录，必须是存在的绝对路径。 */
  readonly cwd: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly timeoutMs?: number;
}

export interface AgentsRuntimeOptions {
  readonly dataDir: string;
  readonly agents: Readonly<Record<string, RuntimeAgentProfile>>;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** 可注入上游 createHostExecutor 或模拟进程；默认调用本机 CLI。 */
  readonly execute?: RuntimeProcessExecutor;
}

export interface LlmServiceOptions { readonly timeoutMs?: number }

export interface OpenAiCompatibleOptions {
  readonly id: string;
  /** API 根路径，例如 https://api.deepseek.com 或 https://gateway.example/v1。 */
  readonly baseURL: string;
  readonly apiKey: string | (() => string | Promise<string>);
  readonly models?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
}

export interface CompanyOptions {
  readonly rootDir: string;
  readonly plannerAgentId: string;
  readonly workerAgentIds: readonly string[];
  readonly maxNodes?: number;
  readonly maxConcurrentTasks?: number;
  readonly maxTasks?: number;
}

export interface CompanyServerOptions { readonly port?: number; readonly staticDir?: string }

export interface CompanyClientOptions { readonly baseURL?: string; readonly pollMs?: number }

export interface DagWebuiOptions { readonly element: HTMLElement }

export type RuntimeAgentsDagOptions = Omit<AgentsDagContextOptions, 'executor'>;
export type DeepseekLlmOptions = Omit<OpenAiCompatibleOptions, 'baseURL'> & { readonly baseURL?: string };
export interface PixelStudioWebuiOptions {
  readonly element: HTMLElement;
  readonly frameUrl?: string;
  readonly onInteraction?: (interaction: StudioInteraction) => void;
}
/** Node.js 公司宿主完整配置；LLM 可选，未配置时不创建 API 连接。 */
export interface CompanyAppOptions {
  readonly agentsRuntime: AgentsRuntimeOptions;
  readonly company: CompanyOptions;
  readonly companyServer?: CompanyServerOptions;
  readonly llm?: LlmServiceOptions & { readonly providers?: readonly OpenAiCompatibleOptions[] };
}
/** 浏览器完整配置；挂载元素由宿主传入，不保存到配置文件。 */
export interface BrowserAppOptions {
  readonly mode?: 'company' | 'editor';
  readonly companyClient?: CompanyClientOptions;
  readonly dagGraph?: DagPluginOptions;
}

export const serviceDefaults = freeze({
  agentsRuntime: {
    timeoutMs: 300_000,
    hostType: 'codex' as RuntimeHostType,
    dataDir: './data/agents-runtime',
    companyDataDir: './data/company-runtime',
  },
  agentsDag: { rootDir: './data/agent-context' },
  company: {
    rootDir: './data/company-context',
    plannerAgentId: 'planner',
    workerAgentIds: ['researcher', 'builder', 'reviewer'],
    maxNodes: 32,
    maxConcurrentTasks: 1,
    maxTasks: 100,
  },
  companyServer: {
    host: '127.0.0.1',
    port: 4318,
    staticDir: './dist/panel',
    requestTimeoutMs: 15_000,
    headersTimeoutMs: 10_000,
    maxBodyBytes: 256 * 1024,
  },
  companyClient: { baseURL: '/api/company', pollMs: 500 },
  llm: { timeoutMs: 120_000, deepseekBaseURL: 'https://api.deepseek.com' },
  pixelStudio: { frameUrl: '/office-engine/frame.html' },
  webui: { devPort: 4317 },
} as const);

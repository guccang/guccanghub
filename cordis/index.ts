/** Cordis 的 Node.js 插件入口；DAG 内核与浏览器入口不依赖此模块。 */
import { Service, type Context } from "cordis";
import {
  createAgentsDagContext,
  type AgentsDagContext,
  type AgentsDagContextOptions,
} from "../agents-dag-context/index.js";

declare module "cordis" {
  interface Context {
    agentsDag: AgentsDagService;
  }
}

/** 由 Cordis 管理注册与卸载，文件和执行策略沿用 Agent 模块。 */
export class AgentsDagService extends Service<AgentsDagContextOptions> {
  readonly runtime: AgentsDagContext;

  constructor(ctx: Context, options: AgentsDagContextOptions) {
    // 在注册前验证配置，避免留下不能使用的服务。
    if (!options || typeof options.rootDir !== "string" || !options.rootDir.trim()) {
      throw new TypeError("rootDir 必须是非空字符串");
    }
    if (typeof options.planner?.decompose !== "function") {
      throw new TypeError("planner.decompose 必须是函数");
    }
    if (typeof options.executor?.execute !== "function") {
      throw new TypeError("executor.execute 必须是函数");
    }
    super(ctx, "agentsDag");
    this.runtime = createAgentsDagContext(options);
  }
}

/** ctx.plugin(agentsDagPlugin, options) 注册服务。 */
export const agentsDagPlugin = {
  name: "agents-dag-context",
  provide: "agentsDag",
  apply(ctx: Context, options: AgentsDagContextOptions) {
    return new AgentsDagService(ctx, options);
  },
};

export type { AgentsDagContextOptions };

export * from "./dag.js";

export * from "./config.js";

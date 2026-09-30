import type { Context } from 'cordis';
import { AgentsDagService } from '../cordis/index.js';
import type { RuntimeAgentsDagOptions } from '../cordis/config.js';
import './service.js';
export type { RuntimeAgentsDagOptions } from '../cordis/config.js';
/** 依赖 runtime 服务，自动装配现有 context 的执行器。 */
export const runtimeAgentsDagPlugin = {
  name: 'runtime-agents-dag', inject: ['agentsRuntime'], provide: 'agentsDag',
  apply(ctx: Context, options: RuntimeAgentsDagOptions) {
    return new AgentsDagService(ctx, { ...options, executor: ctx.agentsRuntime });
  },
};

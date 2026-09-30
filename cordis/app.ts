/** Node.js 统一装配插件；独立服务入口继续可用。 */
import type { Context } from 'cordis';
import { agentsRuntimePlugin } from '../agents-runtime/index.js';
import { companyPlugin, companyServerPlugin } from '../company/index.js';
import { llmPlugin, openAiCompatiblePlugin } from '../llm/index.js';
import type { CompanyAppOptions } from './config.js';
export const companyAppPlugin = {
  name: 'company-app',
  apply(ctx: Context, options: CompanyAppOptions) {
    ctx.plugin(agentsRuntimePlugin, options.agentsRuntime);
    ctx.plugin(companyPlugin, options.company);
    if (options.companyServer) ctx.plugin(companyServerPlugin, options.companyServer);
    if (options.llm) {
      ctx.plugin(llmPlugin, options.llm);
      for (const provider of options.llm.providers ?? []) ctx.plugin(openAiCompatiblePlugin, provider);
    }
  },
};

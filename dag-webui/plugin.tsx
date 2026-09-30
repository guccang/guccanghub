/** Cordis 管理 Web UI 挂载、服务依赖和卸载。 */
import type { Context } from '@cordisjs/core';
import { mountReact } from '../cordis/react.js';
import type { DagWebuiOptions } from '../cordis/config.js';
import '../pixel-studio/service.js';
import '../company/client.js';
import { CompanyWorkbench } from './CompanyWorkbench.js';
import { DagWorkbench } from './DagWorkbench.js';
export type { DagWebuiOptions } from '../cordis/config.js';

export const dagWebuiPlugin = {
  name: 'dag-webui',
  inject: { dagGraph: { required: true }, pixelStudio: { required: false } },
  apply(ctx: Context, options: DagWebuiOptions) {
    mountReact(ctx, options.element, <DagWorkbench service={ctx.dagGraph} studio={ctx.pixelStudio} />);
  },
};

export const companyWebuiPlugin = {
  name: 'company-webui', inject: ['dagGraph', 'pixelStudio', 'companyClient'],
  apply(ctx: Context, options: DagWebuiOptions) {
    mountReact(ctx, options.element, <CompanyWorkbench client={ctx.companyClient} service={ctx.dagGraph} studio={ctx.pixelStudio} />);
  },
};

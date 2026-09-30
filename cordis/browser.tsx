/** 浏览器统一装配；不导入 Node.js 配置或执行服务。 */
import type { Context } from '@cordisjs/core';
import { dagPlugin } from './dag.js';
import { pixelStudioPlugin, dagStudioBridgePlugin } from '../pixel-studio/index.js';
import { companyClientPlugin } from '../company/client.js';
import { companyWebuiPlugin, dagWebuiPlugin } from '../dag-webui/plugin.js';
import type { BrowserAppOptions, DagWebuiOptions } from './config.js';
export const browserAppPlugin = {
  name: 'browser-app',
  apply(ctx: Context, options: BrowserAppOptions & DagWebuiOptions) {
    ctx.plugin(dagPlugin, options.dagGraph);
    ctx.plugin(pixelStudioPlugin);
    if ((options.mode ?? 'company') === 'company') {
      ctx.plugin(companyClientPlugin, options.companyClient);
      ctx.plugin(companyWebuiPlugin, { element: options.element });
    } else {
      ctx.plugin(dagStudioBridgePlugin);
      // 必需显示服务就绪后才挂载，确保初始渲染包含办公室。
      ctx.inject(['dagGraph', 'pixelStudio'], scope => { scope.plugin(dagWebuiPlugin, { element: options.element }); });
    }
  },
};

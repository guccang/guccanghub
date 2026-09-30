import type { PixelStudioWebuiOptions } from '../cordis/config.js';
export type { PixelStudioWebuiOptions } from '../cordis/config.js';
import { mountReact } from '../cordis/react.js';
import type { Context } from '@cordisjs/core';
import { PixelStudio, type PixelStudioProps } from './PixelStudio.js';
import './service.js';
export { PixelStudio };
export type { PixelStudioProps };
/** 可单独挂载，也可在现有 React 根中直接使用 PixelStudio。 */
export const pixelStudioWebuiPlugin = {
  name: 'pixel-studio-webui',
  inject: ['pixelStudio'],
  apply(ctx: Context, options: PixelStudioWebuiOptions) {
    mountReact(ctx, options.element, <PixelStudio display={ctx.pixelStudio} frameUrl={options.frameUrl} onInteraction={options.onInteraction} />);
  },
};

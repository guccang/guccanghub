/** 所有 React 根节点共用 Cordis 挂载/卸载生命周期。 */
import React, { type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Context } from '@cordisjs/core';
export function mountReact(ctx: Context, element: HTMLElement, content: ReactNode): void {
  const root = createRoot(element);
  ctx.on('dispose', () => { root.unmount(); });
  root.render(<React.StrictMode>{content}</React.StrictMode>);
}

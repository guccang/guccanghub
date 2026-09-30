import type { DagPluginOptions } from '../cordis/config.js';
export type { DagPluginOptions } from '../cordis/config.js';
/** 可在 Node.js 和浏览器使用的 Cordis DAG 服务。 */
import { Service, type Context } from '@cordisjs/core';
import { applyDagOperations, createDag, type Dag, type DagOperation } from '../dag/index.js';

export type DagData = Record<string, unknown>;
export type ManagedDag = Dag<DagData, DagData>;


declare module '@cordisjs/core' {
  interface Context { dagGraph: DagGraphService }
}

/** 管理不可变图快照，供其他插件和 React 订阅。 */
export class DagGraphService extends Service {
  private graph: ManagedDag;
  private readonly listeners = new Set<() => void>();

  constructor(ctx: Context, options: DagPluginOptions = {}) {
    const graph = createDag<DagData, DagData>(options.graph);
    super(ctx, 'dagGraph');
    this.graph = graph;
    ctx.on('dispose', () => { this.listeners.clear(); });
  }

  readonly getSnapshot = (): ManagedDag => this.graph;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setGraph(graph: ManagedDag): void {
    this.graph = createDag(graph);
    for (const listener of this.listeners) listener();
  }

  apply(operations: readonly DagOperation<DagData, DagData>[]): void {
    this.setGraph(applyDagOperations(this.graph, operations));
  }
}

export const dagPlugin = {
  name: 'dag-graph',
  provide: 'dagGraph',
  apply(ctx: Context, options: DagPluginOptions = {}) {
    return new DagGraphService(ctx, options);
  },
};

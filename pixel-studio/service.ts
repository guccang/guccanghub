import { freeze } from '../cordis/utils.js';
import { Service, type Context } from '@cordisjs/core';
import { validateStudioSnapshot } from './validation.js';
import type { StudioDisplayPort, StudioDisplayState, StudioSnapshot } from './types.js';

declare module '@cordisjs/core' {
  interface Context { pixelStudio: PixelStudioService }
}
/** Cordis 管理显示快照和订阅；本服务不启动任务。 */
export class PixelStudioService extends Service implements StudioDisplayPort {
  private state: StudioDisplayState = Object.freeze({ snapshot: null, connected: false, connectionEpoch: 0, selectedActorId: null });
  private readonly listeners = new Set<() => void>();
  constructor(ctx: Context) {
    super(ctx, 'pixelStudio');
    ctx.on('dispose', () => { this.listeners.clear(); });
  }
  readonly getSnapshot = (): StudioDisplayState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(state: StudioDisplayState): void {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) listener();
  }
  publish(snapshot: StudioSnapshot, options: { reconnect?: boolean } = {}): boolean {
    validateStudioSnapshot(snapshot);
    const previous = this.state.snapshot;
    const sameRun = previous?.runId === snapshot.runId;
    if (sameRun && snapshot.revision <= previous.revision) {
      if (options.reconnect && snapshot.revision === previous.revision) this.setConnected(true);
      return false;
    }
    const copy = freeze(structuredClone(snapshot));
    const value = copy;
    const selected = sameRun && value.actors.some(actor => actor.id === this.state.selectedActorId) ? this.state.selectedActorId : null;
    this.update({ snapshot: value, connected: true, selectedActorId: selected, connectionEpoch: this.state.connectionEpoch + (options.reconnect || !sameRun || !this.state.connected ? 1 : 0) });
    return true;
  }
  setConnected(connected: boolean): void {
    if (connected !== this.state.connected) this.update({ ...this.state, connected, connectionEpoch: this.state.connectionEpoch + (connected ? 1 : 0) });
  }
  selectActor(id: string | null): void {
    if (id !== null && !this.state.snapshot?.actors.some(actor => actor.id === id)) throw new Error(`角色不存在: ${id}`);
    if (id !== this.state.selectedActorId) this.update({ ...this.state, selectedActorId: id });
  }
}
export const pixelStudioPlugin = {
  name: 'pixel-studio-display',
  provide: 'pixelStudio',
  apply(ctx: Context) { return new PixelStudioService(ctx); },
};

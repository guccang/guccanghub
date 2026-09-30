/** 显示协议只描述画面，不包含执行器、文件路径或调度命令。 */
export const studioCharacters = ['michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar', 'stanley', 'phyllis', 'andy', 'kelly', 'ryan', 'toby', 'creed', 'meredith'] as const;
export type StudioCharacter = typeof studioCharacters[number];
export type StudioStatus = 'idle' | 'working' | 'blocked' | 'paused' | 'success' | 'error' | 'unknown';
export interface StudioActor {
  readonly id: string;
  readonly name: string;
  readonly character: StudioCharacter;
  readonly status: StudioStatus;
  readonly activity: string;
  readonly isLead?: boolean;
}
export interface StudioTask {
  readonly id: string;
  readonly title: string;
  readonly actorId: string;
  readonly status: StudioStatus;
}
export interface StudioHandoff {
  /** 单个运行内单调递增，初次连接与重连不重播历史事件。 */
  readonly sequence: number;
  readonly from: string;
  readonly to: string;
  readonly kind: 'inform' | 'completed' | 'input-required';
}
export interface StudioSnapshot {
  readonly version: 1;
  readonly runId: string;
  readonly title: string;
  /** 同一运行的递增版本；旧版本会被服务拒绝。 */
  readonly revision: number;
  readonly actors: readonly StudioActor[];
  readonly tasks: readonly StudioTask[];
  readonly handoffs: readonly StudioHandoff[];
}
export interface StudioDisplayState {
  readonly snapshot: StudioSnapshot | null;
  readonly connected: boolean;
  readonly connectionEpoch: number;
  readonly selectedActorId: string | null;
}
/** 后续 HTTP/WebSocket、Cordis 或其他数据源只需对接此接口。 */
export interface StudioDisplayPort {
  getSnapshot(): StudioDisplayState;
  subscribe(listener: () => void): () => void;
  publish(snapshot: StudioSnapshot, options?: { reconnect?: boolean }): boolean;
  setConnected(connected: boolean): void;
  selectActor(id: string | null): void;
}
export type StudioInteraction =
  | { readonly type: 'select-actor'; readonly actorId: string }
  | { readonly type: 'navigate'; readonly target: string };

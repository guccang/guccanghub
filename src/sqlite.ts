/** SQLite 持久化适配器：事务快照、事件日志、命令去重及租约隔离。 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Artifact, RunSnapshot, RuntimeEvent, RuntimeStore, StoreTransaction } from './types.js';

/** 在本地磁盘保存单个运行时的数据；快照与日志均以数据库提交为准。 */
export class SqliteStore implements RuntimeStore {
  private db: DatabaseSync;
  private artifactDir: string;
  private owner = '';
  private closed = false;
  /** 初始化数据库与产物目录，启用完整同步和外键。 */
  constructor(public readonly filename: string, artifactDir?: string) {
    if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
    this.artifactDir = resolve(artifactDir ?? join(dirname(resolve(filename)), 'artifacts'));
    mkdirSync(this.artifactDir, { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run_id,seq));
      CREATE TABLE IF NOT EXISTS snapshots (run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(run_id,seq));
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, token INTEGER NOT NULL, expires INTEGER NOT NULL);
      INSERT OR IGNORE INTO lease VALUES(1,NULL,0,0);
      PRAGMA user_version=1;`);
  }
  /** 在显式写事务中完成操作，出现错误则完整回滚。 */
  private atomic<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** 校验写入者的令牌与租约，阻止旧进程或过期进程提交。 */
  private checkFence(token: number): void {
    const lease = this.db.prepare('SELECT * FROM lease WHERE id=1').get()!;
    if (lease.owner !== this.owner || lease.token !== token || Number(lease.expires) <= Date.now()) throw new Error('LEASE_LOST：调度租约已失效');
  }
  /** 获取独占租约；每次接管递增隔离令牌。 */
  acquire(owner: string, ttlMs: number): number {
    return this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM lease WHERE id=1').get()!;
      if (row.owner && Number(row.expires) > Date.now()) throw new Error('运行时已由另一个实例持有');
      const token = Number(row.token) + 1;
      this.db.prepare('UPDATE lease SET owner=?,token=?,expires=? WHERE id=1').run(owner, token, Date.now() + ttlMs);
      this.owner = owner; return token;
    });
  }
  /** 仅允许尚未过期的所有者续租。 */
  renew(owner: string, token: number, ttlMs: number): void {
    this.atomic(() => { this.checkFence(token); if (owner !== this.owner) throw new Error('租约所有者不匹配'); this.db.prepare('UPDATE lease SET expires=? WHERE id=1').run(Date.now() + ttlMs); });
  }
  /** 释放自身租约，保留递增令牌。 */
  release(owner: string, token: number): void {
    if (!this.closed) this.db.prepare('UPDATE lease SET owner=NULL,expires=0 WHERE id=1 AND owner=? AND token=?').run(owner, token);
  }
  /** 读取命令回执；同 ID 不允许提交不同参数。 */
  private receipt(id: string, fingerprint: string): { value: unknown } | undefined {
    const row = this.db.prepare('SELECT * FROM commands WHERE id=?').get(id);
    if (!row) return;
    if (row.fingerprint !== fingerprint) throw new Error('COMMAND_CONFLICT：同一命令 ID 的参数不一致');
    return { value: JSON.parse(String(row.result)) };
  }
  /** 创建运行和首条事件，同时保存幂等回执。 */
  create(state: RunSnapshot, fence: number, commandId: string, fingerprint: string): string {
    return this.atomic(() => {
      this.checkFence(fence);
      const receipt = this.receipt(commandId, fingerprint); if (receipt) return String(receipt.value);
      state.lastEventSeq = 1; state.stateRevision = 1;
      this.db.prepare('INSERT INTO runs VALUES(?,?)').run(state.id, JSON.stringify(state));
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(state.id, state.lastEventSeq, JSON.stringify(state));
      const event: RuntimeEvent = { runId: state.id, seq: 1, type: 'run.created', at: state.createdAt, data: { objective: state.goal.objective }, stateRevision: 1 };
      this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(state.id, 1, JSON.stringify(event));
      this.db.prepare('INSERT INTO commands VALUES(?,?,?)').run(commandId, fingerprint, JSON.stringify(state.id)); return state.id;
    });
  }
  /** 快照、事件与命令回执在同一事务中提交。 */
  transact<T>(runId: string, fence: number, action: (tx: StoreTransaction) => T, command?: { id: string; fingerprint: string }): T {
    return this.atomic(() => {
      this.checkFence(fence);
      if (command) { const receipt = this.receipt(command.id, command.fingerprint); if (receipt) return receipt.value as T; }
      const state = this.read(runId); state.stateRevision++; state.updatedAt = new Date().toISOString();
      const events: RuntimeEvent[] = [];
      const value = action({ state, emit(type, data = {}) { events.push({ runId, seq: ++state.lastEventSeq, type, data, at: state.updatedAt, stateRevision: state.stateRevision }); } });
      if (!events.length) events.push({ runId, seq: ++state.lastEventSeq, type: 'state.updated', data: {}, at: state.updatedAt, stateRevision: state.stateRevision });
      this.db.prepare('UPDATE runs SET state=? WHERE id=?').run(JSON.stringify(state), runId);
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?)').run(runId, state.lastEventSeq, JSON.stringify(state));
      const insert = this.db.prepare('INSERT INTO events VALUES(?,?,?)');
      for (const event of events) insert.run(runId, event.seq, JSON.stringify(event));
      if (command) this.db.prepare('INSERT INTO commands VALUES(?,?,?)').run(command.id, command.fingerprint, JSON.stringify(value ?? null));
      return value;
    });
  }
  /** 单行快照包含对应事件水位，避免快照与序号跨事务撕裂。 */
  read(runId: string): RunSnapshot {
    const row = this.db.prepare('SELECT state FROM runs WHERE id=?').get(runId);
    if (!row) throw new Error(`运行不存在：${runId}`); return JSON.parse(String(row.state));
  }
  /** 返回指定事件水位之前已完整提交的快照，用于无副作用历史查看。 */
  readAt(runId: string, eventSeq: number): RunSnapshot {
    const row = this.db.prepare('SELECT state FROM snapshots WHERE run_id=? AND seq<=? ORDER BY seq DESC LIMIT 1').get(runId, eventSeq);
    if (!row) throw new Error('该事件水位没有历史快照'); return JSON.parse(String(row.state));
  }
  /** 列出已有运行，按创建时间倒序排列。 */
  list(): RunSnapshot[] { return this.db.prepare('SELECT state FROM runs ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.state))); }
  /** 按持久化序号读取增量事件。 */
  events(runId: string, after = 0, limit = 1000): RuntimeEvent[] {
    return this.db.prepare('SELECT body FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, after, limit).map(row => JSON.parse(String(row.body)));
  }
  /** 先同步文件内容再原子重命名；清单稍后由运行时事务提交。 */
  writeArtifact(runId: string, attemptId: string, name: string, content: string | Uint8Array, mediaType: string): Artifact {
    const bytes = Buffer.from(content); const hash = createHash('sha256').update(bytes).digest('hex');
    const destination = join(this.artifactDir, hash);
    if (!existsSync(destination)) {
      const temp = join(this.artifactDir, `${randomUUID()}.tmp`); const fd = openSync(temp, 'wx');
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, destination);
      // POSIX 额外同步目录；Windows 不支持打开目录用于 fsync。
      if (process.platform !== 'win32') { const directory = openSync(this.artifactDir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
    }
    return { id: randomUUID(), runId, attemptId, name, hash, size: bytes.length, mediaType, createdAt: new Date().toISOString() };
  }
  /** 读取并验证内容摘要，阻止使用缺失或损坏的产物。 */
  readArtifact(artifact: Artifact): Uint8Array {
    if (!/^[a-f0-9]{64}$/.test(artifact.hash)) throw new Error('产物摘要无效');
    const bytes = readFileSync(join(this.artifactDir, artifact.hash));
    if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.hash) throw new Error('产物内容校验失败');
    return bytes;
  }
  /** 核查引用是否指向可用产物。 */
  hasArtifact(artifact: Artifact): boolean { try { this.readArtifact(artifact); return true; } catch { return false; } }
  /** 关闭数据库，宿主关闭前应先停止运行时。 */
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}

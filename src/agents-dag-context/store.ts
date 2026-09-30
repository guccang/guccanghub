/** Agent 节点文件夹与 JSON 文件的本地持久化实现。 */
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AgentFeedback,
  AgentNodeState,
  AgentRunPlan,
  JsonObject,
} from "./types.js";

/** 使用固定长度摘要生成安全且稳定的文件夹名。 */
function folderName(prefix: string, id: string): string {
  return `${prefix}-${createHash("sha256").update(id).digest("hex")}`;
}

/** 将 JSON 写入临时文件、同步文件内容，再原子替换目标文件。 */
async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

/** 读取并解析一个 JSON 文件。 */
async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** 目标 JSON 文件不存在时返回 undefined。 */
async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 文件夹式上下文存储；节点 ID 不直接拼入路径。 */
export class AgentContextFileStore {
  readonly rootDir: string;

  /** 将传入的存储根目录解析为绝对路径。 */
  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  /** 返回一个目标的绝对文件夹路径。 */
  runFolder(runId: string): string {
    return join(this.rootDir, "runs", folderName("run", runId));
  }

  /** 返回一个节点相对目标文件夹的路径。 */
  nodeRelativeDir(nodeId: string): string {
    return join("nodes", folderName("node", nodeId));
  }

  /** 返回节点上下文的绝对文件夹路径。 */
  nodeFolder(runId: string, nodeId: string): string {
    return join(this.runFolder(runId), this.nodeRelativeDir(nodeId));
  }

  /** 先写入暂存文件夹，再一次性发布完整计划和所有节点输入。 */
  async createRun(
    plan: AgentRunPlan,
    inputs: Readonly<Record<string, JsonObject>>,
    states: Readonly<Record<string, AgentNodeState>>,
  ): Promise<void> {
    const parent = join(this.rootDir, "runs");
    const target = this.runFolder(plan.runId);
    await mkdir(parent, { recursive: true });
    try {
      await access(target);
      throw new Error(`目标运行已存在: ${plan.runId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(parent, `.creating-${randomUUID()}`);
    await mkdir(temporary);
    for (const node of plan.graph.nodes) {
      const folder = join(temporary, this.nodeRelativeDir(node.id));
      await mkdir(folder, { recursive: true });
      await writeJson(join(folder, "input.json"), inputs[node.id]);
      await writeJson(join(folder, "state.json"), states[node.id]);
    }
    await writeJson(join(temporary, "run.json"), plan);
    await rename(temporary, target);
  }

  /** 读取已经发布的目标与图。 */
  async readRun(runId: string): Promise<AgentRunPlan> {
    return readJson(join(this.runFolder(runId), "run.json"));
  }

  /** 读取节点最初的规划输入。 */
  async readInput(runId: string, nodeId: string): Promise<JsonObject> {
    return readJson(join(this.nodeFolder(runId, nodeId), "input.json"));
  }

  /** 原子保存尚未执行节点的新输入上下文。 */
  async writeInput(
    runId: string,
    nodeId: string,
    input: JsonObject,
  ): Promise<void> {
    await writeJson(join(this.nodeFolder(runId, nodeId), "input.json"), input);
  }

  /** 读取节点当前状态和状态历史。 */
  async readState(runId: string, nodeId: string): Promise<AgentNodeState> {
    return readJson(join(this.nodeFolder(runId, nodeId), "state.json"));
  }

  /** 原子保存节点当前状态及其历史。 */
  async writeState(
    runId: string,
    nodeId: string,
    state: AgentNodeState,
  ): Promise<void> {
    await writeJson(join(this.nodeFolder(runId, nodeId), "state.json"), state);
  }

  /** 在调用外部 Agent 前保存本次冻结的执行输入。 */
  async writeAttemptInput(
    runId: string,
    nodeId: string,
    attempt: number,
    input: unknown,
  ): Promise<void> {
    const folder = this.attemptFolder(runId, nodeId, attempt);
    await mkdir(folder, { recursive: true });
    await writeJson(join(folder, "input.json"), input);
  }

  /** 保存一次执行的固定格式反馈和节点最新反馈/输出。 */
  async writeFeedback(
    runId: string,
    nodeId: string,
    attempt: number,
    feedback: AgentFeedback,
  ): Promise<void> {
    const folder = this.nodeFolder(runId, nodeId);
    await writeJson(
      join(this.attemptFolder(runId, nodeId, attempt), "feedback.json"),
      feedback,
    );
    await writeJson(join(folder, "feedback.json"), feedback);
    await writeJson(join(folder, "output.json"), feedback.output);
  }

  /** 读取本次执行已落盘的反馈，用于崩溃后补录状态。 */
  async readAttemptFeedback(
    runId: string,
    nodeId: string,
    attempt: number,
  ): Promise<AgentFeedback | undefined> {
    return readOptionalJson(
      join(this.attemptFolder(runId, nodeId, attempt), "feedback.json"),
    );
  }

  /** 读取节点最新的固定格式反馈。 */
  async readFeedback(
    runId: string,
    nodeId: string,
  ): Promise<AgentFeedback | undefined> {
    return readOptionalJson(
      join(this.nodeFolder(runId, nodeId), "feedback.json"),
    );
  }

  /** 读取节点最新的 JSON 输出。 */
  async readOutput(
    runId: string,
    nodeId: string,
  ): Promise<JsonObject | undefined> {
    return readOptionalJson(
      join(this.nodeFolder(runId, nodeId), "output.json"),
    );
  }

  /** 返回某次尝试的文件夹。 */
  private attemptFolder(
    runId: string,
    nodeId: string,
    attempt: number,
  ): string {
    return join(
      this.nodeFolder(runId, nodeId),
      "attempts",
      String(attempt).padStart(4, "0"),
    );
  }
}

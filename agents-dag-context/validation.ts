/** Agent 文件协议的运行时校验，与具体 LLM 实现无关。 */
import { createDag, type Dag } from "../dag/index.js";
import type {
  AgentFeedback,
  AgentGoal,
  JsonObject,
  PlannedAgentNode,
} from "./types.js";

/** 检查值能否完整保存为标准 JSON，拒绝循环、函数和非有限数字。 */
export function assertJson(
  value: unknown,
  path = "$",
  seen = new WeakSet<object>(),
  depth = 0,
): asserts value is import("./types.js").JsonValue {
  if (depth > 64) throw new Error(`${path} 超过 JSON 嵌套深度限制`);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new Error(`${path} 不是有效 JSON 值`);
  if (seen.has(value)) throw new Error(`${path} 包含循环引用`);
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error(`${path} 必须是普通 JSON 对象`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) throw new Error(`${path}[${index}] 是空数组槽位`);
      assertJson(value[index], `${path}[${index}]`, seen, depth + 1);
    }
  } else {
    for (const [key, nested] of Object.entries(value))
      assertJson(nested, `${path}.${key}`, seen, depth + 1);
  }
  seen.delete(value);
}

/** 检查 Agent 输入或输出是 JSON 对象。 */
export function assertJsonObject(
  value: unknown,
  path: string,
): asserts value is JsonObject {
  assertJson(value, path);
  if (value === null || Array.isArray(value) || typeof value !== "object")
    throw new Error(`${path} 必须是 JSON 对象`);
}

/** 检查目标文本与初始上下文。 */
export function validateGoal(goal: AgentGoal): void {
  if (!goal || typeof goal.objective !== "string" || !goal.objective.trim())
    throw new Error("目标 objective 必须是非空字符串");
  assertJsonObject(goal.context, "goal.context");
}

/** 校验规划器返回的完整 DAG 与每个节点输入。 */
export function validatePlannedDag(
  value: Dag<PlannedAgentNode, JsonObject>,
): Dag<PlannedAgentNode, JsonObject> {
  const graph = createDag(value);
  for (const node of graph.nodes) {
    if (
      !node.data ||
      typeof node.data.agentId !== "string" ||
      !node.data.agentId.trim()
    )
      throw new Error(`节点 ${node.id} 缺少 agentId`);
    if (
      typeof node.data.instruction !== "string" ||
      !node.data.instruction.trim()
    )
      throw new Error(`节点 ${node.id} 缺少 instruction`);
    assertJsonObject(node.data.input, `节点 ${node.id}.input`);
  }
  for (const edge of graph.edges)
    assertJsonObject(edge.data, `边 ${edge.id}.data`);
  return graph;
}

/** 将执行器的未知返回值严格转换为固定反馈协议。 */
export function parseAgentFeedback(value: unknown): AgentFeedback {
  assertJsonObject(value, "feedback");
  const status = value.status;
  if (status !== "SUCCEEDED" && status !== "FAILED")
    throw new Error("feedback.status 必须是 SUCCEEDED 或 FAILED");
  if (typeof value.summary !== "string" || !value.summary.trim())
    throw new Error("feedback.summary 必须是非空字符串");
  assertJsonObject(value.output, "feedback.output");
  const keys = Object.keys(value);
  const allowed =
    status === "SUCCEEDED"
      ? ["status", "summary", "output"]
      : ["status", "summary", "output", "error"];
  if (keys.some((key) => !allowed.includes(key)))
    throw new Error("feedback 包含协议外字段");
  if (status === "FAILED") {
    if (typeof value.error !== "string" || !value.error.trim())
      throw new Error("FAILED 反馈必须包含 error");
    return {
      status,
      summary: value.summary,
      output: value.output,
      error: value.error,
    };
  }
  return { status, summary: value.summary, output: value.output };
}

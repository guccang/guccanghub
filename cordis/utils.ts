/** 已校验 JSON 的快照工具，不注册系统服务。 */
export function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

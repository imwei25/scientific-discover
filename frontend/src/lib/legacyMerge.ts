import { readPersisted, writePersisted } from "./usePersistentState";

/**
 * 一次性把旧的分散字段合并到统一的 <module>:materials 键。
 *
 * - 已合并过(存在 <materialsKey>:migrated=true) → 立即返回
 * - 否则:按 legacyKeys 顺序读取,非空的以 [来自 <label>] 前缀拼进 materials,
 *   然后写回 materials + 置 migrated=true (不清空老 key,老 key 只是被弃用)。
 *
 * 幂等:第二次调用是 no-op。
 */
export function mergeLegacyIntoMaterials(
  materialsKey: string,
  legacyKeys: { key: string; label: string }[],
): void {
  const sentinel = `${materialsKey}:migrated`;
  if (readPersisted<boolean>(sentinel, false)) return;

  const existing = (readPersisted<string>(materialsKey, "") || "").trim();
  const parts: string[] = existing ? [existing] : [];
  for (const { key, label } of legacyKeys) {
    const v = (readPersisted<string>(key, "") || "").trim();
    if (v) parts.push(`[来自 ${label}]\n${v}`);
  }

  writePersisted(materialsKey, parts.join("\n\n"));
  writePersisted(sentinel, true);
}

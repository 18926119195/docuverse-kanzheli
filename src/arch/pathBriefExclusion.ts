/**
 * reuse 失败后：只剔除 path 实际用过的 brief，保留同门其余 brief。
 * 回溯：path → prospect.briefKey（必剔）+ infer.bookKeys 上「该 prospect 对应的那一贴」；
 * 同 bookKey 门上其他 briefKey 一律保留。
 */

import type {
  InferEdge,
  PathRecord,
  ProspectRecord,
} from '../reasoning/attentionIoStore'
import { listBriefVersionsOnDoor, mapBriefToBook } from '../reasoning/masterTableMap'

export function briefKeysUsedByPath(input: {
  docId: string
  path: PathRecord
  prospects: ProspectRecord[]
  inferEdges: InferEdge[]
}): string[] {
  const used = new Set<string>()
  const prospect = input.prospects.find(
    (p) => p.prospectKey === input.path.prospectKey,
  )
  if (prospect?.briefKey) used.add(prospect.briefKey)

  const edge = input.inferEdges.find((e) => e.inferKey === input.path.inferKey)
  if (edge && prospect?.briefKey) {
    // 确认该 brief 挂在 path 材料门上；只记这一贴，不扫门上全部版本
    for (const bookKey of edge.bookKeys) {
      const hit = mapBriefToBook(input.docId, prospect.briefKey)
      if (hit?.bookKey === bookKey) {
        used.add(prospect.briefKey)
        // 同门其余 brief 不进 used
        void listBriefVersionsOnDoor(input.docId, bookKey)
      }
    }
  }
  return [...used]
}

/** 多条失败 path → 并集（仍只含 path 用过的 brief） */
export function briefKeysUsedByPaths(input: {
  docId: string
  paths: PathRecord[]
  prospects: ProspectRecord[]
  inferEdges: InferEdge[]
}): string[] {
  const used = new Set<string>()
  for (const path of input.paths) {
    for (const bk of briefKeysUsedByPath({ ...input, path })) {
      used.add(bk)
    }
  }
  return [...used]
}

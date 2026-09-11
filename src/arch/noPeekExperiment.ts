/**
 * 实验分支开关：删除 peek，prospect 父门 = bookKey（顶替 brief 索引位）。
 * main 无此文件语义；切回 main 即恢复 peek 架构。
 */

import type { BookIndex } from '../reasoning/pipelineA'
import { docHasAnyBrief, mapBriefToBook } from '../reasoning/masterTableMap'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import { orderedRetrievableBookKeys } from './seedRange'

/** 本分支恒为 true；勿拷到 main */
export const NO_PEEK_EXPERIMENT = true

/**
 * 端点 / 父键 → bookKey：
 * 1) 已是书序门牌
 * 2) 否则当 brief 去 map（兼容旧语料）
 */
export function resolveToBookKey(
  docId: string,
  bookIndex: BookIndex,
  key: string,
): string | null {
  const k = key.trim()
  if (!k) return null
  const ordered = orderedRetrievableBookKeys(bookIndex)
  if (ordered.includes(k)) return k
  return mapBriefToBook(docId, k)?.bookKey?.trim() || null
}

/** 该书是否已有任一 prospect（父门级记忆） */
export function docHasAnyProspect(_docId: string): boolean {
  return useAttentionIo.getState().prospects.length > 0
}

/**
 * 材料前置：无 prospect 且无 brief → 注入冷启骨架 bookKey（不调 peek LLM）。
 */
export function needsColdBookSkeleton(docId: string): boolean {
  if (docHasAnyProspect(docId)) return false
  return !docHasAnyBrief(docId)
}

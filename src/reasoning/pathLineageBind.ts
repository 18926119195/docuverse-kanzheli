/**
 * path 血缘绑定（写信台，非 LLM）：
 * prospect → brief → book 与 infer.bookKeys 有交集 ⇒ 同窝候选对。
 * LLM 只评「推理是否印证预测」，不发明无血缘配对。
 */

import type { InferEdge, ProspectRecord } from './attentionIoStore'
import { mapBriefToBook } from './masterTableMap'

export interface LineageDeskDelivery {
  job: string
  fromKeys: string[]
  toKey: string
}

export interface LineageBoundPair {
  inferKey: string
  prospectKey: string
  briefKey: string
  /** infer 与 prospect 谱系相交的 bookKeys */
  sharedBookKeys: string[]
  inferText: string
  prospectText: string
}

/**
 * briefKey → bookKey：
 * 1) 门表 mapBriefToBook
 * 2) 台递送边 peek：book ──► brief（门表丢了也能溯）
 */
export function resolveBriefBookKey(
  docId: string,
  briefKey: string,
  deskDeliveries?: LineageDeskDelivery[],
): string | null {
  const bk = briefKey.trim()
  if (!bk) return null
  const hit = mapBriefToBook(docId, bk)?.bookKey?.trim()
  if (hit) return hit

  if (!deskDeliveries?.length) return null
  for (let i = deskDeliveries.length - 1; i >= 0; i--) {
    const d = deskDeliveries[i]!
    if (d.toKey !== bk) continue
    if (d.job === 'peek' && d.fromKeys[0]) {
      return d.fromKeys[0]!.trim() || null
    }
  }
  return null
}

/** prospect.briefKey → bookKey（无表/无递送则 null） */
export function prospectBookKey(
  docId: string,
  prospect: Pick<ProspectRecord, 'briefKey'>,
  deskDeliveries?: LineageDeskDelivery[],
): string | null {
  return resolveBriefBookKey(docId, prospect.briefKey, deskDeliveries)
}

/**
 * 台侧圈窝：每个 infer × 同基因 prospect（book 交集非空）。
 * 不唯一化、不贪心删边——一窝可多对；信效度由后续 LLM/人手判定。
 */
export function bindInferProspectByBookLineage(input: {
  docId: string
  inferEdges: InferEdge[]
  prospects: ProspectRecord[]
  deskDeliveries?: LineageDeskDelivery[]
}): LineageBoundPair[] {
  const docId = input.docId.trim()
  const dels = input.deskDeliveries
  const out: LineageBoundPair[] = []
  const seen = new Set<string>()

  for (const edge of input.inferEdges) {
    const ik = edge.inferKey.trim()
    if (!ik) continue
    const books = new Set(
      edge.bookKeys.map((k) => k.trim()).filter(Boolean),
    )
    if (books.size === 0) continue
    const inferText = (edge.infer || edge.rationale || '').trim()

    for (const p of input.prospects) {
      const pk = p.prospectKey.trim()
      if (!pk) continue
      const book = prospectBookKey(docId, p, dels)
      if (!book || !books.has(book)) continue
      const id = `${ik}::${pk}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        inferKey: ik,
        prospectKey: pk,
        briefKey: p.briefKey,
        sharedBookKeys: [book],
        inferText,
        prospectText: p.text.trim(),
      })
    }
  }
  return out
}

/**
 * decide 充分 brief / 已落 prospect → infer 用的 bookKeys（严格血缘）。
 * 只认：prospect.briefKey ∈ mintableBriefKeys → resolveBriefBookKey。
 * 调用方须先筛本问族 prospect；禁止「全部 peek 门」宽兜底。
 */
export function bookKeysForInferFromDecideLineage(input: {
  docId: string
  mintableBriefKeys: string[]
  /** 已筛到本问族、且 brief 属于本轮 mintable 的 prospect */
  prospects: Array<Pick<ProspectRecord, 'prospectKey' | 'briefKey'>>
  deskDeliveries?: LineageDeskDelivery[]
}): {
  bookKeys: string[]
  pairs: Array<{
    prospectKey: string
    briefKey: string
    bookKey: string
  }>
  unmappedBriefKeys: string[]
  orphanProspectKeys: string[]
} {
  const docId = input.docId.trim()
  const mintable = new Set(
    input.mintableBriefKeys.map((k) => k.trim()).filter(Boolean),
  )
  const pairs: Array<{
    prospectKey: string
    briefKey: string
    bookKey: string
  }> = []
  const bookKeys: string[] = []
  const seenBook = new Set<string>()
  const mappedBrief = new Set<string>()
  const orphanProspectKeys: string[] = []

  for (const p of input.prospects) {
    const briefKey = p.briefKey.trim()
    if (!mintable.has(briefKey)) continue
    const bookKey = resolveBriefBookKey(
      docId,
      briefKey,
      input.deskDeliveries,
    )
    if (!bookKey) {
      orphanProspectKeys.push(p.prospectKey.trim())
      continue
    }
    mappedBrief.add(briefKey)
    pairs.push({
      prospectKey: p.prospectKey.trim(),
      briefKey,
      bookKey,
    })
    if (!seenBook.has(bookKey)) {
      seenBook.add(bookKey)
      bookKeys.push(bookKey)
    }
  }

  const unmappedBriefKeys = [...mintable].filter((b) => !mappedBrief.has(b))
  return { bookKeys, pairs, unmappedBriefKeys, orphanProspectKeys }
}

/** 用户 tick：默认以 ι 为底、prospect 修饰拼成归一化正文（用户也可自带整理文） */
export function composeNormTextFromPath(input: {
  inferText: string
  prospectText: string
}): string {
  const infer = input.inferText.trim()
  const prospect = input.prospectText.trim()
  if (infer && prospect) {
    return `${infer}\n\n〔预测补全〕${prospect}`
  }
  return infer || prospect
}

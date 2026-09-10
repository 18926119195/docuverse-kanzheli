/**
 * KeyDecisionState — door-level briefs (小抄) keyed by A1 bookKey.
 * Handbook: brief is task fill on the door; NOT written into BookIndex.
 *
 * briefKey = 写信台 peek 落账微动作铸键（方案 B）。
 * contentFingerprint = 正文副索引，不当门牌。
 */

import {
  contentFingerprint,
  newSettleActionId,
  mintInstanceKey,
} from './settleMint'

export type SuggestAction = 'open' | 'defer' | 'reuse' | 'need_more_peek'

export interface BriefVersion {
  brief: string
  suggestAction: SuggestAction
  /** 该版 brief 的实例门牌（settle） */
  briefKey: string
  /** 正文副索引 */
  contentFingerprint?: string
  actionId?: string
  settleActionId?: string
  taskId?: string
  at: number
  excerptPreviewHash?: string
}

export interface KeyDecisionEntry {
  key: string
  /** Hot tip for next open-door decision (rolled) */
  decisionBrief: string
  suggestAction: SuggestAction
  /** brief 实例门牌（方案 B settle） */
  briefKey: string
  /** 正文副索引（fp_*）；仅「像不像」，不当可调取门牌 */
  contentFingerprint: string
  settleActionId: string
  updatedAt: number
  lastActionId?: string
  lastTaskId?: string
  /** Append-only audit (not default WM input) */
  history: BriefVersion[]
}

export interface KeyDecisionStore {
  docId: string
  byKey: Record<string, KeyDecisionEntry>
  updatedAt: number
}

const storeByDoc = new Map<string, KeyDecisionStore>()

/**
 * @deprecated 名称易误解。现为正文副索引 fp_*。
 * 新代码请用 contentFingerprint；门牌请用 entry.briefKey。
 */
export function briefContentHash(
  brief: string,
  suggestAction: SuggestAction,
): string {
  return contentFingerprint(`${suggestAction}\0${brief.trim()}`)
}

export function emptyKeyDecisionStore(docId: string): KeyDecisionStore {
  return { docId, byKey: {}, updatedAt: Date.now() }
}

export function getKeyDecisionStore(docId: string): KeyDecisionStore {
  let s = storeByDoc.get(docId)
  if (!s) {
    s = emptyKeyDecisionStore(docId)
    storeByDoc.set(docId, s)
  }
  return s
}

export function saveKeyDecisionStore(store: KeyDecisionStore): void {
  store.updatedAt = Date.now()
  storeByDoc.set(store.docId, store)
}

export function getDoorEntry(
  docId: string,
  key: string,
): KeyDecisionEntry | null {
  return getKeyDecisionStore(docId).byKey[key] ?? null
}

/** Roll hot tip; append previous hot tip into history. 每次落账铸新 briefKey。 */
export function rollDoorBrief(input: {
  docId: string
  key: string
  decisionBrief: string
  suggestAction: SuggestAction
  actionId?: string
  taskId?: string
  excerptPreviewHash?: string
  maxHistory?: number
  /** 若调用方已有 settle，可传入；否则台内现铸 */
  settleActionId?: string
}): KeyDecisionEntry {
  const store = getKeyDecisionStore(input.docId)
  const prev = store.byKey[input.key]
  const settleActionId =
    input.settleActionId ||
    input.actionId ||
    newSettleActionId('peek')
  const briefKey = mintInstanceKey('brief', settleActionId)
  const fingerprint = contentFingerprint(
    `${input.suggestAction}\0${input.decisionBrief.trim()}`,
  )
  const now = Date.now()
  const history = [...(prev?.history ?? [])]
  if (prev && prev.decisionBrief.trim()) {
    history.push({
      brief: prev.decisionBrief,
      suggestAction: prev.suggestAction,
      briefKey: prev.briefKey,
      contentFingerprint: prev.contentFingerprint,
      actionId: prev.lastActionId,
      settleActionId: prev.settleActionId,
      taskId: prev.lastTaskId,
      at: prev.updatedAt,
    })
  }
  const maxH = input.maxHistory ?? 12
  const trimmed = history.slice(-maxH)
  const entry: KeyDecisionEntry = {
    key: input.key,
    decisionBrief: input.decisionBrief.trim(),
    suggestAction: input.suggestAction,
    briefKey,
    contentFingerprint: fingerprint,
    settleActionId,
    updatedAt: now,
    lastActionId: input.actionId ?? settleActionId,
    lastTaskId: input.taskId,
    history: trimmed,
  }
  store.byKey[input.key] = entry
  saveKeyDecisionStore(store)
  return entry
}

export function doorsForKeys(
  docId: string,
  keys: ReadonlyArray<string>,
): KeyDecisionEntry[] {
  const store = getKeyDecisionStore(docId)
  return keys
    .map((k) => store.byKey[k])
    .filter((e): e is KeyDecisionEntry => Boolean(e))
}

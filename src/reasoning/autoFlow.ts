/**
 * 自动流（两层勿混）：
 * 0) 材料前置：无 brief → 冷启 peek（书窗骨架，类 embedding）
 * 1) 问线：有历史 queryKey → 阶段A+reuse；否则/失败 → 新铸 decide/infer…
 * decide：三态驱动；不充分且无充分→热启 peek（补中间 70%）。
 * 整窗 coverage 已废，不作调度闸。
 */

import type { BookIndex } from './pipelineA'
import { askDeepSeekWithA1, askDeepSeekWithLetterDesk } from './a1DsChat'
import { newLlmCallId } from './settleMint'
import { atomSearchText } from './hybridRetrieve'
import { useAttentionIo, type LetterDeskPackage } from './attentionIoStore'
import { mapBriefToBook, listAllSettledBriefs } from './masterTableMap'
import {
  bookKeysForInferFromDecideLineage,
} from './pathLineageBind'
import { expandIncrementSlots, statusAllowsMint } from './settleMint'
import {
  extractJsonObject,
  parseQueryNeighbours,
  salvageProspectObjectsByRegex,
} from './inferPath'
import {
  needsColdPeekPrecondition,
  resolveAskLineBranch,
  listHistoricQueryEntriesForNeighbour,
} from './deskEntryGate'
import { selectColdPeekSkeletonKeys } from '../arch/coldPeekSkeleton'
import {
  expandClosedSeedRangesToBookKeys,
  fallbackSeedRange,
  closeSeedRangeDrafts,
  parseSeedRangeDraft,
  type SeedRange,
  type SeedRangeDraft,
} from './seedRange'
import {
  mergeHotPeekCandidates,
  stashHungerForIngest,
  hungerStillOpen,
} from './ingestLlmFeed'
import { chunkUniqueKeys, runBatchesParallel } from '../arch/parallelLlmBatch'
import { deskMonitorAttentionArrival } from './attentionArrival'
import {
  formatDirectedPathIncrementReturn,
  hopsFromAnswerParts,
} from './pathIncrementReturn'
import {
  normalizeIncrementStatus,
  type IncrementReadStatus,
} from './keyIncrementStatus'

const MAX_HOT_PEEK = 2
const MAX_DECIDE_ROUNDS = 6
/** 单次 decide 窗 brief 上限：过大易撞 max_tokens 截断 JSON */
const DECIDE_BATCH = 6
/** decide 真并行并发路上限 */
const DECIDE_CONCURRENCY = 3

function sid(): string {
  return `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** @deprecated 整窗 coverage 已废；仅兼容旧 JSON，勿作调度闸 */
export function normalizeDecideCoverage(raw: string): string {
  const s = raw.trim()
  const lower = s.toLowerCase()
  if (
    lower === 'enough' ||
    lower === 'partial' ||
    lower === 'insufficient'
  ) {
    return lower
  }
  if (
    /足以|足够|够了|可以回应|已覆盖|材料够|够用|commit|enough/.test(s) ||
    /足以回应|多角度.*够|核心.*覆盖/.test(s)
  ) {
    return 'enough'
  }
  if (/peek|扩搜|还要贴|缺材料|不够看/.test(s)) {
    return 'insufficient'
  }
  if (/部分|未全|还要滚|续滚|partial|继续看/.test(s)) {
    return 'partial'
  }
  return lower.slice(0, 48) || 'unknown'
}

export function parseDecideOutcome(llmText: string): {
  briefKeys: string[]
  keeps: Array<{
    briefKey: string
    prospect: string
    status: IncrementReadStatus | null
  }>
  lastBriefKey: string | null
  /** @deprecated 勿作闸；仅日志 */
  coverage: string | null
  stopReason: string | null
  /** 早写草案（可半开）；热启前须经台闭集化 */
  seedRangeDraft: SeedRangeDraft | null
  /** @deprecated 仅当草案为闭集时填充；热启请走闭集化 */
  seedRange: SeedRange | null
  ok: boolean
  note: string
} {
  let obj = extractJsonObject(llmText)
  // 再降一档：整段 JSON 废了也用正则捞已写完的 prospect 行
  if (!obj || typeof obj !== 'object') {
    const loose = salvageProspectObjectsByRegex(llmText)
    if (loose.length === 0) {
      return {
        briefKeys: [],
        keeps: [],
        lastBriefKey: null,
        coverage: null,
        stopReason: null,
        seedRangeDraft: null,
        seedRange: null,
        ok: false,
        note: 'decide 硬闸：无法解析 JSON',
      }
    }
    obj = { prospects: loose }
  }
  const root = obj as Record<string, unknown>
  const lastBriefKey = String(root.lastBriefKey ?? '').trim() || null
  const coverageRaw = String(root.coverage ?? '').trim()
  const coverage = coverageRaw ? normalizeDecideCoverage(coverageRaw) : null
  const stopReason = String(root.stopReason ?? '').trim() || null
  const seedRangeDraft = parseSeedRangeDraft(root.seedRange)
  const seedRange =
    seedRangeDraft?.kind === 'closed'
      ? { from: seedRangeDraft.from, to: seedRangeDraft.to }
      : null

  const briefKeys: string[] = []
  const keeps: Array<{
    briefKey: string
    prospect: string
    status: IncrementReadStatus | null
  }> = []

  const pushKeep = (
    briefKey: string,
    prospect: string,
    status: IncrementReadStatus | null,
  ) => {
    const bk = briefKey.trim()
    const text = prospect.trim()
    if (!bk) return
    briefKeys.push(bk)
    if (!text) return
    keeps.push({ briefKey: bk, prospect: text, status })
  }

  const ingestDecideRow = (r: Record<string, unknown>) => {
    // 实验：bookKey 优先；briefKey 字段亦可回传同一门牌
    const bk = String(r.bookKey ?? r.briefKey ?? r.key ?? '').trim()
    if (!bk) return
    const rowStatus = normalizeIncrementStatus(r.status ?? r.readStatus)
    const slots = expandIncrementSlots(r.prospect, r.prospects)
    if (slots.length === 0) {
      briefKeys.push(bk)
      return
    }
    for (const slot of slots) {
      const slotStatus =
        normalizeIncrementStatus(slot.statusRaw) ?? rowStatus
      pushKeep(bk, slot.text, slotStatus)
    }
  }

  // 主协议 prospects[]（keep[] 已废除）
  if (Array.isArray(root.prospects)) {
    for (const row of root.prospects) {
      if (!row || typeof row !== 'object') continue
      ingestDecideRow(row as Record<string, unknown>)
    }
  }

  // 结构化抠完仍空 → 正则补漏（字段乱序 / 半截 JSON）
  if (keeps.length === 0 && briefKeys.length === 0) {
    for (const row of salvageProspectObjectsByRegex(llmText)) {
      ingestDecideRow(row)
    }
  }

  const mintable = keeps.filter((k) => statusAllowsMint(k.status))
  const hasAny =
    mintable.length > 0 ||
    briefKeys.length > 0 ||
    keeps.length > 0 ||
    Array.isArray(root.keyStatuses) ||
    Array.isArray(root.keyStatus) ||
    Array.isArray(root.statuses)

  if (!hasAny) {
    return {
      briefKeys: [],
      keeps: [],
      lastBriefKey,
      coverage,
      stopReason,
      seedRangeDraft,
      seedRange,
      ok: false,
      note: 'decide 硬闸：无 prospects/keyStatuses',
    }
  }

  return {
    briefKeys: [...new Set(briefKeys)],
    keeps,
    lastBriefKey,
    coverage,
    stopReason,
    seedRangeDraft,
    seedRange,
    ok: true,
    note:
      `decide · 三态驱动` +
      (coverage ? ` · (旧coverage=${coverage}忽略调度)` : '') +
      (stopReason ? ` · stop=${stopReason}` : '') +
      (seedRangeDraft
        ? ` · seedDraft=${seedRangeDraft.kind}`
        : '') +
      ` · prospect槽×${keeps.length} · 可铸×${mintable.length}`,
  }
}

/** @deprecated 用 parseDecideOutcome */
export function parseDecideKeepBriefKeys(llmText: string): string[] {
  return parseDecideOutcome(llmText).briefKeys
}

async function runStageA(input: {
  question: string
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
}): Promise<{
  neighbours: Array<{ queryKey: string; degree: string }>
  raw: string
  note: string
}> {
  const turnQk =
    useAttentionIo.getState().findQueryKeyForQuestion(input.question) ||
    useAttentionIo.getState().ensureQueryKey(input.question)
  const entries = listHistoricQueryEntriesForNeighbour(turnQk)
  if (entries.length === 0) {
    return { neighbours: [], raw: '', note: '阶段A跳过·无历史 queryKey（已排除 Q_now）' }
  }
  const pkg: LetterDeskPackage = {
    id: sid(),
    edgeId: `stageA_${sid()}`,
    bookKey: '',
    briefKey: '',
    question: input.question,
    job: 'query',
    versionIndex: 0,
    createdAt: Date.now(),
  }
  const res = await askDeepSeekWithLetterDesk({
    question: input.question,
    packages: [pkg],
    bookIndex: input.bookIndex,
    docId: input.bookIndex.docId,
    onProgress: input.onProgress,
  })
  let neighbours = parseQueryNeighbours(res.answer)
  // 禁止「解析空 → 全历史当 neighbour」：那会把 brief 队列打成整表
  if (neighbours.length === 0) {
    return {
      neighbours: [],
      raw: res.answer,
      note:
        (res.note || '阶段A') +
        ' · neighbour 解析空（不兜底全历史）',
    }
  }
  return {
    neighbours,
    raw: res.answer,
    note: res.note || `阶段A · neighbour×${neighbours.length}`,
  }
}

/** 按有 neighbour 的 historic queryKey 展 brief；其余 settled 仅作有限补齐 */
const DECIDE_BRIEF_CAP = 24

function briefQueueAfterStageA(
  docId: string,
  neighbourQueryKeys: string[],
): string[] {
  const heads = listAllSettledBriefs(docId)
  const settled = useAttentionIo.getState().settledQueries
  const qkBriefs = useAttentionIo.getState().queryKeyToBriefKeys
  const qBriefs = useAttentionIo.getState().questionToBriefKeys
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const qk of neighbourQueryKeys) {
    for (const bk of qkBriefs[qk] ?? []) {
      if (seen.has(bk)) continue
      seen.add(bk)
      ordered.push(bk)
    }
    const qText = settled[qk]
    if (qText) {
      for (const bk of qBriefs[qText] ?? []) {
        if (seen.has(bk)) continue
        seen.add(bk)
        ordered.push(bk)
      }
    }
  }
  // 仅当 neighbour 侧 brief 不足时，少量补其它 settled（禁止整表灌 decide）
  if (ordered.length < DECIDE_BRIEF_CAP) {
    for (const h of heads) {
      if (ordered.length >= DECIDE_BRIEF_CAP) break
      if (seen.has(h.briefKey)) continue
      seen.add(h.briefKey)
      ordered.push(h.briefKey)
    }
  }
  return ordered.slice(0, DECIDE_BRIEF_CAP)
}

function attachBriefsToQuestion(
  q: string,
  briefKeys: string[],
  queryKey?: string,
) {
  useAttentionIo.setState((s) => {
    const questionToBriefKeys = {
      ...s.questionToBriefKeys,
      [q]: [...new Set([...(s.questionToBriefKeys[q] ?? []), ...briefKeys])],
    }
    const queryKeyToBriefKeys = { ...s.queryKeyToBriefKeys }
    if (queryKey?.trim()) {
      const qk = queryKey.trim()
      queryKeyToBriefKeys[qk] = [
        ...new Set([...(queryKeyToBriefKeys[qk] ?? []), ...briefKeys]),
      ]
    }
    return { questionToBriefKeys, queryKeyToBriefKeys }
  })
}

/** 三态调度：充分可往下；未读续滚；仅不充分→热启 peek（三态按本问族） */
function decideRoundAction(input: {
  scope: string[]
  stopReason: string | null
  mintableCount: number
  queryKey: string
}): 'done' | 'continue_unread' | 'hot_peek' | 'pause' {
  const st = useAttentionIo.getState()
  const scopeSet = new Set(input.scope)
  const qScope = { queryKey: input.queryKey }
  const unread = st
    .listKeysUnread('decide', qScope)
    .filter((k) => scopeSet.has(k))
  const weak = st
    .listKeysNeedingMore('decide', qScope)
    .filter((k) => scopeSet.has(k))

  if (input.mintableCount > 0) return 'done'
  if (unread.length > 0) return 'continue_unread'
  if (input.stopReason === 'peek' || weak.length > 0) return 'hot_peek'
  return 'pause'
}

/** 单问安全阀 / 暂停 → 写信台提示（不进注意力窗） */
function deskPromptSafety(msg: string) {
  useAttentionIo.getState().setDeskPrompt(msg)
  useAttentionIo.getState().setLastStatus(msg)
}

export async function runAutoFlow(input: {
  question: string
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
  sealItems: (items: Array<{
    key: string
    brief: string
    briefKey: string
    bookText?: string
  }>) => Array<{
    key: string
    brief: string
    briefKey: string
    bookText?: string
    bondId: string
  }>
  /**
   * 监督预测轨续跑：禁止采纳这些坏 path。
   * 其它 neighbour 线上 path 仍可 reuse（禁死路 ≠ 禁一切历史）。
   */
  excludePathKeys?: string[]
  /** @deprecated 用 excludePathKeys；true 时等价于不跑 reuse（过刚，仅兼容） */
  skipReuse?: boolean
  /** 写入 decide 窗的监督尸检策略（预测轨） */
  decideCritiqueHint?: string
  /** 进入 decide 前剔除的死路 brief */
  excludeBriefKeys?: string[]
}): Promise<{ ok: boolean; answer: string; note: string }> {
  const q = input.question.trim()
  if (!q) {
    return { ok: false, answer: '', note: '自动流需要问句' }
  }

  const parts: string[] = []
  const notes: string[] = []
  const docId = input.bookIndex.docId
  // 本轮唯一 queryKey（方案 B settle）；贯穿 decide/prospect/infer/path/reuse
  const turnQueryKey = useAttentionIo.getState().ensureQueryKey(q)
  if (input.skipReuse) notes.push('skipReuse')
  if (input.excludePathKeys?.length) {
    notes.push(`excludePath×${input.excludePathKeys.length}`)
  }
  if (input.decideCritiqueHint?.trim()) notes.push('decideCritiqueHint')

  // —— 层 0：材料前置（实验：无 peek LLM，骨架 bookKey 直入 decide 队列）——
  let sealedBriefKeys: string[] = []
  let sealedItems: Array<{
    key: string
    brief: string
    briefKey: string
    bondId?: string
  }> = []
  let stepId = ''

  if (needsColdPeekPrecondition(docId)) {
    input.onProgress?.(
      '自动流 · 材料前置 · 冷启骨架 bookKey（实验·无 peek）…',
    )
    notes.push(`材料前置·冷启骨架·qk=${turnQueryKey}`)
    let semantic: import('./semanticIndex').BookSemanticIndex | null = null
    try {
      const { useIndexGate } = await import('./indexGate')
      semantic = useIndexGate.getState().semanticIndex ?? null
    } catch {
      /* optional */
    }
    const skeleton = selectColdPeekSkeletonKeys({
      bookIndex: input.bookIndex,
      semantic,
    })
    const ordered =
      skeleton.length > 0
        ? skeleton
        : input.bookIndex.chunks.map((c) => c.key).filter(Boolean)
    if (ordered.length === 0) {
      return {
        ok: false,
        answer: '',
        note: '冷启骨架空：A1 无 bookKey，自动流中止',
      }
    }
    // sealedBriefKeys 在本分支语义 = decide 父门 bookKey 队列
    sealedBriefKeys = ordered.slice(0, DECIDE_BRIEF_CAP)
    sealedItems = sealedBriefKeys.map((bk) => ({
      key: bk,
      brief: '',
      briefKey: bk,
    }))
    attachBriefsToQuestion(q, sealedBriefKeys, turnQueryKey)
    parts.push(
      `### 自动流 · 材料前置 · 冷启骨架（无 peek）\nbookKey×${sealedBriefKeys.length}` +
        (skeleton.length ? ' · TOC/书序头尾' : ' · 整表截帽'),
    )
    notes.push(`冷启骨架 book×${sealedBriefKeys.length}`)
  }

  // —— 层 1：问线分叉（历史 queryKey → 复用前置；否则新铸）——
  // 必须排除本轮刚 ensure 的 qk；勿用「账上有任意 qk」误判有历史
  const askBranch = resolveAskLineBranch(turnQueryKey)
  notes.push(`问线·${askBranch.kind}·qk=${turnQueryKey}`)

  if (askBranch.kind === 'try_reuse') {
    input.onProgress?.('自动流 · 问线复用前置（历史 queryKey → neighbour→norm）…')
    const a = await runStageA({
      question: q,
      bookIndex: input.bookIndex,
      onProgress: input.onProgress,
    })
    parts.push(
      `### 自动流 · 阶段 A\nneighbours=${a.neighbours.map((n) => `${n.queryKey}(${n.degree || '·'})`).join(', ') || '∅'}`,
    )
    notes.push(a.note)
    {
      const { ingestKeyIncrementStatuses } = await import('./attentionArrival')
      const historic = listHistoricQueryEntriesForNeighbour(turnQueryKey).map(
        (e) => e.queryKey,
      )
      ingestKeyIncrementStatuses({
        job: 'query',
        llmText: a.raw,
        windowKeys: historic,
        queryKey: turnQueryKey,
      })
    }
    notes.push(`neighbour×${a.neighbours.length}`)
    sealedBriefKeys = briefQueueAfterStageA(
      docId,
      a.neighbours.map((n) => n.queryKey),
    )
    if (sealedBriefKeys.length === 0) {
      sealedBriefKeys = [
        ...new Set([
          ...(useAttentionIo.getState().queryKeyToBriefKeys[turnQueryKey] ??
            []),
          ...(useAttentionIo.getState().questionToBriefKeys[q] ?? []),
          ...listAllSettledBriefs(docId).map((h) => h.briefKey),
        ]),
      ].slice(0, DECIDE_BRIEF_CAP)
    }

    if (input.skipReuse) {
      notes.push('复用跳过·兼容 skipReuse')
      parts.push('### 自动流 · 跳过 reuse（兼容）')
    } else {
      input.onProgress?.('自动流 · 先 reuse（neighbour→path→norm）…')
      const { runReuseGate } = await import('./letterDeskDispatch')
      const gate = await runReuseGate({
        qNow: q,
        docId,
        queryKey: turnQueryKey,
        excludePathKeys: input.excludePathKeys,
        onProgress: input.onProgress,
      })
      notes.push(gate.note)
      parts.push(
        gate.awaitingApproval
          ? `### 自动流 · 复用提案挂起 ×${gate.normKeys?.length ?? 1}\nnorms=${(gate.normKeys ?? []).join(', ') || '·'} · 待批准`
          : gate.adopted
            ? `### 自动流 · 复用采纳 ×${gate.pathKeys?.length ?? 1}\nnorms=${(gate.normKeys ?? []).join(', ') || '·'} · paths=${(gate.pathKeys ?? [gate.pathKey]).join(', ')}`
            : `### 自动流 · 复用未采纳 → 落入新铸\n${gate.note}`,
      )
      if (gate.awaitingApproval) {
        useAttentionIo.getState().setDeskPrompt(
          `写信台 · 复用提案：批准铸 reuse→norm，或撤销后落入新铸。qk=${gate.queryKey ?? turnQueryKey}`,
        )
        notes.push('等待用户批准复用')
        return {
          ok: true,
          answer:
            parts.join('\n\n') +
            `\n\n### 等待复用批准\n` +
            `queryKey=\`${gate.queryKey ?? turnQueryKey}\`\n` +
            `normKeys: ${(gate.normKeys ?? []).map((k) => `\`${k}\``).join(', ')}\n` +
            `pathKeys: ${(gate.pathKeys ?? []).map((k) => `\`${k}\``).join(', ')}\n` +
            `请在结算面板批准 / 撤销。`,
          note: `自动流 · ${notes.join(' → ')}`,
        }
      }
      if (gate.adopted) {
        const pathReturn = formatDirectedPathIncrementReturn({
          question: q,
          hopOutputs: hopsFromAnswerParts(parts),
          mode: 'reuse',
          queryKey: turnQueryKey,
        })
        useAttentionIo.getState().setLastStatus(`自动流 · 复用完成 · ${notes.join(' → ')}`)
        useAttentionIo.getState().clearDeskPrompt()
        return {
          ok: true,
          answer: pathReturn,
          note: `自动流 · ${notes.join(' → ')}`,
        }
      }
      const st = useAttentionIo.getState()
      // 只剔：本闸失败 path 用过的 brief ∪ 本问族 decide insufficient（禁止全局旧问三态）
      const excludeBriefs = new Set<string>(gate.excludeBriefKeys ?? [])
      const qScope = { queryKey: turnQueryKey }
      for (const k of st.listKeysNeedingMore('decide', qScope)) {
        excludeBriefs.add(k)
      }
      if (excludeBriefs.size > 0) {
        sealedBriefKeys = sealedBriefKeys.filter((b) => !excludeBriefs.has(b))
        const unread = st
          .listKeysUnread('decide', qScope)
          .filter((k) => !excludeBriefs.has(k))
        sealedBriefKeys = [...new Set([...sealedBriefKeys, ...unread])]
        notes.push(
          `精细剔除 path/本问不足 brief×${excludeBriefs.size} · 余 ${sealedBriefKeys.length}（同门其余保留）`,
        )
        parts.push(
          `### 自动流 · 复用失败后精细剔除\n本闸 path brief ∪ 本问族 insufficient×${excludeBriefs.size} · 余 ${sealedBriefKeys.length}`,
        )
      }
    }
  } else {
    // mint：无历史问线，不跑阶段 A / reuse
    input.onProgress?.('自动流 · 问线新铸（无历史 queryKey，跳过 reuse）…')
    if (sealedBriefKeys.length === 0) {
      sealedBriefKeys = listAllSettledBriefs(docId)
        .map((h) => h.briefKey)
        .slice(0, DECIDE_BRIEF_CAP)
    }
    notes.push(`新铸 · brief×${sealedBriefKeys.length}（cap ${DECIDE_BRIEF_CAP}）`)
    parts.push(`### 自动流 · 问线新铸\nbrief×${sealedBriefKeys.length} · 无复用前置`)
  }

  if (sealedBriefKeys.length === 0) {
    return {
      ok: false,
      answer: parts.join('\n\n'),
      note: `自动流中止 · 无 brief 可 decide · ${notes.join(' → ')}`,
    }
  }

  // 统一硬帽：并行 peek / 历史 brief 都不得把 decide 窗打成整表
  if (sealedBriefKeys.length > DECIDE_BRIEF_CAP) {
    sealedBriefKeys = sealedBriefKeys.slice(0, DECIDE_BRIEF_CAP)
    notes.push(`decide brief 帽×${DECIDE_BRIEF_CAP}`)
  }

  // 监督预测轨：先剔死路 brief（在 attach 之前）
  if (input.excludeBriefKeys && input.excludeBriefKeys.length > 0) {
    const drop = new Set(input.excludeBriefKeys)
    const before = sealedBriefKeys.length
    sealedBriefKeys = sealedBriefKeys.filter((b) => !drop.has(b))
    notes.push(`监督剔 brief×${drop.size} · ${before}→${sealedBriefKeys.length}`)
    parts.push(
      `### 自动流 · 监督剔除死路 brief\n剔×${drop.size} · 余 ${sealedBriefKeys.length}`,
    )
    if (sealedBriefKeys.length === 0) {
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · 监督剔除后无 brief · ${notes.join(' → ')}`,
      }
    }
  }

  attachBriefsToQuestion(q, sealedBriefKeys, turnQueryKey)

  // 深化子问：父链已有 prospect、本问尚无 → 跳过 decide，材料继承后直开 infer
  const stLine = useAttentionIo.getState()
  const parentQk = stLine.getQueryParent(turnQueryKey)
  const familyQks = new Set(stLine.listQuerySelfAndAncestors(turnQueryKey))
  const parentProspects = stLine.prospects.filter((p) => familyQks.has(p.queryKey))
  const ownProspects = stLine.prospects.filter((p) => p.queryKey === turnQueryKey)
  const deepenSkipDecide =
    Boolean(parentQk) && parentProspects.length > 0 && ownProspects.length === 0

  if (deepenSkipDecide) {
    notes.push(
      `深化·跳过decide · parent=${parentQk} · 继承prospect×${parentProspects.length}`,
    )
    parts.push(
      `### 自动流 · 深化继承\n跳过 decide；沿用父链 prospect×${parentProspects.length}；infer 用深化 Q 控方向`,
    )
    // 递送用父链充分 brief（已在 sealedBriefKeys / 继承）
    const briefKeys = [
      ...new Set(
        parentProspects
          .map((p) => p.briefKey)
          .filter(Boolean),
      ),
    ]
    if (briefKeys.length === 0) {
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · 深化无父 prospect brief · ${notes.join(' → ')}`,
      }
    }
    sealedBriefKeys = [...new Set([...sealedBriefKeys, ...briefKeys])]

    input.onProgress?.('自动流 · 深化 · 直开 infer…')
    const deepenLineage = bookKeysForInferFromDecideLineage({
      docId,
      mintableBriefKeys: briefKeys,
      prospects: parentProspects,
      deskDeliveries: useAttentionIo.getState().deskDeliveries,
    })
    const bookKeys = deepenLineage.bookKeys
    notes.push(
      `深化血缘 book×${bookKeys.length}` +
        (deepenLineage.unmappedBriefKeys.length
          ? ` · 未映brief×${deepenLineage.unmappedBriefKeys.length}`
          : '') +
        (deepenLineage.orphanProspectKeys.length
          ? ` · 无book prospect×${deepenLineage.orphanProspectKeys.length}`
          : ''),
    )
    if (bookKeys.length === 0) {
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · 深化 prospect→brief→book 血缘无解 · ${notes.join(' → ')}`,
      }
    }
    const mainPkg: LetterDeskPackage = {
      id: sid(),
      edgeId: `${stepId || 'infer_deepen'}_${bookKeys[0]}`,
      bookKey: bookKeys[0]!,
      briefKey: deepenLineage.pairs[0]?.briefKey || briefKeys[0] || '',
      question: q,
      job: 'infer',
      versionIndex: 0,
      createdAt: Date.now(),
      onlyBookKeys: bookKeys,
    }
    const mainRes = await askDeepSeekWithLetterDesk({
      question: q,
      packages: [mainPkg],
      bookIndex: input.bookIndex,
      docId,
      onProgress: input.onProgress,
      turnQueryKey,
    })
    parts.push(mainRes.answer || '### infer · （空）')
    notes.push(mainRes.note)
    const mainFailed =
      !mainRes.ok ||
      /空内容|失败|HTTP|无 choices|请求失败/.test(mainRes.note)
    if (mainFailed) {
      deskPromptSafety(
        `写信台 · 深化 infer 未写出（${mainRes.note}）。可钉窗重跑或改深化问法。`,
      )
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流 · 深化 infer 失败 · ${notes.join(' → ')}`,
      }
    }
    deskMonitorAttentionArrival({
      job: 'infer',
      llmText: mainRes.answer,
      windowKeys: bookKeys,
      queryKey: turnQueryKey,
    })
    const pending = useAttentionIo.getState().pendingPathMatch
    const userPaths = useAttentionIo
      .getState()
      .listPathsForQueryKey(turnQueryKey)
      .filter((p) => p.matchMode === 'user')
    if (userPaths.length === 0 && pending) {
      useAttentionIo.getState().setDeskPrompt(
        `写信台 · 深化后 path：候选 pathKey×${pending.pathKeys?.length ?? 0}；或「跳过匹配」→监督铸 norm：` +
          ` qk=${pending.queryKey}`,
      )
      notes.push('等待 path 确认/监督（深化）')
      return {
        ok: true,
        answer:
          parts.join('\n\n') +
          `\n\n### 等待 path（深化 · 已铸候选 pathKey）\n` +
          `queryKey=\`${pending.queryKey}\`\n` +
          `pathKeys×${pending.pathKeys?.length ?? 0}:\n` +
          (pending.boundPairs ?? [])
            .map(
              (p) =>
                `- path=\`${p.pathKey}\` · ι=\`${p.inferKey}\` × prospect=\`${p.prospectKey}\` · book=${p.sharedBookKeys.join(',')}`,
            )
            .join('\n'),
        note: `自动流 · ${notes.join(' → ')}`,
      }
    }
    const pathReturn = formatDirectedPathIncrementReturn({
      question: q,
      hopOutputs: hopsFromAnswerParts(parts),
      mode: 'auto',
      queryKey: turnQueryKey,
    })
    useAttentionIo
      .getState()
      .setLastStatus(`自动流完成 · ${notes.join(' → ')}`)
    useAttentionIo.getState().clearDeskPrompt()
    return {
      ok: true,
      answer: pathReturn,
      note: `自动流 · ${notes.join(' → ')}`,
    }
  }

  // 三态：decide 优先本问族 sufficient ∪ unread；无本问状态则全量本问队列
  {
    const st = useAttentionIo.getState()
    const qScope = { queryKey: turnQueryKey }
    const ready = new Set(st.listKeysReadyToDeliver('decide', qScope))
    const unread = new Set(st.listKeysUnread('decide', qScope))
    if (ready.size > 0 || unread.size > 0) {
      const filtered = sealedBriefKeys.filter(
        (k) => ready.has(k) || unread.has(k),
      )
      if (filtered.length > 0) {
        sealedBriefKeys = filtered
        notes.push(`本问三态过滤 brief×${sealedBriefKeys.length}`)
      }
    }
  }

  let decideOut: ReturnType<typeof parseDecideOutcome> | null = null
  let decideScope: string[] | undefined
  let hotPeekCount = 0
  /** 跨轮早写草案；热启前统一闭集化 */
  const allSeedDrafts: SeedRangeDraft[] = []
  /** 本轮 decide 晚执行闭集（供热启；半开未配不上的不进） */
  let lastClosedForPeek: SeedRange[] = []
  /** 本问已落账的 prospect 累计（分批 decide 合并） */
  const allMintableKeeps: Array<{
    briefKey: string
    prospect: string
    status: IncrementReadStatus | null
  }> = []

  for (let round = 0; round < MAX_DECIDE_ROUNDS; round++) {
    const scope =
      decideScope && decideScope.length > 0 ? decideScope : sealedBriefKeys
    if (scope.length === 0) break

    // 分批真并行：key 去重；有可铸 prospect 即可进 infer → abort 其余批
    const batches = chunkUniqueKeys(scope, DECIDE_BATCH)

    let roundOk = false
    let lastStop: string | null = null
    const roundSeedDrafts: SeedRangeDraft[] = []
    const roundNotes: string[] = []

    type DecideBatchOutcome = {
      bi: number
      batch: string[]
      decideRes: { ok: boolean; answer: string; note: string }
      effective: ReturnType<typeof parseDecideOutcome>
      mintable: Array<{
        briefKey: string
        prospect: string
        status: IncrementReadStatus | null
      }>
    }

    input.onProgress?.(
      `自动流 · decide${round > 0 ? ` · 第${round + 1}轮` : ''}` +
        (batches.length > 1
          ? ` · 真并行 ${batches.length} 批×≤${DECIDE_BATCH} · 并发≤${DECIDE_CONCURRENCY}…`
          : '…'),
    )

    const parallel = await runBatchesParallel({
      batches,
      concurrency: DECIDE_CONCURRENCY,
      run: async (batch, bi, signal): Promise<DecideBatchOutcome> => {
        const firstBrief = batch[0]!
        const firstBook =
          mapBriefToBook(docId, firstBrief)?.bookKey ||
          sealedItems.find((s) => s.briefKey === firstBrief)?.key ||
          ''
        input.onProgress?.(
          `自动流 · decide · 批${bi + 1}/${batches.length} 跑…`,
        )
        const decidePkg: LetterDeskPackage = {
          id: sid(),
          edgeId: `${stepId || 'decide'}_${firstBrief}_b${bi}`,
          bookKey: firstBook,
          briefKey: firstBrief,
          question: q,
          job: 'decide',
          versionIndex: 0,
          createdAt: Date.now(),
          onlyBriefKeys: batch,
          decideCritiqueHint: input.decideCritiqueHint,
        }
        const decideRes = await askDeepSeekWithLetterDesk({
          question: q,
          packages: [decidePkg],
          bookIndex: input.bookIndex,
          docId,
          onProgress: input.onProgress,
          turnQueryKey,
          signal,
        })

        const batchOut = parseDecideOutcome(decideRes.answer)
        let effective = batchOut
        if (!batchOut.ok || batchOut.keeps.length === 0) {
          const fromStore = useAttentionIo
            .getState()
            .prospects.filter(
              (p) =>
                p.queryKey === turnQueryKey && batch.includes(p.briefKey),
            )
            .map((p) => ({
              briefKey: p.briefKey,
              prospect: p.text,
              status: 'sufficient' as IncrementReadStatus,
            }))
          if (fromStore.length > 0) {
            effective = {
              ...batchOut,
              ok: true,
              keeps: fromStore,
              briefKeys: fromStore.map((k) => k.briefKey),
              note: `${batchOut.note} · store补×${fromStore.length}`,
            }
          }
        }
        const mintable = effective.keeps.filter((k) =>
          statusAllowsMint(k.status),
        )
        return { bi, batch, decideRes, effective, mintable }
      },
      shouldStop: (outcome) => outcome.mintable.length > 0,
    })

    const outcomes = parallel.results
      .filter(
        (
          r,
        ): r is {
          index: number
          ok: true
          value: DecideBatchOutcome
        } => Boolean(r && r.ok),
      )
      .map((r) => r.value)
      .sort((a, b) => a.bi - b.bi)

    const seenBrief = new Set(allMintableKeeps.map((k) => k.briefKey))
    for (const o of outcomes) {
      parts.push(o.decideRes.answer || '### decide · （空）')
      roundNotes.push(o.decideRes.note)
      if (o.effective.ok || o.effective.keeps.length > 0) {
        roundOk = true
        for (const m of o.mintable) {
          if (seenBrief.has(m.briefKey)) continue
          seenBrief.add(m.briefKey)
          allMintableKeeps.push(m)
        }
        if (o.effective.stopReason) lastStop = o.effective.stopReason
        if (o.effective.seedRangeDraft) {
          roundSeedDrafts.push(o.effective.seedRangeDraft)
          allSeedDrafts.push(o.effective.seedRangeDraft)
        }
        roundNotes.push(
          o.effective.ok
            ? o.effective.note
            : `decide · 残缺抢救 · prospect槽×${o.effective.keeps.length}`,
        )
      } else {
        roundNotes.push(o.effective.note)
      }
      deskMonitorAttentionArrival({
        job: 'decide',
        llmText: o.decideRes.answer,
        windowKeys: o.batch,
        queryKey: turnQueryKey,
      })
    }
    for (const r of parallel.results) {
      if (r && !r.ok) {
        roundNotes.push(
          r.aborted
            ? `decide · 批${r.index + 1} 早停取消`
            : `decide · 批${r.index + 1} 失败：${r.note}`,
        )
      }
    }
    if (parallel.stoppedEarly) {
      roundNotes.push(parallel.note)
    }

    // 晚执行：并行草案闭集化（锚点须本问族已读）；未配上的半开不进 peek
    const stDecide = useAttentionIo.getState()
    const qScope = { queryKey: turnQueryKey }
    const unreadSet = new Set(stDecide.listKeysUnread('decide', qScope))
    const isBriefRead = (briefKey: string) => {
      const k = briefKey.trim()
      if (!k) return false
      if (unreadSet.has(k)) return false
      const rows = stDecide.listKeyStatuses({
        job: 'decide',
        queryKey: turnQueryKey,
      })
      const hit = rows.find((r) => r.key === k)
      // 有态且非 unread = 已读；无态不认（严）
      return Boolean(hit && hit.status !== 'unread')
    }
    const closedPack = closeSeedRangeDrafts({
      docId,
      bookIndex: input.bookIndex,
      drafts: allSeedDrafts,
      isBriefRead,
    })
    lastClosedForPeek = closedPack.closed
    if (allSeedDrafts.length > 0) {
      notes.push(closedPack.note)
      parts.push(`### 自动流 · seedRange 闭集化\n${closedPack.note}`)
    }
    const mergedClosed = closedPack.closed[0] ?? null

    notes.push(...roundNotes)
    decideOut = {
      briefKeys: [...new Set(allMintableKeeps.map((k) => k.briefKey))],
      keeps: allMintableKeeps,
      lastBriefKey: allMintableKeeps.at(-1)?.briefKey ?? null,
      coverage: null,
      stopReason: lastStop,
      seedRangeDraft: mergedClosed
        ? { kind: 'closed', from: mergedClosed.from, to: mergedClosed.to }
        : roundSeedDrafts[0] ?? null,
      seedRange: mergedClosed,
      ok: roundOk || allMintableKeeps.length > 0,
      note:
        allMintableKeeps.length > 0
          ? `decide · 真并行分批×${batches.length} · 可铸×${allMintableKeeps.length}` +
            (parallel.stoppedEarly ? ' · 早停取消其余' : '') +
            (closedPack.closed.length
              ? ` · 闭集×${closedPack.closed.length}`
              : '')
          : roundNotes.at(-1) || 'decide 硬闸：无法解析 JSON',
    }

    if (!decideOut.ok) {
      deskPromptSafety(
        `写信台 · decide 硬闸失败：${decideOut.note}。请检查本问材料或重试。`,
      )
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · ${decideOut.note} · ${notes.join(' → ')}`,
      }
    }

    const mintable = allMintableKeeps
    const action = decideRoundAction({
      scope,
      stopReason: decideOut.stopReason,
      mintableCount: mintable.length,
      queryKey: turnQueryKey,
    })

    if (action === 'done') {
      useAttentionIo.getState().clearPendingHunger()
      useAttentionIo.getState().clearPendingIngestFeed()
      break
    }

    if (action === 'continue_unread') {
      const unread = useAttentionIo
        .getState()
        .listKeysUnread('decide', { queryKey: turnQueryKey })
        .filter((k) => scope.includes(k))
      // 本批已吐出的 brief 视作已读；未出现在 keeps 里的继续
      const covered = new Set(allMintableKeeps.map((k) => k.briefKey))
      const leftover = scope.filter((k) => !covered.has(k))
      decideScope =
        unread.length > 0
          ? unread
          : leftover.length > 0
            ? leftover
            : scope
      notes.push(`续滚·未读 brief×${decideScope.length}`)
      parts.push(`### 自动流 · 续滚未读\n余 ${decideScope.length} brief`)
      continue
    }

    if (action === 'pause') {
      deskPromptSafety(
        `写信台 · 本问自动流暂停（三态无可铸 prospect）。可钉住注意力窗续调度，或换问法重试。`,
      )
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note:
          `自动流暂停 · 三态无可铸（未进 reuse/infer）· ${notes.join(' → ')}`,
      }
    }

    // hot_peek
    if (hotPeekCount >= MAX_HOT_PEEK) {
      deskPromptSafety(
        `写信台 · 本问热启 peek 已达安全阀（最多 ${MAX_HOT_PEEK} 次）。请人工扩搜/换 seedRange，或钉窗旁路调度；勿空转自动流。`,
      )
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note:
          `自动流暂停 · 热启 peek 安全阀触顶（${MAX_HOT_PEEK}）· ${notes.join(' → ')}`,
      }
    }

    const weakKeys = useAttentionIo
      .getState()
      .listKeysNeedingMore('decide', { queryKey: turnQueryKey })
      .filter((k) => scope.includes(k))

    // 热启只吃闭集；无闭集才 fallback（两端须能 map，且优先用已读 weak）
    let closedForPeek = lastClosedForPeek
    if (closedForPeek.length === 0) {
      const fb = fallbackSeedRange(
        [
          ...weakKeys,
          ...decideOut.briefKeys,
          decideOut.lastBriefKey,
          ...sealedBriefKeys,
        ].filter(Boolean) as string[],
        decideOut.lastBriefKey,
      )
      if (fb) {
        const stFb = useAttentionIo.getState()
        const unreadFb = new Set(
          stFb.listKeysUnread('decide', { queryKey: turnQueryKey }),
        )
        const readOk = (k: string) => {
          if (unreadFb.has(k)) return false
          const hit = stFb
            .listKeyStatuses({ job: 'decide', queryKey: turnQueryKey })
            .find((r) => r.key === k)
          return Boolean(hit && hit.status !== 'unread')
        }
        if (readOk(fb.from) && readOk(fb.to)) {
          closedForPeek = [fb]
          notes.push('seedRange · fallback 闭集（锚点已读）')
        } else {
          notes.push('seedRange · fallback 锚点未读，拒热启')
        }
      }
    }

    if (closedForPeek.length === 0) {
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · 热启无已读锚点闭集 · ${notes.join(' → ')}`,
      }
    }

    const expanded = expandClosedSeedRangesToBookKeys({
      docId,
      bookIndex: input.bookIndex,
      closed: closedForPeek,
    })
    notes.push(expanded.note)
    if (expanded.bookKeys.length === 0) {
      stashHungerForIngest({
        queryKey: turnQueryKey,
        closed: closedForPeek,
        reason: '热启展开为空（区间页可能尚在后台 OCR）',
      })
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note: `自动流暂停 · ${expanded.note} · 已挂起饥饿闭集等后台 · ${notes.join(' → ')}`,
      }
    }

    // 挂起饥饿：即使本轮有候选，后台新页仍可继续补贴（本问仍 insufficient 时）
    if (hungerStillOpen(turnQueryKey)) {
      useAttentionIo.getState().setPendingHunger({
        queryKey: turnQueryKey,
        closed: closedForPeek,
      })
    }

    // 优先铸未开；区间仅已开则仍投递（修订语义）；并吃后台饲料
    const candidates = mergeHotPeekCandidates({
      expandedUnopened: expanded.unopened,
      expandedAll: expanded.bookKeys,
    })
    if (candidates.length === 0) {
      stashHungerForIngest({
        queryKey: turnQueryKey,
        closed: closedForPeek,
        reason: '热启候选空',
      })
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note: `自动流暂停 · 热启候选空 · ${notes.join(' → ')}`,
      }
    }

    input.onProgress?.(
      `自动流 · 热启 peek（闭集×${expanded.usedClosed.length} · N=${candidates.length}）…`,
    )
    const hotPeek = await askDeepSeekWithA1({
      question: q,
      bookIndex: input.bookIndex,
      onProgress: input.onProgress,
      peekMode: 'hot',
      candidateKeys: candidates,
      openedKeys: expanded.opened,
      queryKey: turnQueryKey,
    })
    hotPeekCount++

    if (!hotPeek.ok || !hotPeek.items?.length) {
      parts.push(
        `### 自动流 · 热启 peek\n${hotPeek.note || '区间无新贴'}`,
      )
      notes.push(hotPeek.note || '热启peek空')
      stashHungerForIngest({
        queryKey: turnQueryKey,
        closed: closedForPeek,
        reason: `热启 peek 无新门贴（${hotPeek.note || '区间空'}）`,
      })
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note:
          `自动流暂停 · 热启 peek 无新门贴 · 已挂起等后台 · ${notes.join(' → ')}`,
      }
    }

    const sealed = input.sealItems(
      hotPeek.items
        .filter((it) => Boolean(it.briefKey))
        .map((it) => {
          const chunk = input.bookIndex.chunks.find((c) => c.key === it.key)
          return {
            key: it.key,
            brief: it.brief,
            briefKey: it.briefKey!,
            bookText: chunk ? atomSearchText(chunk) : undefined,
          }
        }),
    )
    if (sealed.length === 0) {
      deskPromptSafety('写信台 · 热启 peek 未铸出 settle briefKey（仅充分才铸）。')
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note: `自动流暂停 · 热启无 briefKey · ${notes.join(' → ')}`,
      }
    }
    sealedItems = [...sealedItems, ...sealed]
    const newBriefKeys = sealed.map((s) => s.briefKey)
    sealedBriefKeys = [...new Set([...sealedBriefKeys, ...newBriefKeys])]
    attachBriefsToQuestion(q, newBriefKeys, turnQueryKey)
    stepId = useAttentionIo.getState().pushPeekStep({
      mode: 'hot',
      question: q,
      items: sealed,
      llmCallId: newLlmCallId('peek'),
    })
    useAttentionIo.getState().attachBondIds(
      stepId,
      sealed.map((s) => ({ bookKey: s.key, bondId: s.bondId })),
    )
    parts.push(`### 自动流 · 热启 peek\n${sealed.length} 门贴 · ${expanded.note}`)
    notes.push(`热启peek ${sealed.length}`)
    // 新贴入队后再压滚：本轮 decide 只看新贴（+ 已充分 brief）
    decideScope = [
      ...newBriefKeys,
      ...decideOut.briefKeys.filter((k) => sealedBriefKeys.includes(k)),
    ]
    if (decideScope.length === 0) decideScope = newBriefKeys
  }

  const finalMintable =
    decideOut?.keeps.filter((k) => statusAllowsMint(k.status)) ?? []
  if (!decideOut || finalMintable.length === 0) {
    deskPromptSafety(
      `写信台 · 本问 decide 轮次触顶或无可铸充分 prospect。请钉窗人工调度或换问法。`,
    )
    return {
      ok: true,
      answer: parts.join('\n\n'),
      note:
        `自动流暂停 · decide 无可铸充分 prospect · ${notes.join(' → ')}`,
    }
  }

  // 递送下游用充分 brief；prospect 已在各轮 letterDeskDispatch(decide) 落账，禁止二次 settle
  const briefKeys = [
    ...new Set(finalMintable.map((k) => k.briefKey)),
  ]
  if (briefKeys.length === 0) {
    return {
      ok: true,
      answer: parts.join('\n\n'),
      note: `自动流暂停 · 充分槽无 briefKey · ${notes.join(' → ')}`,
    }
  }

  const prospectCount = useAttentionIo
    .getState()
    .prospects.filter((p) => p.queryKey === turnQueryKey).length
  notes.push(`prospect×${prospectCount}（desk 已落）`)
  if (prospectCount === 0) {
    // 兼容：若 desk 未落（旧路径），补一次 settle
    const settledProspects = useAttentionIo.getState().settleProspects({
      question: q,
      queryKey: turnQueryKey,
      llmCallId: newLlmCallId('decide'),
      keeps: finalMintable,
      allowedBriefKeys: sealedBriefKeys,
    })
    notes.push(`prospect补落×${settledProspects.prospectKeys.length}`)
    if (settledProspects.prospectKeys.length === 0) {
      deskPromptSafety('写信台 · 充分 prospect 均未落账（窗门牌校验失败？）。')
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note: `自动流暂停 · prospect 落账为空 · ${notes.join(' → ')}`,
      }
    }
  }

  // ——— infer：只送「本轮充分 prospect」血缘上的 book（brief→book），禁宽兜底换错材料 ———
  input.onProgress?.('自动流 · infer…')
  const stInfer = useAttentionIo.getState()
  const mintableSet = new Set(briefKeys)
  const lineageProspects = stInfer.prospects.filter(
    (p) => p.queryKey === turnQueryKey && mintableSet.has(p.briefKey.trim()),
  )
  const lineage = bookKeysForInferFromDecideLineage({
    docId,
    mintableBriefKeys: briefKeys,
    prospects: lineageProspects,
    deskDeliveries: stInfer.deskDeliveries,
  })
  const bookKeys = lineage.bookKeys
  notes.push(
    `infer血缘 pair×${lineage.pairs.length} · book×${bookKeys.length}` +
      (lineage.unmappedBriefKeys.length
        ? ` · 未映brief×${lineage.unmappedBriefKeys.length}`
        : '') +
      (lineage.orphanProspectKeys.length
        ? ` · 无book prospect×${lineage.orphanProspectKeys.length}`
        : ''),
  )
  if (bookKeys.length === 0) {
    deskPromptSafety(
      '写信台 · decide 充分 prospect 无法溯到 bookKey（门表/peek 递送断了）。禁止灌全部 peek 门。',
    )
    return {
      ok: false,
      answer: parts.join('\n\n'),
      note: `自动流中止 · prospect→brief→book 血缘无解 · ${notes.join(' → ')}`,
    }
  }
  // package.briefKey：取第一对血缘 brief（与 onlyBookKeys[0] 同源），勿用任意 sealedBrief
  const lineageBriefKey = lineage.pairs[0]?.briefKey || briefKeys[0] || ''

  const mainPkg: LetterDeskPackage = {
    id: sid(),
    edgeId: `${stepId || 'infer'}_${bookKeys[0]}`,
    bookKey: bookKeys[0]!,
    briefKey: lineageBriefKey,
    question: q,
    job: 'infer',
    versionIndex: 0,
    createdAt: Date.now(),
    onlyBookKeys: bookKeys,
  }

  const mainRes = await askDeepSeekWithLetterDesk({
    question: q,
    packages: [mainPkg],
    bookIndex: input.bookIndex,
    docId,
    onProgress: input.onProgress,
    turnQueryKey,
  })
  parts.push(mainRes.answer || '### infer · （空）')
  notes.push(mainRes.note)

  const mainFailed =
    !mainRes.ok ||
    /空内容|失败|HTTP|无 choices|请求失败/.test(mainRes.note)
  if (mainFailed) {
    deskPromptSafety(
      `写信台 · infer 未写出内容（${mainRes.note}）。前序 decide 已有充分 prospect；可钉住材料窗重跑 infer。`,
    )
    return {
      ok: false,
      answer: parts.join('\n\n'),
      note: `自动流 · infer 失败 · ${notes.join(' → ')}`,
    }
  }

  deskMonitorAttentionArrival({
    job: 'infer',
    llmText: mainRes.answer,
    windowKeys: bookKeys,
    queryKey: turnQueryKey,
  })

  // path：等人手确认成案；未确认则挂起（禁止自动信效度 LLM）
  const pending = useAttentionIo.getState().pendingPathMatch
  const userPaths = useAttentionIo
    .getState()
    .listPathsForQueryKey(turnQueryKey)
    .filter((p) => p.matchMode === 'user')
  if (userPaths.length === 0 && pending) {
    useAttentionIo.getState().setDeskPrompt(
      `写信台 · path：候选 pathKey×${pending.pathKeys?.length ?? 0}；或「跳过匹配」→监督铸 norm。` +
        ` qk=${pending.queryKey}`,
    )
    notes.push('等待用户 path 确认/监督')
    return {
      ok: true,
      answer:
        parts.join('\n\n') +
        `\n\n### 等待 path（已铸候选 pathKey · 非自由配对）\n` +
        `queryKey=\`${pending.queryKey}\`\n` +
        `pathKeys×${pending.pathKeys?.length ?? 0}:\n` +
        (pending.boundPairs ?? [])
          .map(
            (p) =>
              `- path=\`${p.pathKey}\` · ι=\`${p.inferKey}\` × prospect=\`${p.prospectKey}\` · book=${p.sharedBookKeys.join(',')}`,
          )
          .join('\n') +
        `\n请 tick：settleUserPathMatches({ pathKeys }) → 登记 normKey；` +
        `可选 normalizedByPathKey 自整理；或 skipPendingPathMatchToSupervise → 监督 LLM 铸 norm。`,
      note: `自动流 · ${notes.join(' → ')}`,
    }
  }

  const pathReturn = formatDirectedPathIncrementReturn({
    question: q,
    hopOutputs: hopsFromAnswerParts(parts),
    mode: 'auto',
    queryKey: turnQueryKey,
  })

  useAttentionIo
    .getState()
    .setLastStatus(`自动流完成 · ${notes.join(' → ')}`)
  useAttentionIo.getState().clearDeskPrompt()

  return {
    ok: true,
    answer: pathReturn,
    note: `自动流 · ${notes.join(' → ')}`,
  }
}

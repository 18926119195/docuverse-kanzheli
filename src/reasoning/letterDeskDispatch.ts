/**
 * 写信台调度：lookup(job) → 契约导向 expand → fetch → 组窗 → LLM。
 * 薄指令只含门牌；正文仅在 fetch 时从 MasterTable/A1 展开。
 */

import type { BookIndex } from './pipelineA'
import { atomSearchText } from './hybridRetrieve'
import type { DeskJob, LetterDeskPackage } from './attentionIoStore'
import { useAttentionIo } from './attentionIoStore'
import { lookupContract } from './letterDeskContracts'
import {
  doorHasBrief,
  docHasAnyBrief,
  listBriefVersionsOnDoor,
  mapBookToHeadBrief,
  mapBriefToBook,
} from './masterTableMap'
import { demoAuthHeaders } from './demoAuth'
import {
  loadDualModelConfig,
  reasonEndpointReady,
} from './modelRuntimeConfig'
import {
  fallbackInferPaths,
  parseInferPaths,
  parseQueryNeighbours,
  parsePathValidityJudgments,
  parseReuseJudgments,
} from './inferPath'
import { useIndexGate } from './indexGate'
import { settlePeekItemsFromLlm } from './a1DsChat'
import type { InferEdge } from './attentionIoStore'
import { LOCKED_LLM } from './modelRuntimeConfig'
import { listHistoricQueryEntriesForNeighbour } from './deskEntryGate'
import {
  formatDirectedPathIncrementReturn,
  hopsFromAnswerParts,
  notesIndicatePathSettled,
} from './pathIncrementReturn'
import { keyStatusContractHint } from './keyIncrementStatus'
import { ingestKeyIncrementStatuses } from './attentionArrival'
import { newLlmCallId } from './settleMint'
import { briefKeysUsedByPaths } from './pathBriefExclusion'

export interface ThinSeed {
  bookKey?: string
  briefKey?: string
  question: string
  job: DeskJob
  versionIndex?: number
  /** decide 续滚：只展这些 briefKey */
  onlyBriefKeys?: string[]
  /** infer：只展这些 bookKey（与 autoFlow mintable 对准） */
  onlyBookKeys?: string[]
  /** 监督预测轨 → decide 策略提示 */
  decideCritiqueHint?: string
  /** reframe：拒铸与这些坏 prospect 正文同构的输出 */
  avoidProspectTexts?: string[]
}

export interface ExpandedKey {
  kind: 'briefKey' | 'bookKey' | 'queryKey'
  key: string
  /** peek 已开：对照贴 */
  parentBriefKey?: string
  parentBrief?: string
  opened?: boolean
  /** query 窗：历史 Q 文 */
  qText?: string
  /** query 窗：题族角色 */
  familyRole?: 'root' | 'deepen'
  parentQueryKey?: string
}

export interface AssembledWindow {
  job: DeskJob
  contractIn: string
  contractOut: string
  /** 给 LLM 的用户包（已按契约组好） */
  userPayload: string
  systemPayload: string
  note: string
}

function flashChat(input: {
  system: string
  user: string
  temperature?: number
  maxTokens?: number
  retryOnEmpty?: boolean
  /** 仅 decide/infer 开；默认关（DeepSeek V4 否则默认狂烧 reasoning） */
  thinking?: boolean
  /** 写信台早停：取消未完成的 fetch（非暂停/续跑） */
  signal?: AbortSignal
}): Promise<
  | { ok: true; content: string; finishReason: string }
  | { ok: false; note: string }
> {
  // deferred — use shared helper via dynamic path to avoid circular import weight
  return flashChatImpl(input)
}

async function flashChatImpl(input: {
  system: string
  user: string
  temperature?: number
  maxTokens?: number
  /** 空内容时再打一次（主推理偶发） */
  retryOnEmpty?: boolean
  thinking?: boolean
  signal?: AbortSignal
}): Promise<
  | { ok: true; content: string; finishReason: string }
  | { ok: false; note: string }
> {
  const { reason } = loadDualModelConfig()
  if (!reasonEndpointReady(reason)) {
    return { ok: false, note: '推理槽未配置（/api/llm）' }
  }
  const base = (reason.baseUrl.trim() || '/api/llm').replace(/\/$/, '')
  const url = `${base}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...demoAuthHeaders(),
  }
  if (reason.apiKey.trim() && !base.startsWith('/api/')) {
    headers.Authorization = `Bearer ${reason.apiKey.trim()}`
  }
  const { llmThinkingField } = await import('./llmThinking')

  const once = async (): Promise<
    | { ok: true; content: string; finishReason: string }
    | { ok: false; note: string }
  > => {
    try {
      if (input.signal?.aborted) {
        return { ok: false, note: 'LLM 已取消（早停）' }
      }
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: reason.model || LOCKED_LLM.chatModel,
          temperature: input.temperature ?? 0.15,
          max_tokens: input.maxTokens ?? 4096,
          ...llmThinkingField(input.thinking ? 'enabled' : 'disabled'),
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
        signal: input.signal,
      })
      if (!res.ok) {
        const errText = await res.text()
        return {
          ok: false,
          note: `LLM HTTP ${res.status}: ${errText.slice(0, 160)}`,
        }
      }
      const data: unknown = await res.json()
      if (
        typeof data !== 'object' ||
        data === null ||
        !('choices' in data) ||
        !Array.isArray((data as { choices: unknown }).choices)
      ) {
        return { ok: false, note: 'LLM 响应无 choices' }
      }
      const choice = (
        data as {
          choices: Array<{
            finish_reason?: string
            message?: {
              content?: string | null
              reasoning_content?: string | null
              refusal?: string | null
            }
          }>
        }
      ).choices[0]
      const msg = choice?.message
      const finishReason = choice?.finish_reason ?? '?'
      const raw =
        (typeof msg?.content === 'string' && msg.content.trim()
          ? msg.content
          : null) ||
        (typeof msg?.reasoning_content === 'string' &&
        msg.reasoning_content.trim()
          ? msg.reasoning_content
          : null) ||
        (typeof msg?.refusal === 'string' && msg.refusal.trim()
          ? msg.refusal
          : null)
      if (!raw || !raw.trim()) {
        return {
          ok: false,
          note: `LLM 空内容 · finish_reason=${finishReason} · 请重试主推理或缩小材料窗`,
        }
      }
      return { ok: true, content: raw, finishReason }
    } catch (e) {
      const aborted =
        input.signal?.aborted ||
        (e instanceof Error &&
          (e.name === 'AbortError' || /abort/i.test(e.message)))
      return {
        ok: false,
        note: aborted
          ? 'LLM 已取消（早停）'
          : e instanceof Error
            ? e.message
            : 'LLM 请求失败',
      }
    }
  }

  const first = await once()
  if (first.ok || !input.retryOnEmpty) return first
  if (input.signal?.aborted || first.note.includes('已取消')) return first
  if (!first.note.includes('空内容')) return first
  const second = await once()
  if (second.ok) return second
  return {
    ok: false,
    note: `${first.note} → 重试仍失败：${second.note}`,
  }
}

/**
 * 契约导向 expand：先 allow/forbid，再只走准许的 map 边。
 */
export function expandSeedsForJob(input: {
  docId: string
  job: DeskJob
  seeds: ThinSeed[]
  /** 本问线；缺则尝试从 seed.question 解析 */
  queryKey?: string
}): { keys: ExpandedKey[]; note: string } {
  const contract = lookupContract(input.job)
  const keys: ExpandedKey[] = []
  const seen = new Set<string>()
  const io = useAttentionIo.getState()
  const resolvedQk =
    input.queryKey?.trim() ||
    input.seeds
      .map((s) => io.findQueryKeyForQuestion(s.question ?? ''))
      .find(Boolean) ||
    undefined
  const qScope = resolvedQk ? { queryKey: resolvedQk } : undefined

  const push = (k: ExpandedKey) => {
    const id = `${k.kind}:${k.key}`
    if (seen.has(id)) return
    if (k.kind === 'briefKey' && !contract.allow.includes('briefKey')) return
    if (k.kind === 'bookKey' && !contract.allow.includes('bookKey')) return
    if (k.kind === 'queryKey' && !contract.allow.includes('queryKey')) return
    seen.add(id)
    keys.push(k)
  }

  /** 三态驱动：优先 sufficient；unread 仍可进窗；insufficient 默认不递送（除非窗内尚无足够 key） */
  const preferByStatus = (kind: 'briefKey' | 'bookKey' | 'queryKey', raw: string[]) => {
    const ready = new Set(io.listKeysReadyToDeliver(undefined, qScope))
    const unread = new Set(io.listKeysUnread(undefined, qScope))
    const need = new Set(io.listKeysNeedingMore(undefined, qScope))
    const scopedRows = qScope
      ? io.listKeyStatuses({ queryKey: qScope.queryKey })
      : io.keyIncrementStatuses
    if (scopedRows.length === 0) {
      for (const k of raw) push({ kind, key: k })
      return
    }
    const preferred = raw.filter((k) => ready.has(k) || unread.has(k))
    const use = preferred.length > 0 ? preferred : raw.filter((k) => !need.has(k))
    const final = use.length > 0 ? use : raw
    for (const k of final) push({ kind, key: k })
  }

  for (const seed of input.seeds) {
    if (input.job === 'peek') {
      // 门况局部：briefKey → map book → 已开；bookKey → 查是否有贴
      let bookKey = seed.bookKey
      let parentBrief: string | undefined
      let parentBriefKey: string | undefined
      if (seed.briefKey) {
        const hit = mapBriefToBook(input.docId, seed.briefKey)
        if (hit) {
          bookKey = hit.bookKey
          parentBrief = hit.brief
          parentBriefKey = seed.briefKey
        }
      }
      // insufficient book → 优先热启补贴（本问族）
      const needBooks = io.listKeysNeedingMore('peek', qScope)
      if (!bookKey && needBooks.length > 0) {
        bookKey = needBooks[0]
      }
      if (!bookKey) continue
      if (parentBriefKey || doorHasBrief(input.docId, bookKey)) {
        const head = mapBookToHeadBrief(input.docId, bookKey)
        const versions = listBriefVersionsOnDoor(input.docId, bookKey)
        const ver =
          typeof seed.versionIndex === 'number'
            ? versions[seed.versionIndex]
            : undefined
        push({
          kind: 'bookKey',
          key: bookKey,
          opened: true,
          parentBriefKey:
            parentBriefKey || ver?.briefKey || head?.briefKey,
          parentBrief: parentBrief || ver?.brief || head?.brief,
        })
      } else {
        push({ kind: 'bookKey', key: bookKey, opened: false })
      }
      continue
    }

    if (input.job === 'query') {
      const nowQk =
        useAttentionIo.getState().findQueryKeyForQuestion(input.seeds[0]?.question ?? '') ||
        ''
      // 优先用种子 question 对应 qk；多 seed 时仍排除所有当前问文匹配
      const nowKeys = new Set<string>()
      for (const s of input.seeds) {
        const qk = useAttentionIo.getState().findQueryKeyForQuestion(s.question)
        if (qk) nowKeys.add(qk)
      }
      const historic = listHistoricQueryEntriesForNeighbour(
        [...nowKeys][0] || nowQk || undefined,
      ).filter((e) => !nowKeys.has(e.queryKey))
      // 防整表问线：只取最近 HISTORIC_QUERY_CAP 条
      const HISTORIC_QUERY_CAP = 24
      const capped =
        historic.length > HISTORIC_QUERY_CAP
          ? historic.slice(-HISTORIC_QUERY_CAP)
          : historic
      preferByStatus(
        'queryKey',
        capped.map((e) => e.queryKey),
      )
      for (const k of keys) {
        if (k.kind !== 'queryKey') continue
        const hit = historic.find((e) => e.queryKey === k.key)
        if (hit) {
          k.qText = hit.qText
          k.familyRole = hit.familyRole
          k.parentQueryKey = hit.parentQueryKey
        }
      }
      continue
    }

    if (input.job === 'decide') {
      const briefKeys: string[] = []
      if (seed.onlyBriefKeys && seed.onlyBriefKeys.length > 0) {
        briefKeys.push(...seed.onlyBriefKeys)
      } else {
        if (seed.briefKey) briefKeys.push(seed.briefKey)
        else if (seed.bookKey) {
          const head = mapBookToHeadBrief(input.docId, seed.bookKey)
          if (head) briefKeys.push(head.briefKey)
        }
        const hist = io.listBriefKeysForQuestion(seed.question)
        briefKeys.push(...hist)
        // unread / insufficient from 本问族 prior decide → 必须再进窗
        briefKeys.push(...io.listKeysUnread('decide', qScope))
        briefKeys.push(...io.listKeysNeedingMore('decide', qScope))
      }
      preferByStatus('briefKey', [...new Set(briefKeys)])
      continue
    }

    if (input.job === 'supervise') {
      let bookKey = seed.bookKey
      let briefKey = seed.briefKey
      if (briefKey && !bookKey) {
        bookKey = mapBriefToBook(input.docId, briefKey)?.bookKey
      }
      if (bookKey && !briefKey) {
        briefKey = mapBookToHeadBrief(input.docId, bookKey)?.briefKey
      }
      if (bookKey && briefKey) {
        push({ kind: 'bookKey', key: bookKey })
        push({ kind: 'briefKey', key: briefKey })
      }
      continue
    }

    if (input.job === 'infer') {
      const books: string[] = []
      if (seed.onlyBookKeys && seed.onlyBookKeys.length > 0) {
        books.push(...seed.onlyBookKeys)
      } else {
        let bookKey = seed.bookKey
        if (!bookKey && seed.briefKey) {
          bookKey = mapBriefToBook(input.docId, seed.briefKey)?.bookKey
        }
        if (bookKey) books.push(bookKey)
        for (const bk of io.listKeysReadyToDeliver('decide', qScope)) {
          const hit = mapBriefToBook(input.docId, bk)
          if (hit) books.push(hit.bookKey)
        }
        const histBooks = io.listBookKeysForQuestion(seed.question)
        books.push(...histBooks)
        books.push(...io.listKeysUnread('infer', qScope))
      }
      preferByStatus('bookKey', [...new Set(books)])
    }
  }

  return {
    keys,
    note: `expand ${input.job} · ${keys.length} keys · allow=${contract.allow.join(',')} · 三态过滤`,
  }
}

function fetchBookT(bookIndex: BookIndex, bookKey: string): string {
  const chunk = bookIndex.chunks.find((c) => c.key === bookKey)
  return chunk ? atomSearchText(chunk) : ''
}

function fetchBriefText(docId: string, briefKey: string): string {
  const hit = mapBriefToBook(docId, briefKey)
  return hit?.brief ?? ''
}

/**
 * bookKey 已定 → 倒查历史问法 queryKey/Q原文 → 排除槽（展开原文）
 */
export function reverseLookupExcludeQuestions(bookKeys: string[]): Array<{
  queryKey: string
  qText: string
}> {
  return useAttentionIo.getState().listQuestionsForBookKeys(bookKeys)
}

export function assembleWindow(input: {
  docId: string
  bookIndex: BookIndex
  job: DeskJob
  qNow: string
  seeds: ThinSeed[]
  keys: ExpandedKey[]
  /** 玩法 B：钉住 ι 换方向时要避开的 inferKey 原文 */
  excludeInfers?: Array<{ inferKey: string; rationale: string }>
  /** 监督预测轨：decide 策略尸检 */
  decideCritiqueHint?: string
}): AssembledWindow {
  const contract = lookupContract(input.job)
  const lines: string[] = [`Q_now：${input.qNow}`, `契约 in：${contract.inNote}`, '']

  if (input.job === 'query') {
    lines.push('【阶段 A · query 窗 · 历史问族（含根与深化）· 无 brief】')
    for (const k of input.keys.filter((x) => x.kind === 'queryKey')) {
      const role =
        k.familyRole === 'deepen'
          ? `深化←\`${k.parentQueryKey || '?'}\``
          : '根问'
      lines.push(
        `queryKey=\`${k.key}\` · ${role}\n历史Q：${k.qText || '（无原文）'}\n`,
      )
    }
    lines.push(
      '扫完后只输出 JSON：\n' +
        '{\n' +
        '  "neighbours": [{ "queryKey": "qk_…", "degree": "相关度说明或分数" }, …],\n' +
        '  "keyStatuses": [{ "key": "qk_…", "status": "unread|sufficient|insufficient" }],\n' +
        '  "attentionArrived": true | false\n' +
        '}\n' +
        '规则：对称输出 ⊆ 输入 historic queryKey；增量 = neighbour（该历史 Q 与 Q_now 的相关度）；\n' +
        '历史池含「根问」与「深化子问」；深化问与其父/兄可比相关度（靠拢或拉开）；\n' +
        '台对每条 settle neighbourKey，挂在对应 historic queryKey 上；\n' +
        '不出 briefKey；不得渗透 bookKey/T。\n' +
        `- ${keyStatusContractHint('queryKey')}\n` +
        '- 窗内每个 historic queryKey 都要有 status（有 neighbour≈sufficient；未看=unread；看了但不相关=insufficient）。',
    )
  } else if (input.job === 'decide') {
    if (input.decideCritiqueHint?.trim()) {
      lines.push(input.decideCritiqueHint.trim(), '')
    }
    lines.push('【brief 窗 · 仅 briefKey+brief】')
    for (const k of input.keys.filter((x) => x.kind === 'briefKey')) {
      const brief = fetchBriefText(input.docId, k.key)
      lines.push(`briefKey=\`${k.key}\`\nbrief:\n${brief}\n`)
    }
    lines.push(
      '请只输出 JSON（可围栏）：\n' +
        '{\n' +
        '  "prospects": [{ "briefKey": "bh_…", "prospect": "单行≤40字：该 brief 解 Q_now 的一种可能", "status": "sufficient" }],\n' +
        '  "keyStatuses": [{ "key": "bh_…", "status": "unread|sufficient|insufficient" }],\n' +
        '  "stopReason": null | "peek" | "token_full" | "off_book",\n' +
        '  "seedRange": null | { "from":"bh_…","to":"bh_…" } | { "from":"-inf","to":"bh_…" } | { "from":"bh_…","to":"+inf" } | { "kind":"open_low","to":"bh_…" } | { "kind":"open_high","from":"bh_…" }\n' +
        '}\n' +
        '硬规则：\n' +
        '- 调度只看 key 三态；不要输出整窗 coverage；不要输出 keep[]（已废除）。\n' +
        '- 仅 status=sufficient 的槽才会被台铸 prospectKey；unread/insufficient 只记状态，不铸键。\n' +
        '- 未处理完的 brief → status:unread（台续滚）；已读但不够 → insufficient（可写 seedRange 草案；台晚执行）。\n' +
        '- seedRange 可早写半开（−∞/＋∞）；锚点 brief 必须本窗已读（非 unread）。台合并并行草案成闭集后才热启 peek；未配成闭集不 peek。\n' +
        '- 一槽一 prospectKey：多种可能 = 多行 prospects，或同行内嵌数组；禁止合并成一条。\n' +
        '- briefKey 必须字符级回传窗内门牌。\n' +
        '- prospect 必须单行、≤40字；禁止换行；字符串内禁止英文双引号；提到专名则原样保留（如 Lacan/拉康）。\n' +
        '- 只要 brief 正文出现与 Q 相关的专名/概念，status 必须 sufficient，prospect 写清「提到X…」；未出现才写「否：未提到」。\n' +
        `- ${keyStatusContractHint('briefKey')}\n` +
        '- 窗内每个 briefKey 都必须出现在 prospects.status 或 keyStatuses 里。\n' +
        '- 优先保证 JSON 完整可解析；写不完就停在完整对象后，勿截断字符串。',
    )
  } else if (input.job === 'peek') {
    lines.push('【peek 铸贴窗】')
    for (const k of input.keys.filter((x) => x.kind === 'bookKey')) {
      const T = fetchBookT(input.bookIndex, k.key).slice(0, 800)
      if (k.opened && k.parentBrief) {
        lines.push(
          `bookKey=\`${k.key}\` opened=true\n` +
            `对照贴 briefKey=\`${k.parentBriefKey}\`:\n${k.parentBrief}\n` +
            `T:\n${T}\n` +
            `请判 noop|add|condense，输出同一 bookKey + brief 正文（台铸 briefKey）。\n`,
        )
      } else {
        lines.push(
          `bookKey=\`${k.key}\` opened=false\nT:\n${T}\n请 create：同一 bookKey + brief 正文。\n`,
        )
      }
    }
    const secondPeek =
      input.keys.some((k) => k.kind === 'bookKey' && k.opened) ||
      docHasAnyBrief(input.docId)
    lines.push(
      '请只输出 JSON：\n' +
        '{\n' +
        '  "briefs":[\n' +
        '    { "key":"bookKey", "brief":"贴A", "status":"sufficient" },\n' +
        '    { "key":"同一 bookKey", "briefs":["贴B","贴C"], "status":"sufficient" }\n' +
        '  ],\n' +
        '  "keyStatuses":[{ "key":"bookKey", "status":"unread|sufficient|insufficient" }]\n' +
        '}\n' +
        `- ${keyStatusContractHint('bookKey')}\n` +
        '- 主协议是 briefs[]（items[] 已废除）。\n' +
        '- 一槽一 briefKey：多条同 key，或一行 briefs:["贴A","贴B"] 展开；禁止多贴合成一条。\n' +
        '- 仅 status=sufficient（或有 brief 未报态）才铸 briefKey；unread/insufficient 不铸键。\n' +
        (secondPeek
          ? '- 二次+ peek：用户原话若出现在窗旁注，只作修贴意图，禁止抄进 brief。'
          : '- 第一次冷启：只按固定指令从 T 铸贴，不要依赖用户问题。'),
    )
  } else if (input.job === 'supervise') {
    lines.push('【监督 · pathKey 信效度 + 归一化推理（非配对）】')
    const io = useAttentionIo.getState()
    const qk =
      io.pendingPathMatch?.queryKey ||
      io.selectedQueryKey ||
      Object.keys(io.settledQueries).at(-1) ||
      ''
    const pending = io.pendingPathMatch
    const candidatePaths =
      pending?.pathKeys?.length
        ? io.paths.filter((p) => pending.pathKeys.includes(p.pathKey))
        : qk
          ? io.paths.filter(
              (p) =>
                p.queryKey === qk &&
                (p.matchMode === 'candidate' || p.matchMode === 'user'),
            )
          : []
    if (candidatePaths.length === 0) {
      lines.push(
        '台侧无候选 pathKey 可评。勿编造 judgments。\n' +
          '请输出 JSON：{ "judgments": [], "keyStatuses": [] }',
      )
    } else {
      lines.push(
        `queryKey=\`${qk}\`\nQ：${io.settledQueries[qk] ?? input.qNow}\n` +
          '下列均为写信台已铸的 pathKey（血缘已绑定）；你只评信效度，并在充分时写归一化推理正文。\n' +
          '归一化：以 infer 为基地（主链大致不改），prospect 作修饰/补全；供 reuse 单段展开省 token。\n' +
          '禁止增删 pathKey；禁止回传 inferKey/prospectKey 当并列门牌。\n' +
          '请输出 JSON：\n' +
          '{\n' +
          '  "judgments":[{ "pathKey":"ph_…", "status":"sufficient|insufficient", "normalizedText":"…" }],\n' +
          '  "keyStatuses":[{ "key":"ph_…", "status":"unread|sufficient|insufficient" }]\n' +
          '}\n' +
          '- sufficient 必须带 normalizedText → 台铸 normKey；insufficient 不铸\n' +
          `- ${keyStatusContractHint('pathKey')}`,
      )
      for (const p of candidatePaths) {
        const edge = io.inferEdges.find((e) => e.inferKey === p.inferKey)
        const pr = io.prospects.find((x) => x.prospectKey === p.prospectKey)
        lines.push(
          `── pathKey=\`${p.pathKey}\` ──\n` +
            `ι 展开：${(edge?.infer || edge?.rationale || '').trim()}\n` +
            `prospect 展开：${(pr?.text || '').trim()}\n`,
        )
      }
    }
  } else {
    // infer
    lines.push('【infer · 材料 bookKey】')
    const bookKeys = input.keys
      .filter((x) => x.kind === 'bookKey')
      .map((x) => x.key)
    for (const bk of bookKeys) {
      const T = fetchBookT(input.bookIndex, bk).slice(0, 600)
      lines.push(`bookKey=\`${bk}\`\nT:\n${T}\n`)
    }
    const excludesI = input.excludeInfers ?? []
    if (excludesI.length > 0) {
      lines.push('【排除 · 玩法 B · inferKey / ι 原文 · 勿沿此方向再推】')
      for (const e of excludesI) {
        lines.push(`inferKey=\`${e.inferKey}\`\nι原文：${e.rationale}\n`)
      }
    }
    lines.push(
      '请只输出 JSON（可围栏），结构：\n' +
        '{\n' +
        '  "attentionArrived": true | false,\n' +
        '  "materialStatus": [{ "bookKey": "…", "status": "unread|sufficient|insufficient" }],\n' +
        '  "keyStatuses": [{ "key": "…", "status": "unread|sufficient|insufficient" }],\n' +
        '  "paths": [\n' +
        '    {\n' +
        '      "steps": [\n' +
        '        { "bookKeys": ["bk_solo"], "infer": "这一门的 T 如何解 Q_now…" },\n' +
        '        { "bookKeys": ["bk_a","bk_b"], "infer": "a 与 b 如何互撑解 Q…" },\n' +
        '        { "bookKeys": ["bk_a","bk_b","bk_c"], "infers": ["可能一…", "可能二…"] }\n' +
        '      ]\n' +
        '    }\n' +
        '  ]\n' +
        '}\n' +
        '规则：穷举「能解决 Q_now」的走法；每条 infer 与 bookKeys 组合一一对应；' +
        '多种解法必须分槽（多步或 infers[]），禁止塞进同一 infer 字段；' +
        '台对每个槽各铸 inferKey（一槽一 key）；' +
        '每步 bookKeys≥1（须来自上方材料）：单门｜二元｜多门均可；' +
        '禁止 [同一key,同一key] 自环（单门只写一个 key）；' +
        'attentionArrived=本窗材料是否已让你注意力到位（能穷举）；不能则 false；' +
        'rationale 只解释本步如何回 Q；可多条 paths；勿散文结论' +
        (excludesI.length > 0 ? '；勿把排除项当材料' : '') +
        '。\n' +
        `- ${keyStatusContractHint('bookKey')}\n` +
        '- 进入 paths 的门 = sufficient；未用 = unread 或 insufficient。',
    )
  }

  return {
    job: input.job,
    contractIn: contract.inNote,
    contractOut: contract.outNote,
    userPayload: lines.join('\n'),
    systemPayload: [
      `你执行写信台契约「${input.job}」。`,
      `in：${contract.inNote}`,
      `out：${contract.outNote}`,
      '禁止改契约；禁止把排除项当材料；禁止闲聊。',
    ].join('\n'),
    note: `组窗 ${input.job} · keys=${input.keys.length}`,
  }
}

/** 候选 path：neighbour 挂靠的历史 qk + 本问祖先链（深化可直用父 path） */
export function listCandidatePathsViaNeighbours(nowQueryKey?: string) {
  const st = useAttentionIo.getState()
  const qk = nowQueryKey?.trim()
  if (!qk) return []
  const historic = new Set(
    st.neighbours
      .filter((n) => n.nowQueryKey === qk)
      .map((n) => n.historicQueryKey),
  )
  // 深化：父链 path 始终可进 reuse 候选（即使尚未落 neighbour）
  for (const a of st.listQuerySelfAndAncestors(qk)) {
    if (a !== qk) historic.add(a)
  }
  if (historic.size === 0) return []
  const out: ReturnType<typeof st.listPathsForQueryKey> = []
  const seen = new Set<string>()
  for (const hq of historic) {
    for (const p of st.listPathsForQueryKey(hq)) {
      if (seen.has(p.pathKey)) continue
      seen.add(p.pathKey)
      out.push(p)
    }
  }
  return out
}

/** @deprecated 用 listCandidatePathsViaNeighbours；book 邻近扫不符合 reuse 架构 */
export function listCandidatePaths(bookKeys: string[]) {
  return useAttentionIo.getState().listPathsForBookKeys(bookKeys)
}

/** @deprecated 用 listCandidatePaths；保留给玩法 B 排除 ι */
export function listCandidateInferEdges(bookKeys: string[]): InferEdge[] {
  return useAttentionIo.getState().listInferEdgesForBookKeys(bookKeys)
}

/**
 * 复用闸：主坐标 = normKey + 展开(归一化推理)；能则现 qk ──reuse──► normKey。
 */
export async function runReuseGate(input: {
  qNow: string
  /** 用于 brief↔book 精细剔除 */
  docId?: string
  /** @deprecated 架构以 neighbour→path 为准；保留兼容 */
  bookKeys?: string[]
  queryKey?: string
  /** 监督同问复盘：禁止采纳这些坏 path（其它 neighbour path 仍可） */
  excludePathKeys?: string[]
  onProgress?: (msg: string) => void
  signal?: AbortSignal
}): Promise<{
  adopted: boolean
  /** 已挂起提案，等人批（≠ 已 adopt） */
  awaitingApproval: boolean
  queryKey?: string
  reuseKey?: string
  pathKey?: string
  pathKeys?: string[]
  normKey?: string
  normKeys?: string[]
  reuseKeys?: string[]
  oldQueryKey?: string
  inferKeys?: string[]
  prospectKeys?: string[]
  judgments: ReturnType<typeof parseReuseJudgments>
  /** 失败 path 实际用过的 brief（同门其余保留） */
  excludeBriefKeys: string[]
  raw: string
  note: string
}> {
  const banned = new Set(
    (input.excludePathKeys ?? []).map((k) => k.trim()).filter(Boolean),
  )
  const paths = listCandidatePathsViaNeighbours(input.queryKey).filter(
    (p) => !banned.has(p.pathKey),
  )
  const st = useAttentionIo.getState()
  const norms = st
    .listNormsForPathKeys(paths.map((p) => p.pathKey))
    .filter((n) => n.text.trim())
  if (norms.length === 0) {
    return {
      adopted: false,
      awaitingApproval: false,
      judgments: [],
      excludeBriefKeys: [],
      raw: '',
      note: banned.size
        ? `复用闸：候选均被排除或无 normKey（坏 path×${banned.size}）`
        : '复用闸：无 neighbour→path→norm 候选（须历史问线已有 normKey：用户确认 path 登记或监督铸）',
    }
  }

  const settled = st.settledQueries
  const byPath = new Map(paths.map((p) => [p.pathKey, p]))
  const lines: string[] = [
    `Q_now：${input.qNow}`,
    '',
    '【候选 · 每条以 normKey 为主坐标；展开 = 监督归一化推理路径】',
  ]
  for (const n of norms) {
    const p = byPath.get(n.pathKey)
    lines.push(`\nnormKey=\`${n.normKey}\``)
    lines.push(`挂靠 pathKey=\`${n.pathKey}\``)
    lines.push(`挂靠旧 queryKey=\`${p?.queryKey ?? n.queryKey}\``)
    lines.push(
      `旧 Q：${settled[p?.queryKey ?? n.queryKey] ?? '（无原文）'}`,
    )
    lines.push(`归一化推理：${n.text}`)
  }
  lines.push(
    '\n请判断：哪条归一化路径能否解决 Q_now。\n' +
      '只输出 JSON：\n' +
      '{\n' +
      '  "judgments": [\n' +
      '    { "normKey": "nk_…", "pathKey": "ph_…", "canSolve": true|false, "status": "unread|sufficient|insufficient", "rationale": "依据…" }\n' +
      '  ],\n' +
      '  "keyStatuses": [{ "key": "nk_…", "status": "unread|sufficient|insufficient" }]\n' +
      '}\n' +
      '规则：每个候选 normKey 一条；主坐标是 normKey；' +
      'canSolve=true 表示可复用、不必新开主推理；禁止以正文指纹当门牌；' +
      'status：能复用=sufficient；审过不够=insufficient；未审=unread。\n' +
      `- ${keyStatusContractHint('normKey')}`,
  )

  input.onProgress?.('写信台 · 复用闸 · LLM…')
  const chat = await flashChat({
    system: [
      '你是复用闸：只评「已有归一化推理路径（normKey）能否返回 / 撑住 Q_now」。',
      '主坐标是 normKey；不写新路径；不改契约；不翻库；不靠正文指纹撞车。',
    ].join('\n'),
    user: lines.join('\n'),
    temperature: 0.1,
    signal: input.signal,
  })
  if (!chat.ok) {
    return {
      adopted: false,
      awaitingApproval: false,
      judgments: [],
      excludeBriefKeys: [],
      raw: '',
      note: `复用闸失败：${chat.note}`,
    }
  }

  ingestKeyIncrementStatuses({
    job: 'reuse',
    llmText: chat.content,
    windowKeys: norms.map((n) => n.normKey),
    queryKey: input.queryKey,
  })

  let judgments = parseReuseJudgments(chat.content)
  if (judgments.length === 0 && /true|canSolve|能|不能|复用/i.test(chat.content)) {
    const hitTrue = /canSolve\s*[:=]\s*true|能解决|可以复用|足以回/i.test(
      chat.content,
    )
    judgments = norms.map((n, i) => ({
      pathKey: n.pathKey,
      inferKey: byPath.get(n.pathKey)?.inferKey ?? '',
      canSolve: hitTrue && i === 0,
      rationale: chat.content.trim().slice(0, 400),
    }))
  }

  const byNorm = new Map(norms.map((n) => [n.normKey, n]))
  const byPathKeyNorm = new Map(norms.map((n) => [n.pathKey, n]))
  const resolveNorm = (j: (typeof judgments)[0]) => {
    const nk = String((j as { normKey?: string }).normKey ?? '').trim()
    if (nk && byNorm.has(nk)) return byNorm.get(nk)!
    if (j.pathKey && byPathKeyNorm.has(j.pathKey)) {
      return byPathKeyNorm.get(j.pathKey)!
    }
    return null
  }

  const failedPaths = paths.filter((p) => {
    const n = byPathKeyNorm.get(p.pathKey)
    if (!n) return true
    const j = judgments.find((x) => resolveNorm(x)?.normKey === n.normKey)
    return !j || !j.canSolve
  })
  const excludeBriefKeys = input.docId
    ? briefKeysUsedByPaths({
        docId: input.docId,
        paths: failedPaths,
        prospects: st.prospects,
        inferEdges: st.inferEdges,
      })
    : [
        ...new Set(
          failedPaths.flatMap((path) => {
            const pr = st.prospects.find((p) => p.prospectKey === path.prospectKey)
            return pr?.briefKey ? [pr.briefKey] : []
          }),
        ),
      ]

  const wins = judgments.filter((j) => j.canSolve)
  if (wins.length === 0) {
    return {
      adopted: false,
      awaitingApproval: false,
      judgments,
      excludeBriefKeys,
      raw: chat.content,
      note: `复用闸：全部不够 · ${judgments.length} 条审过 → decide/infer`,
    }
  }

  // 先展示再批：挂起提案，不自动 adopt
  const queryKey =
    input.queryKey?.trim() ||
    useAttentionIo.getState().ensureQueryKey(input.qNow)
  const candidates: import('./attentionIoStore').PendingReuseCandidate[] = []
  for (const win of wins) {
    const n = resolveNorm(win)
    if (!n) continue
    const path = byPath.get(n.pathKey) || paths.find((p) => p.pathKey === n.pathKey)
    const inferEdge = path
      ? st.inferEdges.find((e) => e.inferKey === path.inferKey)
      : undefined
    const prospect = path
      ? st.prospects.find((p) => p.prospectKey === path.prospectKey)
      : undefined
    const bookKeys = [
      ...new Set([
        ...(inferEdge?.bookKeys ?? []),
        ...(prospect?.briefKey && input.docId
          ? (() => {
              const hit = mapBriefToBook(input.docId!, prospect.briefKey)
              return hit?.bookKey ? [hit.bookKey] : []
            })()
          : []),
      ]),
    ]
    candidates.push({
      normKey: n.normKey,
      pathKey: n.pathKey,
      oldQueryKey: path?.queryKey ?? n.queryKey,
      rationale: win.rationale || '',
      normText: n.text,
      bookKeys,
      inferKeys: path ? [path.inferKey] : [],
      prospectKeys: path ? [path.prospectKey] : [],
    })
  }
  if (candidates.length === 0) {
    return {
      adopted: false,
      awaitingApproval: false,
      judgments,
      excludeBriefKeys,
      raw: chat.content,
      note: `复用闸判可复用但无法组提案 · wins=${wins.length}`,
    }
  }

  useAttentionIo.getState().beginPendingReuseProposal({
    queryKey,
    question: input.qNow,
    candidates,
    excludeBriefKeys,
    createdAt: Date.now(),
  })

  const first = candidates[0]!
  return {
    adopted: false,
    awaitingApproval: true,
    queryKey,
    pathKey: first.pathKey,
    pathKeys: candidates.map((c) => c.pathKey),
    normKey: first.normKey,
    normKeys: candidates.map((c) => c.normKey),
    oldQueryKey: first.oldQueryKey,
    inferKeys: [...new Set(candidates.flatMap((c) => c.inferKeys))],
    prospectKeys: [...new Set(candidates.flatMap((c) => c.prospectKeys))],
    judgments,
    excludeBriefKeys: [],
    raw: chat.content,
    note: `复用提案挂起×${candidates.length} · 待批准（未铸 reuseKey）`,
  }
}

async function runMainInferAndSettle(input: {
  pkg: LetterDeskPackage
  bookIndex: BookIndex
  docId: string
  keys: ExpandedKey[]
  seeds: ThinSeed[]
  excludeInfers?: Array<{ inferKey: string; rationale: string }>
  queryKey?: string
  onProgress?: (msg: string) => void
  signal?: AbortSignal
}): Promise<{ part: string; note: string }> {
  const bookKeys = input.keys
    .filter((k) => k.kind === 'bookKey')
    .map((k) => k.key)

  const win = assembleWindow({
    docId: input.docId,
    bookIndex: input.bookIndex,
    job: 'infer',
    qNow: input.pkg.question,
    seeds: input.seeds,
    keys: input.keys,
    excludeInfers: input.excludeInfers,
  })
  input.onProgress?.('写信台 · infer · LLM…')
  const chat = await flashChat({
    system: win.systemPayload,
    user: win.userPayload,
    temperature: 0.15,
    maxTokens: 8192,
    retryOnEmpty: true,
    // thinking 全关：开则易 length 空 content，ι 落不成
    signal: input.signal,
  })
  if (!chat.ok) {
    return { part: `### infer 失败\n${chat.note}`, note: chat.note }
  }

  ingestKeyIncrementStatuses({
    job: 'infer',
    llmText: chat.content,
    windowKeys: bookKeys,
    queryKey: input.queryKey,
  })

  let paths = parseInferPaths(chat.content)
  if (paths.length === 0) {
    // 禁止 fallback 造伪槽（会把多段内容并进错误 key）
    void fallbackInferPaths
    return {
      part: `### infer · 未解析到输出槽\n禁止用兜底合并正文。请重跑。\n--- raw ---\n${chat.content.trim()}`,
      note: 'infer 无槽 · 未落账',
    }
  }
  const bookTexts: Record<string, string> = {}
  for (const bk of bookKeys) {
    bookTexts[bk] = fetchBookT(input.bookIndex, bk)
  }
  const settled = useAttentionIo.getState().settleInferPaths({
    question: input.pkg.question,
    paths,
    bookTexts,
    queryKey: input.queryKey,
    llmCallId: newLlmCallId('infer'),
  })

  // 不在此自动监督：挂起等人手确认；显式 skip 才跑监督铸 norm
  const userPaths = useAttentionIo
    .getState()
    .listPathsForQueryKey(settled.queryKey)
    .filter((p) => p.matchMode === 'user')
  const pending = useAttentionIo.getState().pendingPathMatch
  const pathNote =
    userPaths.length > 0
      ? `已有用户确认 path×${userPaths.length}`
      : pending
        ? `已铸候选 pathKey×${pending.pathKeys?.length ?? 0}；确认或「跳过」→监督铸 norm`
        : '无 path 挂起'

  return {
    part:
      `### infer · 落账\n` +
      `queryKey=\`${settled.queryKey}\`\n` +
      `inferKeys: ${settled.inferKeys.map((k) => `\`${k}\``).join(', ')}\n` +
      `pathKeys(candidate): ${(pending?.pathKeys ?? settled.pathKeys).map((k) => `\`${k}\``).join(', ') || '∅'}\n` +
      `pathKeys(user): ${userPaths.map((p) => `\`${p.pathKey}\``).join(', ') || '∅'}\n` +
      `${pathNote}\n` +
      `--- raw ---\n${chat.content.trim()}`,
    note: `settle infer · ${settled.inferKeys.length} · candPath×${pending?.pathKeys?.length ?? settled.pathKeys.length} · userPath×${userPaths.length} · pending=${pending ? 'yes' : 'no'} · qk=${settled.queryKey}`,
  }
}

/**
 * 用户明确跳过手工确认后：用挂起里已铸 pathKey → 监督 LLM → 充分则铸 normKey。
 */
export async function skipPendingPathMatchToSupervise(input?: {
  onProgress?: (msg: string) => void
}): Promise<{ pathKeys: string[]; normKeys?: string[]; note: string; raw: string }> {
  const st = useAttentionIo.getState()
  const pending = st.pendingPathMatch
  if (!pending) {
    const anyUser = st.paths.filter((p) => p.matchMode === 'user')
    if (anyUser.length > 0) {
      return {
        pathKeys: anyUser.map((p) => p.pathKey),
        note: '无挂起 · 已有用户 path',
        raw: '',
      }
    }
    return { pathKeys: [], note: '无挂起的 path 可跳过', raw: '' }
  }
  const qk = pending.queryKey
  const prePathKeys = pending.pathKeys
  const preBound = pending.boundPairs
  st.clearPendingPathMatch()
  return runPathMatchSuperviseIfNeeded({
    queryKey: qk,
    onProgress: input?.onProgress,
    force: true,
    prePathKeys,
    preBoundPairs: preBound,
  })
}

/**
 * 监督：在已铸 pathKey 上评信效度；充分则台铸 normKey（归一化推理）。
 */
export async function runPathMatchSuperviseIfNeeded(input: {
  queryKey: string
  onProgress?: (msg: string) => void
  /** true = 用户已显式跳过手工确认 */
  force?: boolean
  /** 跳过前挂起的 pathKey */
  prePathKeys?: string[]
  /** 兼容：挂起 boundPairs */
  preBoundPairs?: Array<{
    pathKey?: string
    inferKey: string
    prospectKey: string
    briefKey: string
    sharedBookKeys: string[]
  }>
  signal?: AbortSignal
}): Promise<{ pathKeys: string[]; normKeys?: string[]; note: string; raw: string }> {
  const st = useAttentionIo.getState()
  const qk = input.queryKey.trim()
  const existingUser = st
    .listPathsForQueryKey(qk)
    .filter((p) => p.matchMode === 'user')
  if (existingUser.length > 0) {
    const norms = st.listNormsForPathKeys(existingUser.map((p) => p.pathKey))
    return {
      pathKeys: existingUser.map((p) => p.pathKey),
      normKeys: norms.map((n) => n.normKey),
      note: `用户已确认 path×${existingUser.length} · 不触发信效度 LLM`,
      raw: '',
    }
  }
  if (st.pendingPathMatch && !input.force) {
    return {
      pathKeys: [],
      note: '仍在等待用户确认 path · 禁止自动评测（请 settleUserPathMatches 或 skipPendingPathMatchToSupervise）',
      raw: '',
    }
  }

  let candidates = st.paths.filter(
    (p) =>
      p.queryKey === qk &&
      (p.matchMode === 'candidate' || p.matchMode === 'user'),
  )
  if (input.prePathKeys && input.prePathKeys.length > 0) {
    const allow = new Set(input.prePathKeys)
    candidates = candidates.filter((p) => allow.has(p.pathKey))
  } else if (input.preBoundPairs && input.preBoundPairs.length > 0) {
    const allow = new Set(
      input.preBoundPairs.map((p) =>
        p.pathKey?.trim()
          ? p.pathKey.trim()
          : `${p.inferKey}::${p.prospectKey}`,
      ),
    )
    candidates = candidates.filter(
      (p) =>
        allow.has(p.pathKey) ||
        allow.has(`${p.inferKey}::${p.prospectKey}`),
    )
  }
  if (candidates.length === 0) {
    // 无候选则尝试现场绑定并先铸
    const docId = useIndexGate.getState().bookIndex?.docId?.trim() ?? ''
    if (docId) {
      const pending = st.beginPendingPathMatch({
        queryKey: qk,
        question: st.settledQueries[qk] ?? '',
        inferKeys: st.inferEdges
          .filter((e) => e.queryKey === qk)
          .map((e) => e.inferKey),
      })
      candidates = st.paths.filter((p) => pending.pathKeys.includes(p.pathKey))
      st.clearPendingPathMatch()
    }
  }
  if (candidates.length === 0) {
    return {
      pathKeys: [],
      note: '监督跳过 · 无候选 pathKey',
      raw: '',
    }
  }

  const allowedPath = new Set(candidates.map((p) => p.pathKey))
  const lines: string[] = [
    `queryKey=\`${qk}\``,
    `Q：${st.settledQueries[qk] ?? ''}`,
    '',
    '【台已铸 pathKey · 血缘已绑定】',
    '你只评信效度；充分时写归一化推理（infer 为底、prospect 修饰）。',
    '禁止增删 pathKey；禁止把 inferKey/prospectKey 当并列门牌回传。',
    '',
  ]
  for (const p of candidates) {
    const edge = st.inferEdges.find((e) => e.inferKey === p.inferKey)
    const pr = st.prospects.find((x) => x.prospectKey === p.prospectKey)
    lines.push(
      `── pathKey=\`${p.pathKey}\` ──\n` +
        `ι：${(edge?.infer || edge?.rationale || '').trim().slice(0, 400)}\n` +
        `prospect：${(pr?.text || '').trim().slice(0, 400)}\n`,
    )
  }
  lines.push(
    '\n只输出一个 JSON 对象（可 ```json 围栏），不要散文：\n' +
      '{\n' +
      '  "judgments": [\n' +
      '    { "pathKey": "ph_…", "status": "sufficient|insufficient", "normalizedText": "…" }\n' +
      '  ]\n' +
      '}\n' +
      '须覆盖上方每一 pathKey；sufficient 必须带 normalizedText → 台铸 normKey。',
  )

  input.onProgress?.('写信台 · 监督 · pathKey 信效度+归一化…')
  const chat = await flashChat({
    system: [
      '你是监督：pathKey 已由写信台按材料血缘铸好。',
      '只判信效度；充分则写归一化推理（infer 为底、prospect 修饰），供 reuse 省 token。',
      '只输出合法 JSON（judgments）；thinking 关闭场景下务必完整闭合括号。',
    ].join('\n'),
    user: lines.join('\n'),
    temperature: 0.1,
    maxTokens: 8192,
    retryOnEmpty: true,
    signal: input.signal,
  })
  if (!chat.ok) {
    return { pathKeys: [], note: `监督失败：${chat.note}`, raw: '' }
  }

  ingestKeyIncrementStatuses({
    job: 'supervise',
    llmText: chat.content,
    windowKeys: candidates.map((p) => p.pathKey),
    queryKey: qk,
  })

  const pairToPath = new Map(
    candidates.map((p) => [`${p.inferKey}::${p.prospectKey}`, p.pathKey] as const),
  )
  const judgments = parsePathValidityJudgments(chat.content).map((j) => {
    let pathKey = (j.pathKey ?? '').trim()
    if (!pathKey && j.inferKey && j.prospectKey) {
      pathKey = pairToPath.get(`${j.inferKey}::${j.prospectKey}`) ?? ''
    }
    return { ...j, pathKey }
  })
  const mapped = judgments.filter((j) => j.pathKey && allowedPath.has(j.pathKey))
  if (mapped.length === 0) {
    return {
      pathKeys: candidates.map((p) => p.pathKey),
      note: `监督 · 候选 path×${candidates.length} · 无有效 judgments`,
      raw: chat.content,
    }
  }

  const llmCallId = newLlmCallId('supervise')
  const confirmed = useAttentionIo.getState().confirmSupervisePaths({
    queryKey: qk,
    llmCallId,
    judgments: mapped.map((j) => ({
      pathKey: j.pathKey!,
      status: j.status,
      normalizedText: j.normalizedText,
    })),
  })
  useAttentionIo.getState().clearPendingPathMatch()
  return {
    pathKeys: confirmed.pathKeys,
    normKeys: confirmed.normKeys,
    note: `${confirmed.note} · 候选×${candidates.length}`,
    raw: chat.content,
  }
}

/** 薄包 → 台调度 → LLM（正文仅此处 fetch） */
export async function dispatchLetterDesk(input: {
  docId: string
  bookIndex: BookIndex
  packages: LetterDeskPackage[]
  /** 调度条上的补充说明；默认用各包 question */
  dispatcherNote?: string
  /** 本轮已铸 queryKey（方案 B）；缺则各 settle 自铸 */
  turnQueryKey?: string
  onProgress?: (msg: string) => void
  /** 并行早停：取消本包未完成的 LLM fetch */
  signal?: AbortSignal
}): Promise<{ ok: boolean; answer: string; note: string }> {
  if (input.packages.length === 0) {
    return { ok: false, answer: '', note: '写信台无薄指令包' }
  }

  const parts: string[] = []
  const notes: string[] = []
  const turnQueryKey = input.turnQueryKey?.trim() || undefined

  for (const pkg of input.packages) {
    if (input.signal?.aborted) {
      notes.push('写信台 · 已取消（早停）')
      break
    }
    input.onProgress?.(`写信台 · ${pkg.job} · expand…`)
    const seeds: ThinSeed[] = [
      {
        bookKey: pkg.bookKey || undefined,
        briefKey: pkg.briefKey || undefined,
        question: pkg.question,
        job: pkg.job,
        versionIndex: pkg.versionIndex,
        onlyBriefKeys: pkg.onlyBriefKeys,
        onlyBookKeys: pkg.onlyBookKeys,
        decideCritiqueHint: pkg.decideCritiqueHint,
        avoidProspectTexts: pkg.avoidProspectTexts,
      },
    ]
    const { keys, note: expNote } = expandSeedsForJob({
      docId: input.docId,
      job: pkg.job,
      seeds,
      queryKey: turnQueryKey,
    })
    notes.push(expNote)
    if (keys.length === 0) {
      parts.push(
        `### ${pkg.job} · 无法组窗（expand 空）\nseed book=${pkg.bookKey} brief=${pkg.briefKey}`,
      )
      continue
    }

    if (pkg.job === 'infer') {
      // infer；reuse 在前；再开时必排本问族已有 ι（狭义推理记忆，≠ reuse）
      const { priorInferKeysForQuery } = await import('./superviseCritique')
      const qkForPrior =
        turnQueryKey ||
        useAttentionIo.getState().findQueryKeyForQuestion(pkg.question) ||
        ''
      const priorIk = qkForPrior ? priorInferKeysForQuery(qkForPrior) : []
      const wantExclude = [
        ...new Set([
          ...(pkg.excludeMode === 'B' ? pkg.excludeInferKeys ?? [] : []),
          ...priorIk,
        ]),
      ]

      // 显式玩法 B / 监督换推：跳过 reuse，直开带排除的 infer
      const forceExcludeInfer =
        pkg.excludeMode === 'B' && (pkg.excludeInferKeys?.length ?? 0) > 0

      if (!forceExcludeInfer) {
        const priorPaths = listCandidatePathsViaNeighbours(turnQueryKey)
        if (priorPaths.length > 0) {
          const gate = await runReuseGate({
            qNow: pkg.question,
            docId: input.docId,
            queryKey: turnQueryKey,
            onProgress: input.onProgress,
            signal: input.signal,
          })
          notes.push(gate.note)
          if (gate.awaitingApproval) {
            parts.push(
              `### 复用 · 提案挂起 ×${gate.normKeys?.length ?? 1}（待批准，未开 infer）\n` +
                `现 queryKey=\`${gate.queryKey}\`\n` +
                `normKeys: ${(gate.normKeys ?? []).map((k) => `\`${k}\``).join(', ')}\n` +
                `pathKeys: ${(gate.pathKeys ?? [gate.pathKey]).map((k) => `\`${k}\``).join(', ')}\n` +
                `--- gate raw ---\n${gate.raw.trim()}`,
            )
            notes.push('等待用户批准复用')
            continue
          }
          if (gate.adopted) {
            parts.push(
              `### 复用 · 采纳旧 path ×${gate.pathKeys?.length ?? 1}（未开新 infer）\n` +
                `现 queryKey=\`${gate.queryKey}\`\n` +
                `pathKeys: ${(gate.pathKeys ?? [gate.pathKey]).map((k) => `\`${k}\``).join(', ')}\n` +
                `reuseKeys: ${(gate.reuseKeys ?? [gate.reuseKey]).map((k) => `\`${k}\``).join(', ')}\n` +
                `依据：${gate.judgments.filter((j) => j.canSolve).map((j) => j.rationale).join('；')}\n` +
                `--- gate raw ---\n${gate.raw.trim()}`,
            )
            continue
          }
          parts.push(
            `### 复用未采纳 → infer\n` +
              `${gate.note}` +
              (gate.excludeBriefKeys.length
                ? ` · 已标剔 brief×${gate.excludeBriefKeys.length}（供 decide 前置，不进 infer 窗）`
                : '') +
              `\n` +
              (gate.raw ? `--- gate raw ---\n${gate.raw.trim()}\n` : ''),
          )
        } else {
          notes.push('复用跳过·无 neighbour→path')
        }
      }

      if (wantExclude.length > 0) {
        const want = new Set(wantExclude)
        const all = useAttentionIo.getState().inferEdges
        const excludeInfers = all
          .filter((e) => want.has(e.inferKey))
          .map((e) => ({
            inferKey: e.inferKey,
            rationale: e.infer || e.rationale,
          }))
        if (excludeInfers.length === 0 && forceExcludeInfer) {
          parts.push(
            `### infer · 拒绝无差分重跑\n排除键无法解析。请钉住 ι 或走监督归因。`,
          )
          notes.push('infer 拒绝 · 排除集空解析')
          continue
        }
        if (excludeInfers.length > 0) {
          notes.push(
            `infer 必排先验 ι×${excludeInfers.length}` +
              (forceExcludeInfer ? ' · 玩法B/监督' : ' · 自动'),
          )
          const main = await runMainInferAndSettle({
            pkg,
            bookIndex: input.bookIndex,
            docId: input.docId,
            keys,
            seeds,
            excludeInfers,
            queryKey: turnQueryKey,
            onProgress: input.onProgress,
            signal: input.signal,
          })
          parts.push(main.part)
          notes.push(main.note)
          continue
        }
      }

      // 首次 infer（无先验 ι）
      const main = await runMainInferAndSettle({
        pkg,
        bookIndex: input.bookIndex,
        docId: input.docId,
        keys,
        seeds,
        queryKey: turnQueryKey,
        onProgress: input.onProgress,
        signal: input.signal,
      })
      parts.push(main.part)
      notes.push(main.note)
      continue
    }

    const win = assembleWindow({
      docId: input.docId,
      bookIndex: input.bookIndex,
      job: pkg.job,
      qNow: pkg.question,
      seeds,
      keys,
      decideCritiqueHint:
        pkg.job === 'decide'
          ? pkg.decideCritiqueHint || seeds[0]?.decideCritiqueHint
          : undefined,
    })
    notes.push(win.note)
    input.onProgress?.(`写信台 · ${pkg.job} · LLM…`)
    const chat = await flashChat({
      system: win.systemPayload,
      user: win.userPayload,
      temperature: 0.15,
      // decide 12 条 prospect JSON 易撞 length；与 infer 同档
      maxTokens: pkg.job === 'decide' ? 8192 : undefined,
      // thinking 默认关（decide/infer 亦关；见实测全关更稳）
      signal: input.signal,
    })
    if (!chat.ok) {
      parts.push(`### ${pkg.job} 失败\n${chat.note}`)
    } else {
      ingestKeyIncrementStatuses({
        job: pkg.job,
        llmText: chat.content,
        windowKeys: keys.map((k) => k.key),
        queryKey:
          turnQueryKey ||
          useAttentionIo.getState().findQueryKeyForQuestion(pkg.question) ||
          undefined,
      })
      // 一槽一 key：写信台路径也必须 settle，禁止只吐文本不落账
      if (pkg.job === 'decide') {
        const { parseDecideOutcome } = await import('./autoFlow')
        const { filterKeepsAvoidingBadProspects } = await import(
          './prospectIsomorph'
        )
        const decideOut = parseDecideOutcome(chat.content)
        const allowed = keys
          .filter((k) => k.kind === 'briefKey')
          .map((k) => k.key)
        const avoid = pkg.avoidProspectTexts ?? []
        let keeps = decideOut.keeps
        let isoRejected: Array<{ briefKey: string; reason: string }> = []
        let rawForLog = chat.content
        let truncated = chat.finishReason === 'length'

        // 解析失败或截断空窗 → 缩短 prospect 再打一轮（不换材料）
        if (
          (!decideOut.ok || keeps.length === 0 || truncated) &&
          !pkg.edgeId.includes('_json_retry')
        ) {
          input.onProgress?.(
            truncated
              ? '写信台 · decide JSON 截断 → 缩短重试…'
              : '写信台 · decide JSON 不可解析 → 缩短重试…',
          )
          const retryHint =
            (pkg.decideCritiqueHint || '') +
            '\n【JSON 抢救重试】上一轮输出无法完整解析或被截断。' +
            '每个 prospect 单行≤30字；禁止换行与字符串内双引号；' +
            '必须输出完整可解析 JSON；写不完就少写几条，保证括号闭合。' +
            '若 brief 含与 Q 相关专名（如 Lacan/拉康/freudo-lacanien），必须 sufficient 并写明「提到…」。'
          const retryWin = assembleWindow({
            docId: input.docId,
            bookIndex: input.bookIndex,
            job: 'decide',
            qNow: pkg.question,
            seeds,
            keys,
            decideCritiqueHint: retryHint,
          })
          const retryChat = await flashChat({
            system: retryWin.systemPayload,
            user: retryWin.userPayload,
            temperature: 0.1,
            maxTokens: 8192,
            signal: input.signal,
          })
          if (retryChat.ok) {
            const retryOut = parseDecideOutcome(retryChat.content)
            if (retryOut.keeps.length > 0 || retryOut.ok) {
              keeps = retryOut.keeps
              rawForLog = retryChat.content
              truncated = retryChat.finishReason === 'length'
              ingestKeyIncrementStatuses({
                job: 'decide',
                llmText: retryChat.content,
                windowKeys: keys.map((k) => k.key),
                queryKey:
                  turnQueryKey ||
                  useAttentionIo
                    .getState()
                    .findQueryKeyForQuestion(pkg.question) ||
                  undefined,
              })
              parts.push(
                `### decide · JSON重试\nkeeps ${keeps.length} · finish=${retryChat.finishReason}\n--- raw ---\n${retryChat.content.trim()}`,
              )
            }
          }
        }

        if (avoid.length > 0) {
          const filtered = filterKeepsAvoidingBadProspects(keeps, avoid)
          keeps = filtered.kept
          isoRejected = filtered.rejected
          // 全部同构 → 加强提示再 decide 一次
          if (
            keeps.length === 0 &&
            isoRejected.length > 0 &&
            !pkg.edgeId.includes('_iso_retry')
          ) {
            input.onProgress?.(
              '写信台 · reframe 同构拒铸 → 加强尸检再 decide…',
            )
            const retryHint =
              (pkg.decideCritiqueHint || '') +
              '\n【硬闸重试】上一轮 prospect 与坏框同构已被拒铸。必须给出明显不同的解题可能；禁止复述旧 prospect。'
            const retryWin = assembleWindow({
              docId: input.docId,
              bookIndex: input.bookIndex,
              job: 'decide',
              qNow: pkg.question,
              seeds,
              keys,
              decideCritiqueHint: retryHint,
            })
            const retryChat = await flashChat({
              system: retryWin.systemPayload,
              user: retryWin.userPayload,
              temperature: 0.2,
              maxTokens: 8192,
              signal: input.signal,
            })
            if (retryChat.ok) {
              const retryOut = parseDecideOutcome(retryChat.content)
              const again = filterKeepsAvoidingBadProspects(
                retryOut.keeps,
                avoid,
              )
              keeps = again.kept
              isoRejected = [...isoRejected, ...again.rejected]
              rawForLog = retryChat.content
              ingestKeyIncrementStatuses({
                job: 'decide',
                llmText: retryChat.content,
                windowKeys: keys.map((k) => k.key),
                queryKey:
                  turnQueryKey ||
                  useAttentionIo
                    .getState()
                    .findQueryKeyForQuestion(pkg.question) ||
                  undefined,
              })
              parts.push(
                `### decide · 同构重试\n保留 ${keeps.length} · 仍拒 ${again.rejected.length}\n--- raw ---\n${retryChat.content.trim()}`,
              )
            }
          }
        }
        const settled = useAttentionIo.getState().settleProspects({
          question: pkg.question,
          queryKey: turnQueryKey,
          llmCallId: newLlmCallId('decide'),
          keeps,
          allowedBriefKeys: allowed,
        })
        notes.push(
          `prospect×${settled.prospectKeys.length}` +
            (settled.rejected.length || isoRejected.length
              ? ` · 拒${settled.rejected.length + isoRejected.length}`
              : '') +
            (isoRejected.length ? ` · 同构${isoRejected.length}` : '') +
            (truncated ? ' · truncated' : '') +
            (!decideOut.ok && keeps.length === 0
              ? ` · parse:${decideOut.note}`
              : ''),
        )
        parts.push(
          `### decide · 落账\nprospectKeys: ${settled.prospectKeys.map((k) => `\`${k}\``).join(', ') || '∅'}` +
            (isoRejected.length
              ? `\n同构拒：${isoRejected.map((r) => `${r.briefKey}(${r.reason})`).join('; ')}`
              : '') +
            (truncated ? `\nfinish_reason=length（已尽量抢救完整行）` : '') +
            `\n--- raw ---\n${rawForLog.trim()}`,
        )
      } else if (pkg.job === 'query') {
        const rows = parseQueryNeighbours(chat.content)
        const nb = useAttentionIo.getState().settleNeighbours({
          nowQuestion: pkg.question,
          nowQueryKey: turnQueryKey,
          llmCallId: newLlmCallId('query'),
          neighbours: rows.map((n) => ({
            historicQueryKey: n.queryKey,
            degree: n.degree,
          })),
        })
        notes.push(`neighbour×${nb.neighbourKeys.length}`)
        parts.push(
          `### query · 落账\nneighbourKeys: ${nb.neighbourKeys.map((k) => `\`${k}\``).join(', ') || '∅'}\n--- raw ---\n${chat.content.trim()}`,
        )
      } else if (pkg.job === 'peek') {
        const bookKeys = keys
          .filter((k) => k.kind === 'bookKey')
          .map((k) => k.key)
        const peekCallId = newLlmCallId('peek')
        const peekSettled = settlePeekItemsFromLlm({
          docId: input.docId,
          llmText: chat.content,
          allowedBookKeys: bookKeys,
        })
        notes.push(peekSettled.note)
        parts.push(
          `### peek · 落账\nbriefKeys: ${peekSettled.items.map((i) => `\`${i.briefKey}\``).join(', ') || '∅'}\nllmCallId: \`${peekCallId}\`\n--- raw ---\n${chat.content.trim()}`,
        )
      } else {
        parts.push(`### ${pkg.job} · out\n${chat.content.trim()}`)
      }
    }
  }

  const joined = parts.join('\n\n')
  const q =
    input.packages.map((p) => p.question.trim()).find(Boolean) ||
    input.dispatcherNote?.trim() ||
    ''
  // 整条路径落账（新铸 qk 或复用旧 qk）后：有向增量原文回填调度台
  const answer =
    q && notesIndicatePathSettled(notes)
      ? formatDirectedPathIncrementReturn({
          question: q,
          hopOutputs: hopsFromAnswerParts(parts),
          mode: 'auto',
        })
      : joined

  return {
    ok: parts.length > 0,
    answer,
    note: notes.join(' · '),
  }
}

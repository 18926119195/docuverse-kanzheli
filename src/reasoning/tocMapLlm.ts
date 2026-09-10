/**
 * toc_map：用户框选目录相关渲染页（strand）→ LLM 出章/节标题 + strand 起止。
 * 主坐标 = strandIndex（= A1 chunk.page / 机器牌），不是书上印码。
 */

import type { BookIndex } from './pipelineA'
import { demoAuthHeaders } from './demoAuth'
import { llmThinkingField } from './llmThinking'
import {
  loadDualModelConfig,
  reasonEndpointReady,
  LOCKED_LLM,
} from './modelRuntimeConfig'
import { extractJsonObject } from './inferPath'
import {
  emptyTocEntry,
  fillEndStrand,
  type TocEntryDraft,
} from './tocParse'

async function flashChat(input: {
  system: string
  user: string
}): Promise<{ ok: true; content: string } | { ok: false; note: string }> {
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
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: reason.model || LOCKED_LLM.chatModel,
        temperature: 0.1,
        max_tokens: 8192,
        ...llmThinkingField('disabled'),
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
      }),
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
    const content = (
      data as { choices: Array<{ message?: { content?: string } }> }
    ).choices[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, note: 'LLM 空内容' }
    }
    return { ok: true, content }
  } catch (e) {
    return {
      ok: false,
      note: e instanceof Error ? e.message : 'LLM 请求失败',
    }
  }
}

/** 每页抽 1～2 个 bookKey 锚，帮模型对齐 strand↔正文位置（非整表） */
function sampleBookKeysByStrand(
  bookIndex: BookIndex,
  strands: number[],
): string {
  const lines: string[] = []
  for (const s of strands) {
    const chunks = bookIndex.chunks.filter((c) => c.page === s)
    if (chunks.length === 0) {
      lines.push(`strand=${s} · （本页无 A1 key）`)
      continue
    }
    const first = chunks[0]!.key
    const last = chunks[chunks.length - 1]!.key
    lines.push(
      last === first
        ? `strand=${s} · key=\`${first}\``
        : `strand=${s} · key首=\`${first}\` · key尾=\`${last}\``,
    )
  }
  return lines.join('\n')
}

function parseTocMapSections(
  raw: string,
  maxStrand: number,
): TocEntryDraft[] {
  const obj = extractJsonObject(raw)
  if (!obj || typeof obj !== 'object') return []
  const root = obj as Record<string, unknown>
  const arr = Array.isArray(root.sections) ? root.sections : []
  const drafts: TocEntryDraft[] = []
  for (let i = 0; i < arr.length; i++) {
    const row = arr[i]
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const title = String(r.title ?? '').trim()
    if (!title) continue
    let start = Number(r.startStrand ?? r.start_page ?? r.startPage)
    let end = Number(r.endStrand ?? r.end_page ?? r.endPage)
    if (!Number.isFinite(start)) start = 0
    if (!Number.isFinite(end)) end = start
    start = Math.max(0, Math.min(maxStrand, Math.floor(start)))
    end = Math.max(0, Math.min(maxStrand, Math.floor(end)))
    if (end < start) [start, end] = [end, start]
    const level = Math.max(1, Math.min(6, Number(r.level) || 1))
    drafts.push({
      id: `toc_llm_${Date.now().toString(36)}_${i}`,
      title: title.slice(0, 160),
      startStrand: start,
      endStrand: end,
      /** 展示用：机器牌 1-based；不当主坐标 */
      startPrinted: start + 1,
      endPrinted: end + 1,
      level,
    })
  }
  return fillEndStrand(drafts, maxStrand)
}

/**
 * 选中的目录页文本 → LLM → 章/节 + strand 起止。
 */
export async function runTocMapLlm(input: {
  tocStrands: number[]
  pageText: (strand: number) => string
  bookIndex: BookIndex
  maxStrand: number
  onProgress?: (msg: string) => void
}): Promise<{
  ok: boolean
  entries: TocEntryDraft[]
  note: string
  raw: string
}> {
  const strands = [...new Set(input.tocStrands)]
    .filter((s) => s >= 0 && s <= input.maxStrand)
    .sort((a, b) => a - b)
  if (strands.length === 0) {
    return {
      ok: false,
      entries: [],
      note: '请先点选至少一页目录（strand）',
      raw: '',
    }
  }

  input.onProgress?.(`toc_map · 读目录页×${strands.length}…`)

  const pageBlocks = strands.map((s) => {
    const text = input.pageText(s).trim() || '（本页无文本/OCR）'
    return `【目录相关页 · strand=${s} · 机器第 ${s + 1} 张牌】\n${text.slice(0, 6000)}`
  })

  // 全书每页抽锚（帽）：避免漏掉正文界；页多则稀疏
  const allStrands: number[] = []
  const step = Math.max(1, Math.ceil((input.maxStrand + 1) / 40))
  for (let s = 0; s <= input.maxStrand; s += step) allStrands.push(s)
  if (!allStrands.includes(input.maxStrand)) allStrands.push(input.maxStrand)

  const system = [
    '你是目录分节员 toc_map。',
    '用户已框选与目录有关的 PDF 渲染页；页的主坐标是 strandIndex（机器牌序号，从 0 起），不是书上印的页码。',
    '请抽出有序章/节标题，并为每一节给出正文在全书中的起止 strand（闭区间）。',
    '禁止编造目录页未出现的标题；不确定则该节 status=insufficient 仍可给近似界。',
    '只输出一个 JSON 对象，不要散文。',
  ].join('\n')

  const user = [
    `【全书机器牌范围】strand 0 … ${input.maxStrand}（含）`,
    '',
    '【目录相关页 OCR/文本】',
    ...pageBlocks,
    '',
    '【书序锚点抽样 · bookKey（帮助对齐 strand，须原样理解勿编造）】',
    sampleBookKeysByStrand(input.bookIndex, allStrands),
    '',
    '只输出 JSON：',
    '{',
    '  "tocStrandsUsed": [0,1],',
    '  "sections": [',
    '    { "ord": 0, "title": "章/节名", "level": 1, "startStrand": 10, "endStrand": 40, "status": "sufficient" }',
    '  ],',
    '  "unresolved": [],',
    '  "attentionArrived": true',
    '}',
    '硬规则：startStrand/endStrand 必须是整数且落在 0…maxStrand；节按书序排列、尽量不重叠；',
    'endStrand 可用下一节 startStrand-1；最后一节可到 maxStrand。',
  ].join('\n')

  input.onProgress?.('toc_map · LLM 分节…')
  const chat = await flashChat({ system, user })
  if (!chat.ok) {
    return { ok: false, entries: [], note: chat.note, raw: '' }
  }

  let entries = parseTocMapSections(chat.content, input.maxStrand)
  if (entries.length === 0) {
    entries = [
      {
        ...emptyTocEntry(0),
        startStrand: 0,
        endStrand: input.maxStrand,
        startPrinted: 1,
        endPrinted: input.maxStrand + 1,
      },
    ]
    return {
      ok: false,
      entries,
      note: 'toc_map 未能解析 JSON · 已给全书占位行，请手改 strand',
      raw: chat.content,
    }
  }

  return {
    ok: true,
    entries,
    note: `toc_map · 分节×${entries.length} · 目录页 strand ${strands.join(',')}`,
    raw: chat.content,
  }
}

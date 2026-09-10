/**
 * Parse TOC-ish OCR / text into editable chapter rows.
 * 主坐标 = strandIndex（机器牌 / A1 page）；印码仅展示或校准副轨。
 */

export interface TocEntryDraft {
  id: string
  title: string
  /**
   * 正文起止 · 机器牌 strand（闭区间）。toc_map / 冷启分配以此为准。
   * 缺省时由 startPrinted + calibration 换算。
   */
  startStrand?: number
  endStrand?: number
  /** Inclusive printed start（副轨；书上印码） */
  startPrinted: number
  /** Inclusive printed end */
  endPrinted: number
  /** 目录层级：1=章 … */
  level?: number
}

function newId(): string {
  return `toc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * Pull "title …. 12" / "第一章  15" style lines from raw page text.
 * @deprecated 主路径用 toc_map LLM；本函数仅备胎。
 */
export function parseTocText(raw: string): TocEntryDraft[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 2)

  const entries: TocEntryDraft[] = []
  for (const line of lines) {
    const m = line.match(/^(.*?)[\s.·…．。\-—–]*(\d{1,4})\s*$/)
    if (!m) continue
    const title = m[1].replace(/[\s.·…．。\-—–]+$/g, '').trim()
    const startPrinted = Number(m[2])
    if (!title || !Number.isFinite(startPrinted) || startPrinted < 0) continue
    if (title.length < 1 || /^\d+$/.test(title)) continue
    entries.push({
      id: newId(),
      title: title.slice(0, 120),
      startPrinted,
      endPrinted: startPrinted,
    })
  }

  return fillEndPrinted(entries)
}

/** endPrinted = next.start - 1 (last keeps start until caller sets max). */
export function fillEndPrinted(
  entries: TocEntryDraft[],
  lastEndFallback?: number,
): TocEntryDraft[] {
  const sorted = [...entries].sort((a, b) => a.startPrinted - b.startPrinted)
  return sorted.map((e, i) => {
    const next = sorted[i + 1]
    const endPrinted = next
      ? Math.max(e.startPrinted, next.startPrinted - 1)
      : lastEndFallback != null
        ? Math.max(e.startPrinted, lastEndFallback)
        : e.endPrinted || e.startPrinted
    return { ...e, endPrinted }
  })
}

/** strand 闭区间：下一节起点 −1；末节用 lastStrandFallback */
export function fillEndStrand(
  entries: TocEntryDraft[],
  lastStrandFallback?: number,
): TocEntryDraft[] {
  const sorted = [...entries].sort(
    (a, b) =>
      (a.startStrand ?? a.startPrinted) - (b.startStrand ?? b.startPrinted),
  )
  return sorted.map((e, i) => {
    const start =
      e.startStrand != null && Number.isFinite(e.startStrand)
        ? e.startStrand
        : Math.max(0, e.startPrinted - 1)
    const next = sorted[i + 1]
    const nextStart =
      next?.startStrand != null && Number.isFinite(next.startStrand)
        ? next.startStrand
        : next
          ? Math.max(0, next.startPrinted - 1)
          : null
    const endStrand =
      nextStart != null
        ? Math.max(start, nextStart - 1)
        : lastStrandFallback != null
          ? Math.max(start, lastStrandFallback)
          : e.endStrand != null
            ? e.endStrand
            : start
    return {
      ...e,
      startStrand: start,
      endStrand,
      startPrinted: start + 1,
      endPrinted: endStrand + 1,
    }
  })
}

export function emptyTocEntry(startStrand = 0): TocEntryDraft {
  return {
    id: newId(),
    title: '新章节',
    startStrand,
    endStrand: startStrand,
    startPrinted: startStrand + 1,
    endPrinted: startStrand + 1,
    level: 1,
  }
}

/** 条目是否已带可用 strand 界 */
export function tocEntryHasStrand(e: TocEntryDraft): boolean {
  return (
    e.startStrand != null &&
    e.endStrand != null &&
    Number.isFinite(e.startStrand) &&
    Number.isFinite(e.endStrand)
  )
}

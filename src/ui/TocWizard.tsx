/**
 * 建库向导 · 目录分节（toc_map）：
 * 触控多选目录相关 PDF 渲染页（strand）→ LLM 出章/节标题 + strand 起止 → 确认落 memberKeys。
 * 主坐标 = strandIndex（机器牌），不是书上印码。
 */

import { useEffect, useMemo, useState } from 'react'
import { useDocuverse } from '../canvas/store'
import { useIndexGate } from '../reasoning/indexGate'
import {
  emptyTocEntry,
  fillEndStrand,
  type TocEntryDraft,
} from '../reasoning/tocParse'
import { runTocMapLlm } from '../reasoning/tocMapLlm'
import { atomSearchText } from '../reasoning/hybridRetrieve'

type Step = 'pick_toc' | 'edit' | 'preview'

export function TocWizard() {
  const open = useIndexGate((s) => s.tocWizardOpen)
  const tocStatus = useIndexGate((s) => s.tocStatus)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const confirmTocWizard = useIndexGate((s) => s.confirmTocWizard)
  const skipTocWizard = useIndexGate((s) => s.skipTocWizard)
  const closeTocWizard = useIndexGate((s) => s.closeTocWizard)

  const pages = useDocuverse((s) => s.pages)
  const currentStrand = useDocuverse((s) => s.currentStrand)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)
  const ocrByStrand = useDocuverse((s) => s.ocrByStrand)

  const [step, setStep] = useState<Step>('pick_toc')
  const [tocStrands, setTocStrands] = useState<number[]>([])
  const [entries, setEntries] = useState<TocEntryDraft[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setStep('pick_toc')
    setErr(null)
    setStatus(null)
  }, [open])

  const maxStrand = useMemo(() => {
    if (!bookIndex?.chunks.length) return Math.max(0, pages.length - 1)
    return Math.max(0, ...bookIndex.chunks.map((c) => c.page))
  }, [bookIndex, pages.length])

  const previewRows = useMemo(() => {
    if (entries.length === 0 || !bookIndex) return []
    const filled = fillEndStrand(entries, maxStrand)
    return filled.map((e) => {
      const startPage = e.startStrand ?? 0
      const endPage = e.endStrand ?? startPage
      let keyCount = 0
      for (const c of bookIndex.chunks) {
        if (c.page >= startPage && c.page <= endPage) keyCount += 1
      }
      return { ...e, startPage, endPage, keyCount }
    })
  }, [entries, bookIndex, maxStrand])

  if (!open || tocStatus === 'confirmed') return null

  const pageText = (strand: number): string => {
    const ocr = ocrByStrand[strand]
    if (ocr?.blocks?.length) {
      return ocr.blocks.map((b) => b.content || '').join('\n')
    }
    const page = pages.find((p) => p.strandIndex === strand)
    if (page?.textChunks?.length) {
      return page.textChunks.map((c) => c.content).join('\n')
    }
    if (bookIndex) {
      return bookIndex.chunks
        .filter((c) => c.page === strand)
        .map((c) => atomSearchText(c))
        .join('\n')
    }
    return page?.text ?? ''
  }

  const toggleTocStrand = (s: number) => {
    setTocStrands((prev) =>
      prev.includes(s)
        ? prev.filter((x) => x !== s)
        : [...prev, s].sort((a, b) => a - b),
    )
  }

  const onRunTocMap = async () => {
    setErr(null)
    if (!bookIndex) {
      setErr('尚无 A1 索引')
      return
    }
    if (tocStrands.length === 0) {
      setErr('请至少点选一页与目录有关的渲染页')
      return
    }
    setBusy(true)
    try {
      const res = await runTocMapLlm({
        tocStrands,
        pageText,
        bookIndex,
        maxStrand,
        onProgress: (m) => setStatus(m),
      })
      setEntries(res.entries)
      setStatus(res.note)
      if (!res.ok) setErr(res.note)
      setStep('edit')
    } finally {
      setBusy(false)
    }
  }

  const onConfirm = () => {
    setErr(null)
    const filled = fillEndStrand(entries, maxStrand)
    const r = confirmTocWizard(filled)
    if (!r.ok) setErr(r.error || '确认失败')
  }

  const thumbLimit = Math.min(pages.length, 80)

  return (
    <div className="toc-wizard-backdrop" role="dialog" aria-modal="true">
      <div className="toc-wizard">
        <header className="toc-wizard-head">
          <div>
            <div className="toc-wizard-title">建库向导 · 目录分节（toc_map）</div>
            <div className="toc-wizard-sub">
              点选目录相关 PDF 渲染页 → LLM 输出章/节标题与{' '}
              <strong>strand</strong>（机器牌）起止 → 确认后分配 bookKey。印码不作为主坐标。
            </div>
          </div>
          <button
            type="button"
            className="fanout-btn"
            onClick={() => skipTocWizard()}
          >
            跳过（整书冷启兜底）
          </button>
        </header>

        <nav className="toc-wizard-steps">
          <span className={step === 'pick_toc' ? 'on' : ''}>① 选目录页</span>
          <span className={step === 'edit' ? 'on' : ''}>② 核对 strand</span>
          <span className={step === 'preview' ? 'on' : ''}>③ 确认</span>
        </nav>

        {step === 'pick_toc' && (
          <section className="toc-wizard-body">
            <p className="toc-wizard-p">
              在下方缩略图<strong>多选</strong>所有与目录有关的渲染页（总目、续目等）。点选会
              swoop 到该页；再次点击取消。当前球上页：strand {currentStrand}（机器第{' '}
              {currentStrand + 1} 张）。
            </p>
            <div className="toc-thumb-row">
              {pages.slice(0, thumbLimit).map((p) => (
                <button
                  key={p.strandIndex}
                  type="button"
                  className={
                    tocStrands.includes(p.strandIndex)
                      ? 'toc-thumb on'
                      : 'toc-thumb'
                  }
                  onClick={() => {
                    swoopToPage(p.strandIndex)
                    toggleTocStrand(p.strandIndex)
                  }}
                  title={`strand ${p.strandIndex}`}
                >
                  {p.imageUrl ? (
                    <img src={p.imageUrl} alt="" />
                  ) : (
                    <span>s{p.strandIndex}</span>
                  )}
                  <em>{p.strandIndex}</em>
                </button>
              ))}
            </div>
            <p className="toc-wizard-p">
              已选 strand：
              {tocStrands.length ? tocStrands.join(', ') : '无'}
            </p>
            <div className="toc-wizard-actions">
              <button
                type="button"
                className="fanout-btn primary"
                disabled={busy || tocStrands.length === 0}
                onClick={() => void onRunTocMap()}
              >
                {busy ? 'toc_map 分节中…' : '送入 toc_map LLM →'}
              </button>
            </div>
            {status ? <p className="toc-wizard-p">{status}</p> : null}
          </section>
        )}

        {step === 'edit' && (
          <section className="toc-wizard-body">
            <p className="toc-wizard-p">
              核对章/节名与 <strong>strand 起止</strong>（闭区间）。结束页默认可由下一节起点
              −1 自动填。
            </p>
            <div className="toc-entry-table">
              <div className="toc-entry-head toc-entry-head-strand">
                <span>章/节名</span>
                <span>起 strand</span>
                <span>止 strand</span>
                <span />
              </div>
              {entries.map((e, i) => (
                <div key={e.id} className="toc-entry-row toc-entry-row-strand">
                  <input
                    value={e.title}
                    onChange={(ev) => {
                      const v = ev.target.value
                      setEntries((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, title: v } : r)),
                      )
                    }}
                  />
                  <input
                    type="number"
                    value={e.startStrand ?? 0}
                    onChange={(ev) => {
                      const n = Number(ev.target.value)
                      setEntries((rows) =>
                        rows.map((r, j) =>
                          j === i
                            ? {
                                ...r,
                                startStrand: Number.isFinite(n) ? n : r.startStrand,
                                startPrinted: Number.isFinite(n) ? n + 1 : r.startPrinted,
                              }
                            : r,
                        ),
                      )
                    }}
                  />
                  <input
                    type="number"
                    value={e.endStrand ?? e.startStrand ?? 0}
                    onChange={(ev) => {
                      const n = Number(ev.target.value)
                      setEntries((rows) =>
                        rows.map((r, j) =>
                          j === i
                            ? {
                                ...r,
                                endStrand: Number.isFinite(n) ? n : r.endStrand,
                                endPrinted: Number.isFinite(n) ? n + 1 : r.endPrinted,
                              }
                            : r,
                        ),
                      )
                    }}
                  />
                  <button
                    type="button"
                    className="fanout-linkish"
                    onClick={() =>
                      setEntries((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    删
                  </button>
                </div>
              ))}
            </div>
            <div className="toc-wizard-actions">
              <button
                type="button"
                className="fanout-btn"
                onClick={() =>
                  setEntries((rows) => [
                    ...rows,
                    emptyTocEntry(rows.at(-1)?.endStrand ?? 0),
                  ])
                }
              >
                + 加一节
              </button>
              <button
                type="button"
                className="fanout-btn"
                onClick={() => setStep('pick_toc')}
              >
                ← 重选目录页
              </button>
              <button
                type="button"
                className="fanout-btn primary"
                onClick={() => {
                  setEntries(fillEndStrand(entries, maxStrand))
                  setStep('preview')
                }}
              >
                预览 key 分配 →
              </button>
            </div>
          </section>
        )}

        {step === 'preview' && (
          <section className="toc-wizard-body">
            <p className="toc-wizard-p">
              确认后将按 strand 闭集 ∩ A1 写入各节 memberKeys，供冷启每节头尾 15%。
            </p>
            <ul className="toc-preview-list">
              {previewRows.map((r) => (
                <li key={r.id}>
                  <strong>{r.title}</strong>
                  <span>
                    {' '}
                    · strand {r.startPage}–{r.endPage} · key×{r.keyCount}
                  </span>
                </li>
              ))}
            </ul>
            <div className="toc-wizard-actions">
              <button type="button" className="fanout-btn" onClick={() => setStep('edit')}>
                ← 编辑
              </button>
              <button type="button" className="fanout-btn primary" onClick={onConfirm}>
                确认目录并分配 key
              </button>
            </div>
          </section>
        )}

        {err && <p className="toc-wizard-error">{err}</p>}

        <footer className="toc-wizard-foot">
          <button
            type="button"
            className="fanout-linkish"
            onClick={() => closeTocWizard()}
          >
            先关掉向导（稍后再开）
          </button>
        </footer>
      </div>
    </div>
  )
}

/** Persistent warning when TOC was skipped */
export function TocSkipBanner() {
  const tocStatus = useIndexGate((s) => s.tocStatus)
  const openTocWizard = useIndexGate((s) => s.openTocWizard)
  if (tocStatus !== 'skipped') return null
  return (
    <div className="toc-skip-banner" role="status">
      <strong>警告：</strong>
      已跳过目录确认 · 无 TOC 闭集。冷启将退回整书书序两端；建议打开向导用 toc_map 确认分节。
      <button type="button" className="fanout-btn" onClick={() => openTocWizard()}>
        打开目录向导
      </button>
    </div>
  )
}

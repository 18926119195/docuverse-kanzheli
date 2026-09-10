/**
 * 结算面（评论层默认跳转）：
 * - 复用线：norm 提案 → 批准/撤销
 * - 新铸线：path tick / 跳过监督
 * book 列表单锚：C 固定，切页转球
 */

import { useEffect, useMemo, useState } from 'react'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import { useIndexGate } from '../reasoning/indexGate'
import { useDocuverse } from '../canvas/store'
import {
  enterSettlementSingleAnchor,
  exitSettlementFrame,
  settlementSelectBookKey,
} from '../canvas/settleFrame'
import { formatDirectedPathIncrementReturn } from '../arch/pathIncrementReturn'
import { skipPendingPathMatchToSupervise } from '../reasoning/letterDeskDispatch'
import { runAutoFlow } from '../reasoning/autoFlow'
import { newLlmCallId } from '../reasoning/settleMint'

function short(k: string, n = 10): string {
  const t = k.trim()
  if (t.length <= n) return t
  return `${t.slice(0, 4)}…${t.slice(-4)}`
}

export function SettlementDeskPanel() {
  const pendingReuse = useAttentionIo((s) => s.pendingReuseProposal)
  const pendingPath = useAttentionIo((s) => s.pendingPathMatch)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const [busy, setBusy] = useState(false)
  const [activeBook, setActiveBook] = useState<string | null>(null)
  const [selectedNorms, setSelectedNorms] = useState<Set<string>>(new Set())
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<string | null>(null)

  const mode: 'reuse' | 'path' | null = pendingReuse
    ? 'reuse'
    : pendingPath
      ? 'path'
      : null

  const bookKeys = useMemo(() => {
    if (pendingReuse) {
      return [
        ...new Set(pendingReuse.candidates.flatMap((c) => c.bookKeys)),
      ].filter(Boolean)
    }
    if (pendingPath) {
      return [
        ...new Set(
          (pendingPath.boundPairs ?? []).flatMap((p) => p.sharedBookKeys),
        ),
      ].filter(Boolean)
    }
    return [] as string[]
  }, [pendingReuse, pendingPath])

  useEffect(() => {
    if (!mode) {
      exitSettlementFrame()
      return
    }
    if (pendingReuse) {
      setSelectedNorms(new Set(pendingReuse.candidates.map((c) => c.normKey)))
    }
    if (pendingPath) {
      setSelectedPaths(new Set(pendingPath.pathKeys ?? []))
    }
    if (!bookIndex || bookKeys.length === 0) return
    const first = bookKeys[0]!
    setActiveBook(first)
    enterSettlementSingleAnchor({
      kind: mode,
      bookKey: first,
      bookIndex,
    })
  }, [
    mode,
    pendingReuse?.createdAt,
    pendingPath?.createdAt,
    bookIndex?.docId,
    bookKeys.join('|'),
  ])

  if (!mode) return null

  const onPickBook = (bk: string) => {
    if (!bookIndex) return
    setActiveBook(bk)
    settlementSelectBookKey({ bookKey: bk, bookIndex })
  }

  const onApproveReuse = () => {
    if (busy) return
    setBusy(true)
    try {
      const res = useAttentionIo.getState().approvePendingReuse({
        normKeys: [...selectedNorms],
        llmCallId: newLlmCallId('reuse'),
      })
      setStatus(res.note)
      if (res.ok) {
        const pathReturn = formatDirectedPathIncrementReturn({
          question: pendingReuse!.question,
          hopOutputs: [],
          mode: 'reuse',
          queryKey: pendingReuse!.queryKey,
        })
        useAttentionIo.getState().setDeskPrompt(
          `复用已批准 · ${res.note}`,
        )
        useAttentionIo.getState().setLastStatus(pathReturn.slice(0, 200))
        exitSettlementFrame()
      }
    } finally {
      setBusy(false)
    }
  }

  const onRejectReuse = async () => {
    if (busy || !bookIndex) return
    setBusy(true)
    try {
      const r = useAttentionIo.getState().rejectPendingReuse()
      if (!r) return
      exitSettlementFrame()
      setStatus('已撤销复用 · 续跑新铸…')
      const sealItems = (
        items: Array<{
          key: string
          brief: string
          briefKey: string
          bookText?: string
        }>,
      ) => {
        const sealAttentionBond = useDocuverse.getState().sealAttentionBond
        return items.map((it) => {
          const chunk = bookIndex.chunks.find((c) => c.key === it.key)
          const bbox = chunk
            ? ([...chunk.bbox] as [number, number, number, number])
            : ([0, 0, 100, 100] as [number, number, number, number])
          const bondId = sealAttentionBond({
            strandIndex: chunk?.page ?? 0,
            bbox,
            confirmedText: it.bookText || it.key,
            comment: it.brief,
            bookKey: it.key,
            briefKey: it.briefKey,
          })
          return { ...it, bondId }
        })
      }
      const out = await runAutoFlow({
        question: r.question,
        bookIndex,
        skipReuse: true,
        excludeBriefKeys: r.excludeBriefKeys,
        sealItems,
        onProgress: (msg) => setStatus(msg),
      })
      useAttentionIo.getState().setDeskPrompt(out.note)
      setStatus(out.note)
    } finally {
      setBusy(false)
    }
  }

  const onTickPaths = () => {
    if (busy) return
    setBusy(true)
    try {
      const res = useAttentionIo.getState().settleUserPathMatches({
        queryKey: pendingPath?.queryKey,
        pathKeys: [...selectedPaths],
      })
      setStatus(res.note)
      if (res.ok) exitSettlementFrame()
    } finally {
      setBusy(false)
    }
  }

  const onSkipSupervise = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await skipPendingPathMatchToSupervise({
        onProgress: (msg) => setStatus(msg),
      })
      setStatus(res.note)
      exitSettlementFrame()
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="settlement-desk" aria-label="结算面板">
      <header className="settlement-desk-head">
        <span className="settlement-desk-title">
          {mode === 'reuse' ? '结算 · 复用闸' : '结算 · path tick'}
        </span>
        {status ? <span className="settlement-desk-status">{status}</span> : null}
      </header>

      {bookKeys.length > 0 ? (
        <div className="settlement-book-list">
          <div className="settlement-k">材料 bookKey（单锚 · 点选转球）</div>
          <ul>
            {bookKeys.map((bk) => (
              <li key={bk}>
                <button
                  type="button"
                  className={
                    activeBook === bk
                      ? 'settlement-chip active'
                      : 'settlement-chip'
                  }
                  onClick={() => onPickBook(bk)}
                  title={bk}
                >
                  {short(bk, 14)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {mode === 'reuse' && pendingReuse ? (
        <div className="settlement-body">
          <div className="settlement-k">
            提案 normKey×{pendingReuse.candidates.length}（批前无 reuseKey）
          </div>
          <ul className="settlement-rows">
            {pendingReuse.candidates.map((c) => (
              <li key={c.normKey} className="settlement-row">
                <label className="settlement-check">
                  <input
                    type="checkbox"
                    checked={selectedNorms.has(c.normKey)}
                    onChange={() => {
                      setSelectedNorms((prev) => {
                        const n = new Set(prev)
                        if (n.has(c.normKey)) n.delete(c.normKey)
                        else n.add(c.normKey)
                        return n
                      })
                    }}
                  />
                  <span>
                    norm <code>{short(c.normKey)}</code> · path{' '}
                    <code>{short(c.pathKey)}</code>
                  </span>
                </label>
                <p className="settlement-norm-text">
                  {c.normText.slice(0, 280)}
                  {c.normText.length > 280 ? '…' : ''}
                </p>
                {c.rationale ? (
                  <p className="settlement-hint">{c.rationale.slice(0, 160)}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="settlement-actions">
            <button
              type="button"
              className="settlement-btn primary"
              disabled={busy || selectedNorms.size === 0}
              onClick={onApproveReuse}
            >
              批准复用
            </button>
            <button
              type="button"
              className="settlement-btn danger"
              disabled={busy}
              onClick={() => void onRejectReuse()}
            >
              撤销 → 新铸
            </button>
          </div>
        </div>
      ) : null}

      {mode === 'path' && pendingPath ? (
        <div className="settlement-body">
          <div className="settlement-k">
            候选 pathKey×{pendingPath.pathKeys?.length ?? 0}
          </div>
          <ul className="settlement-rows">
            {(pendingPath.boundPairs ?? []).map((p) => (
              <li key={p.pathKey} className="settlement-row">
                <label className="settlement-check">
                  <input
                    type="checkbox"
                    checked={selectedPaths.has(p.pathKey)}
                    onChange={() => {
                      setSelectedPaths((prev) => {
                        const n = new Set(prev)
                        if (n.has(p.pathKey)) n.delete(p.pathKey)
                        else n.add(p.pathKey)
                        return n
                      })
                    }}
                  />
                  <span>
                    path <code>{short(p.pathKey)}</code>
                  </span>
                </label>
                <p className="settlement-hint">
                  ι {short(p.inferKey)} × prospect {short(p.prospectKey)}
                  {p.sharedBookKeys.length
                    ? ` · book×${p.sharedBookKeys.length}`
                    : ''}
                </p>
              </li>
            ))}
          </ul>
          <div className="settlement-actions">
            <button
              type="button"
              className="settlement-btn primary"
              disabled={busy || selectedPaths.size === 0}
              onClick={onTickPaths}
            >
              Tick → 登记 norm
            </button>
            <button
              type="button"
              className="settlement-btn"
              disabled={busy}
              onClick={() => void onSkipSupervise()}
            >
              跳过 → 监督铸 norm
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  )
}

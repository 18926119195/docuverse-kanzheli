import { useRef, useState } from 'react'
import { isPublicDemo } from '../demoMode'
import { importPdfFile } from '../data/pdfImport'
import {
  loadDualModelConfig,
  saveDualModelConfig,
} from '../reasoning/modelRuntimeConfig'
import { useIndexGate } from '../reasoning/indexGate'
import {
  a1DsChatPromptStub,
  exportA1ForDeepSeek,
  exportA1ForDeepSeekJsonl,
} from '../reasoning/a1DsExport'
import { useDocuverse } from '../canvas/store'

export function PdfUploadPanel() {
  const inputRef = useRef<HTMLInputElement>(null)
  const applyUploadedUniverse = useDocuverse((s) => s.applyUploadedUniverse)
  const clearWorkspaceAnnotations = useDocuverse(
    (s) => s.clearWorkspaceAnnotations,
  )
  const setUploadProgress = useDocuverse((s) => s.setUploadProgress)
  const uploadProgress = useDocuverse((s) => s.uploadProgress)
  const corpus = useDocuverse((s) => s.corpus)
  const uploadLabel = useDocuverse((s) => s.uploadLabel)
  const runOcrOnPagesLackingText = useDocuverse(
    (s) => s.runOcrOnPagesLackingText,
  )
  const setImporting = useIndexGate((s) => s.setImporting)
  const finalizeIndex = useIndexGate((s) => s.finalizeIndex)
  const setIndexError = useIndexGate((s) => s.setError)
  const resetIndex = useIndexGate((s) => s.reset)
  const indexPhase = useIndexGate((s) => s.phase)
  const indexMessage = useIndexGate((s) => s.message)
  const indexReady = useIndexGate((s) => s.ready)
  const tocStatus = useIndexGate((s) => s.tocStatus)
  const openTocWizard = useIndexGate((s) => s.openTocWizard)

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [exportNote, setExportNote] = useState<string | null>(null)
  const [pdfHasTextLayer, setPdfHasTextLayer] = useState(
    () => loadDualModelConfig().pdfHasTextLayer,
  )
  const bookIndex = useIndexGate((s) => s.bookIndex)

  const persistTextLayerFlag = (hasText: boolean) => {
    setPdfHasTextLayer(hasText)
    const cfg = loadDualModelConfig()
    saveDualModelConfig({ ...cfg, pdfHasTextLayer: hasText })
  }

  const onPick = async (file: File | undefined) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('请选择 PDF 文件')
      return
    }
    setError(null)
    setBusy(true)
    resetIndex()
    setImporting('正在打开 PDF…')
    try {
      const result = await importPdfFile(file, (p) => {
        setUploadProgress({
          current: p.current,
          total: p.total,
          message: p.message,
        })
      })
      applyUploadedUniverse(result)
      setUploadProgress(null)

      const cfg = loadDualModelConfig()
      const docId = `upload:${result.label}`
      // 用户声明有文字层 → 跳过 OCR；声明无文字层且开启自动 OCR → 强制 OCR
      const shouldOcr =
        cfg.autoOcrOnUpload !== false && !pdfHasTextLayer
      if (shouldOcr) {
        useIndexGate.setState({
          phase: 'ocr',
          message: '正在识别扫描页…',
          ready: false,
        })
        setUploadProgress({
          current: 0,
          total: 1,
          message: '正在识别扫描页…',
        })
        const pageCount = useDocuverse.getState().pages.length
        const { done, failed } = await runOcrOnPagesLackingText({
          maxPages: Math.max(pageCount, 1),
          deferIndexSync: true,
          // 用户已声明无可用文字层：即使 pdf.js 抽出字也不跳过
          forceEvenIfPdfText: true,
          onProgress: (d, t) => {
            setUploadProgress({
              current: d,
              total: t,
              message: `处理中 ${d}/${t} 页`,
            })
            useIndexGate.setState({
              phase: 'ocr',
              message: `处理中 ${d}/${t} 页`,
            })
          },
        })
        setUploadProgress(null)
        if (failed > 0) {
          setError(
            `部分页面未能识别（${failed}/${done + failed}）· 将使用已有结果继续`,
          )
        }
      }

      setUploadProgress({
        current: 0,
        total: 1,
        message: '正在整理文献…',
      })
      const { pages, ocrByStrand } = useDocuverse.getState()
      await finalizeIndex({ docId, pages, ocrByStrand })
      setUploadProgress(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '导入失败'
      setError(msg)
      setIndexError(msg)
      setUploadProgress(null)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <section className="hud-panel upload">
      <h2>上传 PDF</h2>
      {isPublicDemo ? (
        <p className="meta">上传后可在右侧输入问题并对照出处</p>
      ) : (
        <p className="meta">
          流水线：导入 →
          {pdfHasTextLayer ? ' PDF 文字层' : ' OCR'} → A1 就绪后底部对话
          （DeepSeek Flash · KEY+T）
        </p>
      )}
      <label className="meta" style={{ display: 'block', marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={pdfHasTextLayer}
          disabled={busy}
          onChange={(e) => persistTextLayerFlag(e.target.checked)}
        />{' '}
        PDF 有可用文字层（勾选则跳过 OCR，直接用 PDF 文字）
      </label>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => void onPick(e.target.files?.[0])}
      />
      <button
        type="button"
        className="upload-btn"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? '处理中…' : '选择 PDF 文件'}
      </button>
      <button
        type="button"
        className="corpus-chip"
        disabled={busy}
        title="清除标注；页面保留"
        onClick={() => {
          if (
            !window.confirm(
              '清除全部强调 / 连线标注？页面会保留，可继续导入。',
            )
          ) {
            return
          }
          clearWorkspaceAnnotations()
          resetIndex()
        }}
      >
        清空标注
      </button>
      {(busy || indexPhase === 'ocr' || indexPhase === 'embedding') && (
        <p className="meta">{indexMessage}</p>
      )}
      {indexReady && (
        <p className="meta" style={{ color: '#5cffb1' }}>
          ✓ {indexMessage}
        </p>
      )}
      {indexReady && bookIndex && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button
            type="button"
            className="corpus-chip"
            title="导出 Markdown 分包：KEY+原文+强制吐 key 指令，可直接丢给 DeepSeek"
            onClick={() => {
              try {
                const r = exportA1ForDeepSeek(bookIndex)
                setExportNote(
                  r.mode === 'single'
                    ? `已导出 .md · ${r.rowCount} 行 KEY（可直接上传 DS）`
                    : `书过大：错开下载 ${r.packCount} 个 .md 包 · 共 ${r.rowCount} 行（请允许多次下载）`,
                )
              } catch (e) {
                setError(e instanceof Error ? e.message : '导出失败')
              }
            }}
          >
            导出 A1→DS（.md）
          </button>
          <button
            type="button"
            className="corpus-chip"
            title="导出 JSONL 分包（每行 {key,pdfPage,text}）"
            onClick={() => {
              try {
                const r = exportA1ForDeepSeekJsonl(bookIndex)
                setExportNote(
                  r.mode === 'single'
                    ? `已导出 .jsonl · ${r.rowCount} 行`
                    : `错开下载 ${r.packCount} 个 .jsonl · 共 ${r.rowCount} 行`,
                )
              } catch (e) {
                setError(e instanceof Error ? e.message : '导出失败')
              }
            }}
          >
            导出 A1→DS（.jsonl）
          </button>
          <button
            type="button"
            className="corpus-chip"
            title="复制一段可贴进 DeepSeek 对话框的规则+问题壳"
            onClick={() => {
              void navigator.clipboard
                .writeText(a1DsChatPromptStub(''))
                .then(() => setExportNote('已复制 DS 提问壳（规则+空问题）'))
                .catch(() => setError('剪贴板写入失败'))
            }}
          >
            复制 DS 提问壳
          </button>
        </div>
      )}
      {exportNote && (
        <p className="meta" style={{ color: '#9ecbff' }}>
          {exportNote}
        </p>
      )}
      {indexReady && tocStatus === 'pending' && (
        <p className="meta" style={{ color: '#ffcc66' }}>
          目录向导待完成（点选目录页 → toc_map）{' '}
          <button type="button" className="corpus-chip" onClick={() => openTocWizard()}>
            打开向导
          </button>
        </p>
      )}
      {tocStatus === 'skipped' && (
        <p className="meta" style={{ color: '#ff8a8a' }}>
          ⚠ 已跳过目录 · 无 TOC 闭集（提问走全书 BM25）{' '}
          <button type="button" className="corpus-chip" onClick={() => openTocWizard()}>
            重新打开向导
          </button>
        </p>
      )}
      {tocStatus === 'confirmed' && (
        <p className="meta" style={{ color: '#5cffb1' }}>
          ✓ 目录已确认并完成 key 归属
        </p>
      )}
      {uploadProgress && (
        <div className="upload-progress">
          <div className="bar">
            <span
              style={{
                width:
                  uploadProgress.total > 0
                    ? `${Math.min(100, (100 * uploadProgress.current) / uploadProgress.total)}%`
                    : '30%',
              }}
            />
          </div>
          <p className="meta">{uploadProgress.message}</p>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {corpus === 'upload' && uploadLabel && (
        <p className="meta">当前：{uploadLabel}</p>
      )}
    </section>
  )
}

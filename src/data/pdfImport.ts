/**
 * Browser-side PDF → page image cards (works for scanned PDFs).
 * Uses pdf.js *legacy* build so older Chromium/Safari without
 * Map.getOrInsertComputed still work (worker included).
 */

import { ensurePdfRuntimePolyfills } from './pdfPolyfills'

ensurePdfRuntimePolyfills()

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorker from './pdfWorkerBootstrap?worker&url'
import type { PageDocument, ResolvedConnection } from '../zigzag/types'
import { extractPdfTextChunks } from './pdfTextLayer'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker

export interface PdfImportProgress {
  phase: 'loading' | 'rendering' | 'done' | 'error'
  current: number
  total: number
  message: string
}

function canvasToObjectUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('无法导出页面图像'))
          return
        }
        resolve(URL.createObjectURL(blob))
      },
      'image/jpeg',
      0.82,
    )
  })
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

export async function importPdfFile(
  file: File,
  onProgress?: (p: PdfImportProgress) => void,
): Promise<{ pages: PageDocument[]; connections: ResolvedConnection[]; label: string }> {
  const label = file.name.replace(/\.pdf$/i, '') || 'Uploaded PDF'
  onProgress?.({
    phase: 'loading',
    current: 0,
    total: 0,
    message: `读取 ${file.name}…`,
  })

  const data = new Uint8Array(await file.arrayBuffer())
  // Scanned PDFs often use JBIG2; wasmUrl is required or pages render blank white.
  // isEvalSupported helps WASM fallbacks; disableFontFace reduces worker font paths
  // that call ArrayBuffer.transferToFixedLength on older Chromium.
  const doc = await pdfjs.getDocument({
    data,
    wasmUrl: '/pdfjs-wasm/',
    useSystemFonts: true,
    disableFontFace: true,
  }).promise
  const total = doc.numPages

  if (total < 1) {
    throw new Error('PDF 没有可渲染的页面')
  }

  const pages: PageDocument[] = []
  // Cap for browser memory / time; progress stays responsive via yieldToUi
  const maxPages = Math.min(total, 80)

  for (let i = 1; i <= maxPages; i++) {
    onProgress?.({
      phase: 'rendering',
      current: i,
      total: maxPages,
      message: `渲染第 ${i}/${maxPages} 页…`,
    })
    // Let React paint the progress bar between heavy canvas work
    await yieldToUi()

    const page = await doc.getPage(i)
    const base = page.getViewport({ scale: 1 })
    const targetW = 960
    const scale = Math.min(1.8, targetW / base.width)
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 不可用')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const task = page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      background: '#ffffff',
    })
    try {
      await task.promise
    } catch (err) {
      // Skip a bad page rather than hanging the whole import
      console.warn(`PDF page ${i} render failed`, err)
      canvas.width = 0
      canvas.height = 0
      pages.push({
        strandIndex: i - 1,
        title: `${label} p.${i}（渲染失败）`,
        text: `${label}\nPage ${i} of ${total}\n(render failed)`,
        offsetMap: [],
        sourceDoc: 'upload',
        sourcePage: i,
        textChunks: [],
      })
      continue
    }

    const imageUrl = await canvasToObjectUrl(canvas)
    canvas.width = 0
    canvas.height = 0

    const textChunks = await extractPdfTextChunks(page, viewport, i - 1)
    const extracted = textChunks
      .map((c) => c.content)
      .filter((t) => t.length > 0)
      .join('\n\n')

    pages.push({
      strandIndex: i - 1,
      title: `${label} p.${i}`,
      text: extracted || `${label}\nPage ${i} of ${total}`,
      offsetMap: [],
      imageUrl,
      sourceDoc: 'upload',
      sourcePage: i,
      textChunks,
    })
  }

  try {
    const closable = doc as { destroy?: () => Promise<void> }
    await closable.destroy?.()
  } catch {
    /* ignore */
  }

  const connections: ResolvedConnection[] = []
  // No auto beams — rays are user-authored permanent bonds only

  onProgress?.({
    phase: 'done',
    current: maxPages,
    total: maxPages,
    message:
      total > maxPages
        ? `已导入前 ${maxPages} 页（共 ${total} 页，已截断）`
        : `已导入 ${maxPages} 页`,
  })

  return { pages, connections, label }
}

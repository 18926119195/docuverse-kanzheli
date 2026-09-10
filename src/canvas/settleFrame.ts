/**
 * 结算架：C 固定 + 单锚一页；多 book 列表切换时转球进槽（不动相机）。
 * 写信台工作台：先 ensurePageForAudit 物化页图再亮球。
 */

import * as THREE from 'three'
import type { BookIndex } from '../reasoning/pipelineA'
import { bookKeyHostWorld } from '../reasoning/keyWorldAnchor'
import { focusA1KeyOnPdf } from '../reasoning/focusA1Key'
import { useDocuverse } from './store'
import {
  clearPokerYawOffset,
  radialToYawPitch,
  setPokerYawOffset,
} from './geometry'
import { singleAnchorShellPoint } from './surfaceGeometry'

export type SettlementKind = 'reuse' | 'path'

type LockedSettlementFrame = {
  kind: SettlementKind
  eye: [number, number, number]
  lookAt: [number, number, number]
  yaw: number
  pitch: number
  distance: number
  slotRingAngle: number
  activeBookKey: string
}

let locked: LockedSettlementFrame | null = null

function naturalRingAngle(strand: number, total: number): number {
  const n = Math.max(total, 1)
  if (n === 1) return 0
  return (strand / n) * Math.PI * 2 - Math.PI / 2
}

function pageOfBookKey(
  bookKey: string,
  bookIndex: BookIndex,
): number | null {
  const chunk = bookIndex.chunks.find((c) => c.key === bookKey)
  return chunk ? chunk.page : null
}

function applyCamera(frame: LockedSettlementFrame) {
  useDocuverse.setState({
    cameraLens: 'construction',
    constructionLinkId: null,
    keyComparePair: null,
    keyCompareTri: null,
    cameraEye: frame.eye,
    cameraLookAt: frame.lookAt,
    viewYaw: frame.yaw,
    viewPitch: frame.pitch,
    cameraDistance: frame.distance,
    viewPan: [0, 0, 0],
    constructionStage: 'rail',
    constructionDepth: 'commentNear',
    commentLayerExpanded: true,
    swooping: false,
    settlementSphereEpoch: useDocuverse.getState().settlementSphereEpoch + 1,
  })
}

async function prepareAuditPage(
  bookKey: string,
  bookIndex: BookIndex,
): Promise<number | null> {
  const strand = pageOfBookKey(bookKey, bookIndex)
  if (strand == null) return null
  await useDocuverse.getState().ensurePageForAudit(strand)
  useDocuverse.getState().revealSphereForAudit()
  return strand
}

/**
 * 进入结算架：先按需物化审计页图，再锁 C。
 */
export async function enterSettlementSingleAnchor(input: {
  kind: SettlementKind
  bookKey: string
  bookIndex: BookIndex
}): Promise<boolean> {
  const strand = await prepareAuditPage(input.bookKey, input.bookIndex)
  if (strand == null) return false

  const pages = useDocuverse.getState().pages.length
  const host = bookKeyHostWorld(input.bookKey, input.bookIndex, pages)
  if (!host) return false

  const { point: c, outward } = singleAnchorShellPoint(host, 'comment')
  const m: [number, number, number] = [
    host[0] * 0.92,
    host[1] * 0.92,
    host[2] * 0.92,
  ]
  const out = new THREE.Vector3(outward[0], outward[1], outward[2]).normalize()
  const cR = Math.max(
    new THREE.Vector3(c[0], c[1], c[2]).length(),
    1,
  )
  const halfFov = THREE.MathUtils.degToRad(25)
  const distPastC = Math.max(3.4, (4.2 * 0.5) / Math.tan(halfFov))
  const eyeV = out.clone().multiplyScalar(cR + distPastC)
  const eye = [eyeV.x, eyeV.y, eyeV.z] as [number, number, number]
  const lookAt = m
  const { yaw, pitch } = radialToYawPitch(eyeV)

  const total = Math.max(pages, 1)
  clearPokerYawOffset()
  const slotRingAngle = naturalRingAngle(strand, total)

  locked = {
    kind: input.kind,
    eye,
    lookAt,
    yaw,
    pitch,
    distance: eyeV.length(),
    slotRingAngle,
    activeBookKey: input.bookKey,
  }

  useDocuverse.setState({ currentStrand: strand })
  applyCamera(locked)
  focusA1KeyOnPdf({
    key: input.bookKey,
    bookIndex: input.bookIndex,
    swoopToPage: () => {
      /* 结算架禁止 swoop 改机位；仅高亮 */
    },
  })
  applyCamera(locked)
  return true
}

/** 列表切 book：先物化该页，再转球进固定槽 */
export async function settlementSelectBookKey(input: {
  bookKey: string
  bookIndex: BookIndex
}): Promise<boolean> {
  if (!locked) {
    return enterSettlementSingleAnchor({
      kind: 'path',
      bookKey: input.bookKey,
      bookIndex: input.bookIndex,
    })
  }
  const strand = await prepareAuditPage(input.bookKey, input.bookIndex)
  if (strand == null) return false
  const total = Math.max(useDocuverse.getState().pages.length, 1)
  const natural = naturalRingAngle(strand, total)
  setPokerYawOffset(locked.slotRingAngle - natural)
  locked = { ...locked, activeBookKey: input.bookKey }
  useDocuverse.setState({
    currentStrand: strand,
    settlementSphereEpoch: useDocuverse.getState().settlementSphereEpoch + 1,
  })
  focusA1KeyOnPdf({
    key: input.bookKey,
    bookIndex: input.bookIndex,
    swoopToPage: () => {},
  })
  applyCamera(locked)
  return true
}

export function getSettlementFrame(): LockedSettlementFrame | null {
  return locked
}

export function exitSettlementFrame(): void {
  locked = null
  clearPokerYawOffset()
  useDocuverse.getState().hideSphereAfterAudit()
  useDocuverse.setState({
    commentLayerExpanded: false,
    settlementSphereEpoch: useDocuverse.getState().settlementSphereEpoch + 1,
  })
}

/**
 * Printed-page ↔ strandIndex calibration (one anchor → linear map).
 * Assumes consecutive physical pages advance strandIndex by 1.
 *
 * strandIndex = printedPage + offset
 * offset = anchorStrand - anchorPrinted
 */

export interface PageCalibration {
  /** Strand the user clicked when calibrating */
  anchorStrand: number
  /** Printed page number the user typed (Arabic / whatever they read) */
  anchorPrinted: number
  /** strandIndex = printedPage + offset */
  offset: number
  calibratedAt: number
}

export function makeCalibration(
  anchorStrand: number,
  anchorPrinted: number,
): PageCalibration {
  return {
    anchorStrand,
    anchorPrinted,
    offset: anchorStrand - anchorPrinted,
    calibratedAt: Date.now(),
  }
}

export function printedToStrand(
  printedPage: number,
  cal: PageCalibration,
): number {
  return printedPage + cal.offset
}

export function strandToPrinted(
  strandIndex: number,
  cal: PageCalibration,
): number {
  return strandIndex - cal.offset
}

export function printedRangeToStrandRange(
  startPrinted: number,
  endPrinted: number,
  cal: PageCalibration,
): { startPage: number; endPage: number } {
  const a = printedToStrand(startPrinted, cal)
  const b = printedToStrand(endPrinted, cal)
  return {
    startPage: Math.min(a, b),
    endPage: Math.max(a, b),
  }
}

export function calibrationNote(cal: PageCalibration): string {
  return `书上第 ${cal.anchorPrinted} 页 = 机器第 ${cal.anchorStrand + 1} 张牌（strand ${cal.anchorStrand}）· offset=${cal.offset}`
}

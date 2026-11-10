// generate-form-report / layout.ts
// Shared house style for the forms-app reports. Palette, geometry, header/footer bands,
// compass ring, brand mark, bearing labels, revision table and DRAFT stamp are copied 1:1
// from generate-survey-report (v57) so app reports look identical to the FastField ones.
// On top of that a small "Doc" helper with flowing layout (tables that break across pages,
// info boxes, signature blocks, photo appendix).
import {
  PDFDocument, StandardFonts, rgb, degrees, LineCapStyle,
  type PDFFont, type PDFPage, type PDFImage, type Color,
} from 'https://esm.sh/pdf-lib@1.17.1'

export { PDFDocument, StandardFonts, rgb, degrees }
export type { PDFFont, PDFPage, PDFImage, Color }

// ───────────── palette (identical to generate-survey-report) ─────────────
const NAVY_950_T: [number, number, number] = [0.039, 0.102, 0.200]
const NAVY_800_T: [number, number, number] = [0.082, 0.196, 0.388]
export const NAVY_950 = rgb(...NAVY_950_T)
export const SKY_500 = rgb(0.184, 0.627, 0.839)
export const SKY_300 = rgb(0.561, 0.824, 0.933)
export const INK_900 = rgb(0.063, 0.125, 0.239)
export const SLATE_500 = rgb(0.361, 0.420, 0.522)
export const SLATE_300 = rgb(0.576, 0.631, 0.733)
export const LINE_200 = rgb(0.886, 0.906, 0.949)
export const SKY_TINT = rgb(0.914, 0.961, 0.984)
export const SKY_TINT_LINE = rgb(0.788, 0.902, 0.949)
export const AMBER_TINT = rgb(0.996, 0.961, 0.910)
export const AMBER_TINT_LINE = rgb(0.984, 0.902, 0.769)
export const AMBER_700 = rgb(0.706, 0.443, 0.086)
export const GREEN_700 = rgb(0.086, 0.502, 0.318)
export const GREEN_TINT = rgb(0.914, 0.965, 0.933)
export const CRIT_TINT = rgb(0.984, 0.918, 0.906)
export const CRIT_700 = rgb(0.702, 0.224, 0.173)
export const WHITE = rgb(1, 1, 1)
export const PAPER_50 = rgb(0.961, 0.973, 0.988)
export const ZEBRA = rgb(0.975, 0.979, 0.988)

// ───────────── geometry (identical) ─────────────
export const A4_W = 595.28
export const A4_H = 841.89
export const M = 42
export const BLEED = 10
export const HEADER_H = 118
export const FOOTER_H = 34
export const CONTENT_W = A4_W - 2 * M
export const BODY_BOTTOM = FOOTER_H + 24

// ───────────── formatting helpers ─────────────
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}
export function num(v: unknown, decimals = 3): string {
  const n = toNum(v)
  return n == null ? '-' : n.toFixed(decimals)
}
export function qty(v: unknown, unit = 'MT', decimals = 3): string {
  const n = toNum(v)
  return n == null ? '-' : (unit ? `${n.toFixed(decimals)} ${unit}` : n.toFixed(decimals))
}
export function signedQty(v: unknown, unit = 'MT', decimals = 3): string {
  const n = toNum(v)
  if (n == null) return '-'
  const s = n > 0 ? '+' : ''
  return unit ? `${s}${n.toFixed(decimals)} ${unit}` : `${s}${n.toFixed(decimals)}`
}
export function signedPct(v: unknown, decimals = 2): string {
  const n = toNum(v)
  if (n == null) return '-'
  return `${n > 0 ? '+' : ''}${n.toFixed(decimals)}%`
}
export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}
export function humanize(s: string | null | undefined): string {
  if (!s) return '-'
  return capitalize(String(s).replace(/_/g, ' '))
}

/** WinAnsi-safe text for the standard Helvetica/Courier fonts. */
export function pdfSafe(t: unknown): string {
  return String(t ?? '')
    .replace(/[–—−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/³/g, '3').replace(/[\r\t]/g, ' ')
    .replace(/[^\x20-\x7E -ÿ\n]/g, '?')
}
export function fit(text: string, font: PDFFont, size: number, maxW: number): string {
  text = pdfSafe(text)
  if (font.widthOfTextAtSize(text, size) <= maxW) return text
  let t = text
  while (t.length > 1 && font.widthOfTextAtSize(t + '...', size) > maxW) t = t.slice(0, -1)
  return t + '...'
}
/** Word wrap that also honours explicit newlines and breaks words longer than the line. */
export function wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = []
  for (const para of pdfSafe(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    let line = ''
    for (let w of words) {
      while (font.widthOfTextAtSize(w, size) > maxW && w.length > 1) {
        // hard-break an over-long token
        let k = w.length - 1
        while (k > 1 && font.widthOfTextAtSize(w.slice(0, k), size) > maxW) k--
        if (line) { out.push(line); line = '' }
        out.push(w.slice(0, k))
        w = w.slice(k)
      }
      const test = line ? line + ' ' + w : w
      if (font.widthOfTextAtSize(test, size) > maxW) {
        if (line) out.push(line)
        line = w
      } else line = test
    }
    out.push(line)
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out.length ? out : ['']
}
export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(s)
}
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// ───────────── drawing primitives (identical to generate-survey-report) ─────────────
export function gradientBand(page: PDFPage, x: number, y: number, w: number, h: number) {
  const steps = 32
  const stripW = w / steps
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    const c = rgb(
      NAVY_950_T[0] + (NAVY_800_T[0] - NAVY_950_T[0]) * t,
      NAVY_950_T[1] + (NAVY_800_T[1] - NAVY_950_T[1]) * t,
      NAVY_950_T[2] + (NAVY_800_T[2] - NAVY_950_T[2]) * t,
    )
    page.drawRectangle({ x: x + stripW * i, y, width: stripW + 0.6, height: h, color: c })
  }
}

export function drawRing(page: PDFPage, cx: number, cy: number) {
  const opacity = 0.35
  page.drawEllipse({ x: cx, y: cy, xScale: 92, yScale: 92, borderColor: SKY_300, borderWidth: 1, borderOpacity: opacity })
  page.drawEllipse({ x: cx, y: cy, xScale: 68, yScale: 68, borderColor: SKY_300, borderWidth: 1, borderOpacity: opacity })
  const ticks: Array<[number, number, number, number]> = [
    [cx, cy + 90, cx, cy + 104], [cx, cy - 104, cx, cy - 90], [cx - 104, cy, cx - 90, cy], [cx + 90, cy, cx + 104, cy],
  ]
  for (const [x1, y1, x2, y2] of ticks) page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1, color: SKY_300, opacity })
}

export type Fonts = { body: PDFFont; bold: PDFFont; italic: PDFFont; mono: PDFFont; monoBold: PDFFont }

export function drawBrandMark(page: PDFPage, fonts: Fonts, x: number, cy: number): number {
  const s = 0.42
  const reach = 46 * s
  const cx = x + reach
  const anchor = { x: cx - 50 * s, y: cy + 50 * s, scale: s }
  const kite = (path: string, color: Color) => page.drawSvgPath(path, { ...anchor, color })
  kite('M50 4 L58 44 L50 50 L42 44 Z', SKY_300)
  kite('M96 50 L56 58 L50 50 L56 42 Z', WHITE)
  kite('M50 96 L42 56 L50 50 L58 56 Z', WHITE)
  kite('M4 50 L44 42 L50 50 L44 58 Z', SKY_300)
  const arc = (startDeg: number, endDeg: number, color: Color) => {
    const steps = 16
    const pts: string[] = []
    for (let i = 0; i <= steps; i++) {
      const t = startDeg + (endDeg - startDeg) * (i / steps)
      const rad = (t * Math.PI) / 180
      pts.push(`${i === 0 ? 'M' : 'L'} ${(50 + 34 * Math.cos(rad)).toFixed(2)} ${(50 + 34 * Math.sin(rad)).toFixed(2)}`)
    }
    page.drawSvgPath(pts.join(' '), { ...anchor, borderColor: color, borderWidth: 6, borderLineCap: LineCapStyle.Round })
  }
  arc(-45, 45, SKY_300)
  arc(135, 225, WHITE)
  const wordX = cx + reach + 14
  const size = 16
  page.drawText('Global', { x: wordX, y: cy - size * 0.36, size, font: fonts.bold, color: WHITE })
  const gWidth = fonts.bold.widthOfTextAtSize('Global', size)
  page.drawText('BQS', { x: wordX + gWidth, y: cy - size * 0.36, size, font: fonts.bold, color: SKY_300 })
  return wordX + gWidth + fonts.bold.widthOfTextAtSize('BQS', size)
}

// A5 (09-11-2026): own job of a surveyor company - their logo replaces the GlobalBQS mark
export type Brand = { name: string; img: PDFImage | null }

/** Surveyor logo top-left on a white rounded tile (or the company name when there is no PNG/JPG logo). */
export function drawSurveyorBrand(page: PDFPage, fonts: Fonts, brand: Brand, x: number, top: number) {
  const tileH = 44, maxTileW = 190, pad = 6
  if (brand.img) {
    const maxW = maxTileW - 2 * pad, maxH = tileH - 2 * pad
    const sc = Math.min(maxW / brand.img.width, maxH / brand.img.height)
    const w = brand.img.width * sc, h = brand.img.height * sc
    const tileW = Math.max(w + 2 * pad, 60)
    page.drawRectangle({ x, y: top - tileH, width: tileW, height: tileH, color: WHITE, borderColor: WHITE, borderWidth: 0 })
    page.drawImage(brand.img, { x: x + (tileW - w) / 2, y: top - tileH + (tileH - h) / 2, width: w, height: h })
  } else {
    const nm = fit(pdfSafe(brand.name), fonts.bold, 15, 250)
    page.drawText(nm, { x, y: top - 30, size: 15, font: fonts.bold, color: WHITE })
  }
  const lbl = 'ISSUED BY'
  page.drawText(lbl, { x, y: top - tileH - 13, size: 6.8, font: fonts.mono, color: SKY_300 })
  const nm2 = fit(pdfSafe(brand.name), fonts.bold, 8, 220)
  page.drawText(nm2, { x: x + fonts.mono.widthOfTextAtSize(lbl, 6.8) + 6, y: top - tileH - 13, size: 8, font: fonts.bold, color: WHITE })
}

// 5.18 c revision context - same shape and texts as generate-survey-report
export type RevCtx = { current: number; rows: { rev: number; date: string; description: string; reason: string }[]; tableDrawn?: boolean }
export const REV_REASON_EN: Record<string, string> = {
  surveyor_error: 'Correction of survey data',
  order_data: 'Correction of order data',
  client_addition: "Addition at client's request",
}

function drawRevisionTable(page: PDFPage, fonts: Fonts, rev: RevCtx, top: number): number {
  let y = top
  page.drawText('DOCUMENT REVISION', { x: M, y, size: 8, font: fonts.monoBold, color: SKY_500 })
  y -= 8
  const colX = [M, M + 34, M + 104, A4_W - M - 150]
  const descW = colX[3] - colX[2] - 10
  const headH = 15
  page.drawRectangle({ x: M, y: y - headH, width: A4_W - 2 * M, height: headH, color: PAPER_50 })
  ;['REV.', 'DATE', 'DESCRIPTION', 'REASON'].forEach((h, i) =>
    page.drawText(h, { x: colX[i] + 4, y: y - 10.5, size: 7, font: fonts.bold, color: SLATE_500 }))
  y -= headH
  for (const r of rev.rows) {
    const isCurrent = r.rev === rev.current
    const f = isCurrent ? fonts.bold : fonts.body
    const desc = wrap(r.description, f, 8, descW)
    const reason = wrap(r.reason, fonts.body, 8, 140)
    const lines = Math.max(desc.length, reason.length, 1)
    const h = 6 + lines * 10.5
    page.drawText(String(r.rev), { x: colX[0] + 4, y: y - 12, size: 8, font: isCurrent ? fonts.monoBold : fonts.mono, color: INK_900 })
    page.drawText(pdfSafe(r.date), { x: colX[1] + 4, y: y - 12, size: 8, font: fonts.mono, color: INK_900 })
    desc.forEach((l, i) => page.drawText(l, { x: colX[2] + 4, y: y - 12 - i * 10.5, size: 8, font: f, color: INK_900 }))
    reason.forEach((l, i) => page.drawText(l, { x: colX[3] + 4, y: y - 12 - i * 10.5, size: 8, font: fonts.body, color: SLATE_500 }))
    y -= h
    page.drawLine({ start: { x: M, y }, end: { x: A4_W - M, y }, thickness: 0.6, color: LINE_200 })
  }
  y -= 11
  page.drawText('This revision supersedes all previous versions of this report.', { x: M, y, size: 7.5, font: fonts.italic, color: SLATE_500 })
  return y - 22
}

export type PageLabel = { page: PDFPage; x: number; y: number; prefix?: string }

export function drawHeader(
  page: PDFPage, fonts: Fonts,
  data: { reportNumber: string; dateOfSurvey: string; revision?: RevCtx | null; brand?: Brand | null },
  eyebrow: string, typeLabel: string, partLabel?: string | null,
): { bodyTop: number; pageLabel: PageLabel } {
  const top = A4_H
  gradientBand(page, 0, top - HEADER_H, A4_W, HEADER_H)
  drawRing(page, A4_W - 66, top - 60)
  if (data.brand) drawSurveyorBrand(page, fonts, data.brand, M, top - 12)
  else drawBrandMark(page, fonts, M, top - 38)
  const rightX = A4_W - M
  page.drawText(eyebrow, { x: rightX - fonts.mono.widthOfTextAtSize(eyebrow, 7.5), y: top - 30, size: 7.5, font: fonts.mono, color: SKY_300 })
  const num_ = pdfSafe(data.reportNumber || '-')
  page.drawText(num_, { x: rightX - fonts.monoBold.widthOfTextAtSize(num_, 17), y: top - 50, size: 17, font: fonts.monoBold, color: WHITE })
  const rev = data.revision ?? undefined
  const pageLabel: PageLabel = { page, x: rightX, y: top - 63, prefix: rev ? `Rev. ${rev.current} · ` : undefined }
  if (partLabel) {
    const pl = pdfSafe(partLabel.toUpperCase())
    page.drawText(pl, { x: rightX - fonts.mono.widthOfTextAtSize(pl, 6.8), y: top - 74, size: 6.8, font: fonts.mono, color: SKY_300, opacity: 0.8 })
  }
  const metaY = top - HEADER_H + 24
  page.drawLine({ start: { x: M, y: metaY + 16 }, end: { x: A4_W - M, y: metaY + 16 }, thickness: 0.75, color: WHITE, opacity: 0.18 })
  page.drawText('Date of survey', { x: M, y: metaY, size: 8, font: fonts.monoBold, color: SKY_300 })
  page.drawText(pdfSafe(data.dateOfSurvey), { x: M + 84, y: metaY, size: 8, font: fonts.mono, color: WHITE })
  {
    const s = pdfSafe(typeLabel)
    const labelW = fonts.monoBold.widthOfTextAtSize('Type', 8)
    const valueW = fonts.mono.widthOfTextAtSize(s, 8)
    page.drawText('Type', { x: A4_W - M - labelW - 6 - valueW, y: metaY, size: 8, font: fonts.monoBold, color: SKY_300 })
    page.drawText(s, { x: A4_W - M - valueW, y: metaY, size: 8, font: fonts.mono, color: WHITE })
  }
  let bodyTop = top - HEADER_H - 30
  if (rev && !rev.tableDrawn) {
    rev.tableDrawn = true
    bodyTop = drawRevisionTable(page, fonts, rev, bodyTop)
  }
  return { bodyTop, pageLabel }
}

export function drawFooter(page: PDFPage, fonts: Fonts, brand?: Brand | null) {
  gradientBand(page, 0, 0, A4_W, FOOTER_H)
  if (brand) {
    // A5: own job - "Issued by" left, "Powered by GlobalBQS" right (decision 03-11)
    const left = fit('Issued by ' + pdfSafe(brand.name), fonts.bold, 7.5, 260)
    page.drawText(left, { x: M, y: FOOTER_H / 2 - 3, size: 7.5, font: fonts.bold, color: SKY_300 })
    const pw = 'Powered by GlobalBQS · one standard for every survey'
    page.drawText(pw, { x: A4_W - M - fonts.mono.widthOfTextAtSize(pw, 7), y: FOOTER_H / 2 - 3, size: 7, font: fonts.mono, color: SKY_300 })
    return
  }
  page.drawText('GlobalBQS - Standardised bunker survey reporting & analytics', { x: M, y: FOOTER_H / 2 - 3, size: 7.5, font: fonts.bold, color: SKY_300 })
  const url = '000° globalbqs.com'
  page.drawText(url, { x: A4_W - M - fonts.mono.widthOfTextAtSize(url, 7.5), y: FOOTER_H / 2 - 3, size: 7.5, font: fonts.mono, color: SKY_300 })
}

/** 5.18 c: DRAFT watermark / revision line on every page of a finished PDF (identical to generate-survey-report). */
export async function stampPdf(bytes: Uint8Array, opts: { draft?: boolean; revisionLine?: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const reg = await doc.embedFont(StandardFonts.Helvetica)
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize()
    if (opts.draft) {
      const word = 'DRAFT'
      const size = Math.min(width, height) * 0.24
      const w = bold.widthOfTextAtSize(word, size)
      const c = Math.SQRT1_2
      page.drawText(word, {
        x: width / 2 - (w / 2) * c + (size / 2.8) * c, y: height / 2 - (w / 2) * c - (size / 2.8) * c,
        size, font: bold, color: rgb(0.80, 0.16, 0.16), opacity: 0.16, rotate: degrees(45),
      })
      const band = 'DRAFT - for checking by the attending surveyor only. Not a valid survey report.'
      const bs = 8
      page.drawRectangle({ x: 0, y: height - 16, width, height: 16, color: rgb(0.80, 0.16, 0.16), opacity: 0.9 })
      page.drawText(band, { x: (width - bold.widthOfTextAtSize(band, bs)) / 2, y: height - 11.5, size: bs, font: bold, color: rgb(1, 1, 1) })
    }
    if (opts.revisionLine) {
      const line = pdfSafe(opts.revisionLine)
      let size = 7.5
      while (size > 5 && reg.widthOfTextAtSize(line, size) > width - 40) size -= 0.25
      page.drawRectangle({ x: 0, y: height - 15, width, height: 15, color: rgb(1, 0.96, 0.88) })
      page.drawText(line, { x: 20, y: height - 10.5, size, font: reg, color: rgb(0.55, 0.27, 0.02) })
    }
  }
  return await doc.save()
}

// ───────────── condition pills ─────────────
export function pillColors(raw?: string | null): { bg: Color; fg: Color } {
  const v = (raw ?? '').toLowerCase()
  if (v.includes('good') || v === 'signed' || v === 'yes_ok' || v === 'within') return { bg: GREEN_TINT, fg: GREEN_700 }
  if (v.includes('fair') || v.includes('receipt') || v === 'outside') return { bg: AMBER_TINT, fg: AMBER_700 }
  if (v.includes('poor') || v.includes('damaged') || v.includes('not signed') || v.includes('not_signed')) return { bg: CRIT_TINT, fg: CRIT_700 }
  return { bg: LINE_200, fg: SLATE_500 }
}
export const RATING_LABEL: Record<string, string> = { good: 'Good', fair: 'Fair', damaged: 'Damaged', poor: 'Poor', na: 'N/A' }

// ───────────── images ─────────────
export type ImgSrc = { bytes: Uint8Array; mime: string }
export async function embedImage(pdf: PDFDocument, src?: ImgSrc | null): Promise<PDFImage | null> {
  if (!src || !src.bytes || !src.bytes.length) return null
  try {
    const b = src.bytes
    const isPng = b[0] === 0x89 && b[1] === 0x50
    const isJpg = b[0] === 0xff && b[1] === 0xd8
    if (isPng) return await pdf.embedPng(b)
    if (isJpg) return await pdf.embedJpg(b)
    return null
  } catch {
    return null
  }
}

// ───────────── table model ─────────────
export type Cell = string | { t: string; color?: Color; bold?: boolean; mono?: boolean; italic?: boolean; pill?: string | null }
export type Col = { label: string; w: number; align?: 'left' | 'right'; mono?: boolean; bold?: boolean }
export type TableOpts = {
  size?: number
  zebra?: boolean
  subtotal?: Cell[] | null // drawn in SKY_TINT, after the rows
  subtotalLabel?: string
  grid?: boolean // tank-sheet grid (outer border + column separators)
  headerTint?: Color
  minRowH?: number
}

export type PhotoItem = { img: ImgSrc; caption: string }
export type PhotoGroup = { title: string; sub?: Array<{ title: string; items: PhotoItem[] }>; items?: PhotoItem[] }

export type SigBlock = {
  role: string
  name?: string | null
  status?: string | null // signed | receipt_only | not_signed | null (missing)
  reason?: string | null
  signedAt?: string | null // formatted LT
  image?: ImgSrc | null
}

export type DocMeta = {
  eyebrow: string
  typeLabel: string
  reportNumber: string
  gbqsReference: string
  dateOfSurvey: string
  revision?: RevCtx | null
  /** A5: set for a surveyor's own job - logo bytes are embedded once in Doc.create */
  brandSrc?: { name: string; logo: Uint8Array | null; kind: 'png' | 'jpg' | null } | null
  brand?: Brand | null
  /** C6: attending surveyor is GCS-certified (GBQS reports only) */
  gcs?: { number: string } | null
}

// ───────────── flowing document ─────────────
export class Doc {
  pdf!: PDFDocument
  fonts!: Fonts
  meta: DocMeta
  page!: PDFPage
  y = 0
  partLabel: string | null = null
  pages: PDFPage[] = []
  labels: PageLabel[] = []
  private bearingIdx = 0
  bodyTop = 0
  photoNo = 1
  issuedByDrawn = false
  gcsImg: PDFImage | null = null

  private constructor(meta: DocMeta) { this.meta = meta }

  static async create(meta: DocMeta): Promise<Doc> {
    const d = new Doc(meta)
    d.pdf = await PDFDocument.create()
    d.pdf.setTitle(`${meta.reportNumber} - ${meta.typeLabel}`)
    d.pdf.setAuthor(meta.brandSrc ? meta.brandSrc.name : 'GlobalBQS')
    d.pdf.setCreator('GlobalBQS generate-form-report')
    d.fonts = {
      body: await d.pdf.embedFont(StandardFonts.Helvetica),
      bold: await d.pdf.embedFont(StandardFonts.HelveticaBold),
      italic: await d.pdf.embedFont(StandardFonts.HelveticaOblique),
      mono: await d.pdf.embedFont(StandardFonts.Courier),
      monoBold: await d.pdf.embedFont(StandardFonts.CourierBold),
    }
    if (meta.gcs && !meta.brandSrc) {
      try {
        const b64 = GCS_BADGE_JPG_B64
        const bin = atob(b64); const u = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
        d.gcsImg = await d.pdf.embedJpg(u)
      } catch (e) { console.warn('gcs badge could not be embedded', String(e)) }
    }
    if (meta.brandSrc) {
      let img: PDFImage | null = null
      try {
        if (meta.brandSrc.logo && meta.brandSrc.kind === 'png') img = await d.pdf.embedPng(meta.brandSrc.logo)
        else if (meta.brandSrc.logo && meta.brandSrc.kind === 'jpg') img = await d.pdf.embedJpg(meta.brandSrc.logo)
      } catch (e) { console.warn('surveyor logo could not be embedded', String(e)) }
      meta.brand = { name: meta.brandSrc.name, img }
    }
    return d
  }

  newPage() {
    const p = this.pdf.addPage([A4_W, A4_H])
    this.pages.push(p)
    const { bodyTop, pageLabel } = drawHeader(p, this.fonts, this.meta, this.meta.eyebrow, this.meta.typeLabel, this.partLabel)
    this.labels.push(pageLabel)
    drawFooter(p, this.fonts, this.meta.brand)
    this.page = p
    this.y = bodyTop
    this.bodyTop = bodyTop
    this.bearingIdx = 0
  }

  /** Compass bearing labels: 090/180/270/000 per labelled section, restarting on every page. */
  bearing(): string {
    const B = ['090°', '180°', '270°', '000°']
    return B[this.bearingIdx++ % 4]
  }

  room(): number { return this.y - BODY_BOTTOM }
  /** New page unless the current page is still (almost) empty or has plenty of room left. */
  freshPage(minRoom = 9999) { if (this.bodyTop - this.y > 40 && this.room() < minRoom) this.newPage() }
  ensure(h: number) { if (this.y - h < BODY_BOTTOM) this.newPage() }

  text(s: string, x: number, y: number, size: number, f: PDFFont, color: Color = INK_900) {
    this.page.drawText(pdfSafe(s ?? ''), { x, y, size, font: f, color })
  }
  textRight(s: string, xr: number, y: number, size: number, f: PDFFont, color: Color = INK_900) {
    const t = pdfSafe(s ?? '')
    this.page.drawText(t, { x: xr - f.widthOfTextAtSize(t, size), y, size, font: f, color })
  }

  /** Section label "090°  TITLE" with optional right-hand note (e.g. "3 photos"). */
  section(title: string, opts: { right?: string; keepWith?: number } = {}) {
    if (this.bodyTop - this.y > 20) this.y -= 4
    this.ensure(22 + (opts.keepWith ?? 40))
    const f = this.fonts
    this.text(this.bearing(), M, this.y, 8, f.mono, SKY_500)
    this.text(title.toUpperCase(), M + 26, this.y, 8.5, f.bold, SLATE_500)
    if (opts.right) this.textRight(opts.right, A4_W - M, this.y, 8, f.body, SLATE_300)
    this.y -= 16
  }

  /** Big page title ("Tank soundings") with the GBQS reference on the right. */
  pageTitle(title: string) {
    this.ensure(60)
    this.text(title, M, this.y - 4, 15, this.fonts.bold, INK_900)
    this.textRight(this.meta.gbqsReference, A4_W - M, this.y - 2, 8.5, this.fonts.mono, SLATE_500)
    this.y -= 30
  }

  subTitle(title: string, color: Color = SKY_500, keepWith = 50) {
    if (this.bodyTop - this.y > 20) this.y -= 6
    this.ensure(14 + keepWith)
    this.text(title.toUpperCase(), M, this.y, 8.5, this.fonts.bold, color)
    this.y -= 14
  }

  /** Vessel block (bearing + VESSEL + name + details) with optional "carried out on behalf of". */
  vesselBlock(v: { name: string; lines: string[] }, onBehalfOf?: string | null) {
    const f = this.fonts
    const top = this.y
    this.text(this.bearing(), M, top, 8, f.mono, SKY_500)
    this.text('VESSEL', M, top - 14, 8, f.bold, SLATE_500)
    this.text(fit(v.name, f.bold, 11, 300), M, top - 30, 11, f.bold, INK_900)
    v.lines.filter(Boolean).forEach((l, i) => this.text(fit(l, f.body, 9, 300), M, top - 42 - i * 12, 9, f.body, SLATE_500))
    if (onBehalfOf) {
      const label = 'CARRIED OUT ON BEHALF OF'
      this.textRight(label, A4_W - M, top - 14, 7, f.bold, SKY_500)
      const nm = fit(onBehalfOf, f.bold, 10.5, 230)
      this.textRight(nm, A4_W - M, top - 28, 10.5, f.bold, INK_900)
    }
    this.y = top - 42 - v.lines.filter(Boolean).length * 12 - 12
  }

  /** Paper info box with a 3-column key/value grid; rows of up to 3 [key, value, mono?] cells. */
  infoBox(rows: Array<Array<[string, string, boolean?] | null>>, opts: { cols?: number } = {}) {
    const f = this.fonts
    const cols = opts.cols ?? 3
    const colW = CONTENT_W / cols
    // measure
    const rowHeights = rows.map(r => {
      let lines = 1
      r.forEach(c => { if (c) lines = Math.max(lines, Math.min(3, wrap(c[1] || '-', c[2] ? f.monoBold : f.bold, 9, colW - 14).length)) })
      return 14 + lines * 11 + 6
    })
    const h = rowHeights.reduce((a, b) => a + b, 0) + 6
    this.ensure(h + 8)
    this.page.drawRectangle({ x: M - BLEED, y: this.y - h, width: CONTENT_W + 2 * BLEED, height: h, color: PAPER_50, borderColor: LINE_200, borderWidth: 1 })
    let yy = this.y - 6
    rows.forEach((r, ri) => {
      r.forEach((c, ci) => {
        if (!c) return
        const x = M + ci * colW
        this.text(c[0].toUpperCase(), x, yy - 10, 7, f.bold, SKY_500)
        const font = c[2] ? f.monoBold : f.bold
        wrap(c[1] || '-', font, 9, colW - 14).slice(0, 3).forEach((ln, li) => this.text(ln, x, yy - 23 - li * 11, 9, font, INK_900))
      })
      yy -= rowHeights[ri]
    })
    this.y -= h + 12
  }

  /** Wrapped paragraph; box = 'sky' (remarks style) | 'paper' | 'amber' | none. */
  paragraph(s: string, opts: { size?: number; color?: Color; font?: PDFFont; box?: 'sky' | 'paper' | 'amber' | 'crit'; label?: string } = {}) {
    if (!s) return
    const f = this.fonts
    const size = opts.size ?? 8.5
    const font = opts.font ?? f.body
    const pad = opts.box ? 10 : 0
    const maxW = CONTENT_W - 2 * pad
    const lineH = size + 3.5
    let lines = wrap(s, font, size, maxW - (opts.label ? 0 : 0))
    const labelLines = opts.label ? 1 : 0
    // split across pages if needed
    while (lines.length) {
      const avail = Math.max(1, Math.floor((this.room() - 2 * pad - labelLines * lineH - 6) / lineH))
      if (avail < 2 && lines.length > 1) { this.newPage(); continue }
      const chunk = lines.slice(0, avail)
      lines = lines.slice(avail)
      const h = chunk.length * lineH + 2 * pad + labelLines * lineH + (opts.box ? 2 : 0)
      if (opts.box) {
        const bg = opts.box === 'sky' ? SKY_TINT : opts.box === 'amber' ? AMBER_TINT : opts.box === 'crit' ? CRIT_TINT : PAPER_50
        const bd = opts.box === 'sky' ? SKY_TINT_LINE : opts.box === 'amber' ? AMBER_TINT_LINE : LINE_200
        this.page.drawRectangle({ x: M - BLEED, y: this.y - h, width: CONTENT_W + 2 * BLEED, height: h, color: bg, borderColor: bd, borderWidth: 1 })
      }
      let yy = this.y - pad - size
      if (opts.label) { this.text(opts.label, M + pad - (opts.box ? BLEED - 4 : 0), yy, size, f.bold, INK_900); yy -= lineH }
      chunk.forEach(l => { this.text(l, M + pad - (opts.box ? BLEED - 4 : 0), yy, size, font, opts.color ?? (opts.box ? INK_900 : SLATE_500)); yy -= lineH })
      this.y -= h + (opts.box ? 8 : 10)
      if (lines.length) this.newPage()
    }
  }

  /** Coloured confirm/notice banner (green ok / amber warn / red crit). */
  banner(s: string, kind: 'ok' | 'warn' | 'crit') {
    const f = this.fonts
    const lines = wrap(s, f.bold, 9, CONTENT_W - 10)
    const h = 14 + lines.length * 12
    this.ensure(h + 8)
    const bg = kind === 'ok' ? GREEN_TINT : kind === 'warn' ? AMBER_TINT : CRIT_TINT
    const fg = kind === 'ok' ? GREEN_700 : kind === 'warn' ? AMBER_700 : CRIT_700
    this.page.drawRectangle({ x: M - BLEED, y: this.y - h, width: CONTENT_W + 2 * BLEED, height: h, color: bg })
    lines.forEach((l, i) => this.text(l, M, this.y - 16 - i * 12, 9, f.bold, fg))
    this.y -= h + 12
  }

  /** Navy result bar: title + subtitle left, figures (stacked) or a pill right. */
  resultBar(title: string, subtitle: string, figures: string[], opts: { pill?: string } = {}) {
    const f = this.fonts
    const rowGap = 15
    const h = figures.length > 1 ? 50 + (figures.length - 1) * rowGap : 42
    this.ensure(h + 14)
    const y = this.y
    gradientBand(this.page, M - BLEED, y - h, CONTENT_W + 2 * BLEED, h)
    this.text('000°', M + 6, y - 21 - 3, 8, f.mono, SKY_300)
    this.text(title, M + 36, y - 17, 11, f.bold, WHITE)
    this.text(fit(subtitle, f.mono, 8, 300), M + 36, y - 30, 8, f.mono, SKY_300)
    const xr = A4_W - M + BLEED - 14
    if (opts.pill) {
      const lbl = pdfSafe(opts.pill.toUpperCase())
      const w = f.monoBold.widthOfTextAtSize(lbl, 11) + 24
      this.page.drawRectangle({ x: xr - w, y: y - h / 2 - 9, width: w, height: 20, color: SKY_300, opacity: 0.18 })
      this.text(lbl, xr - w + 12, y - h / 2 - 4, 11, f.monoBold, SKY_300)
    } else if (figures.length === 1) {
      const sz = figures[0].length > 18 ? 13 : 16
      this.textRight(figures[0], xr, y - h / 2 - 5, sz, f.monoBold, SKY_300)
    } else {
      let ly = y - 20
      figures.forEach(s => { this.textRight(s, xr, ly, 11.5, f.monoBold, SKY_300); ly -= rowGap })
    }
    this.y -= h + 14
  }

  /** "Part 2 - Vessel Condition Survey" divider (navy circle + title + rule). */
  partDivider(n: number, title: string, sub: string) {
    const f = this.fonts
    this.ensure(70)
    const y = this.y
    this.page.drawEllipse({ x: M + 6, y: y - 12, xScale: 15, yScale: 15, color: NAVY_950 })
    this.text(String(n), M + 6 - f.monoBold.widthOfTextAtSize(String(n), 12) / 2, y - 16, 12, f.monoBold, SKY_300)
    this.text(title, M + 30, y - 9, 13, f.bold, INK_900)
    this.text(sub, M + 30, y - 22, 8.5, f.body, SLATE_500)
    const tw = Math.max(f.bold.widthOfTextAtSize(pdfSafe(title), 13), f.body.widthOfTextAtSize(pdfSafe(sub), 8.5))
    if (M + 40 + tw < A4_W - M) this.page.drawLine({ start: { x: M + 40 + tw, y: y - 12 }, end: { x: A4_W - M, y: y - 12 }, thickness: 1, color: LINE_200 })
    this.y -= 44
  }

  /** Grid table that wraps cells and breaks across pages (repeating the header). */
  table(cols: Col[], rows: Cell[][], opts: TableOpts = {}) {
    const f = this.fonts
    const size = opts.size ?? 8
    const lineH = size + 2.6
    const totalW = cols.reduce((a, c) => a + c.w, 0)
    const scale = CONTENT_W / totalW
    const W = cols.map(c => c.w * scale)
    const X: number[] = []
    { let cum = M; for (const w of W) { X.push(cum); cum += w } }
    const HS = 6.5
    const headerLines = cols.map((c, i) => wrap(c.label.toUpperCase(), f.bold, HS, W[i] - 8))
    const headerH = 9 + Math.max(...headerLines.map(l => l.length)) * 8
    const cellFont = (c: Col, cell: Cell) => {
      if (typeof cell !== 'string') {
        if (cell.pill !== undefined) return f.monoBold
        if (cell.bold && (cell.mono ?? c.mono)) return f.monoBold
        if (cell.bold) return f.bold
        if (cell.italic) return f.italic
        if (cell.mono ?? c.mono) return f.mono
      }
      if (c.bold) return f.bold
      return c.mono ? f.mono : f.body
    }
    const cellText = (cell: Cell) => (typeof cell === 'string' ? cell : cell.t) ?? '-'
    const shown = (cell: Cell) => { const t = cellText(cell); return t === '' ? '' : (t || '-') }
    const measure = (row: Cell[]) => {
      let n = 1
      row.forEach((cell, i) => { if (i < cols.length && !(typeof cell !== 'string' && cell.pill !== undefined)) n = Math.max(n, wrap(cellText(cell) || '-', cellFont(cols[i], cell), size, W[i] - 10).length) })
      return Math.max(opts.minRowH ?? 0, 8 + n * lineH)
    }
    let tableTop = 0
    const drawHeaderRow = () => {
      tableTop = this.y
      this.page.drawRectangle({ x: M, y: this.y - headerH, width: CONTENT_W, height: headerH, color: opts.headerTint ?? SKY_TINT })
      cols.forEach((c, i) => headerLines[i].forEach((ln, li) => {
        const tx = c.align === 'right' ? X[i] + W[i] - 5 - f.bold.widthOfTextAtSize(ln, HS) : X[i] + 5
        this.page.drawText(ln, { x: tx, y: this.y - 9 - li * 8, size: HS, font: f.bold, color: SLATE_500 })
      }))
      this.y -= headerH
    }
    const closeGrid = () => {
      if (opts.grid !== false) {
        this.page.drawRectangle({ x: M, y: this.y, width: CONTENT_W, height: tableTop - this.y, borderColor: SLATE_300, borderWidth: 0.8 })
        X.forEach((cx, i) => { if (i > 0) this.page.drawLine({ start: { x: cx, y: tableTop }, end: { x: cx, y: this.y }, thickness: 0.4, color: LINE_200 }) })
        this.page.drawLine({ start: { x: M, y: tableTop - headerH }, end: { x: A4_W - M, y: tableTop - headerH }, thickness: 0.7, color: SLATE_300 })
      }
    }
    const drawRow = (row: Cell[], ri: number, tint?: Color) => {
      const h = measure(row)
      const top = this.y
      if (tint) this.page.drawRectangle({ x: M, y: top - h, width: CONTENT_W, height: h, color: tint })
      else if (opts.zebra !== false && ri % 2 === 1) this.page.drawRectangle({ x: M, y: top - h, width: CONTENT_W, height: h, color: ZEBRA })
      row.forEach((cell, i) => {
        if (i >= cols.length) return
        const c = cols[i]
        const font = cellFont(c, cell)
        const color = typeof cell !== 'string' && cell.color ? cell.color : (c.bold ? INK_900 : (c.mono ? SLATE_500 : INK_900))
        if (typeof cell !== 'string' && cell.pill !== undefined) {
          const lbl = pdfSafe((cell.t || '-').toUpperCase())
          const pc = pillColors(cell.pill ?? cell.t)
          const ps = Math.min(size, 7.5)
          const w = Math.min(W[i] - 8, f.monoBold.widthOfTextAtSize(lbl, ps) + 10)
          const px = c.align === 'right' ? X[i] + W[i] - 4 - w : X[i] + 4
          this.page.drawRectangle({ x: px, y: top - 5 - ps - 3, width: w, height: ps + 5, color: pc.bg })
          this.page.drawText(fit(lbl, f.monoBold, ps, w - 8), { x: px + 5, y: top - 5 - ps, size: ps, font: f.monoBold, color: pc.fg })
          return
        }
        wrap(shown(cell), font, size, W[i] - 10).forEach((ln, li) => {
          const tx = c.align === 'right' ? X[i] + W[i] - 5 - font.widthOfTextAtSize(ln, size) : X[i] + 5
          this.page.drawText(ln, { x: tx, y: top - 4 - size - li * lineH + 1, size, font, color })
        })
      })
      this.y -= h
      this.page.drawLine({ start: { x: M, y: this.y }, end: { x: A4_W - M, y: this.y }, thickness: 0.35, color: LINE_200 })
    }
    const firstH = rows.length ? measure(rows[0]) : 16
    this.ensure(headerH + firstH + (opts.subtotal ? 18 : 0) + 4)
    drawHeaderRow()
    if (!rows.length) {
      const h = 16
      this.page.drawText('No entries', { x: M + 5, y: this.y - 11, size: 7.5, font: f.italic, color: SLATE_500 })
      this.y -= h
    }
    rows.forEach((row, ri) => {
      const h = measure(row)
      if (this.y - h < BODY_BOTTOM) {
        closeGrid()
        this.newPage()
        drawHeaderRow()
      }
      drawRow(row, ri)
    })
    if (opts.subtotal) {
      const h = Math.max(18, measure(opts.subtotal))
      if (this.y - h < BODY_BOTTOM) { closeGrid(); this.newPage(); drawHeaderRow() }
      const top = this.y
      this.page.drawRectangle({ x: M, y: top - h, width: CONTENT_W, height: h, color: SKY_TINT })
      this.page.drawLine({ start: { x: M, y: top }, end: { x: A4_W - M, y: top }, thickness: 0.7, color: SLATE_300 })
      opts.subtotal.forEach((cell, i) => {
        const t = cellText(cell)
        if (!t) return
        const c = cols[i]
        const font = i === 0 ? f.italic : f.monoBold
        const color = i === 0 ? SLATE_500 : INK_900
        const sz = i === 0 ? size : size + 0.5
        const tx = c.align === 'right' ? X[i] + W[i] - 5 - font.widthOfTextAtSize(pdfSafe(t), sz) : X[i] + 5
        this.page.drawText(pdfSafe(t), { x: tx, y: top - 12.5, size: sz, font, color })
      })
      this.y -= h
    }
    closeGrid()
    this.y -= 12
  }

  /** Compare table in the style of the summary block: SOURCE column + one right-aligned column per grade. */
  compare(grades: string[], rows: Array<{ label: string; values: Array<string | { t: string; color?: Color }>; italic?: boolean; bold?: boolean; color?: Color }>) {
    const f = this.fonts
    const labelW = 170
    const colW = (CONTENT_W - labelW) / Math.max(1, grades.length)
    this.ensure(30 + rows.length * 17)
    this.text('SOURCE', M, this.y, 7.5, f.bold, SLATE_300)
    grades.forEach((g, i) => this.textRight(g, M + labelW + (i + 1) * colW, this.y, 7.5, f.bold, SLATE_300))
    this.y -= 6
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: A4_W - M, y: this.y }, thickness: 0.75, color: LINE_200 })
    this.y -= 15
    for (const r of rows) {
      this.ensure(17)
      this.text(fit(r.label, f.body, 9, labelW - 6), M, this.y, 9, r.italic ? f.italic : (r.bold ? f.bold : f.body), r.color ?? (r.italic ? SLATE_500 : INK_900))
      r.values.forEach((v, i) => {
        const t = typeof v === 'string' ? v : v.t
        const c = typeof v === 'string' ? (r.color ?? INK_900) : (v.color ?? r.color ?? INK_900)
        this.textRight(t, M + labelW + (i + 1) * colW, this.y, 9.5, r.bold || r.italic ? f.monoBold : f.mono, c)
      })
      this.y -= 17
    }
    this.y += 5
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: A4_W - M, y: this.y }, thickness: 0.75, color: LINE_200 })
    this.y -= 16
  }

  /** Two-column signature grid. Each block: role, name, image/line, status caption (LT time / reason). */
  async signatures(title: string, blocks: SigBlock[]) {
    const f = this.fonts
    if (!blocks.length) return
    const colW = CONTENT_W / 2
    const sigMaxW = colW - 30
    const sigMaxH = 32
    const imgs = await Promise.all(blocks.map(b => embedImage(this.pdf, b.image)))
    const rowsN = Math.ceil(blocks.length / 2)
    const capLines = blocks.map(b => this.sigCaption(b, sigMaxW).length)
    const rowH = (r: number) => 26 + sigMaxH + 8 + 10 * Math.max(capLines[r * 2] ?? 1, capLines[r * 2 + 1] ?? 1) + 12
    this.ensure(18 + rowH(0))
    this.text(title.toUpperCase(), M, this.y, 8, f.bold, SLATE_500)
    this.y -= 18
    for (let r = 0; r < rowsN; r++) {
      this.ensure(rowH(r))
      const top = this.y
      for (let c = 0; c < 2; c++) {
        const i = r * 2 + c
        const b = blocks[i]
        if (!b) continue
        const px = M + c * colW
        this.text(b.role.toUpperCase(), px, top, 7, f.bold, SLATE_500)
        const isGcs = !!(this.gcsImg && this.meta.gcs && /surveyor/i.test(b.role))
        const nm = fit(b.name || '-', f.bold, 10.5, isGcs ? sigMaxW - 110 : sigMaxW)
        this.text(nm, px, top - 15, 10.5, f.bold, INK_900)
        if (isGcs) {
          // C6: small official badge + certificate number next to the surveyor's name
          const bx = px + f.bold.widthOfTextAtSize(nm, 10.5) + 6
          const bh = 15, bw = bh * this.gcsImg!.width / this.gcsImg!.height
          this.page.drawImage(this.gcsImg!, { x: bx, y: top - 19, width: bw, height: bh })
          this.text(this.meta.gcs!.number, bx + bw + 4, top - 12, 6.5, f.bold, SLATE_500)
          this.text('GlobalBQS Certified Surveyor', bx + bw + 4, top - 19.5, 6, f.body, SLATE_500)
        }
        const slotBottom = top - 26 - sigMaxH
        const img = imgs[i]
        if (img && b.status !== 'not_signed') {
          const scale = Math.min(sigMaxW / img.width, sigMaxH / img.height, 1)
          this.page.drawImage(img, { x: px, y: slotBottom, width: img.width * scale, height: img.height * scale })
        }
        this.page.drawLine({ start: { x: px, y: slotBottom }, end: { x: px + sigMaxW, y: slotBottom }, thickness: 0.75, color: LINE_200 })
        const st = b.status ?? ''
        const capColor = st === 'not_signed' ? CRIT_700 : st === 'receipt_only' ? AMBER_700 : SLATE_500
        this.sigCaption(b, sigMaxW).forEach((ln, li) => this.text(ln, px, slotBottom - 10 - li * 10, 7.5, f.italic, capColor))
      }
      this.y -= rowH(r)
    }
    // A5: "Issued by [surveyor company]" under the surveyor's signature (own jobs only, once)
    if (this.meta.brand && !this.issuedByDrawn && blocks.some(b => /surveyor/i.test(b.role))) {
      this.issuedByDrawn = true
      this.ensure(30)
      this.text('ISSUED BY', M, this.y - 2, 7, f.bold, SLATE_500)
      this.text(fit(this.meta.brand.name, f.bold, 10.5, CONTENT_W), M, this.y - 16, 10.5, f.bold, INK_900)
      this.y -= 30
    }
    this.y -= 4
  }

  private sigCaption(b: SigBlock, maxW: number): string[] {
    const at = b.signedAt ? ` - ${b.signedAt}` : ''
    let s: string
    if (b.status === 'signed') s = `Signed electronically${at}`
    else if (b.status === 'receipt_only') s = `Signed for receipt only (not for agreement)${at}`
    else if (b.status === 'not_signed') s = `Not signed${b.reason ? ' - reason: ' + b.reason : ''}${at}`
    else s = 'No signature on file'
    return wrap(s, this.fonts.italic, 7.5, maxW)
  }

  /** Photo appendix: 4-column grid of 4:3 thumbnails, numbered, grouped (and optionally sub-grouped). */
  async photoAppendix(groups: PhotoGroup[], note?: string) {
    const f = this.fonts
    const embedAll = async (items: PhotoItem[]) => {
      const out: Array<{ img: PDFImage; caption: string }> = []
      for (const it of items) { const img = await embedImage(this.pdf, it.img); if (img) out.push({ img, caption: it.caption }) }
      return out
    }
    const prepared: Array<{ title: string; sub: Array<{ title: string; items: Array<{ img: PDFImage; caption: string }> }> }> = []
    for (const g of groups) {
      const sub: Array<{ title: string; items: Array<{ img: PDFImage; caption: string }> }> = []
      if (g.items?.length) { const e = await embedAll(g.items); if (e.length) sub.push({ title: '', items: e }) }
      for (const s of g.sub ?? []) { const e = await embedAll(s.items); if (e.length) sub.push({ title: s.title, items: e }) }
      if (sub.length) prepared.push({ title: g.title, sub })
    }
    if (!prepared.length) return 0
    this.newPage()
    this.pageTitle('Photo appendix')
    if (note) { this.paragraph(note, { box: 'paper', size: 8 }); this.y -= 6 }
    const cols = 4
    const gap = 14
    const cellW = (CONTENT_W - (cols - 1) * gap) / cols
    const cellH = (cellW * 3) / 4
    const captionH = 28
    const rowH = cellH + captionH + 8
    const drawGrid = (items: Array<{ img: PDFImage; caption: string }>) => {
      let col = 0
      let rowTop = this.y
      for (const { img, caption } of items) {
        if (col === 0) { this.ensure(rowH); rowTop = this.y }
        const cx = M + col * (cellW + gap)
        this.text(String(this.photoNo).padStart(2, '0'), cx, rowTop, 7.5, f.mono, SKY_500)
        const cellTop = rowTop - 11
        this.page.drawRectangle({ x: cx, y: cellTop - cellH, width: cellW, height: cellH, color: SKY_TINT, borderColor: LINE_200, borderWidth: 1 })
        const scale = Math.min(cellW / img.width, cellH / img.height)
        const w = img.width * scale
        const h = img.height * scale
        this.page.drawImage(img, { x: cx + (cellW - w) / 2, y: cellTop - cellH + (cellH - h) / 2, width: w, height: h })
        wrap(caption, f.body, 7, cellW).slice(0, 2).forEach((ln, li) => this.text(ln, cx, cellTop - cellH - 11 - li * 9, 7, f.body, SLATE_500))
        this.photoNo++
        col++
        if (col === cols) { col = 0; this.y = rowTop - cellH - captionH - 6 }
      }
      if (col !== 0) this.y = rowTop - cellH - captionH - 6
    }
    let count = 0
    for (const g of prepared) {
      const total = g.sub.reduce((a, s) => a + s.items.length, 0)
      count += total
      this.ensure(30 + rowH)
      this.text(this.bearing(), M, this.y, 8, f.mono, SKY_500)
      this.text(g.title.toUpperCase(), M + 26, this.y, 8.5, f.bold, SLATE_500)
      this.textRight(`${total} photo${total === 1 ? '' : 's'}`, A4_W - M, this.y, 8, f.body, SLATE_300)
      this.y -= 22
      for (const s of g.sub) {
        if (s.title) {
          this.ensure(16 + rowH)
          this.text(s.title.toUpperCase(), M, this.y, 9.5, f.bold, SKY_500)
          this.textRight(`${s.items.length} photo${s.items.length === 1 ? '' : 's'}`, A4_W - M, this.y, 8, f.body, SLATE_300)
          this.y -= 16
        }
        drawGrid(s.items)
        this.y -= 12
      }
      this.y -= 8
    }
    return count
  }

  /** Arrow continuation note in a paper box. */
  note(s: string) {
    const f = this.fonts
    const lines = wrap('-> ' + s, f.body, 8.5, CONTENT_W - 12)
    const h = 14 + lines.length * 11
    if (this.y - h - 4 < BODY_BOTTOM) return // a continuation note only makes sense at the bottom of the page it belongs to
    this.page.drawRectangle({ x: M - BLEED, y: this.y - h, width: CONTENT_W + 2 * BLEED, height: h, color: PAPER_50 })
    lines.forEach((l, i) => this.text(l, M + 6, this.y - 14 - i * 11, 8.5, f.body, SLATE_500))
    this.y -= h + 10
  }

  async finish(): Promise<Uint8Array> {
    const total = this.pages.length
    this.labels.forEach((pl, i) => {
      const label = `${pl.prefix ?? ''}Page ${i + 1} of ${total}`
      pl.page.drawText(pdfSafe(label), { x: pl.x - this.fonts.mono.widthOfTextAtSize(pdfSafe(label), 8.5), y: pl.y, size: 8.5, font: this.fonts.mono, color: SKY_300 })
    })
    return await this.pdf.save()
  }
}

// C6 (10-11-2026): official GCS badge, 69x64 JPEG on white, for the surveyor signature block in GBQS reports.
const GCS_BADGE_JPG_B64 = "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"

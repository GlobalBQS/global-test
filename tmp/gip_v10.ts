// ============================================================================
// generate-invoice-pdf - single-file Edge Function (GlobalBQS)
// Builds the invoice PDF in the house style (same components as generate-survey-report:
// header/footer band, VESSEL-style party blocks, PAPER_50 info-box strips, summary table,
// navy result band), stores it in survey-documents/invoices/{invoice_number}.pdf and sets
// invoices.pdf_file_id, pdf_file_name, pdf_uploaded_at.
//
// POST JSON:
//   { "invoice_id": "..." }                 -> generate + store
//   { "invoice_number": "INV-2026-0242" }   -> same, by number
//   { "invoice_id": "...", "send": true }   -> also POST to MAKE_INVOICE_READY_WEBHOOK_URL
//                                              (Make mails the client; Make sets sent_at/sent_to)
//   { "backfill": true, "limit": 25, "force": true }  -> regenerate (force = also existing PDFs)
// Auth: header x-retool-secret (= env RETOOL_SHARED_SECRET) or x-gbqs-token
//       (= vault secret gbqs_internal_invoke_token, for pg_net / internal calls).
// Env: MAKE_INVOICE_READY_WEBHOOK_URL (optional), PORTAL_URL (optional).
// v2 (24/9/2026): page 1 restyled to the survey-report component set.
// v4 (8/10/2026): FROM block aligned with the Invoice number column; KvK and VAT on separate lines.
// v6 (12/10/2026): bookkeeping copy for SnelStart in EUR (ECB rate of the invoice date, locked on the
//                 invoice via gbqs_invoice_fx_lock): payload bcc_pdf_base64 / bcc_file_name; body { invoice_id, eur_copy: true }
//                 returns that EUR PDF as base64 (used by send-invoice).
// v5 (12/10/2026): payload field bcc_email = system_settings.snelstart_bcc_email on the first send only.
// v3 (8/10/2026): client PO / reference. Invoice level: invoices.po_reference (default from
//                 clients.po_reference), else the single shared order PO. Order level:
//                 orders.po_number_client_ref shown under the service line.
// v7 (21/10/2026): page 1 payment instructions anchored to the bottom (above the continuation note).
// v8 (10/11/2026): surveyor credit invoices (invoices.surveyor_company_id): one page, VAT lines (invoices.vat_rate /
//                 vat_amount / net_amount / vat_note), 'Paid by card' instead of payment instructions, mailed to the
//                 company's invoice e-mail. Client invoices without vat_rate are unchanged.
// v9 (10/11/2026): surveyor credit invoices paid by bank transfer (bundles of 25/100): unpaid -> due date =
//                 issue date + system_settings.sa_invoice_term_days (default 14), payment instructions on page 1
//                 and a note that the credits are added once the payment is received. Make payload: invoice_kind, paid.
// v10 (10/11/2026): VAT advice. Dutch VAT on a non-EUR invoice is also stated in EUR (ECB reference rate of the
//                 invoice date, locked via gbqs_invoice_fx_lock). Client invoices: optional VAT line + note from
//                 system_settings.client_invoice_vat_note (zero rate seagoing vessels); empty setting = unchanged.
//                 VAT notes wrap over several lines.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { PDFDocument, StandardFonts, rgb, LineCapStyle, type PDFFont, type PDFPage, type Color } from 'https://esm.sh/pdf-lib@1.17.1'

type InvoiceCost = { description: string; amount: number }
type InvoiceOrderLine = { reference: string; vessel: string; service: string; po?: string; surveyCount: number; fee: number; costs: InvoiceCost[]; lineTotal: number }
type InvoiceGroup = { key: string; title: string; subtitle: string; lines: InvoiceOrderLine[] }
type InvoicePdfData = {
  invoiceNumber: string
  issueDate: string
  dueDate: string
  period: string
  currency: string
  total: number
  poReference?: string
  from: { name: string; lines: string[]; regLine?: string }
  client: { name: string; lines: string[]; vat?: string }
  groups: InvoiceGroup[]
  extraLines: InvoiceCost[]
  bank: { iban?: string; name?: string; address?: string; swift?: string }
  headerLabel?: string
  fxNote?: string
  vat?: { rate: number; amount: number; net: number; note?: string; eur?: { amount: number; net: number; ratePerEur: number; rateDate: string; cur: string } }
  paid?: { date: string; method: string }
  singlePage?: boolean
}

const NAVY_950_T: [number, number, number] = [0.039, 0.102, 0.200]
const NAVY_800_T: [number, number, number] = [0.082, 0.196, 0.388]
const SKY_500 = rgb(0.184, 0.627, 0.839)
const SKY_300 = rgb(0.561, 0.824, 0.933)
const INK_900 = rgb(0.063, 0.125, 0.239)
const SLATE_500 = rgb(0.361, 0.420, 0.522)
const SLATE_300 = rgb(0.576, 0.631, 0.733)
const LINE_200 = rgb(0.886, 0.906, 0.949)
const SKY_TINT_LINE = rgb(0.788, 0.902, 0.949)
const PAPER_50 = rgb(0.961, 0.973, 0.988)
const WHITE = rgb(1, 1, 1)

const A4_W = 595.28
const A4_H = 841.89
const M = 42
const HEADER_H = 118
const FOOTER_H = 34
const CONTENT_W = A4_W - 2 * M

type Fonts = { body: PDFFont; bold: PDFFont; italic: PDFFont; mono: PDFFont; monoBold: PDFFont }

function money(v: number, cur: string): string {
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${v < 0 ? '-' : ''}${cur} ${s}`
}
function fit(text: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text
  let t = text
  while (t.length > 1 && font.widthOfTextAtSize(t + '...', size) > maxW) t = t.slice(0, -1)
  return t + '...'
}
function wrapText(t: string, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const w of t.split(/\s+/).filter(Boolean)) {
    const nx = cur ? cur + ' ' + w : w
    if (font.widthOfTextAtSize(nx, size) <= maxW || !cur) cur = nx
    else { out.push(cur); cur = w }
  }
  if (cur) out.push(cur)
  return out
}
function safe(s: string | null | undefined): string {
  return (s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
}
function rightText(page: PDFPage, text: string, xRight: number, y: number, size: number, font: PDFFont, color: Color) {
  page.drawText(text, { x: xRight - font.widthOfTextAtSize(text, size), y, size, font, color })
}
function gradientBand(page: PDFPage, x: number, y: number, w: number, h: number) {
  const steps = 32, stripW = w / steps
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
function drawRing(page: PDFPage, cx: number, cy: number) {
  const opacity = 0.35
  page.drawEllipse({ x: cx, y: cy, xScale: 92, yScale: 92, borderColor: SKY_300, borderWidth: 1, borderOpacity: opacity })
  page.drawEllipse({ x: cx, y: cy, xScale: 68, yScale: 68, borderColor: SKY_300, borderWidth: 1, borderOpacity: opacity })
  const ticks: Array<[number, number, number, number]> = [
    [cx, cy + 90, cx, cy + 104], [cx, cy - 104, cx, cy - 90], [cx - 104, cy, cx - 90, cy], [cx + 90, cy, cx + 104, cy],
  ]
  for (const [x1, y1, x2, y2] of ticks) page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1, color: SKY_300, opacity })
}
function drawBrandMark(page: PDFPage, fonts: Fonts, x: number, cy: number) {
  const s = 0.42, reach = 46 * s, cx = x + reach
  const anchor = { x: cx - 50 * s, y: cy + 50 * s, scale: s }
  const kite = (path: string, color: Color) => page.drawSvgPath(path, { ...anchor, color })
  kite('M50 4 L58 44 L50 50 L42 44 Z', SKY_300)
  kite('M96 50 L56 58 L50 50 L56 42 Z', WHITE)
  kite('M50 96 L42 56 L50 50 L58 56 Z', WHITE)
  kite('M4 50 L44 42 L50 50 L44 58 Z', SKY_300)
  const arc = (a0: number, a1: number, color: Color) => {
    const pts: string[] = []
    for (let i = 0; i <= 16; i++) {
      const t = ((a0 + (a1 - a0) * (i / 16)) * Math.PI) / 180
      pts.push(`${i === 0 ? 'M' : 'L'} ${(50 + 34 * Math.cos(t)).toFixed(2)} ${(50 + 34 * Math.sin(t)).toFixed(2)}`)
    }
    page.drawSvgPath(pts.join(' '), { ...anchor, borderColor: color, borderWidth: 6, borderLineCap: LineCapStyle.Round })
  }
  arc(-45, 45, SKY_300)
  arc(135, 225, WHITE)
  const wordX = cx + reach + 14, size = 16
  page.drawText('Global', { x: wordX, y: cy - size * 0.36, size, font: fonts.bold, color: WHITE })
  page.drawText('BQS', { x: wordX + fonts.bold.widthOfTextAtSize('Global', size), y: cy - size * 0.36, size, font: fonts.bold, color: SKY_300 })
}

type PageLabel = { page: PDFPage; x: number; y: number }

function drawHeader(page: PDFPage, fonts: Fonts, d: InvoicePdfData): { bodyTop: number; label: PageLabel } {
  const top = A4_H
  gradientBand(page, 0, top - HEADER_H, A4_W, HEADER_H)
  drawRing(page, A4_W - 66, top - 60)
  page.drawRectangle({ x: 0, y: top - HEADER_H - 70, width: A4_W, height: 70, color: WHITE }) // clip ring below the band
  drawBrandMark(page, fonts, M, top - 38)
  const rx = A4_W - M
  rightText(page, d.headerLabel ?? 'INVOICE', rx, top - 30, 7.5, fonts.mono, SKY_300)
  rightText(page, d.invoiceNumber, rx, top - 50, 17, fonts.monoBold, WHITE)
  const metaY = top - HEADER_H + 24
  page.drawLine({ start: { x: M, y: metaY + 16 }, end: { x: A4_W - M, y: metaY + 16 }, thickness: 0.75, color: WHITE, opacity: 0.18 })
  page.drawText('Invoice date', { x: M, y: metaY, size: 8, font: fonts.monoBold, color: SKY_300 })
  page.drawText(d.issueDate, { x: M + 84, y: metaY, size: 8, font: fonts.mono, color: WHITE })
  const dv = d.dueDate, dvw = fonts.mono.widthOfTextAtSize(dv, 8), dlw = fonts.monoBold.widthOfTextAtSize('Due date', 8)
  page.drawText('Due date', { x: rx - dvw - 6 - dlw, y: metaY, size: 8, font: fonts.monoBold, color: SKY_300 })
  page.drawText(dv, { x: rx - dvw, y: metaY, size: 8, font: fonts.mono, color: WHITE })
  return { bodyTop: top - HEADER_H - 30, label: { page, x: rx, y: top - 63 } }
}
function drawFooter(page: PDFPage, fonts: Fonts) {
  gradientBand(page, 0, 0, A4_W, FOOTER_H)
  page.drawText('GlobalBQS - Standardised bunker survey reporting & analytics', { x: M, y: FOOTER_H / 2 - 3, size: 7.5, font: fonts.bold, color: SKY_300 })
  rightText(page, '000° globalbqs.com', A4_W - M, FOOTER_H / 2 - 3, 7.5, fonts.mono, SKY_300)
}
function sectionLabel(page: PDFPage, fonts: Fonts, b: string, text: string, y: number) {
  page.drawText(b, { x: M, y, size: 8, font: fonts.mono, color: SKY_500 })
  page.drawText(text.toUpperCase(), { x: M + 26, y, size: 8.5, font: fonts.bold, color: SLATE_500 })
}

async function buildInvoicePdf(d: InvoicePdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`${d.invoiceNumber} - GlobalBQS invoice`)
  pdf.setAuthor('GlobalBQS')
  const fonts: Fonts = {
    body: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
    monoBold: await pdf.embedFont(StandardFonts.CourierBold),
  }
  const cur = d.currency || 'USD'
  const labels: PageLabel[] = []
  const newPage = () => {
    const page = pdf.addPage([A4_W, A4_H])
    const h = drawHeader(page, fonts, d)
    drawFooter(page, fonts)
    labels.push(h.label)
    return { page, y: h.bodyTop }
  }

  // ════════════ PAGE 1 — summary (same component set as the survey reports) ════════════
  let { page, y } = newPage()
  const BLEED = 10
  const text = (t: string, x: number, yy: number, size: number, f: PDFFont, color: Color = INK_900) =>
    page.drawText(safe(t), { x, y: yy, size, font: f, color })

  // CLIENT (left) / FROM (right) - same block style as the report's VESSEL block
  // FROM aligns with the third column of the details strip (Invoice number)
  const col3 = CONTENT_W / 3
  const party = (x: number, b: string, label: string, name: string, lines: string[], colW: number) => {
    text(b, x, y, 8, fonts.mono, SKY_500)
    text(label, x, y - 14, 8, fonts.bold, SLATE_500)
    const all = [name, ...lines.filter(Boolean)]
    all.forEach((l, i) => text(fit(safe(l), i === 0 ? fonts.bold : fonts.body, i === 0 ? 11 : 9, colW), x, y - 30 - i * 12, i === 0 ? 11 : 9, i === 0 ? fonts.bold : fonts.body, i === 0 ? INK_900 : SLATE_500))
    return all.length
  }
  const nA = party(M, '090°', 'CLIENT', d.client.name, [...d.client.lines, d.client.vat ? `VAT ${d.client.vat}` : ''], 2 * col3 - 16)
  const nB = party(M + 2 * col3, '270°', 'FROM', d.from.name, [...d.from.lines, ...(d.from.regLine ? d.from.regLine.split('\n') : [])], col3)
  y = y - 30 - Math.max(nA, nB) * 12 - 16

  // INVOICE DETAILS strip (PAPER_50 info-box, like the report's survey-details strip)
  {
    const rowH = 64
    page.drawRectangle({ x: M - BLEED, y: y - rowH, width: CONTENT_W + 2 * BLEED, height: rowH, color: PAPER_50, borderColor: LINE_200, borderWidth: 1 })
    const cw = CONTENT_W / 3
    const cols: Array<[string, string, string, string]> = [
      ['Invoice date', d.issueDate, 'Due date', d.dueDate],
      ['Period', d.period, 'Currency', cur === 'USD' ? 'US Dollar (USD)' : cur],
      d.poReference
        ? ['Invoice number', d.invoiceNumber, 'Your reference (PO)', d.poReference]
        : ['Invoice number', d.invoiceNumber, 'Payment reference', d.invoiceNumber],
    ]
    cols.forEach(([k1, v1, k2, v2], i) => {
      const cx = M + i * cw
      text(k1.toUpperCase(), cx, y - 14, 7, fonts.bold, SKY_500)
      text(fit(safe(v1), fonts.monoBold, 9.5, cw - 12), cx, y - 27, 9.5, fonts.monoBold, INK_900)
      text(k2.toUpperCase(), cx, y - 41, 7, fonts.bold, SKY_500)
      text(fit(safe(v2), fonts.monoBold, 9.5, cw - 12), cx, y - 54, 9.5, fonts.monoBold, INK_900)
    })
    y -= rowH + 20
  }

  // SUMMARY table (same header/row/total styling as the report's summary table)
  sectionLabel(page, fonts, '180°', `Summary (${cur})`, y)
  y -= 20
  text('ITEM', M, y, 7.5, fonts.bold, SLATE_300)
  const amtHead = 'AMOUNT'
  text(amtHead, A4_W - M - fonts.bold.widthOfTextAtSize(amtHead, 7.5), y, 7.5, fonts.bold, SLATE_300)
  y -= 6
  page.drawLine({ start: { x: M, y }, end: { x: A4_W - M, y }, thickness: 0.75, color: LINE_200 })
  y -= 18
  type SumRow = { title: string; sub: string; amount: number }
  const rows: SumRow[] = d.groups.map(g => ({ title: g.title, sub: g.subtitle, amount: g.lines.reduce((a, l) => a + l.fee, 0) }))
  const extrasAsRows = !!d.singlePage
  const costTotal = d.groups.reduce((a, g) => a + g.lines.reduce((b, l) => b + l.costs.reduce((c, x) => c + x.amount, 0), 0), 0)
  if (costTotal > 0.004) rows.push({ title: 'Extra incurred costs', sub: 'entry permits, waiting time and other on-site costs', amount: costTotal })
  const extraTotal = d.extraLines.reduce((a, x) => a + x.amount, 0)
  if (extrasAsRows) for (const e of d.extraLines) rows.push({ title: e.description, sub: '', amount: e.amount })
  else if (d.extraLines.length) rows.push({ title: 'Additional items', sub: d.extraLines.length === 1 ? d.extraLines[0].description : `${d.extraLines.length} items`, amount: extraTotal })
  for (const r of rows) {
    text(fit(safe(r.title), fonts.body, 9, CONTENT_W - 120), M, y, 9, fonts.body, INK_900)
    text(fit(safe(r.sub), fonts.body, 7.8, CONTENT_W - 170), M + fonts.body.widthOfTextAtSize(safe(r.title), 9) + 8, y, 7.8, fonts.body, SLATE_500)
    const v = money(r.amount, cur)
    text(v, A4_W - M - fonts.mono.widthOfTextAtSize(v, 9.5), y, 9.5, fonts.mono, INK_900)
    y -= 17
  }
  if (d.vat) {
    const sv = money(d.vat.net, cur)
    text('Subtotal (excl. VAT)', M, y, 9, fonts.italic, SLATE_500)
    text(sv, A4_W - M - fonts.mono.widthOfTextAtSize(sv, 9.5), y, 9.5, fonts.mono, INK_900)
    y -= 17
    const vv = money(d.vat.amount, cur)
    text(`VAT ${Number(d.vat.rate).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`, M, y, 9, fonts.italic, SLATE_500)
    text(vv, A4_W - M - fonts.mono.widthOfTextAtSize(vv, 9.5), y, 9.5, fonts.mono, INK_900)
    y -= 17
  }
  text(d.vat ? 'Total (incl. VAT)' : 'Total', M, y, 9, fonts.italic, SLATE_500)
  const tv = money(d.total, cur)
  text(tv, A4_W - M - fonts.monoBold.widthOfTextAtSize(tv, 9.5), y, 9.5, fonts.monoBold, INK_900)
  y -= 12
  page.drawLine({ start: { x: M, y }, end: { x: A4_W - M, y }, thickness: 0.75, color: LINE_200 })
  y -= 16

  // TOTAL DUE band (identical component to the report's "Survey result" band)
  {
    const h = 42
    gradientBand(page, M - BLEED, y - h, CONTENT_W + 2 * BLEED, h)
    text('000°', M + 6, y - h / 2 - 3, 8, fonts.mono, SKY_300)
    text(d.paid ? 'Paid' : 'Total due', M + 36, y - 17, 11, fonts.bold, WHITE)
    text(d.paid ? `Paid by ${d.paid.method} on ${d.paid.date} · nothing to pay` : `Due ${d.dueDate} · payment reference ${d.invoiceNumber}`, M + 36, y - 30, 8, fonts.mono, SKY_300)
    const amt = money(d.total, cur)
    text(amt, A4_W - M + BLEED - 14 - fonts.monoBold.widthOfTextAtSize(amt, 18), y - h / 2 - 5, 18, fonts.monoBold, SKY_300)
    y -= h + 20
  }
  if (d.fxNote) {
    text(d.fxNote, M, y + 4, 8, fonts.italic, SLATE_500)
    y -= 14
  }
  if (d.vat?.note) {
    for (const ln of wrapText(safe(d.vat.note), fonts.italic, 8, CONTENT_W)) {
      text(ln, M, y + 4, 8, fonts.italic, SLATE_500)
      y -= 11
    }
    y -= 3
  }
  if (d.vat?.eur) {
    // v10: Art. 226/230 EU VAT Directive - VAT payable also expressed in EUR
    const e = d.vat.eur
    const f2 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const ln = `VAT in EUR: EUR ${f2(e.amount)} on a taxable amount of EUR ${f2(e.net)} (ECB reference rate ${e.cur} ${e.ratePerEur} = EUR 1, ${e.rateDate}).`
    for (const l of wrapText(safe(ln), fonts.italic, 8, CONTENT_W)) {
      text(l, M, y + 4, 8, fonts.italic, SLATE_500)
      y -= 11
    }
    y -= 3
  }

  if (d.singlePage) {
    // surveyor credit invoice (v8): paid at checkout -> no payment instructions, no order pages
    const n1 = labels.length
    labels.forEach((l, i) => rightText(l.page, `Page ${i + 1} of ${n1}`, l.x, l.y, 7.8, fonts.mono, SKY_300))
    if (d.paid) {
      const noteH = 26
      const ny = FOOTER_H + M + noteH
      page.drawRectangle({ x: M - BLEED, y: ny - noteH, width: CONTENT_W + 2 * BLEED, height: noteH, color: PAPER_50 })
      text(`This invoice was paid by ${d.paid.method} on ${d.paid.date}. No payment is required. Credits are valid for 12 months.`, M + 6, ny - noteH / 2 - 3, 8.5, fonts.body, SLATE_500)
      return await pdf.save()
    }
    // v9: unpaid surveyor invoice (bank transfer) -> payment instructions below, then return
  }

  // PAYMENT INSTRUCTIONS (info-box, like the report's draft/list/owner strip)
  // v7 (21/10/2026): anchored to the bottom of page 1, 16 pt above the continuation note; the free
  // space now sits between Total due and this block. If page 1 is long, it flows as before.
  {
    const anchoredY = FOOTER_H + M + 26 + 16 + 90 + 12 // note top + gap + box height + label offset
    if (y > anchoredY) y = anchoredY
  }
  sectionLabel(page, fonts, '270°', 'Payment instructions', y)
  y -= 12
  {
    const rowH = 90
    page.drawRectangle({ x: M - BLEED, y: y - rowH, width: CONTENT_W + 2 * BLEED, height: rowH, color: PAPER_50, borderColor: LINE_200, borderWidth: 1 })
    const cw = CONTENT_W / 3
    const cols: Array<[string, string, PDFFont]> = [
      ['Beneficiary', d.from.name, fonts.bold], ['Bank', d.bank.name || '-', fonts.bold], ['Payment reference', d.invoiceNumber, fonts.monoBold],
      ['Account (IBAN)', d.bank.iban || '-', fonts.monoBold], ['SWIFT / BIC', d.bank.swift || '-', fonts.monoBold], ['', '', fonts.bold],
    ]
    cols.forEach(([k, v, f], i) => {
      if (!k) return
      const cx = M + (i % 3) * cw, ry = y - 14 - Math.floor(i / 3) * 27
      text(k.toUpperCase(), cx, ry, 7, fonts.bold, SKY_500)
      text(fit(safe(v), f, 9, cw - 12), cx, ry - 13, 9, f, INK_900)
    })
    text('BANK ADDRESS', M, y - 68, 7, fonts.bold, SKY_500)
    text(fit(safe(d.bank.address || '-'), fonts.bold, 9, CONTENT_W), M, y - 81, 9, fonts.bold, INK_900)
    y -= rowH + 16
  }

  // continuation note, anchored above the footer (same as the report)
  {
    const noteH = 26
    const ny = FOOTER_H + M + noteH
    page.drawRectangle({ x: M - BLEED, y: ny - noteH, width: CONTENT_W + 2 * BLEED, height: noteH, color: PAPER_50 })
    text(d.singlePage
      ? `The credits are added to your account as soon as we have received the payment. Credits are valid for 12 months.`
      : '-> Order-level details, references and incurred-cost breakdowns are listed on the following page(s).', M + 6, ny - noteH / 2 - 3, 8.5, fonts.body, SLATE_500)
  }
  if (d.singlePage) return await pdf.save()

  // ════════════ PAGE 2+ — details ════════════
  ;({ page, y } = newPage())
  sectionLabel(page, fonts, '090°', `Order details (${cur})`, y)
  y -= 24
  const bottom = FOOTER_H + 30
  const colRefX = M, colVesX = M + 118, colAmtR = A4_W - M
  const ensure = (need: number) => {
    if (y - need < bottom) { ({ page, y } = newPage()); y -= 4 }
  }
  const tableHead = () => {
    page.drawText('REFERENCE', { x: colRefX, y, size: 7.5, font: fonts.bold, color: SLATE_300 })
    page.drawText('VESSEL / SERVICE', { x: colVesX, y, size: 7.5, font: fonts.bold, color: SLATE_300 })
    rightText(page, 'AMOUNT', colAmtR, y, 7.5, fonts.bold, SLATE_300)
    y -= 6
    page.drawLine({ start: { x: M, y }, end: { x: A4_W - M, y }, thickness: 0.75, color: LINE_200 })
    y -= 18
  }
  const renderGroup = (gi: number, title: string, lines: InvoiceOrderLine[] | null, extras: InvoiceCost[] | null) => {
    ensure(70)
    const highlight = gi % 2 === 1
    page.drawText(safe(title).toUpperCase(), { x: M, y, size: 8, font: fonts.bold, color: SLATE_500 })
    y -= 16
    tableHead()
    const breakIfNeeded = (need: number) => {
      if (y - need < bottom) {
        ;({ page, y } = newPage()); y -= 4
        tableHead()
      }
    }
    for (const l of lines ?? []) {
      const need = 30 + l.costs.length * 15 + (l.costs.length ? 22 : 0)
      breakIfNeeded(Math.min(need, 120))
      page.drawText(safe(l.reference), { x: colRefX, y, size: 8.5, font: fonts.mono, color: SKY_500 })
      page.drawText(fit(safe(l.vessel), fonts.bold, 9.5, colAmtR - colVesX - 110), { x: colVesX, y, size: 9.5, font: fonts.bold, color: INK_900 })
      const svc = l.po ? `${l.service} · PO ${l.po}` : l.service
      page.drawText(fit(safe(svc), fonts.body, 8, colAmtR - colVesX - 110), { x: colVesX, y: y - 11, size: 8, font: fonts.body, color: SLATE_500 })
      rightText(page, money(l.fee, cur), colAmtR, y, 9, fonts.mono, INK_900)
      y -= 20
      if (l.costs.length) {
        for (const c of l.costs) {
          breakIfNeeded(15)
          page.drawLine({ start: { x: colRefX + 14, y: y + 7 }, end: { x: colRefX + 14, y: y + 2 }, thickness: 0.6, color: SLATE_300 })
          page.drawLine({ start: { x: colRefX + 14, y: y + 2 }, end: { x: colRefX + 20, y: y + 2 }, thickness: 0.6, color: SLATE_300 })
          page.drawText(fit(safe(c.description), fonts.body, 8.3, colAmtR - colRefX - 130), { x: colRefX + 24, y, size: 8.3, font: fonts.body, color: SLATE_500 })
          rightText(page, money(c.amount, cur), colAmtR, y, 8.3, fonts.mono, SLATE_500)
          y -= 14
        }
        page.drawText(`Subtotal ${safe(l.reference)}`, { x: colRefX + 24, y, size: 8.3, font: fonts.italic, color: SLATE_500 })
        rightText(page, money(l.lineTotal, cur), colAmtR, y, 8.3, fonts.mono, SLATE_500)
        y -= 8
      } else {
        y += 2
      }
      page.drawLine({ start: { x: M, y }, end: { x: A4_W - M, y }, thickness: 0.6, color: highlight ? SKY_TINT_LINE : LINE_200 })
      y -= 16
    }
    for (const e of extras ?? []) {
      breakIfNeeded(24)
      page.drawText('-', { x: colRefX, y, size: 8.5, font: fonts.mono, color: SLATE_300 })
      page.drawText(fit(safe(e.description), fonts.bold, 9.5, colAmtR - colVesX - 110), { x: colVesX, y, size: 9.5, font: fonts.bold, color: INK_900 })
      rightText(page, money(e.amount, cur), colAmtR, y, 9, fonts.mono, INK_900)
      y -= 8
      page.drawLine({ start: { x: M, y }, end: { x: A4_W - M, y }, thickness: 0.6, color: LINE_200 })
      y -= 16
    }
    y -= 10
  }
  let gi = 0
  for (const g of d.groups) renderGroup(gi++, `${g.title} - ${g.lines.length} order${g.lines.length === 1 ? '' : 's'}`, g.lines, null)
  if (d.extraLines.length) renderGroup(gi++, 'Additional items', null, d.extraLines)

  ensure(56)
  {
    const h = 42
    gradientBand(page, M - 10, y - h, CONTENT_W + 20, h)
    page.drawText('000°', { x: M + 6, y: y - h / 2 - 3, size: 8, font: fonts.mono, color: SKY_300 })
    page.drawText('Total invoice amount', { x: M + 36, y: y - 25, size: 11, font: fonts.bold, color: WHITE })
    const amt = money(d.total, cur)
    page.drawText(amt, { x: A4_W - M + 10 - 14 - fonts.monoBold.widthOfTextAtSize(amt, 16), y: y - h / 2 - 5, size: 16, font: fonts.monoBold, color: SKY_300 })
  }

  const n = labels.length
  labels.forEach((l, i) => rightText(l.page, `Page ${i + 1} of ${n}`, l.x, l.y, 7.8, fonts.mono, SKY_300))
  return await pdf.save()
}

// ───────────────────────── data loading + HTTP handler ─────────────────────────
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const retoolSecret = Deno.env.get('RETOOL_SHARED_SECRET')
const makeInvoiceWebhook = Deno.env.get('MAKE_INVOICE_READY_WEBHOOK_URL')
const PORTAL_URL = Deno.env.get('PORTAL_URL') ?? ''
const BUCKET = 'survey-documents'
const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December']
const fmtDate = (d: Date) => `${String(d.getUTCDate()).padStart(2,'0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
function periodLabel(dates: Date[], fallback: Date): string {
  const ds = dates.length ? dates : [fallback]
  const min = new Date(Math.min(...ds.map(d => +d))), max = new Date(Math.max(...ds.map(d => +d)))
  if (min.getUTCFullYear() === max.getUTCFullYear() && min.getUTCMonth() === max.getUTCMonth()) return `${MONTHS_LONG[min.getUTCMonth()]} ${min.getUTCFullYear()}`
  if (min.getUTCFullYear() === max.getUTCFullYear()) return `${MONTHS[min.getUTCMonth()]} - ${MONTHS[max.getUTCMonth()]} ${max.getUTCFullYear()}`
  return `${MONTHS[min.getUTCMonth()]} ${min.getUTCFullYear()} - ${MONTHS[max.getUTCMonth()]} ${max.getUTCFullYear()}`
}
const n = (v: unknown) => (v == null || v === '' ? 0 : Number(v))
const round2 = (v: number) => Math.round(v * 100) / 100

async function loadInvoice(invoiceId: string): Promise<{ data: InvoicePdfData; inv: any; client: any; S: Record<string, string> }> {
  const { data: inv, error } = await db.from('invoices').select('*').eq('id', invoiceId).single()
  if (error || !inv) throw new Error(`invoice not found: ${invoiceId}`)
  if (inv.surveyor_company_id) return await loadSurveyorInvoice(inv)
  const [{ data: client }, { data: settingsRows }, { data: lines }, { data: extras }] = await Promise.all([
    db.from('clients').select('*').eq('id', inv.client_id).single(),
    db.from('system_settings').select('key,value'),
    db.from('invoice_lines').select('id, order_id, amount, created_at').eq('invoice_id', invoiceId).order('created_at'),
    db.from('invoice_extra_lines').select('description, amount, created_at').eq('invoice_id', invoiceId).order('created_at'),
  ])
  const S: Record<string, string> = Object.fromEntries((settingsRows ?? []).map((r: any) => [r.key, r.value ?? '']))
  const orderIds = [...new Set((lines ?? []).map((l: any) => l.order_id).filter(Boolean))]
  const [{ data: orders }, { data: surveys }, { data: costs }, { data: types }] = await Promise.all([
    orderIds.length ? db.from('orders').select('id, gbqs_reference, vessel_name, vessel_id, service_level, created_at, po_number_client_ref, vessels(vessel_name)').in('id', orderIds) : Promise.resolve({ data: [] as any[] }),
    orderIds.length ? db.from('surveys').select('order_id, survey_type, date_of_survey').in('order_id', orderIds) : Promise.resolve({ data: [] as any[] }),
    orderIds.length ? db.from('order_extra_costs').select('order_id, description, amount, created_at').in('order_id', orderIds).order('created_at') : Promise.resolve({ data: [] as any[] }),
    db.from('survey_types_config').select('name, description'),
  ])
  const typeLabel = new Map((types ?? []).map((t: any) => [t.name, t.description || t.name]))
  const orderMap = new Map((orders ?? []).map((o: any) => [o.id, o]))
  const surveysBy = new Map<string, any[]>()
  for (const s of surveys ?? []) { if (!surveysBy.has(s.order_id)) surveysBy.set(s.order_id, []); surveysBy.get(s.order_id)!.push(s) }
  const costsBy = new Map<string, InvoiceCost[]>()
  for (const c of costs ?? []) { if (!costsBy.has(c.order_id)) costsBy.set(c.order_id, []); costsBy.get(c.order_id)!.push({ description: c.description || 'Incurred cost', amount: n(c.amount) }) }

  const groupsMap = new Map<string, InvoiceGroup>()
  const surveyDates: Date[] = []
  for (const l of lines ?? []) {
    const o: any = orderMap.get(l.order_id) ?? {}
    const sv = surveysBy.get(l.order_id) ?? []
    sv.forEach(s => s.date_of_survey && surveyDates.push(new Date(s.date_of_survey)))
    const c = costsBy.get(l.order_id) ?? []
    const costSum = c.reduce((a, x) => a + x.amount, 0)
    const lineTotal = n(l.amount)
    const includesCosts = c.length > 0 && lineTotal - costSum >= -0.005
    const level = (o.service_level || 'logbook').toLowerCase()
    if (!groupsMap.has(level)) {
      groupsMap.set(level, level === 'voyager'
        ? { key: level, title: 'Voyager surveys', subtitle: '', lines: [] }
        : { key: level, title: 'Logbook surveys', subtitle: '', lines: [] })
    }
    groupsMap.get(level)!.lines.push({
      reference: o.gbqs_reference || '-',
      vessel: o.vessels?.vessel_name || o.vessel_name || '-',
      service: [...new Set(sv.map(s => typeLabel.get(s.survey_type) || s.survey_type))].join(' + ') || 'Survey',
      po: (o.po_number_client_ref ?? '').trim() || undefined,
      surveyCount: Math.max(sv.length, 1),
      fee: round2(includesCosts ? lineTotal - costSum : lineTotal),
      costs: includesCosts ? c : [],
      lineTotal: round2(lineTotal),
    })
  }
  const groups = [...groupsMap.values()].sort((a, b) => (a.key === 'logbook' ? -1 : b.key === 'logbook' ? 1 : 0))
  for (const g of groups) {
    const cnt = g.lines.reduce((a, l) => a + l.surveyCount, 0)
    g.subtitle = `${cnt} survey${cnt === 1 ? '' : 's'} · ${g.key === 'voyager' ? 'GlobalBQS-appointed surveyor' : 'client-appointed surveyor'}`
  }

  // invoice-level PO: explicit on the invoice, else one shared order PO
  const orderPos = [...new Set(groups.flatMap(g => g.lines.map(l => l.po)).filter(Boolean) as string[])]
  const poReference = (inv.po_reference ?? '').trim() || (orderPos.length === 1 ? orderPos[0] : undefined)

  const issued = new Date(inv.created_at)
  const due = new Date(+issued + (client?.payment_term_days ?? 30) * 864e5)
  const extraLines = (extras ?? []).map((e: any) => ({ description: e.description || 'Additional item', amount: n(e.amount) }))
  const computed = round2((lines ?? []).reduce((a: number, l: any) => a + n(l.amount), 0) + extraLines.reduce((a, e) => a + e.amount, 0))
  const total = inv.total_amount != null ? n(inv.total_amount) : computed

  const data: InvoicePdfData = {
    invoiceNumber: inv.invoice_number,
    issueDate: fmtDate(issued),
    dueDate: fmtDate(due),
    period: periodLabel(surveyDates, issued),
    currency: S.currency || 'USD',
    total,
    poReference,
    from: {
      name: S.company_legal_name || S.company_name || 'GlobalBQS',
      lines: [S.address, S.zip_city, S.country, S.company_phone, S.company_email].filter(Boolean),
      regLine: [S.kvk_number ? `KvK ${S.kvk_number}` : '', S.vat_number ? `VAT ${S.vat_number}` : ''].filter(Boolean).join('\n') || undefined,
    },
    client: {
      name: client?.company || '-',
      lines: [client?.address, [client?.zip_code, client?.city].filter(Boolean).join(' '), client?.country, client?.email_admin || client?.email].filter(Boolean),
      vat: client?.vat_number || undefined,
    },
    groups,
    extraLines,
    bank: { iban: S.bank_iban, name: S.bank_name, address: S.bank_address, swift: S.bank_swift },
  }
  // v10: zero rate for services to seagoing vessels, shown when the setting holds the wording
  const clientVatNote = (S.client_invoice_vat_note ?? '').trim()
  if (clientVatNote && inv.vat_rate == null) data.vat = { rate: 0, amount: 0, net: total, note: clientVatNote }
  if (Math.abs(computed - total) > 0.01) console.warn(`invoice ${inv.invoice_number}: total_amount ${total} differs from lines ${computed}`)
  return { data, inv, client, S }
}

// v8: surveyor credit invoice (bought by card in the surveyor portal)
async function loadSurveyorInvoice(inv: any): Promise<{ data: InvoicePdfData; inv: any; client: any; S: Record<string, string> }> {
  const [{ data: co }, { data: settingsRows }, { data: extras }] = await Promise.all([
    db.from('surveyor_companies').select('*').eq('id', inv.surveyor_company_id).single(),
    db.from('system_settings').select('key,value'),
    db.from('invoice_extra_lines').select('description, amount, created_at').eq('invoice_id', inv.id).order('created_at'),
  ])
  const S: Record<string, string> = Object.fromEntries((settingsRows ?? []).map((r: any) => [r.key, r.value ?? '']))
  const issued = new Date(inv.created_at)
  const extraLines = (extras ?? []).map((e: any) => ({ description: e.description || 'Survey credits', amount: n(e.amount) }))
  const net = inv.net_amount != null ? n(inv.net_amount) : round2(extraLines.reduce((a, e) => a + e.amount, 0))
  const to = (co?.invoice_email || co?.office_email || '').trim()
  const data: InvoicePdfData = {
    invoiceNumber: inv.invoice_number,
    issueDate: fmtDate(issued),
    dueDate: fmtDate(inv.paid_at ? new Date(inv.paid_at) : new Date(+issued + (parseInt(S.sa_invoice_term_days || '14', 10) || 14) * 864e5)),
    period: periodLabel([], issued),
    currency: S.currency || 'USD',
    total: n(inv.total_amount),
    from: {
      name: S.company_legal_name || S.company_name || 'GlobalBQS',
      lines: [S.address, S.zip_city, S.country, S.company_phone, S.company_email].filter(Boolean),
      regLine: [S.kvk_number ? `KvK ${S.kvk_number}` : '', S.vat_number ? `VAT ${S.vat_number}` : ''].filter(Boolean).join('\n') || undefined,
    },
    client: {
      name: co?.name || '-',
      lines: [co?.address, [co?.zip_code, co?.city].filter(Boolean).join(' '), co?.country, to].filter(Boolean),
      vat: co?.vat_number || undefined,
    },
    groups: [],
    extraLines,
    bank: { iban: S.bank_iban, name: S.bank_name, address: S.bank_address, swift: S.bank_swift },
    vat: { rate: n(inv.vat_rate), amount: n(inv.vat_amount), net, note: inv.vat_note || undefined },
    paid: inv.paid_at ? { date: fmtDate(new Date(inv.paid_at)), method: inv.payment_method === 'card' ? 'card' : 'bank transfer' } : undefined,
    singlePage: true,
  }
  return { data, inv, client: { email_admin: to, surveyor: true }, S }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

// ── EUR bookkeeping copy (v6) ──
function toEur(d: InvoicePdfData, ratePerEur: number, rateDate: string, origCur: string): InvoicePdfData {
  const c = (v: number) => round2(v / ratePerEur)
  const total = c(d.total)
  const groups = d.groups.map(g => ({ ...g, lines: g.lines.map(l => ({ ...l, fee: c(l.fee), costs: l.costs.map(x => ({ ...x, amount: c(x.amount) })), lineTotal: 0 })) }))
  const extraLines = d.extraLines.map(x => ({ ...x, amount: c(x.amount) }))
  // rounding: put the cent difference on the largest fee so the lines add up to the converted total
  const all = groups.flatMap(g => g.lines)
  const parts = all.reduce((a, l) => a + l.fee + l.costs.reduce((b, x) => b + x.amount, 0), 0) + extraLines.reduce((a, x) => a + x.amount, 0)
  const diff = round2(total - parts)
  if (diff !== 0 && all.length) { const big = all.reduce((m, l) => (l.fee > m.fee ? l : m)); big.fee = round2(big.fee + diff) }
  for (const l of all) l.lineTotal = round2(l.fee + l.costs.reduce((b, x) => b + x.amount, 0))
  const vat = d.vat ? { ...d.vat, amount: c(d.vat.amount), net: round2(total - c(d.vat.amount)), eur: undefined } : undefined
  if (vat && extraLines.length && !all.length) {
    // surveyor invoice: lines must add up to the converted net amount
    const ex = round2(vat.net - extraLines.reduce((a, x) => a + x.amount, 0))
    if (ex !== 0) extraLines[0].amount = round2(extraLines[0].amount + ex)
  }
  return {
    ...d,
    currency: 'EUR',
    total,
    groups,
    extraLines,
    vat,
    headerLabel: 'INVOICE - BOOKKEEPING COPY (EUR)',
    fxNote: `Bookkeeping copy. Original invoice ${origCur} ${d.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}, converted at ECB reference rate ${origCur} ${ratePerEur} = EUR 1 (${rateDate}).`,
  }
}
async function eurCopy(invoiceId: string, data: InvoicePdfData): Promise<{ base64: string; fileName: string; fx: any } | null> {
  if ((data.currency || 'USD').toUpperCase() === 'EUR') return null
  const { data: fx, error } = await db.rpc('gbqs_invoice_fx_lock', { p_invoice: invoiceId })
  if (error || !fx?.ok || !fx?.rate_per_eur) { console.warn(`EUR copy skipped for ${data.invoiceNumber}: ${error?.message ?? fx?.error}`); return null }
  const eur = toEur(data, Number(fx.rate_per_eur), fmtDate(new Date(fx.rate_date)), data.currency || 'USD')
  const bytes = await buildInvoicePdf(eur)
  return { base64: bytesToBase64(bytes), fileName: `${data.invoiceNumber}_EUR.pdf`, fx }
}

// v10: VAT charged on a non-EUR invoice -> VAT amount also in EUR at the ECB rate of the invoice date
async function addVatEur(invoiceId: string, data: InvoicePdfData) {
  const cur = (data.currency || 'USD').toUpperCase()
  if (!data.vat || !(data.vat.amount > 0) || cur === 'EUR') return
  const { data: fx, error } = await db.rpc('gbqs_invoice_fx_lock', { p_invoice: invoiceId })
  if (error || !fx?.ok || !fx?.rate_per_eur) { console.warn(`VAT in EUR skipped for ${data.invoiceNumber}: ${error?.message ?? fx?.error}`); return }
  const r = Number(fx.rate_per_eur)
  data.vat.eur = { amount: round2(data.vat.amount / r), net: round2(data.vat.net / r), ratePerEur: r, rateDate: fmtDate(new Date(fx.rate_date)), cur }
}

async function generateOne(invoiceId: string, send: boolean) {
  const { data, inv, client, S } = await loadInvoice(invoiceId)
  await addVatEur(invoiceId, data)
  const bytes = await buildInvoicePdf(data)
  const path = `invoices/${data.invoiceNumber}.pdf`
  const { error: upErr } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: true })
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`)
  await db.from('invoices').update({ pdf_file_id: path, pdf_file_name: `${data.invoiceNumber}.pdf`, pdf_uploaded_at: new Date().toISOString() }).eq('id', invoiceId)

  let sent = false
  if (send) {
    if (!makeInvoiceWebhook) throw new Error('MAKE_INVOICE_READY_WEBHOOK_URL is not configured')
    const to = client?.email_admin || client?.email
    if (!to) throw new Error('client has no email_admin / email')
    const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 14)
    const wantsCopy = !inv.sent_at && !!(S.snelstart_bcc_email ?? '').trim()
    const bccCopy = wantsCopy ? await eurCopy(invoiceId, data).catch(e => { console.warn(e); return null }) : null
    const res = await fetch(makeInvoiceWebhook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invoice_id: invoiceId, invoice_number: data.invoiceNumber, client_name: data.client.name, client_email: to,
        total: data.total, currency: data.currency, issue_date: data.issueDate, due_date: data.dueDate, period: data.period,
        po_reference: data.poReference ?? null,
        // v9: lets the mail scenario word surveyor credit invoices (paid by card vs. to be paid by transfer)
        invoice_kind: client?.surveyor ? 'surveyor' : 'client', paid: !!inv.paid_at,
        // v5 (12/10/2026): SnelStart bookkeeping copy - only on the first send, never on a resend
        bcc_email: !inv.sent_at && (S.snelstart_bcc_email ?? '').trim() ? S.snelstart_bcc_email.trim() : null,
        bcc_pdf_base64: bccCopy?.base64 ?? null,
        bcc_file_name: bccCopy?.fileName ?? null,
        portal_url: client?.surveyor ? null : (PORTAL_URL ? `${PORTAL_URL.replace(/\/$/, '')}/invoices/${invoiceId}` : null),
        signed_url: signed?.signedUrl ?? null, file_name: `${data.invoiceNumber}.pdf`, pdf_base64: bytesToBase64(bytes),
      }),
    })
    if (!res.ok) throw new Error(`Make webhook responded ${res.status}`)
    sent = true
  }
  return { invoice_id: invoiceId, invoice_number: inv.invoice_number, path, bytes: bytes.byteLength, sent }
}

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const tok = req.headers.get('x-gbqs-token')
  let ok = false
  if (retoolSecret && req.headers.get('x-retool-secret') === retoolSecret) ok = true
  if (!ok && tok) { const { data } = await db.rpc('gbqs_check_internal_token', { p_token: tok }); ok = data === true }
  if (!ok) return json({ error: 'unauthorized' }, 401)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'expected JSON body' }, 400) }
  try {
    if (body?.backfill) {
      const limit = Math.min(Number(body.limit) || 25, 60)
      const offset = Math.max(Number(body.offset) || 0, 0)
      const q = db.from('invoices').select('id').order('created_at', { ascending: false }).order('id')
      const { data: rows } = body.force ? await q.range(offset, offset + limit - 1) : await q.is('pdf_file_id', null).limit(limit)
      const results: any[] = []
      for (const r of rows ?? []) {
        try { results.push(await generateOne(r.id, false)) } catch (e) { results.push({ invoice_id: r.id, error: String((e as Error).message ?? e) }) }
      }
      return json({ ok: true, count: results.length, results })
    }
    let id = body?.invoice_id as string | undefined
    if (!id && body?.invoice_number) {
      const { data } = await db.from('invoices').select('id').eq('invoice_number', body.invoice_number).maybeSingle()
      id = data?.id
    }
    if (!id) return json({ error: 'missing invoice_id or invoice_number' }, 400)
    if (body?.eur_copy === true) {
      const { data } = await loadInvoice(id)
      const copy = await eurCopy(id, data)
      return json({ ok: true, eur_pdf_base64: copy?.base64 ?? null, file_name: copy?.fileName ?? null, fx: copy?.fx ?? null })
    }
    const r = await generateOne(id, body?.send === true)
    return json({ ok: true, ...r })
  } catch (e) {
    console.error(e)
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500)
  }
})

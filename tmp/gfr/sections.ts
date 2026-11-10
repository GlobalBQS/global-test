// generate-form-report / sections.ts
// Report sections shared by the form-family builders.
import {
  Doc, type Cell, type Col, type SigBlock, num, qty, signedQty, signedPct, toNum, humanize, RATING_LABEL,
  AMBER_700, GREEN_700, CRIT_700, SLATE_500, INK_900,
} from './layout.ts'
import type { FormReportData, Tank, Signature, Delivery } from './data.ts'
import { SECTION_ORDER, SECTION_TITLES } from './data.ts'

export const REPORT_TYPE_META: Record<string, { eyebrow: string; typeLabel: string; emailLabel: string }> = {
  bunker_quantity_survey: { eyebrow: 'BUNKER QUANTITY SURVEY REPORT', typeLabel: 'Bunker Quantity Survey (B221)', emailLabel: 'Bunker Quantity Survey' },
  on_hire_bunker: { eyebrow: 'ON-HIRE BUNKER SURVEY REPORT', typeLabel: 'On-Hire Bunker Survey', emailLabel: 'On-Hire Bunker Survey' },
  off_hire_bunker: { eyebrow: 'OFF-HIRE BUNKER SURVEY REPORT', typeLabel: 'Off-Hire Bunker Survey', emailLabel: 'Off-Hire Bunker Survey' },
  bunker_delivery_survey: { eyebrow: 'BUNKER DELIVERY SURVEY REPORT', typeLabel: 'Bunker Delivery Survey', emailLabel: 'Bunker Delivery Survey' },
  on_hire_condition: { eyebrow: 'ON-HIRE CONDITION SURVEY REPORT', typeLabel: 'On-Hire Condition Survey', emailLabel: 'On-Hire Condition Survey' },
  off_hire_condition: { eyebrow: 'OFF-HIRE CONDITION SURVEY REPORT', typeLabel: 'Off-Hire Condition Survey', emailLabel: 'Off-Hire Condition Survey' },
  on_hire_bc: { eyebrow: 'ON-HIRE BUNKER & CONDITION SURVEY REPORT', typeLabel: 'On-Hire Bunker & Condition Survey (B+C)', emailLabel: 'On-Hire Bunker & Condition Survey' },
  off_hire_bc: { eyebrow: 'OFF-HIRE BUNKER & CONDITION SURVEY REPORT', typeLabel: 'Off-Hire Bunker & Condition Survey (B+C)', emailLabel: 'Off-Hire Bunker & Condition Survey' },
  joint_hire_bunker: { eyebrow: 'ON/OFF-HIRE BUNKER SURVEY REPORT', typeLabel: 'On/Off-Hire Bunker Survey', emailLabel: 'On/Off-Hire Bunker Survey' },
  joint_hire_condition: { eyebrow: 'ON/OFF-HIRE CONDITION SURVEY REPORT', typeLabel: 'On/Off-Hire Condition Survey', emailLabel: 'On/Off-Hire Condition Survey' },
  joint_hire_bc: { eyebrow: 'ON/OFF-HIRE BUNKER & CONDITION SURVEY REPORT', typeLabel: 'On/Off-Hire Bunker & Condition Survey (B+C)', emailLabel: 'On/Off-Hire Bunker & Condition Survey' },
}

export async function newDoc(d: FormReportData, partLabel: string | null = null): Promise<Doc> {
  const meta = REPORT_TYPE_META[d.labelKey] ?? REPORT_TYPE_META[d.surveyType] ?? REPORT_TYPE_META.bunker_quantity_survey
  const doc = await Doc.create({
    eyebrow: meta.eyebrow, typeLabel: meta.typeLabel, reportNumber: d.reportNumber, gbqsReference: d.gbqsReference,
    dateOfSurvey: d.dateOfSurvey, revision: d.revision ?? null,
    brandSrc: d.branding ? { name: d.branding.companyName, logo: d.branding.logo, kind: d.branding.logoKind } : null,
    gcs: d.branding ? null : (d.gcs ?? null),
  })
  doc.partLabel = partLabel
  doc.newPage()
  return doc
}

const LIST_SIDE: Record<string, string> = { port: 'to port', starboard: 'to starboard', upright: 'upright' }

/** Page-1 header block: vessel, place/time/ref strip and (for bunker forms) drafts/list/owner strip. */
export function vesselAndSurvey(doc: Doc, d: FormReportData, opts: { bunker: boolean }) {
  const v = d.vessel
  doc.vesselBlock({
    name: v.name,
    lines: [
      [v.imo ? `IMO ${v.imo}` : '', v.type ?? '', v.flag ? `Flag: ${v.flag}` : ''].filter(Boolean).join(' · '),
      v.portOfRegistry ? `Port of registry: ${v.portOfRegistry}` : '',
    ],
  }, d.onBehalfOf)
  doc.infoBox([
    [['Place of survey', d.placeOfSurvey ?? '-'], ['Time of survey', d.timeOfSurvey ?? '-', true], ['Client ref / PO', d.poNumber ?? '-', true]],
    [[d.branding ? 'Job reference' : 'GBQS reference', d.gbqsReference, true], ['Master / Chief Engineer', [d.master, d.chiefEngineer ? `C/E ${d.chiefEngineer}` : ''].filter(Boolean).join(' / ') || '-'], ['Surveyor', d.surveyor ?? '-']],
  ])
  if (opts.bunker) {
    const side = d.extras?.listSide
    const listTxt = d.list == null ? '-' : (side === 'upright' || d.list === 0 ? 'Upright' : `${num(d.list, 2)}°${side ? ' ' + (LIST_SIDE[side] ?? side) : ''}`)
    doc.infoBox([
      [['Draft fwd', d.draftFwd == null ? '-' : `${num(d.draftFwd, 2)} m`, true], ['List', listTxt, true], ['Owner', d.owner ?? '-']],
      [['Draft aft', d.draftAft == null ? '-' : `${num(d.draftAft, 2)} m`, true], ['Trim', d.trim == null ? '-' : `${num(d.trim, 2)} m`, true], ['Charterer', d.charterer ?? '-']],
    ])
  } else {
    doc.infoBox([[['Owner', d.owner ?? '-'], ['Charterer', d.charterer ?? '-'], null]])
  }
}

export function gradeTotal(tanks: Tank[], grade: string, phase?: string): number | null {
  const rows = tanks.filter(t => t.grade === grade && (!phase || t.phase === phase) && t.mt != null)
  if (!rows.length) return null
  return Math.round(rows.reduce((a, t) => a + (t.mt ?? 0), 0) * 1000) / 1000
}

/** Sounded vs logbook summary (MT and %) + navy result bar. Returns the per-grade results. */
export function soundedVsLogbook(doc: Doc, d: FormReportData, phase: string, title = 'Summary - sounded vs logbook (MT)') {
  const grades = d.grades.filter(g => d.tanks.some(t => t.grade === g && t.phase === phase) || d.logbook[g] != null)
  if (!grades.length) { doc.paragraph('No fuel grades were recorded.', { box: 'paper' }); return [] }
  const res = grades.map(g => {
    const s = gradeTotal(d.tanks, g, phase)
    const l = d.logbook[g] ?? null
    const diff = s != null && l != null ? Math.round((s - l) * 1000) / 1000 : null
    const pct = diff != null && l ? (diff / l) * 100 : null
    const within = pct == null ? null : Math.abs(pct) <= d.tolerancePct
    return { g, s, l, diff, pct, within }
  })
  doc.section(title, { keepWith: 100 })
  const col = (v: number | null) => (v == null || v === 0 ? SLATE_500 : v < 0 ? AMBER_700 : GREEN_700)
  doc.compare(grades, [
    { label: 'Sounded by surveyor', values: res.map(r => qty(r.s, '')) },
    { label: 'Logbook figures', values: res.map(r => qty(r.l, '')), color: SLATE_500 },
    { label: 'Difference (MT)', italic: true, values: res.map(r => ({ t: signedQty(r.diff, ''), color: col(r.diff) })) },
    { label: 'Difference (%)', italic: true, values: res.map(r => ({ t: signedPct(r.pct), color: r.within === false ? CRIT_700 : col(r.pct) })) },
  ])
  const real = res.filter(r => r.diff != null && Math.abs(r.diff) > 0.0005)
  const outside = res.filter(r => r.within === false)
  doc.resultBar(
    'Survey result',
    outside.length ? `Outside ${d.tolerancePct}% tolerance: ${outside.map(r => r.g).join(', ')}` : real.length ? `Within ${d.tolerancePct}% tolerance` : 'Sounded figures match logbook',
    real.length ? real.map(r => `${r.g} ${signedQty(r.diff)} (${signedPct(r.pct)})`) : ['Nil'],
  )
  return res
}

const METHOD_SHORT: Record<string, string> = { sounding: 'Sounding', ullage: 'Ullage', gauge: 'Gauge', weighbridge: 'Weighbridge', meter: 'Meter' }
function methodCell(m: string | null, _corrected?: boolean | null): string {
  const k = String(m ?? '').toLowerCase()
  return METHOD_SHORT[k] ?? (m || '-')
}
function tlCell(m: string | null, corrected: boolean | null): string {
  const k = String(m ?? '').toLowerCase()
  if (k === 'gauge' || k === 'meter' || k === 'weighbridge') return 'n/a'
  return corrected === true ? 'Yes' : corrected === false ? 'No' : '-'
}

const TANK_COLS: Col[] = [
  { label: 'Tank', w: 60, bold: true },
  { label: 'Method', w: 46 },
  { label: 'T/L corr.', w: 30 },
  { label: 'Reading (m)', w: 40, align: 'right', mono: true },
  { label: 'TOV (m3)', w: 46, align: 'right', mono: true },
  { label: 'Temp °C', w: 32, align: 'right', mono: true },
  { label: 'Density 15°C (kg/l)', w: 44, align: 'right', mono: true },
  { label: 'VCF T54B', w: 44, align: 'right', mono: true },
  { label: 'GSV (m3 @ 15°C)', w: 48, align: 'right', mono: true },
  { label: 'WCF', w: 36, align: 'right', mono: true },
  { label: 'Weight (MT)', w: 50, align: 'right', mono: true },
]

/** Per-grade tank tables for one phase (method, T/L corrected, TOV, temp, density, VCF 5 dec, GSV, WCF, MT). */
export function tankTables(doc: Doc, d: FormReportData, phase: string, heading?: string) {
  const tanks = d.tanks.filter(t => t.phase === phase)
  if (heading) doc.subTitle(heading, INK_900, 80)
  if (!tanks.length) { doc.paragraph('No tank soundings recorded for this phase.', { box: 'paper' }); return }
  for (const g of d.grades) {
    const rows = tanks.filter(t => t.grade === g)
    if (!rows.length) continue
    doc.section(g, { keepWith: 70 })
    const notes: string[] = []
    const body: Cell[][] = rows.map(t => {
      const nm = !!t.remark && /^not measured/i.test(t.remark)
      if (t.remark) notes.push(`${t.tank}: ${t.remark}`)
      return [
        t.remark ? `${t.tank} *` : t.tank,
        nm ? { t: 'Not measured', italic: true, color: AMBER_700 } : methodCell(t.method, t.corrected),
        nm ? '-' : tlCell(t.method, t.corrected),
        nm ? '-' : num(t.raw, 3), num(t.tov, 3), num(t.temp, 1), num(t.dens, 4), num(t.vcf, 5), num(t.gsv, 3), num(t.wcf, 4),
        { t: num(t.mt, 3), bold: true, mono: true, color: INK_900 },
      ]
    })
    doc.table(TANK_COLS, body, { size: 7.5, subtotal: [`Subtotal ${g}`, '', '', '', num(rows.reduce((a, t) => a + (t.tov ?? 0), 0), 3), '', '', '', num(rows.reduce((a, t) => a + (t.gsv ?? 0), 0), 3), '', `${num(gradeTotal(rows, g), 3)}`] })
    if (notes.length) doc.paragraph(notes.map(n => `* ${n}`).join('\n'), { size: 7.5 })
  }
  doc.paragraph('VCF per ASTM D1250-04 Table 54B (5 decimals); GSV = TOV x VCF; WCF = density 15°C (kg/l) - 0.0011; weight = GSV x WCF. All figures recalculated by GlobalBQS from the surveyor\'s raw readings.', { size: 7 })
}

export function remarks(doc: Doc, d: FormReportData) {
  if (d.masterRemarks) doc.paragraph(d.masterRemarks, { box: 'sky', label: 'Remarks Master / Chief Engineer:' })
  if (d.surveyorRemarks) doc.paragraph(d.surveyorRemarks, { box: 'sky', label: 'Remarks surveyor:' })
}

export function lopsSection(doc: Doc, d: FormReportData) {
  if (!d.lops.length) return
  doc.section('Letters of protest', { right: `${d.lops.length} LOP${d.lops.length === 1 ? '' : 's'}`, keepWith: 60 })
  doc.table([
    { label: '#', w: 18, mono: true }, { label: 'Direction', w: 70 }, { label: 'Issued by', w: 62 }, { label: 'Issued to', w: 62 },
    { label: 'Subject', w: 88, bold: true }, { label: 'Person', w: 62 }, { label: 'Remark', w: 114 }, { label: 'Photo', w: 36 },
  ], d.lops.map(l => [
    String(l.seq), l.direction === 'received_by_vessel' ? 'Received by vessel' : 'Issued by vessel', l.issuedBy ?? '-', l.issuedTo ?? '-',
    l.subject ?? '-', l.person ?? '-', l.remark ?? '-', l.hasPhoto ? 'Yes' : '-',
  ]), { size: 7.5 })
}

const ROLE_LABEL: Record<string, string> = {
  master: 'Master', chief_engineer: 'Chief Engineer', surveyor: 'Bunker surveyor', supplier_rep: 'Supplier representative', other: 'Other',
}
export function sigBlocks(sigs: Signature[], section: string | string[], surveyorLabel = 'Bunker surveyor'): SigBlock[] {
  const secs = Array.isArray(section) ? section : [section]
  const rows = sigs.filter(s => secs.includes(s.section))
  const order = (r: string) => (r === 'surveyor' ? 2 : r === 'supplier_rep' ? 3 : 1)
  return rows.sort((a, b) => order(a.role) - order(b.role)).map(s => ({
    role: s.role === 'surveyor' ? surveyorLabel : s.role === 'master' || s.role === 'chief_engineer' ? `Master / Chief Engineer (${ROLE_LABEL[s.role]})` : (ROLE_LABEL[s.role] ?? s.role),
    name: s.name, status: s.status, reason: s.reason, signedAt: s.signedAt, image: s.image,
  }))
}
/** Placeholders when a signature row is missing entirely (so the reader sees it was not captured). */
export function withMissing(blocks: SigBlock[], d: FormReportData, surveyorLabel = 'Bunker surveyor'): SigBlock[] {
  const out = [...blocks]
  if (!out.some(b => b.role.startsWith('Master'))) out.unshift({ role: 'Master / Chief Engineer', name: d.chiefEngineer ?? d.master, status: null })
  if (!out.some(b => b.role === surveyorLabel)) out.push({ role: surveyorLabel, name: d.surveyor, status: null })
  return out
}

export function confirmBannerFor(doc: Doc, blocks: SigBlock[], what = 'values') {
  if (!blocks.length) return
  const vessel = blocks.filter(b => b.role.startsWith('Master'))
  const allSigned = blocks.every(b => b.status === 'signed')
  if (allSigned) return doc.banner(`Both parties confirm the above ${what} are true and correct.`, 'ok')
  const v = vessel[0]
  if (v?.status === 'receipt_only') return doc.banner(`The Master / Chief Engineer signed for receipt only - the ${what} are not confirmed by the vessel.`, 'warn')
  if (v?.status === 'not_signed') return doc.banner(`The Master / Chief Engineer did not sign${v.reason ? ' (' + v.reason + ')' : ''} - see remarks.`, 'crit')
  return doc.banner(`Not all parties confirmed the ${what} - see signatures and remarks.`, 'warn')
}

// ───────────── condition part ─────────────
const ER_FIELD_ITEMS = ['erapp', 'erhouse', 'ercrit']

export function conditionSections(doc: Doc, d: FormReportData) {
  const items = d.conditionItems
  const photoCount = (sec: string) => items.filter(i => i.section === sec).reduce((a, i) => a + i.photos, 0)
    + (d.photoGroups.find(g => g.title === SECTION_TITLES[sec])?.items?.length ?? 0)
  for (const sec of SECTION_ORDER) {
    if (sec === 'hold') { holdsSection(doc, d); continue }
    if (sec === 'engine_room') { engineRoom(doc, d); continue }
    const list = items.filter(i => i.section === sec)
    if (!list.length) continue
    const pc = photoCount(sec)
    doc.section(SECTION_TITLES[sec] ?? humanize(sec), { right: pc ? `${pc} photo${pc === 1 ? '' : 's'}` : undefined, keepWith: 60 })
    const rows: Cell[][] = list.map(i => {
      const extra: string[] = []
      if (i.key === 'fouling' && d.extras?.hullLastCleaning) extra.push(`Last hull cleaning: ${fmtD(d.extras.hullLastCleaning)}`)
      if (i.key === 'mooring' && d.extras?.ropes220 != null) extra.push(`Mooring ropes on board (220 m): ${d.extras.ropes220}`)
      return [i.label, { t: RATING_LABEL[i.rating ?? ''] ?? (i.rating || '-'), pill: i.rating ?? '' }, [i.remark, ...extra].filter(Boolean).join('\n') || '-', i.photos ? String(i.photos) : '-']
    })
    doc.table([{ label: 'Item', w: 120, bold: true }, { label: 'Condition', w: 66 }, { label: 'Remarks', w: 270 }, { label: 'Photos', w: 40, align: 'right', mono: true }], rows, { size: 8, grid: false })
  }
  if (items.some(i => !SECTION_ORDER.includes(i.section))) {
    const other = items.filter(i => !SECTION_ORDER.includes(i.section))
    doc.section('Other items', { keepWith: 60 })
    doc.table([{ label: 'Section', w: 90 }, { label: 'Item', w: 110, bold: true }, { label: 'Condition', w: 66 }, { label: 'Remarks', w: 230 }],
      other.map(i => [humanize(i.section), i.label, { t: RATING_LABEL[i.rating ?? ''] ?? (i.rating || '-'), pill: i.rating ?? '' }, i.remark ?? '-']), { size: 8, grid: false })
  }
}

function fmtD(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return s
  return `${m[3]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(m[2], 10) - 1]} ${m[1]}`
}

function holdsSection(doc: Doc, d: FormReportData) {
  const list = d.conditionItems.filter(i => i.section === 'hold')
  if (!list.length) return
  const holds = [...new Set(list.map(i => i.holdNo ?? 0))].sort((a, b) => a - b)
  const pc = list.reduce((a, i) => a + i.photos, 0)
  doc.section('Condition of cargo holds', { right: `${holds.length} hold${holds.length === 1 ? '' : 's'}${pc ? ` · ${pc} photo${pc === 1 ? '' : 's'}` : ''}`, keepWith: 60 })
  const rows: Cell[][] = []
  for (const h of holds) {
    list.filter(i => (i.holdNo ?? 0) === h).forEach((i, k) => rows.push([
      k === 0 ? (h ? `Hold ${h}` : 'Hold ?') : '', i.label, { t: RATING_LABEL[i.rating ?? ''] ?? (i.rating || '-'), pill: i.rating ?? '' }, i.remark ?? '-', i.photos ? String(i.photos) : '-',
    ]))
  }
  doc.table([{ label: 'Hold', w: 46, bold: true }, { label: 'Item checked', w: 110 }, { label: 'Condition', w: 66 }, { label: 'Remarks', w: 234 }, { label: 'Photos', w: 40, align: 'right', mono: true }], rows, { size: 7.8, grid: false })
}

function engineRoom(doc: Doc, d: FormReportData) {
  const list = d.conditionItems.filter(i => i.section === 'engine_room')
  const x = d.extras
  if (!list.length && !x) return
  const pc = list.reduce((a, i) => a + i.photos, 0) + (d.photoGroups.find(g => g.title === 'Engine room')?.items?.length ?? 0)
  doc.section('Engine room', { right: pc ? `${pc} photo${pc === 1 ? '' : 's'}` : undefined, keepWith: 80 })
  const r = (k: string) => { const i = list.find(z => z.key === k); return i ? (RATING_LABEL[i.rating ?? ''] ?? (i.rating || '-')) : '-' }
  doc.infoBox([
    [['General appearance', r('erapp')], ['House keeping', r('erhouse')], ['Status critical equipment', r('ercrit')]],
    [['Next liner / cylinder head due', x?.nextLinerDue ?? '-', true], ['Routine jobs overdue', x?.routineOverdue == null ? '-' : String(x.routineOverdue), true], ['Critical jobs overdue', x?.criticalOverdue == null ? '-' : String(x.criticalOverdue), true]],
    [['Condition of class', x?.conditionOfClass == null ? '-' : x.conditionOfClass ? 'Yes' : 'No'], x?.conditionOfClass ? ['Condition of class details', x.conditionOfClassDetails ?? '-'] : null, null],
  ])
  const rem = list.filter(i => ER_FIELD_ITEMS.includes(i.key) && i.remark).map(i => `${i.label}: ${i.remark}`)
  if (rem.length) doc.paragraph(rem.join('\n'), { size: 8 })
  if (x?.engineRoomComments) doc.paragraph(x.engineRoomComments, { box: 'sky', label: 'Engine room comments:' })
}

export function damagesSection(doc: Doc, d: FormReportData, offHire: boolean) {
  const reg = d.damages.filter(x => x.kind !== 'stevedore')
  doc.section('Damage register', { right: `${reg.length} damage${reg.length === 1 ? '' : 's'}`, keepWith: 50 })
  if (!reg.length) doc.paragraph('No damages recorded.', { box: 'paper', size: 8 })
  else doc.table([
    { label: '#', w: 18, mono: true }, { label: 'Area', w: 80, bold: true }, { label: 'Location', w: 90 }, { label: 'Description', w: offHire ? 190 : 270 },
    ...(offHire ? [{ label: 'Compared with on-hire', w: 80 }] : []), { label: 'Photos', w: 38, align: 'right' as const, mono: true },
  ], reg.map(x => [String(x.seq), x.area ?? '-', x.location ?? '-', x.description ?? '-', ...(offHire ? [x.comparedOnHire ?? '-'] : []), x.photos ? String(x.photos) : '-']), { size: 7.8 })
  if (offHire) {
    const st = d.damages.filter(x => x.kind === 'stevedore')
    const flag = d.extras?.outstandingDamages
    doc.section('Outstanding stevedore damages', { right: st.length ? `${st.length} listed` : undefined, keepWith: 50 })
    if (flag === false && !st.length) doc.banner('No outstanding stevedore damages.', 'ok')
    else if (flag == null && !st.length) doc.paragraph('Not answered by the surveyor.', { box: 'paper', size: 8 })
    else {
      if (st.length) doc.table([{ label: '#', w: 18, mono: true }, { label: 'Location', w: 120, bold: true }, { label: 'Description', w: 320 }, { label: 'Photos', w: 38, align: 'right', mono: true }],
        st.map((x, i) => [String(i + 1), x.location ?? '-', x.description ?? '-', x.photos ? String(x.photos) : '-']), { size: 7.8 })
      else doc.banner('Outstanding stevedore damages reported - see remark.', 'warn')
    }
    if (d.extras?.outstandingDamagesRemark) doc.paragraph(d.extras.outstandingDamagesRemark, { box: 'amber', label: 'Remark:' })
  }
}

export function conclusion(doc: Doc, d: FormReportData) {
  doc.section('Conclusion', { keepWith: 80 })
  if (d.conclusion) doc.paragraph(d.conclusion, { size: 8.8, color: INK_900 })
  const oc = d.overallCondition
  doc.resultBar('Overall condition', 'For this type of vessel and age', [], { pill: oc ? (RATING_LABEL[oc] ?? oc) : 'Not stated' })
  if (d.extras?.conditionMasterRemarks) doc.paragraph(d.extras.conditionMasterRemarks, { box: 'sky', label: 'Remarks Master / Chief Engineer (condition):' })
}

// ───────────── samples ─────────────
export function samplesSection(doc: Doc, d: FormReportData) {
  const rows: Cell[][] = []
  for (const del of d.deliveries) {
    if (del.samplesStatus === 'none') rows.push([`#${del.seq} ${del.grade}`, { t: 'No samples taken', italic: true, color: AMBER_700 }, '-', '-', del.noSamplesReason ?? '-'])
    for (const s of del.samples) rows.push([`#${del.seq} ${del.grade}`, s.type + (s.description ? ` (${s.description})` : ''), { t: s.seal || '-', mono: true, bold: true }, s.extra ? 'Extra' : 'Standard', s.remark ?? (del.samplingPoint ? `Sampling point: ${del.samplingPoint}` : '-')])
  }
  for (const s of d.looseSamples) rows.push([s.grade || '-', s.type + (s.description ? ` (${s.description})` : ''), { t: s.seal || '-', mono: true, bold: true }, s.extra ? 'Extra' : 'Standard', s.remark ?? '-'])
  if (!rows.length) return
  doc.section('Samples & seals', { keepWith: 60 })
  doc.table([{ label: 'Delivery / grade', w: 80, bold: true }, { label: 'Sample', w: 140 }, { label: 'Seal no.', w: 80 }, { label: 'Type', w: 50 }, { label: 'Remark / reason', w: 150 }], rows, { size: 7.8 })
}

export function deliveryCards(doc: Doc, d: FormReportData) {
  for (const del of d.deliveries) {
    const mode = del.mode ? humanize(del.mode) : '-'
    const carrierLbl = del.mode === 'truck' ? 'Truck / licence plate' : del.mode === 'pipeline' ? 'Pipeline / meter' : 'Barge'
    doc.subTitle(`Delivery ${del.seq} - ${del.grade}`, undefined, 120)
    doc.infoBox([
      [['Supplier', del.supplier ?? '-'], ['Delivery by', mode], [carrierLbl, del.carrier ?? '-']],
      [['Supplier representative', del.rep ?? '-'], ['BDN number', del.bdn ?? '-', true], ['Nominated quantity', del.nominated == null ? '-' : qty(del.nominated), true]],
      [['BDN quantity', del.bdnQty == null ? '-' : qty(del.bdnQty), true], ['BDN density 15°C', del.bdnDens == null ? '-' : `${num(del.bdnDens, 1)} kg/m3`, true], ['Sampling point', del.samplingPoint ?? (del.samplesStatus === 'none' ? 'No samples taken' : '-')]],
    ])
    if (del.remark) doc.paragraph(del.remark, { size: 8 })
    supplierMeasurements(doc, del)
  }
}

function supplierMeasurements(doc: Doc, del: Delivery) {
  const ms = del.measurements
  if (!ms.length) return
  const kind = ms[0].kind
  const isMeter = ms.some(m => m.method === 'meter')
  const isWb = ms.some(m => m.method === 'weighbridge')
  doc.section(`Supplier measurements - ${kind === 'barge_tank' ? 'barge tanks' : kind}`, { keepWith: 60 })
  const rows: Cell[][] = ms.map(m => {
    const reading = m.method === 'meter' ? `${num(m.meterReading, 3)}${m.meterFactor != null && m.meterFactor !== 1 ? ` x ${num(m.meterFactor, 4)}` : ''}`
      : m.method === 'weighbridge' ? qty(m.weighbridge, 'MT') : num(m.raw, 3)
    return [
      m.phase === 'before' ? 'Before' : m.phase === 'after' ? 'After' : humanize(m.phase), m.tank ?? '-',
      m.notMeasured ? { t: `Not measured${m.notMeasuredReason ? ': ' + m.notMeasuredReason : ''}`, italic: true, color: AMBER_700 } : methodCell(m.method, m.corrected),
      tlCell(m.method, m.corrected), reading, isWb ? '-' : num(m.tov, 3), num(m.temp, 1), m.dens == null ? '-' : num(m.dens, 1), num(m.vcf, 5), num(m.gsv, 3),
      { t: num(m.mt, 3), bold: true, mono: true, color: INK_900 },
    ]
  })
  doc.table([
    { label: 'Phase', w: 40 }, { label: kind === 'barge_tank' ? 'Barge tank' : kind === 'pipeline' ? 'Meter' : 'Truck', w: 60, bold: true },
    { label: 'Method', w: 50 }, { label: 'T/L corr.', w: 28 }, { label: isMeter ? 'Meter reading' : isWb ? 'Weighbridge' : 'Reading (m)', w: 56, align: 'right', mono: true },
    { label: isMeter ? 'Volume (m3)' : 'TOV (m3)', w: 46, align: 'right', mono: true }, { label: 'Temp °C', w: 34, align: 'right', mono: true },
    { label: 'Density 15°C (kg/m3)', w: 46, align: 'right', mono: true }, { label: 'VCF T54B', w: 44, align: 'right', mono: true },
    { label: 'GSV (m3)', w: 46, align: 'right', mono: true }, { label: 'Weight (MT)', w: 50, align: 'right', mono: true },
  ], rows, { size: 7.5 })
  const sup = del.supplierDelivered
  const diff = sup != null && del.bdnQty != null ? sup - del.bdnQty : null
  const pct = diff != null && del.bdnQty ? (diff / del.bdnQty) * 100 : null
  doc.paragraph(
    sup == null
      ? 'Supplier delivered quantity could not be derived (before and after measurements are both needed).'
      : `Delivered according to supplier measurements: ${qty(sup)} vs BDN ${qty(del.bdnQty)} = ${signedQty(diff)} (${signedPct(pct)}). ` +
        (isMeter ? 'Meter: after - before.' : 'Tanks / weighbridge: before - after.') + ' Density: BDN density where no own density was measured.',
    { size: 7.8 },
  )
}

export { toNum }

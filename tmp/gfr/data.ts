// generate-form-report / data.ts
// Loads everything for one forms-app survey from the NEW tables (filtered on
// surveys.form_submission_ref) into one plain object that the builders render.
// Legacy tables are only used for things that live nowhere else: survey_phases
// remarks/totals (filled by the same processing run) and survey_bdn is NOT used.
import type { ImgSrc, PhotoGroup, PhotoItem, RevCtx } from './layout.ts'
import { toNum } from './layout.ts'

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>
// deno-lint-ignore no-explicit-any
type Db = any

export type Tank = {
  phase: string; grade: string; tank: string; method: string | null; raw: number | null; corrected: boolean | null
  tov: number | null; temp: number | null; dens: number | null; vcf: number | null; gsv: number | null; wcf: number | null; mt: number | null
  remark: string | null
}
export type Measurement = {
  phase: string; kind: string; tank: string | null; method: string | null; raw: number | null; corrected: boolean | null
  tov: number | null; temp: number | null; dens: number | null; vcf: number | null; gsv: number | null; wcf: number | null; mt: number | null
  meterReading: number | null; meterFactor: number | null; weighbridge: number | null; notMeasured: boolean; notMeasuredReason: string | null
}
export type Sample = { grade: string; type: string; seal: string; description: string | null; remark: string | null; extra: boolean; deliverySeq: number | null }
export type Delivery = {
  id: string; seq: number; grade: string; bdn: string | null; mode: string | null; carrier: string | null; supplier: string | null; rep: string | null
  nominated: number | null; bdnQty: number | null; bdnDens: number | null; samplesStatus: string | null; noSamplesReason: string | null
  samplingPoint: string | null; remark: string | null; supplierDelivered: number | null; vesselReceived: number | null
  diffMt: number | null; diffPct: number | null; tolerance: number | null; within: boolean | null
  measurements: Measurement[]; samples: Sample[]
}
export type Lop = { seq: number; direction: string; issuedBy: string | null; issuedTo: string | null; subject: string | null; person: string | null; remark: string | null; hasPhoto: boolean }
export type Signature = { section: string; role: string; name: string | null; status: string; reason: string | null; signedAt: string | null; image: ImgSrc | null }
export type TimesheetEvent = { seq: number; key: string; label: string; at: string | null }
export type CondItem = { section: string; holdNo: number | null; key: string; label: string; rating: string | null; remark: string | null; photos: number }
export type Damage = { seq: number; kind: string; area: string | null; location: string | null; description: string | null; comparedOnHire: string | null; photos: number }
export type Extras = {
  listSide: string | null; consumed: Record<string, number> | null; hullLastCleaning: string | null; ropes220: number | null
  nextLinerDue: string | null; conditionOfClass: boolean | null; conditionOfClassDetails: string | null
  routineOverdue: number | null; criticalOverdue: number | null; engineRoomComments: string | null; conditionMasterRemarks: string | null
  outstandingDamages: boolean | null; outstandingDamagesRemark: string | null
}

export type FormReportData = {
  surveyId: string
  surveyType: string
  labelKey: string // REPORT_TYPE_META key (joint_hire_* when applicable)
  reportNumber: string
  gbqsReference: string
  dateOfSurvey: string
  timeOfSurvey: string | null
  utcOffset: string | null
  placeOfSurvey: string | null
  poNumber: string | null
  onBehalfOf: string | null
  clientEmail: string | null
  tolerancePct: number
  vessel: { name: string; imo: string | null; flag: string | null; type: string | null; portOfRegistry: string | null }
  owner: string | null
  charterer: string | null
  master: string | null
  chiefEngineer: string | null
  surveyor: string | null
  draftFwd: number | null; draftAft: number | null; trim: number | null; list: number | null
  grades: string[]
  logbook: Record<string, number | null>
  tanks: Tank[]
  masterRemarks: string | null
  surveyorRemarks: string | null
  timesheetRemarks: string | null
  deliveries: Delivery[]
  looseSamples: Sample[]
  lops: Lop[]
  signatures: Signature[]
  timesheet: TimesheetEvent[]
  conditionItems: CondItem[]
  damages: Damage[]
  extras: Extras | null
  overallCondition: string | null
  conclusion: string | null
  photoGroups: PhotoGroup[]
  photoSkipped: number
  revision?: RevCtx | null
  submittedAt: string | null
  formVersion: string | null
  /** A5 (09-11-2026): own job of a surveyor company - report carries the surveyor's branding */
  branding?: Branding | null
  /** C6 (10-11-2026): attending surveyor is a GlobalBQS Certified Surveyor (GBQS reports only) */
  gcs?: { number: string } | null
}

/** A5: branding for a surveyor's own job (surveys.surveyor_job_id). logo = PNG/JPG bytes (SVG is not supported by the PDF engine -> company name instead). */
export type Branding = {
  jobId: string; companyId: string; companyName: string
  logo: Uint8Array | null; logoKind: 'png' | 'jpg' | null
  clientName: string | null; clientContact: string | null; reportEmails: string[]; officeEmail: string | null
}

export async function loadBranding(db: Db, s: Row): Promise<Branding | null> {
  if (!s?.surveyor_job_id) return null
  const { data: j } = await db.from('surveyor_jobs').select('id, company_id, surveyor_client_id').eq('id', s.surveyor_job_id).maybeSingle()
  if (!j) return null
  const [cR, kR] = await Promise.all([
    db.from('surveyor_companies').select('id, name, logo_path, office_email').eq('id', j.company_id).maybeSingle(),
    j.surveyor_client_id ? db.from('surveyor_clients').select('name, contact_name, report_emails').eq('id', j.surveyor_client_id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const c: Row | null = cR.data
  const k: Row | null = kR.data
  let logo: Uint8Array | null = null
  let logoKind: 'png' | 'jpg' | null = null
  if (c?.logo_path) {
    try {
      const { data: blob } = await db.storage.from('surveyor-logos').download(c.logo_path)
      if (blob) {
        const b = new Uint8Array(await blob.arrayBuffer())
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) { logo = b; logoKind = 'png' }
        else if (b[0] === 0xff && b[1] === 0xd8) { logo = b; logoKind = 'jpg' }
      }
    } catch (e) { console.warn('surveyor logo could not be loaded', String(e)) }
  }
  return {
    jobId: j.id, companyId: j.company_id, companyName: (c?.name ?? '').trim() || 'Surveyor',
    logo, logoKind,
    clientName: (k?.name ?? '').trim() || null, clientContact: (k?.contact_name ?? '').trim() || null,
    reportEmails: Array.isArray(k?.report_emails) ? k!.report_emails.filter((x: unknown) => typeof x === 'string' && x.includes('@')) : [],
    officeEmail: (c?.office_email ?? '').trim() || null,
  }
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function fmtDate(d: string | null | undefined): string {
  if (!d) return '-'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d))
  if (!m) return String(d)
  return `${m[3]} ${MON[parseInt(m[2], 10) - 1]} ${m[1]}`
}
/** wall-clock local timestamp ("2026-10-05T14:30:00" / timestamp w/o tz) -> "05 Oct 2026 14:30 LT" */
export function fmtLocal(ts: string | null | undefined, withDate = true): string | null {
  if (!ts) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(ts))
  if (!m) return String(ts)
  const t = `${m[4]}:${m[5]} LT`
  return withDate ? `${m[3]} ${MON[parseInt(m[2], 10) - 1]} ${m[1]} ${t}` : t
}
function offsetMinutes(off: string | null | undefined): number | null {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(off ?? '').trim())
  if (!m) return null
  return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10))
}
/** UTC instant + "+02:00" -> local wall-clock "21 Oct 2026 14:05 LT" (falls back to UTC label). */
export function fmtUtcAsLocal(utc: string | null | undefined, off: string | null | undefined): string | null {
  if (!utc) return null
  const d = new Date(utc)
  if (Number.isNaN(d.getTime())) return String(utc)
  const om = offsetMinutes(off)
  const l = new Date(d.getTime() + (om ?? 0) * 60000)
  const p = (n: number) => String(n).padStart(2, '0')
  const s = `${p(l.getUTCDate())} ${MON[l.getUTCMonth()]} ${l.getUTCFullYear()} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}`
  return om == null ? `${s} UTC` : `${s} LT`
}

export const SECTION_TITLES: Record<string, string> = {
  hull: 'Hull condition', main_deck: 'Main deck', deck_fittings: 'Deck fittings',
  deck_machinery_safety: 'Deck machinery & safety equipment', engine_room: 'Engine room', hold: 'Condition of cargo holds',
}
export const SECTION_ORDER = ['hull', 'main_deck', 'deck_fittings', 'hold', 'deck_machinery_safety', 'engine_room']
const ITEM_LABELS: Record<string, string> = {
  shell: 'Shell plating', coating: 'Coating', corrosion: 'Corrosion / pitting', fouling: 'Hull fouling',
  deckplate: 'Deck plating', coamings: 'Hatch coamings', drainage: 'Deck drainage', bulwarks: 'Bulwarks / railings',
  mooring: 'Mooring winches', anchors: 'Anchors / windlass', cranes: 'Cranes / derricks', ladders: 'Ladders / gangway',
  ff: 'Fire fighting equipment', lsa: 'Life-saving appliances', emerg: 'Emergency equipment', navlights: 'Navigation lights',
  erapp: 'General appearance', erhouse: 'House keeping', ercrit: 'Status critical equipment',
  tank_top: 'Tank top', hopper_sides: 'Hopper sides', side_shell_frames: 'Side shell / frames', topside_sloping_plates: 'Topside sloping plates',
  transverse_bulkheads: 'Transverse bulkheads', ladders_access: 'Ladders / access', hatch_coaming: 'Hatch coaming',
  hatch_covers_seals: 'Hatch covers & seals', bilge_wells: 'Bilge wells',
}
const PHOTO_GROUP: Array<[RegExp, string, number]> = [
  [/^photo_hull$/, 'Hull condition', 10], [/^photo_main_deck$/, 'Main deck', 11], [/^photo_deck_fittings$/, 'Deck fittings', 12],
  [/^cargo_hold_/, 'Condition of cargo holds', 13], [/^photo_deck_machinery/, 'Deck machinery & safety equipment', 14],
  [/^photo_engine_room$/, 'Engine room', 15], [/^photo_damage$/, 'Damages', 16],
  [/^photo_engine_log$/, 'Engine log', 1], [/^photo_tanks$/, 'Tanks and soundings', 2], [/^bdn_document$/, 'Bunker delivery notes', 3],
  [/^photo_supplier_/, 'Supplier measurements', 4], [/^lop_photo$/, 'Letters of protest', 5], [/^photo_not_signed$/, 'Signatures (not signed)', 20],
  [/^photo_other$/, 'Other photos', 30],
]

/** Grades in the order the app sent them (payload.grades), then any extra tank/delivery grades. */
function orderGrades(payloadGrades: string[], tanks: Tank[], dels: Delivery[]): string[] {
  const out: string[] = []
  const add = (g: string) => { const u = String(g || '').toUpperCase(); if (u && !out.includes(u)) out.push(u) }
  payloadGrades.forEach(add); tanks.forEach(t => add(t.grade)); dels.forEach(d => add(d.grade))
  return out
}

async function download(db: Db, path: string): Promise<ImgSrc | null> {
  try {
    const { data, error } = await db.storage.from('survey-documents').download(path)
    if (error || !data) return null
    return { bytes: new Uint8Array(await data.arrayBuffer()), mime: data.type || '' }
  } catch {
    return null
  }
}

export async function loadFormReportData(db: Db, surveyId: string): Promise<FormReportData> {
  const { data: s, error } = await db.from('surveys').select('*').eq('id', surveyId).single()
  if (error || !s) throw new Error(`survey not found: ${error?.message ?? surveyId}`)
  const ref: string | null = s.form_submission_ref
  if (!ref) throw new Error('survey has no forms-app submission (surveys.form_submission_ref is empty)')

  const q = (t: string, cols = '*') => db.from(t).select(cols).eq('survey_id', surveyId).eq('submission_id', ref)
  const [orderR, subR, tanksR, delsR, sampR, lopR, sigR, tsR, ciR, dmR, exR, phR, filesR, settingR] = await Promise.all([
    s.order_id ? db.from('orders').select('*').eq('id', s.order_id).maybeSingle() : Promise.resolve({ data: null }),
    db.from('form_submissions').select('id, payload, received_at, form_version, status').eq('id', ref).maybeSingle(),
    q('survey_tank_soundings').order('created_at', { ascending: true }),
    q('survey_deliveries').order('seq', { ascending: true }),
    q('survey_samples').order('created_at', { ascending: true }),
    q('survey_lops').order('seq', { ascending: true }),
    q('survey_signatures').order('created_at', { ascending: true }),
    q('survey_timesheet_events').order('seq', { ascending: true }),
    q('survey_condition_items').order('created_at', { ascending: true }),
    q('survey_damages').order('seq', { ascending: true }),
    q('survey_form_extras').maybeSingle(),
    db.from('survey_phases').select('*').eq('survey_id', surveyId),
    db.from('form_files').select('id, client_file_id, kind, section, storage_path, mime, uploaded_at, taken_at, registered_at').eq('submission_id', ref),
    db.from('system_settings').select('value').eq('key', 'forms_hold_items').maybeSingle(),
  ])
  const o: Row | null = orderR.data
  const sub: Row | null = subR.data
  const payload: Row = sub?.payload ?? {}
  const sv: Row = payload.survey ?? {}
  const [clientR, vesselR, tsheetR] = await Promise.all([
    o?.client_id ? db.from('clients').select('*').eq('id', o.client_id).maybeSingle() : Promise.resolve({ data: null }),
    o?.vessel_id ? db.from('vessels').select('*').eq('id', o.vessel_id).maybeSingle() : Promise.resolve({ data: null }),
    db.from('survey_timesheets').select('remarks').eq('survey_id', surveyId).maybeSingle(),
  ])
  let client: Row | null = clientR.data
  const vessel: Row | null = vesselR.data

  // hold item labels from settings
  try {
    const hv = settingR.data?.value
    const arr = typeof hv === 'string' ? JSON.parse(hv) : hv
    if (Array.isArray(arr)) for (const it of arr) if (it?.key && it?.label) ITEM_LABELS[it.key] = it.label
  } catch { /* defaults */ }

  const files: Row[] = filesR.data ?? []
  const fileById = new Map<string, Row>(files.map(f => [f.id, f]))

  // ── tanks ──
  const tanks: Tank[] = (tanksR.data ?? []).filter((r: Row) => (r.tank_name ?? '').trim()).map((r: Row) => ({
    phase: r.phase, grade: String(r.fuel_type ?? '').toUpperCase(), tank: r.tank_name, method: r.measurement_method,
    raw: toNum(r.raw_value ?? r.sounding_ullage), corrected: r.trim_list_corrected, tov: toNum(r.tov_m3), temp: toNum(r.actual_temp_c),
    dens: toNum(r.density_15c), vcf: toNum(r.vcf), gsv: toNum(r.gsv_m3), wcf: toNum(r.wcf), mt: toNum(r.weight_mt), remark: r.remark ?? null,
  }))

  // ── deliveries + supplier measurements + samples ──
  const delRows: Row[] = delsR.data ?? []
  const delIds = delRows.map(d => d.id)
  const measR = delIds.length
    ? await db.from('survey_supplier_measurements').select('*').in('delivery_id', delIds).order('seq', { ascending: true })
    : { data: [] }
  const samples: Row[] = sampR.data ?? []
  const deliveries: Delivery[] = delRows.map(d => ({
    id: d.id, seq: d.seq, grade: String(d.grade ?? '').toUpperCase(), bdn: d.bdn_number, mode: d.delivery_mode, carrier: d.carrier_name,
    supplier: d.supplier_name, rep: d.supplier_rep, nominated: toNum(d.nominated_qty_mt), bdnQty: toNum(d.bdn_qty_mt), bdnDens: toNum(d.bdn_density_15),
    samplesStatus: d.samples_status, noSamplesReason: d.no_samples_reason, samplingPoint: d.sampling_point, remark: d.remark,
    supplierDelivered: toNum(d.supplier_delivered_mt), vesselReceived: toNum(d.vessel_received_mt), diffMt: toNum(d.diff_mt), diffPct: toNum(d.diff_pct),
    tolerance: toNum(d.tolerance_pct), within: d.within_tolerance,
    measurements: (measR.data ?? []).filter((m: Row) => m.delivery_id === d.id).map((m: Row) => ({
      phase: m.phase, kind: m.kind, tank: m.tank_name, method: m.method, raw: toNum(m.raw_value), corrected: m.trim_list_corrected,
      tov: toNum(m.tov_m3), temp: toNum(m.temp_c), dens: toNum(m.density_15), vcf: toNum(m.vcf), gsv: toNum(m.gsv_m3), wcf: toNum(m.wcf), mt: toNum(m.weight_mt),
      meterReading: toNum(m.meter_reading), meterFactor: toNum(m.meter_factor), weighbridge: toNum(m.weighbridge_mt),
      notMeasured: !!m.not_measured, notMeasuredReason: m.not_measured_reason,
    })),
    samples: samples.filter(x => x.delivery_id === d.id).map(x => ({
      grade: String(x.grade ?? d.grade ?? '').toUpperCase(), type: x.sample_type, seal: x.seal_number, description: x.description, remark: x.remark,
      extra: !!x.is_extra, deliverySeq: d.seq,
    })),
  }))
  const looseSamples: Sample[] = samples.filter(x => !x.delivery_id).map(x => ({
    grade: String(x.grade ?? '').toUpperCase(), type: x.sample_type, seal: x.seal_number, description: x.description, remark: x.remark, extra: !!x.is_extra, deliverySeq: null,
  }))

  // ── LOPs ──
  const lops: Lop[] = (lopR.data ?? []).map((l: Row) => ({
    seq: l.seq, direction: l.direction, issuedBy: l.issued_by, issuedTo: l.issued_to, subject: l.subject, person: l.person_name, remark: l.remark,
    hasPhoto: !!(l.file_id && fileById.get(l.file_id)?.uploaded_at),
  }))

  // ── signatures (image from form_files) ──
  const signatures: Signature[] = []
  for (const g of (sigR.data ?? []) as Row[]) {
    const f = g.file_id ? fileById.get(g.file_id) : null
    const img = f?.storage_path && f.uploaded_at ? await download(db, f.storage_path) : null
    signatures.push({
      section: g.section, role: g.role, name: g.signer_name, status: g.status, reason: g.reason,
      signedAt: fmtUtcAsLocal(g.signed_at, g.utc_offset ?? sv.utc_offset), image: img,
    })
  }

  // ── timesheet ──
  const timesheet: TimesheetEvent[] = (tsR.data ?? []).map((e: Row) => ({
    seq: e.seq, key: e.event_key, label: e.label || String(e.event_key ?? '').replace(/_/g, ' ').replace(/^./, (c: string) => c.toUpperCase()),
    at: fmtLocal(e.event_at_local),
  }))

  // ── condition ──
  const ciRows: Row[] = ciR.data ?? []
  const conditionItems: CondItem[] = ciRows.map(c => ({
    section: c.section, holdNo: c.hold_no, key: c.item_key, label: ITEM_LABELS[c.item_key] ?? String(c.item_key ?? '').replace(/_/g, ' '),
    rating: c.rating, remark: c.remark, photos: (c.file_ids ?? []).filter((id: string) => fileById.get(id)?.uploaded_at).length,
  }))
  const dmRows: Row[] = dmR.data ?? []
  const damages: Damage[] = dmRows.map(d => ({
    seq: d.seq, kind: d.kind, area: d.area, location: d.location, description: d.description, comparedOnHire: d.compared_on_hire,
    photos: (d.file_ids ?? []).filter((id: string) => fileById.get(id)?.uploaded_at).length,
  }))
  const ex: Row | null = exR.data
  const extras: Extras | null = ex ? {
    listSide: ex.list_side, consumed: ex.consumed_during_bunkering_mt, hullLastCleaning: ex.hull_last_cleaning_date, ropes220: ex.mooring_ropes_220m_count,
    nextLinerDue: ex.next_liner_cyl_head_due, conditionOfClass: ex.condition_of_class, conditionOfClassDetails: ex.condition_of_class_details,
    routineOverdue: ex.routine_jobs_overdue, criticalOverdue: ex.critical_jobs_overdue, engineRoomComments: ex.engine_room_comments,
    conditionMasterRemarks: ex.condition_master_remarks, outstandingDamages: ex.outstanding_damages, outstandingDamagesRemark: ex.outstanding_damages_remark,
  } : null

  // ── photos (optional): every uploaded non-signature file of this submission, grouped per section ──
  const captionFor = new Map<string, string>()
  for (const c of ciRows) for (const id of c.file_ids ?? []) {
    const lbl = ITEM_LABELS[c.item_key] ?? c.item_key
    captionFor.set(id, c.hold_no ? `Hold ${c.hold_no} - ${lbl}` : `${SECTION_TITLES[c.section] ?? c.section} - ${lbl}`)
  }
  for (const d of dmRows) for (const id of d.file_ids ?? []) captionFor.set(id, `${d.kind === 'stevedore' ? 'Stevedore damage' : 'Damage'} ${d.seq}${d.location ? ' - ' + d.location : d.area ? ' - ' + d.area : ''}`)
  for (const l of (lopR.data ?? []) as Row[]) if (l.file_id) captionFor.set(l.file_id, `LOP ${l.seq}${l.subject ? ' - ' + l.subject : ''}`)
  for (const d of delRows) if (d.bdn_file_id) captionFor.set(d.bdn_file_id, `BDN ${d.bdn_number ?? ''} (${String(d.grade).toUpperCase()})`)
  for (const m of (measR.data ?? []) as Row[]) if (m.file_id) captionFor.set(m.file_id, `${m.phase === 'before' ? 'Before' : 'After'} - ${m.tank_name ?? m.kind} (${m.method ?? ''})`)

  const photoFiles = files
    .filter(f => f.uploaded_at && f.kind !== 'signature' && !String(f.section ?? '').startsWith('signature'))
    .sort((a, b) => String(a.taken_at ?? a.registered_at ?? '').localeCompare(String(b.taken_at ?? b.registered_at ?? '')))
  const buckets = new Map<string, { order: number; items: PhotoItem[]; holds: Map<number, PhotoItem[]> }>()
  let skipped = 0
  for (const f of photoFiles) {
    const sec = String(f.section ?? 'photo_other')
    const g = PHOTO_GROUP.find(([re]) => re.test(sec))
    const title = g ? g[1] : sec.replace(/^photo_/, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
    const img = await download(db, f.storage_path)
    const b = img?.bytes
    const embeddable = !!b && ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50))
    if (!img || !embeddable) { skipped++; continue }
    if (!buckets.has(title)) buckets.set(title, { order: g ? g[2] : 25, items: [], holds: new Map() })
    const bk = buckets.get(title)!
    const holdM = /^cargo_hold_(\d+)/.exec(sec)
    const item = { img, caption: captionFor.get(f.id) ?? (holdM ? `Hold ${holdM[1]}` : title) }
    if (holdM) {
      const n = parseInt(holdM[1], 10)
      if (!bk.holds.has(n)) bk.holds.set(n, [])
      bk.holds.get(n)!.push(item)
    } else bk.items.push(item)
  }
  const photoGroups: PhotoGroup[] = [...buckets.entries()].sort((a, b) => a[1].order - b[1].order).map(([title, b]) => ({
    title,
    items: b.items,
    sub: [...b.holds.entries()].sort((x, y) => x[0] - y[0]).map(([n, items]) => ({ title: `Hold ${n}`, items })),
  }))

  // ── remarks / phases ──
  const phases: Row[] = phR.data ?? []
  const ph = phases.find(p => p.master_remarks || p.surveyor_remarks) ?? phases[0] ?? {}
  const pick = (...v: unknown[]) => { for (const x of v) if (x != null && String(x).trim() !== '') return String(x); return null }

  const grades = orderGrades(Array.isArray(payload.grades) ? payload.grades : [], tanks, deliveries)
  const logbook: Record<string, number | null> = {}
  const lb: Row = sv.logbook ?? {}
  for (const g of grades) {
    const k = Object.keys(lb).find(x => x.toUpperCase() === g)
    const key = ({ VLSFO: 'lsfo', LSFO: 'lsfo', ULSFO: 'lsfo', HSFO: 'hsfo', LSMGO: 'lsmgo', MGO: 'lsmgo', MDO: 'mdo' } as Record<string, string>)[g]
    logbook[g] = k ? toNum(lb[k]) : (key ? toNum(s[`logbook_${key}`]) : null)
  }

  // A5: own job of a surveyor company -> their branding, their client as "carried out on behalf of"
  const branding = await loadBranding(db, s)
  if (branding) { client = null }
  // C6: GCS badge next to the surveyor's name - only on GlobalBQS reports, only while certified (not conditional/revoked)
  let gcs: { number: string } | null = null
  if (!branding && s.surveyor_id) {
    try {
      const { data: c } = await db.from('surveyor_certifications').select('status, cert_number, valid_until').eq('surveyor_id', s.surveyor_id).maybeSingle()
      const today = new Date().toISOString().slice(0, 10)
      if (c && c.status === 'certified' && c.cert_number && (!c.valid_until || String(c.valid_until) >= today)) gcs = { number: c.cert_number }
    } catch (e) { console.warn('gcs lookup failed', String(e)) }
  }
  const timeStr = s.time_of_survey ? String(s.time_of_survey).slice(0, 5) : pick(sv.time_of_survey)
  const off = pick(sv.utc_offset)
  return {
    surveyId,
    surveyType: s.survey_type,
    labelKey: s.survey_type,
    reportNumber: s.report_number ?? s.gbqs_reference,
    gbqsReference: s.gbqs_reference,
    dateOfSurvey: fmtDate(s.date_of_survey),
    timeOfSurvey: timeStr ? `${timeStr} LT${off ? ` (UTC${off})` : ''}` : null,
    utcOffset: off,
    placeOfSurvey: pick(s.place_of_survey, sv.place, o?.port),
    poNumber: pick(s.po_number_client_ref, o?.po_number_client_ref),
    onBehalfOf: branding ? branding.clientName : pick(client?.company),
    clientEmail: pick(client?.email, client?.email_admin),
    tolerancePct: toNum(client?.delivery_tolerance_pct) ?? 0.5,
    vessel: {
      name: pick(vessel?.display_name, vessel?.vessel_name, s.vessel_name, o?.vessel_name) ?? '-',
      imo: pick(s.imo_number, vessel?.imo_number), flag: pick(vessel?.flag), type: pick(vessel?.vessel_type), portOfRegistry: pick(s.port_of_registry, sv.port_of_registry),
    },
    owner: pick(s.owner, sv.owner), charterer: pick(s.charterer, sv.charterer),
    master: pick(sv.master_name, s.master_chief_engineer), chiefEngineer: pick(sv.chief_engineer_name), surveyor: pick(sv.surveyor_name, s.bunker_surveyor),
    draftFwd: toNum(s.draft_fwd_mtr), draftAft: toNum(s.draft_aft_mtr), trim: toNum(s.trim_mtr), list: toNum(s.list),
    grades, logbook, tanks,
    masterRemarks: pick(ph.master_remarks, sv.master_remarks), surveyorRemarks: pick(ph.surveyor_remarks, sv.surveyor_remarks),
    timesheetRemarks: pick(tsheetR.data?.remarks, sv.timesheet_remarks),
    deliveries, looseSamples, lops, signatures, timesheet, conditionItems, damages, extras,
    overallCondition: pick(s.overall_condition, sv.overall_condition), conclusion: pick(s.conclusion, sv.conclusion),
    photoGroups, photoSkipped: skipped,
    submittedAt: sub?.received_at ?? null, formVersion: sub?.form_version ?? null,
    branding,
    gcs,
  }
}

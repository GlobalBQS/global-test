// generate-form-report (GlobalBQS) - 21-10-2026 - 6.6 phase D1
// Survey report PDF for surveys submitted with the GBQS forms app (surveys.form_submission_ref set),
// built from the NEW tables only (survey_deliveries, survey_supplier_measurements, survey_signatures,
// survey_condition_items, survey_damages, survey_form_extras, survey_timesheet_events, form_files ...).
//
// Same contract as generate-survey-report, so callers can switch by changing only the URL:
//   POST { survey_id }                      -> issue: report/{ref}/{report_number}.pdf, survey_documents 'report',
//                                              Make "report ready" webhook, status -> issued, pending draft released
//   POST { survey_id, mode:'draft' }        -> DRAFT watermark, draft/{ref}/{report_number}_draft.pdf, nothing sent
//   POST { survey_id, revision:true }       -> Revision n (survey_revisions), previous PDF kept under superseded/
//   extra: { preview:true }                 -> nothing stored/sent/changed; returns { pdf_base64 } (testing)
//          { notify:false }                 -> issue without calling the Make webhook (testing)
// Router: a survey WITHOUT form_submission_ref (FastField) is forwarded unchanged to generate-survey-report,
// so this URL can be used for every survey.
// Auth: header x-retool-secret (env RETOOL_SHARED_SECRET) or x-gbqs-token (vault, gbqs_check_internal_token).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { stampPdf, bytesToBase64, REV_REASON_EN, type RevCtx } from './layout.ts'
import { loadFormReportData, type FormReportData } from './data.ts'
import { REPORT_TYPE_META } from './sections.ts'
import { buildB221 } from './b221.ts'
import { buildBunker } from './bunker.ts'
import { buildBC } from './bc.ts'
import { buildCondition } from './condition.ts'
import { buildBunkerDelivery } from './bunker_delivery.ts'

const VERSION = 'd1-1.1.1' // 1.1.1 (10-11-2026): C6 GCS badge next to the surveyor in GBQS reports
// prev: 'd1-1.1.0' // 1.1.0 (09-11-2026): A5 surveyor branding + own-job report mail
const REPORTS_BUCKET = 'survey-documents'
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const makeWebhookUrl = Deno.env.get('MAKE_REPORT_READY_WEBHOOK_URL')
const retoolSecret = Deno.env.get('RETOOL_SHARED_SECRET') ?? ''

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function authorized(req: Request): Promise<boolean> {
  const sec = req.headers.get('x-retool-secret')
  if (retoolSecret && sec && sec === retoolSecret) return true
  const tok = req.headers.get('x-gbqs-token')
  if (tok) {
    const { data } = await supabase.rpc('gbqs_check_internal_token', { p_token: tok })
    if (data === true) return true
  }
  return false
}

export async function buildFormReport(d: FormReportData): Promise<Uint8Array> {
  switch (d.surveyType) {
    case 'bunker_quantity_survey': return await buildB221(d)
    case 'on_hire_bunker': case 'off_hire_bunker': return await buildBunker(d)
    case 'on_hire_bc': case 'off_hire_bc': return await buildBC(d)
    case 'on_hire_condition': case 'off_hire_condition': return await buildCondition(d)
    case 'bunker_delivery_survey': return await buildBunkerDelivery(d)
    default: throw new Error(`no forms-app report layout for survey type ${d.surveyType}`)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'GET') return json({ ok: true, service: 'generate-form-report', version: VERSION })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!(await authorized(req))) return json({ error: 'unauthorized' }, 401)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'expected JSON body { survey_id, mode?, revision? }' }, 400) }
  const surveyId = String(body?.survey_id ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(surveyId)) return json({ error: 'expected JSON body { survey_id, mode?, revision? }' }, 400)
  const mode: 'issue' | 'draft' = body.mode === 'draft' || body.draft === true ? 'draft' : 'issue'
  const isRevision = body.revision === true
  const preview = body.preview === true
  const notify = body.notify !== false
  if (mode === 'draft' && isRevision) return json({ error: 'draft and revision cannot be combined' }, 400)

  const { data: sRow, error: sErr } = await supabase.from('surveys')
    .select('id, survey_type, form_submission_ref, issued_at, gbqs_reference').eq('id', surveyId).maybeSingle()
  if (sErr || !sRow) return json({ ok: false, error: `survey not found: ${sErr?.message ?? surveyId}` }, 404)

  // ── router: FastField surveys keep using the existing generator ──
  if (!sRow.form_submission_ref) {
    if (preview) return json({ ok: false, error: 'preview is only available for forms-app surveys' }, 400)
    const fwd = { ...body }
    delete fwd.preview; delete fwd.notify; delete fwd.draft
    if (mode === 'draft') fwd.mode = 'draft'
    const res = await fetch(`${supabaseUrl}/functions/v1/generate-survey-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(retoolSecret ? { 'x-retool-secret': retoolSecret } : {}) },
      body: JSON.stringify(fwd),
    })
    const txt = await res.text()
    return new Response(txt, { status: res.status, headers: { 'content-type': 'application/json', 'x-gbqs-routed-to': 'generate-survey-report' } })
  }

  try {
    // joint hire survey (closes one charter and opens the next) - same rule as generate-survey-report
    let jointKey: string | null = null
    if (/^(on|off)_hire_(bunker|condition|bc)$/.test(sRow.survey_type)) {
      const [{ count: asDelivery }, { count: asRedelivery }] = await Promise.all([
        supabase.from('charter_contracts').select('id', { count: 'exact', head: true }).eq('delivery_survey_id', surveyId),
        supabase.from('charter_contracts').select('id', { count: 'exact', head: true }).eq('redelivery_survey_id', surveyId),
      ])
      if ((asDelivery ?? 0) > 0 && (asRedelivery ?? 0) > 0) jointKey = 'joint_hire_' + sRow.survey_type.replace(/^(on|off)_hire_/, '')
    }
    const emailLabelBase = (REPORT_TYPE_META[jointKey ?? sRow.survey_type] ?? REPORT_TYPE_META.bunker_quantity_survey).emailLabel

    // revision history (5.18 c) - identical rules to generate-survey-report
    let revCtx: RevCtx | null = null
    let revisionRow: { id: string; rev_no: number } | null = null
    if (mode !== 'draft') {
      const { data: revs, error: revErr } = await supabase.from('survey_revisions')
        .select('id, rev_no, reason_code, note, created_at, issued_at').eq('survey_id', surveyId).order('rev_no', { ascending: true })
      if (revErr && isRevision) throw new Error(`survey_revisions not available: ${revErr.message}`)
      const all = (revs ?? []) as Array<{ id: string; rev_no: number; reason_code: string; note: string | null; created_at: string; issued_at: string | null }>
      if (isRevision) {
        const open = [...all].reverse().find(r => !r.issued_at)
        if (!open) throw new Error('no open revision for this survey (create it first with ops_report_revision)')
        revisionRow = open
      }
      const used = all.filter(r => r.issued_at || (revisionRow && r.id === revisionRow.id))
      if (used.length) {
        const fmt = (d: string | null | undefined) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'
        revCtx = {
          current: used[used.length - 1].rev_no,
          rows: [
            { rev: 0, date: fmt(sRow.issued_at), description: 'Original issue', reason: '-' },
            ...used.map(r => ({
              rev: r.rev_no, date: fmt(r.issued_at ?? new Date().toISOString()),
              description: (r.note ?? '').trim() || (REV_REASON_EN[r.reason_code] ?? 'Amendment'),
              reason: REV_REASON_EN[r.reason_code] ?? 'Amendment',
            })),
          ],
        }
      }
    }

    const data = await loadFormReportData(supabase, surveyId)
    if (jointKey) data.labelKey = jointKey
    data.revision = revCtx
    let pdfBytes = await buildFormReport(data)
    if (mode === 'draft') pdfBytes = await stampPdf(pdfBytes, { draft: true })

    if (preview) {
      return json({
        ok: true, preview: true, mode, generator: 'generate-form-report', version: VERSION, survey_type: data.surveyType,
        label: emailLabelBase, own_job: !!data.branding, logo: data.branding ? (data.branding.logoKind ?? 'none') : null, bytes: pdfBytes.byteLength, photos: data.photoGroups.reduce((a, g) => a + (g.items?.length ?? 0) + (g.sub ?? []).reduce((b, s) => b + s.items.length, 0), 0),
        photos_skipped: data.photoSkipped, pdf_base64: bytesToBase64(pdfBytes),
      })
    }

    if (mode === 'draft') {
      const draftPath = `draft/${data.gbqsReference}/${data.reportNumber}_draft.pdf`
      const { error: dErr } = await supabase.storage.from(REPORTS_BUCKET).upload(draftPath, pdfBytes, { contentType: 'application/pdf', upsert: true })
      if (dErr) throw new Error(`draft upload failed: ${dErr.message}`)
      const { data: dSigned } = await supabase.storage.from(REPORTS_BUCKET).createSignedUrl(draftPath, 60 * 60 * 24 * 7)
      return json({ ok: true, mode: 'draft', storage_path: draftPath, signed_url: dSigned?.signedUrl ?? null, generator: 'generate-form-report' })
    }

    const storagePath = `report/${data.gbqsReference}/${data.reportNumber}.pdf`
    let reportTypeLabel = emailLabelBase
    let supersededPath: string | null = null
    if (isRevision && revisionRow) {
      supersededPath = `report/${data.gbqsReference}/superseded/${data.reportNumber}_before_rev${revisionRow.rev_no}.pdf`
      const { error: cpErr } = await supabase.storage.from(REPORTS_BUCKET).copy(storagePath, supersededPath)
      if (cpErr) { console.warn('could not keep previous version', cpErr.message); supersededPath = null }
      reportTypeLabel = `Amended report (Revision ${revisionRow.rev_no}) - ${reportTypeLabel}`
    }
    const { error: upErr } = await supabase.storage.from(REPORTS_BUCKET).upload(storagePath, pdfBytes, { contentType: 'application/pdf', upsert: true })
    if (upErr) throw new Error(`storage upload failed: ${upErr.message}`)

    const { data: existingDoc } = await supabase.from('survey_documents').select('id')
      .eq('survey_id', surveyId).eq('section', 'report').limit(1).maybeSingle()
    const docPayload = {
      survey_id: surveyId, gbqs_reference: data.gbqsReference, file_id: storagePath, file_name: `${data.reportNumber}.pdf`,
      file_size_bytes: pdfBytes.byteLength, uploaded_at: new Date().toISOString(), section: 'report',
    }
    const { error: docError } = existingDoc
      ? await supabase.from('survey_documents').update(docPayload).eq('id', existingDoc.id)
      : await supabase.from('survey_documents').insert(docPayload)
    if (docError) throw new Error(`survey_documents write failed: ${docError.message}`)

    // A5: own job of a surveyor company -> no GlobalBQS client mail; the platform mails the surveyor's client
    let ownMail: unknown = null
    if (data.branding) {
      if (notify) {
        const { data: m, error: mErr } = await supabase.rpc('sa_report_issued', { p_survey_id: surveyId, p_path: storagePath, p_revision: revisionRow?.rev_no ?? null })
        if (mErr) console.error('sa_report_issued failed', mErr.message)
        ownMail = mErr ? { ok: false, error: mErr.message } : m
      }
    } else if (makeWebhookUrl && notify) {
      const { data: signed } = await supabase.storage.from(REPORTS_BUCKET).createSignedUrl(storagePath, 60 * 60 * 24 * 7)
      const makeRes = await fetch(makeWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          survey_id: surveyId, gbqs_reference: data.gbqsReference, report_number: data.reportNumber, vessel_name: data.vessel.name,
          client_email: data.clientEmail, report_type_label: reportTypeLabel, signed_url: signed?.signedUrl ?? null,
          pdf_base64: bytesToBase64(pdfBytes),
        }),
      })
      if (!makeRes.ok) throw new Error(`Make webhook responded ${makeRes.status}`)
    }

    await supabase.from('surveys').update({ status: 'issued' }).eq('id', surveyId).not('status', 'in', '(invoiced,completed,closed)')
    // 5.18 c: close a pending draft (tables/columns may not exist on every project - ignore errors)
    await supabase.from('survey_drafts').update({ status: 'released', decided_at: new Date().toISOString() }).eq('survey_id', surveyId).eq('status', 'pending')
    await supabase.from('surveys').update({ draft_state: null }).eq('id', surveyId)
    if (revisionRow) {
      await supabase.from('survey_revisions').update({ issued_at: new Date().toISOString(), superseded_path: supersededPath, report_path: storagePath }).eq('id', revisionRow.id)
    }
    return json({ ok: true, storage_path: storagePath, revision: revisionRow?.rev_no ?? null, generator: 'generate-form-report', notified: data.branding ? !!ownMail : !!(makeWebhookUrl && notify), own_job: !!data.branding, own_mail: ownMail })
  } catch (err) {
    console.error('generate-form-report', surveyId, err)
    // status untouched, same as generate-survey-report
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500)
  }
})

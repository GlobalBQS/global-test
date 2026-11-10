import { assertPermission } from '../shared/permissions'
import { withRetry } from '../shared/db'
import { recordAudit } from '../shared/audit'

type Params = { action: 'get' | 'set'; clientId: string; attach?: boolean }

// FTR-031 – Rapportmail per klant (GlobalBQS v1.0.48, 10-11-2026).
// Standaard krijgt de klant een mail met een downloadknop (link naar het rapport).
// Met report_as_attachment = true gaat het rapport als PDF-bijlage mee, zoals vroeger.
// Het schip krijgt het rapport altijd als bijlage (aparte mail, los van deze instelling).
// 'get' leest via to_jsonb zodat het ook werkt voordat de kolom bestaat.
export default async function (req: { params: Params; user: User }) {
  const { action, clientId, attach } = req.params

  if (action === 'set') {
    await assertPermission(req.user, 'clients.edit')
    const res = await withRetry(() => gbqsSupabase.query<{ company: string; report_as_attachment: boolean }>(
      `UPDATE clients SET report_as_attachment = $1 WHERE id = $2 RETURNING company, report_as_attachment`,
      [!!attach, clientId],
    ))
    const row = res.data?.[0] ?? null
    if (!row) return { ok: false, message: 'Klant niet gevonden' }
    await recordAudit(req.user, row.report_as_attachment ? 'Rapportmail: als bijlage' : 'Rapportmail: met downloadlink', { entity: 'client', entityRef: row.company })
    return { ok: true, attach: row.report_as_attachment }
  }

  const res = await withRetry(() => gbqsSupabase.query<{ attach: boolean | null; supported: boolean }>(
    `SELECT (to_jsonb(c)->>'report_as_attachment')::boolean AS attach,
            (to_jsonb(c) ? 'report_as_attachment') AS supported
       FROM clients c WHERE c.id = $1`,
    [clientId],
  ))
  const row = res.data?.[0]
  return { attach: row?.attach === true, supported: row?.supported === true }
}

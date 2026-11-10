import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import { useReportMailSetting } from '../../hooks/backend/clients'
import { Switch } from '../../lib/shadcn/switch'
import { toast } from '../../lib/shadcn/sonner'
import { CARD } from '../dashboard/cardStyles'

// FTR-031 – Rapportmail per klant (GlobalBQS v1.0.48, 10-11-2026).
// Backend: backend/clients/reportMailSetting.ts (kolom clients.report_as_attachment).

export default function ReportMailCard({ clientId, canEdit }: { clientId: string; canEdit: boolean }) {
  const { trigger } = useReportMailSetting()
  const { trigger: triggerSet } = useReportMailSetting()
  const [attach, setAttach] = useState(false)
  const [supported, setSupported] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setLoaded(false)
    trigger({ action: 'get', clientId }).then(r => {
      if (!alive) return
      const d = r as { attach?: boolean; supported?: boolean } | null
      setAttach(d?.attach === true)
      setSupported(d?.supported !== false)
      setLoaded(true)
    })
    return () => { alive = false }
  }, [clientId])

  async function change(v: boolean) {
    setBusy(true)
    const prev = attach
    setAttach(v)
    try {
      const r = (await triggerSet({ action: 'set', clientId, attach: v })) as { ok?: boolean; message?: string } | null
      if (r?.ok) toast.success(v ? 'Rapport gaat voortaan als bijlage mee' : 'Rapport gaat voortaan als downloadlink mee')
      else { setAttach(prev); toast.error(r?.message ?? 'Opslaan mislukt') }
    } catch (e) {
      setAttach(prev)
      toast.error('Opslaan mislukt', { description: e instanceof Error ? e.message : String(e) })
    } finally { setBusy(false) }
  }

  return (
    <div className={CARD}>
      <div className="px-5 py-3 border-b border-border flex items-center gap-2">
        <FileText className="w-4 h-4 text-primary shrink-0" />
        <h3 className="text-sm font-semibold text-foreground flex-1">Rapportmail</h3>
      </div>
      <div className="px-5 py-4 text-[13px] space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-foreground">Rapport als bijlage meesturen</span>
          <Switch checked={attach} disabled={!canEdit || !loaded || busy || !supported} onCheckedChange={change} />
        </div>
        <p className="text-xs text-muted-foreground">
          {attach
            ? 'De klant krijgt het rapport als PDF-bijlage.'
            : 'De klant krijgt een mail met een downloadknop; het rapport staat ook in het portaal.'}
          {' '}Het schip krijgt het rapport altijd als bijlage.
        </p>
        {!supported && <p className="text-xs text-warning">Nog niet beschikbaar in deze omgeving (database-update volgt).</p>}
      </div>
    </div>
  )
}

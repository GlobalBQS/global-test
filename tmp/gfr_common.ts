// generate-form-report / common.ts - timesheet + photo appendix wrappers shared by the builders.
import { Doc } from './layout.ts'
import type { FormReportData } from './data.ts'
import { sigBlocks, withMissing } from './sections.ts'

export async function timesheetSection(doc: Doc, d: FormReportData) {
  if (!d.timesheet.length) return
  doc.freshPage(350)
  doc.pageTitle('Timesheet')
  doc.section('Time log (local time)', { right: d.utcOffset ? `LT = UTC${d.utcOffset}` : undefined, keepWith: 60 })
  doc.table([{ label: '#', w: 22, mono: true }, { label: 'Event', w: 300, bold: true }, { label: 'Date / time (LT)', w: 170, mono: true }],
    d.timesheet.map((e, i) => [String(i + 1), e.label, e.at ?? '-']), { size: 8.5, minRowH: 18 })
  if (d.timesheetRemarks) doc.paragraph(d.timesheetRemarks, { box: 'sky', label: 'Timesheet remarks:' })
  const ts = sigBlocks(d.signatures, 'timesheet')
  await doc.signatures('Timesheet signed by', ts.length ? ts : withMissing([], d).slice(0, 1))
}

export async function appendix(doc: Doc, d: FormReportData) {
  const note = d.photoSkipped
    ? `${d.photoSkipped} file(s) could not be embedded (not a JPEG/PNG image, e.g. a PDF or HEIC file) and are available from ${d.branding ? d.branding.companyName : 'GlobalBQS'} on request.`
    : undefined
  await doc.photoAppendix(d.photoGroups, note)
}

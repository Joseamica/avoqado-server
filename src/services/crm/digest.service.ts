/**
 * The CRM's emails to the sales team (spec 2026-10-30 §5.3 and §5.4). Here: «Nuevo prospecto», sent the moment a new
 * landing prospect arrives, because getting there first counts, and «Volvió un prospecto», when an archived one comes
 * back through the landing (ruling 31). Task 7 adds the daily digest to this file.
 */
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import emailService from '../email.service'
import { effectiveKeys } from './access.service'

// ponytail: the sales team is a handful of people; past 200 rows with «Editar» the oldest 200 get the notice (logged).
const TEAM_CAP = 200
/** «Nuevo prospecto: » plus this stays under the 60 characters of the email standard. */
const SUBJECT_NAME_MAX = 40
const LOGO = 'https://avoqado.io/isotipo.svg'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)

interface Recipient {
  id: string
  email: string
}

/**
 * Everyone who holds «Editar» (rulings 21 and 26): each active key row whose EFFECTIVE keys include `editar`, resolved
 * to its person by the rule of `getCrmAccess`/`holdsRow` — a claimed row is its Staff, if active and while their
 * current email still leads to it; an unclaimed one is the active Staff with that exact (lowercase) email, with a
 * verified email and no other row of their own. Superadmins without a row get none: every landing signup already
 * emails onboarding.
 */
async function editors(): Promise<Recipient[]> {
  const rows = await prisma.platformAccess.findMany({
    where: { active: true, verScope: { not: null }, editarScope: { not: null } },
    select: {
      email: true,
      staffId: true,
      verScope: true,
      editarScope: true,
      contactar: true,
      campanas: true,
      exportar: true,
      ventas: true,
      admin: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: TEAM_CAP,
  })
  if (rows.length === TEAM_CAP) logger.warn('[CRM] More people with «Editar» than the new-prospect notice reaches', { cap: TEAM_CAP })
  const withEditar = rows.filter(row => effectiveKeys(row).editar)
  if (!withEditar.length) return []

  // ONE query for every row: claimed ones by id, unclaimed ones by email.
  const people = await prisma.staff.findMany({
    where: {
      OR: [
        { id: { in: withEditar.flatMap(row => (row.staffId ? [row.staffId] : [])) } },
        { email: { in: withEditar.flatMap(row => (row.staffId ? [] : [row.email])) } },
      ],
    },
    select: { id: true, email: true, active: true, emailVerified: true },
    take: withEditar.length,
  })
  const byId = new Map(people.map(person => [person.id, person]))
  const byEmail = new Map(people.map(person => [person.email, person]))
  // Whoever is found by email but already holds ANOTHER row: `holdsRow` refuses them that one (P2002) — no access, no
  // notice (ruling 26). One bounded query: `staffId` is unique, so at most one row each.
  const byEmailIds = withEditar.flatMap(row => {
    const person = row.staffId ? undefined : byEmail.get(row.email)
    return person ? [person.id] : []
  })
  const holders = new Set(
    byEmailIds.length
      ? (
          await prisma.platformAccess.findMany({
            where: { staffId: { in: byEmailIds } },
            select: { staffId: true },
            take: byEmailIds.length,
          })
        ).map(holder => holder.staffId)
      : [],
  )

  const recipients = new Map<string, Recipient>()
  for (const row of withEditar) {
    const person = row.staffId ? byId.get(row.staffId) : byEmail.get(row.email)
    if (!person?.active) continue
    // Claimed: only while that Staff's CURRENT email still leads to this row, as `getCrmAccess` looks it up (ruling 10).
    if (row.staffId && person.email.toLowerCase() !== row.email) continue
    if (!row.staffId && (!person.emailVerified || holders.has(person.id))) continue
    recipients.set(person.id, { id: person.id, email: person.email })
  }
  return [...recipients.values()]
}

/**
 * Why the team hears about an account: a new prospect, or one that came back from the archive through the landing
 * (ruling 31). Each has its own text and its own email key.
 */
const NOTICES = {
  NEW: { title: 'Nuevo prospecto', nota: 'Entró sin dueño desde la landing: el primero que lo tome se queda con él.' },
  RETURNED: {
    title: 'Volvió un prospecto',
    nota: 'Estaba archivado y volvió a llenar el formulario de la landing: ya está otra vez en el embudo.',
  },
} as const

type Notice = keyof typeof NOTICES

/** What an old signup the sweep loaded says instead of four blank rows (ruling 30b): the form's answers were never kept. */
const QUALIFICATION_UNAVAILABLE = 'no disponible (alta anterior al CRM)'

/**
 * The notice: the business and how it qualified, and the way to the CRM. Never its phone or email — those stay in the
 * CRM (spec §5.10).
 */
function prospectEmail(
  account: {
    name: string
    giro: string | null
    ventasRango: string | null
    sucursales: number | null
    modulos: string[]
    qualificationAvailable?: boolean
  },
  notice: Notice,
) {
  const { title, nota } = NOTICES[notice]
  const name = account.name.replace(/\s+/g, ' ').trim()
  // «<title>: » plus the name stays under the 60 characters of the email standard.
  const nameMax = Math.min(SUBJECT_NAME_MAX, 60 - title.length - 2)
  const shortName = name.length > nameMax ? `${name.slice(0, nameMax - 1).trimEnd()}…` : name
  const crmUrl = `${(process.env.SUPERADMIN_URL || 'https://superadmin.avoqado.io').replace(/\/$/, '')}/crm/pendientes`
  const qualified = account.qualificationAvailable !== false
  const rows: Array<[string, string]> = qualified
    ? [
        ['Tipo de negocio', account.giro ?? '—'],
        ['Sucursales', account.sucursales === null ? '—' : String(account.sucursales)],
        ['Ventas al mes', account.ventasRango ?? '—'],
        ['Qué pidió', account.modulos.length ? account.modulos.join(', ') : '—'],
      ]
    : [['Calificación', QUALIFICATION_UNAVAILABLE]]
  // The section heading only above the four rows: the single row already says «Calificación».
  const headingHtml = qualified
    ? '<h2 style="margin:0 0 12px 0;font-size:13px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Calificación</h2>'
    : ''
  const headingText = qualified ? 'CALIFICACIÓN\n' : ''

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;margin:0;padding:0;background-color:#ffffff;color:#000000;">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;">
    <div style="padding-bottom:32px;">
      <img src="${LOGO}" alt="Avoqado" width="32" height="32" style="display:inline-block;vertical-align:middle;">
      <span style="font-size:18px;font-weight:700;color:#000;vertical-align:middle;margin-left:8px;">Avoqado</span>
    </div>
    <div style="padding-bottom:24px;">
      <h1 style="margin:0 0 8px 0;font-size:32px;font-weight:400;color:#000;">${title}</h1>
      <p style="margin:0;font-size:16px;color:#666;">${escapeHtml(name)}</p>
    </div>
    ${headingHtml}
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:24px;">
      ${rows
        .map(
          ([label, value]) => `<tr>
        <td style="width:160px;padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#666;font-size:13px;">${escapeHtml(label)}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#000;font-size:14px;">${escapeHtml(value)}</td>
      </tr>`,
        )
        .join('')}
    </table>
    <p style="margin:0 0 8px 0;font-size:14px;color:#666;">${nota}</p>
    <div style="padding:24px 0;text-align:center;">
      <a href="${escapeHtml(crmUrl)}" style="background-color:#000000;color:#fff;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;display:inline-block;">Ver en el CRM</a>
    </div>
    <hr style="border:none;border-top:1px solid #e0e0e0;margin:40px 0 24px 0;">
    <div>
      <div style="margin-bottom:16px;">
        <img src="${LOGO}" alt="Avoqado" width="24" height="24" style="display:inline-block;vertical-align:middle;">
        <span style="font-size:16px;font-weight:700;color:#000;vertical-align:middle;margin-left:8px;">Avoqado</span>
      </div>
      <p style="margin:0 0 16px 0;font-size:14px;color:#000;">Servicios Tecnológicos Avo S.A. de C.V.<br>Ciudad de México, México</p>
      <p style="margin:16px 0 0 0;font-size:14px;"><a href="https://avoqado.io/privacy" style="color:#000;text-decoration:none;font-weight:600;">Política de Privacidad</a></p>
    </div>
  </div>
</body></html>`

  const text = `${title}: ${name}

${headingText}${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}

${nota}
Ver en el CRM: ${crmUrl}

Servicios Tecnológicos Avo S.A. de C.V. — Ciudad de México, México
Política de Privacidad: https://avoqado.io/privacy
`
  return { subject: `${title}: ${shortName}`, html, text }
}

/**
 * One notice to every person with «Editar», one email per person: Resend takes one recipient per call and refuses an
 * idempotency key reused with other content, so the key names the account AND the person — a retry or the sweep never
 * repeats it, and each seller gets theirs. Never throws: a notice that does not go out is logged.
 */
async function notifyTeam(accountId: string, notice: Notice, keyFor: (staffId: string) => string): Promise<void> {
  try {
    const account = await prisma.crmAccount.findUnique({
      where: { id: accountId },
      select: { id: true, name: true, giro: true, ventasRango: true, sucursales: true, modulos: true, qualificationAvailable: true },
    })
    if (!account) return
    const recipients = await editors()
    if (!recipients.length) return
    const email = prospectEmail(account, notice)
    const results = await Promise.allSettled(
      recipients.map(person => emailService.sendEmailWithResult({ ...email, to: person.email, idempotencyKey: keyFor(person.id) })),
    )
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.ok) return
      logger.warn('[CRM] A prospect notice did not go out', {
        accountId,
        notice,
        staffId: recipients[index].id,
        error: result.status === 'rejected' ? errorText(result.reason) : (result.value.errorCode ?? 'not sent'),
      })
    })
  } catch (error) {
    logger.error('[CRM] The prospect notice could not be sent', { accountId, notice, error: errorText(error) })
  }
}

/** «Nuevo prospecto: <negocio>», keyed `crm-nuevo:<account>:<person>`. Never throws. */
export async function notifyNewProspect(accountId: string): Promise<void> {
  await notifyTeam(accountId, 'NEW', staffId => `crm-nuevo:${accountId}:${staffId}`)
}

/**
 * «Volvió un prospecto: <negocio>»: an archived account that an entry of the landing brought back (ruling 31). Its own key,
 * `crm-volvio:<account>:<entry>:<person>` — the «nuevo» one may already have gone out with other content, and an account
 * can come back more than once. Never throws.
 */
export async function notifyReturningProspect(accountId: string, entryId: string): Promise<void> {
  await notifyTeam(accountId, 'RETURNED', staffId => `crm-volvio:${accountId}:${entryId}:${staffId}`)
}

/**
 * The CRM's emails to the sales team (spec 2026-10-30 §5.3 and §5.4): «Nuevo prospecto», sent the moment a new landing
 * prospect arrives, because getting there first counts; «Volvió un prospecto», when an archived one comes back through
 * the landing (ruling 31); and the daily digest of each seller's pending work (task 7, ruling 32).
 */
import { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { DEFAULT_TIMEZONE, formatInVenueTimezone } from '../../utils/datetime'
import prisma from '../../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../../utils/retry'
import emailService from '../email.service'
import { CRM_KEY_SELECT, effectiveKeys, getCrmAccess, scopeWhere, type CrmAccess } from './access.service'
import { getPending, type Pending, type PendingSection } from './accounts.service'
import { bloqueoPorReputacion } from './email/optOut.service'
import { puedeMandarFueraDeProduccion } from './email/testAllowlist'

// ponytail: the sales team is a handful of people; past 200 key rows the oldest 200 get the emails (logged).
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
 * ¿Hay que dejar de escribirle a esta dirección para cuidar la reputación del remitente? Sólo un rebote duro o una queja
 * (`EmailSuppression`: «REBOTE» / «QUEJA»). 🔴 La BAJA de marketing (`CrmEmailOptOut`) NO cuenta: estos correos son avisos de trabajo
 * al equipo de ventas de Avoqado, no marketing. Va DIRECTO a la supresión: `isBlocked` contesta «BAJA» primero, y una queja
 * registra supresión Y baja (Codex código r2 P1). Si la consulta falla LANZA: quien llama lo trata como un envío fallido que se
 * reintenta, nunca como «no está bloqueado».
 */
const frenadoPorReputacion = (email: string) => bloqueoPorReputacion(email)

/**
 * Everyone who holds `key` (rulings 21 and 26): each active key row whose EFFECTIVE keys include it, resolved to its
 * person by the rule of `getCrmAccess`/`holdsRow` — a claimed row is its Staff, if active and while their current email
 * still leads to it; an unclaimed one is the active Staff with that exact (lowercase) email, with a verified email and
 * no other row of their own. Superadmins without a row get none: the emails are the sales team's.
 */
async function team(key: 'ver' | 'editar'): Promise<Recipient[]> {
  const rows = await prisma.platformAccess.findMany({
    where: { active: true, verScope: { not: null }, ...(key === 'editar' ? { editarScope: { not: null } } : {}) },
    select: { email: true, staffId: true, ...CRM_KEY_SELECT },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: TEAM_CAP,
  })
  if (rows.length === TEAM_CAP) logger.warn('[CRM] More key rows than the team emails reach', { cap: TEAM_CAP, key })
  const withKey = rows.filter(row => effectiveKeys(row)[key])
  if (!withKey.length) return []

  // ONE query for every row: claimed ones by id, unclaimed ones by email.
  const people = await prisma.staff.findMany({
    where: {
      OR: [
        { id: { in: withKey.flatMap(row => (row.staffId ? [row.staffId] : [])) } },
        { email: { in: withKey.flatMap(row => (row.staffId ? [] : [row.email])) } },
      ],
    },
    select: { id: true, email: true, active: true, emailVerified: true },
    take: withKey.length,
  })
  const byId = new Map(people.map(person => [person.id, person]))
  const byEmail = new Map(people.map(person => [person.email, person]))
  // Whoever is found by email but already holds ANOTHER row: `holdsRow` refuses them that one (P2002) — no access, no
  // notice (ruling 26). One bounded query: `staffId` is unique, so at most one row each.
  const byEmailIds = withKey.flatMap(row => {
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
  for (const row of withKey) {
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

const crmUrl = () => `${(process.env.SUPERADMIN_URL || 'https://superadmin.avoqado.io').replace(/\/$/, '')}/crm/pendientes`

/**
 * The Avoqado email (EMAIL_STANDARDS.md) every CRM email uses: header, title and subtitle, an optional section heading
 * over one key/value table, a note, the black CTA to «Mis pendientes» and the footer — in HTML and plain text.
 */
function avoqadoEmail(parts: { title: string; subtitle: string; heading: string | null; rows: Array<[string, string]>; nota: string }) {
  const { title, subtitle, heading, rows, nota } = parts
  const url = crmUrl()
  const headingHtml = heading
    ? `<h2 style="margin:0 0 12px 0;font-size:13px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.5px;">${heading}</h2>`
    : ''
  const headingText = heading ? `${heading.toUpperCase()}\n` : ''

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
      <p style="margin:0;font-size:16px;color:#666;">${escapeHtml(subtitle)}</p>
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
      <a href="${escapeHtml(url)}" style="background-color:#000000;color:#fff;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;display:inline-block;">Ver en el CRM</a>
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

  const text = `${title}: ${subtitle}

${headingText}${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}

${nota}
Ver en el CRM: ${url}

Servicios Tecnológicos Avo S.A. de C.V. — Ciudad de México, México
Política de Privacidad: https://avoqado.io/privacy
`
  return { html, text }
}

/**
 * What a notice says about the business: its name and how it qualified — never its phone or email, those stay in the CRM
 * (spec §5.10). The landing fixes it when it applies the entry and keeps it in the entry's ENTRY_APPLIED (ruling 49): a
 * retry sends exactly that, because Resend refuses a key reused with other content.
 */
export interface NoticeContent {
  name: string
  giro: string | null
  ventasRango: string | null
  sucursales: number | null
  modulos: string[]
  qualificationAvailable?: boolean
}

/** The notice: the business and how it qualified, and the way to the CRM. */
function prospectEmail(account: NoticeContent, notice: Notice) {
  const { title, nota } = NOTICES[notice]
  const name = account.name.replace(/\s+/g, ' ').trim()
  // «<title>: » plus the name stays under the 60 characters of the email standard.
  const nameMax = Math.min(SUBJECT_NAME_MAX, 60 - title.length - 2)
  const shortName = name.length > nameMax ? `${name.slice(0, nameMax - 1).trimEnd()}…` : name
  const rows: Array<[string, string]> =
    account.qualificationAvailable !== false
      ? [
          ['Tipo de negocio', account.giro ?? '—'],
          ['Sucursales', account.sucursales === null ? '—' : String(account.sucursales)],
          ['Ventas al mes', account.ventasRango ?? '—'],
          ['Qué pidió', account.modulos.length ? account.modulos.join(', ') : '—'],
        ]
      : [['Calificación', QUALIFICATION_UNAVAILABLE]]
  // The section heading only above the four rows: the single row already says «Calificación».
  const heading = rows.length > 1 ? 'Calificación' : null
  return { subject: `${title}: ${shortName}`, ...avoqadoEmail({ title, subtitle: name, heading, rows, nota }) }
}

/**
 * One notice to every person with «Editar», one email per person: Resend takes one recipient per call and refuses an
 * idempotency key reused with other content, so the key names the account AND the person — a retry or the sweep never
 * repeats it, and each seller gets theirs. With `content`, that is what goes out (a retry repeats the first send); without
 * it, the account as it is now.
 *
 * Never throws. True when every email went out — or there was nothing to send: the account is gone, or nobody holds
 * «Editar» —; false when one did not go out (logged), so the landing counts a try and the sweep retries (ruling 49).
 */
async function notifyTeam(
  accountId: string,
  notice: Notice,
  keyFor: (staffId: string) => string,
  content?: NoticeContent,
): Promise<boolean> {
  try {
    const account =
      content ??
      (await prisma.crmAccount.findUnique({
        where: { id: accountId },
        select: { id: true, name: true, giro: true, ventasRango: true, sucursales: true, modulos: true, qualificationAvailable: true },
      }))
    if (!account) return true
    // 🔴 Fuera de producción sólo le llega a quien esté en la lista de prueba. Quien se omite cuenta como «nada que mandar»
    // (igual que un equipo sin «Editar»): devolver false haría que el barrido reintente el aviso 5 veces para nada.
    const onTheList = (await team('editar')).filter(person => {
      if (puedeMandarFueraDeProduccion(person.email)) return true
      logger.info('[CRM] A prospect notice was not sent: the address is outside the test list', { accountId, notice, staffId: person.id })
      return false
    })
    // 🔴 Un rebote duro o una queja frenan el aviso (igual que la lista de prueba: cuenta como «nada que mandar»); la baja de
    // marketing no. Si NO se pudo revisar, no se manda a esa persona y el aviso dice false: el barrido lo reintenta, y su llave por
    // persona hace que a los demás no se les repita.
    // ponytail: una consulta por persona en paralelo; el equipo son unas cuantas personas (TEAM_CAP lo acota).
    const checks = await Promise.allSettled(onTheList.map(person => frenadoPorReputacion(person.email)))
    let all = true
    const recipients = onTheList.filter((person, index) => {
      const check = checks[index]
      if (check.status === 'rejected') {
        all = false
        logger.warn('[CRM] A prospect notice was not sent: the address could not be checked for bounces and complaints', {
          accountId,
          notice,
          staffId: person.id,
          error: errorText(check.reason),
        })
        return false
      }
      if (check.value) {
        logger.info('[CRM] A prospect notice was not sent: the address bounced or complained', {
          accountId,
          notice,
          staffId: person.id,
          motivo: check.value,
        })
        return false
      }
      return true
    })
    if (!recipients.length) return all
    const email = prospectEmail(account, notice)
    const results = await Promise.allSettled(
      recipients.map(person => emailService.sendEmailWithResult({ ...email, to: person.email, idempotencyKey: keyFor(person.id) })),
    )
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.ok) return
      all = false
      logger.warn('[CRM] A prospect notice did not go out', {
        accountId,
        notice,
        staffId: recipients[index].id,
        error: result.status === 'rejected' ? errorText(result.reason) : (result.value.errorCode ?? 'not sent'),
      })
    })
    return all
  } catch (error) {
    logger.error('[CRM] The prospect notice could not be sent', { accountId, notice, error: errorText(error) })
    return false
  }
}

/** «Nuevo prospecto: <negocio>», keyed `crm-nuevo:<account>:<person>`. Never throws; true when it reached everyone. */
export async function notifyNewProspect(accountId: string, content?: NoticeContent): Promise<boolean> {
  return notifyTeam(accountId, 'NEW', staffId => `crm-nuevo:${accountId}:${staffId}`, content)
}

/**
 * «Volvió un prospecto: <negocio>»: an archived account that an entry of the landing brought back (ruling 31). Its own key,
 * `crm-volvio:<account>:<entry>:<person>` — the «nuevo» one may already have gone out with other content, and an account
 * can come back more than once. Never throws; true when it reached everyone.
 */
export async function notifyReturningProspect(accountId: string, entryId: string, content?: NoticeContent): Promise<boolean> {
  return notifyTeam(accountId, 'RETURNED', staffId => `crm-volvio:${accountId}:${entryId}:${staffId}`, content)
}

// ── The daily digest (task 7, spec §5.4, ruling 32) ───────────────────────────────────────────────────────────────────

const DIGEST_KIND = 'DIARIO'
const DIGEST_TITLE = 'Tus pendientes de hoy'
const DIGEST_NOTA = 'Los datos de contacto de cada negocio están en el CRM.'
/** The job ticks every 15 minutes; only 8:30 to 11:00 of a weekday in Mexico City counts. Later ticks recover. */
const WINDOW_FROM = '08:30'
const WINDOW_TO = '11:00'
/** A row reserved longer ago than this was left by a process that died, before or after sending. */
const RESERVATION_TIMEOUT_MS = 10 * 60_000
const MAX_ATTEMPTS = 3
const NAMES_PER_SECTION = 5

/** What every seller sees: their own pending work. */
const DIGEST_SECTIONS = [
  ['vencidas', 'Vencidas'],
  ['hoy', 'Para hoy'],
  ['sinSiguientePaso', 'Sin siguiente paso'],
  ['estancados', 'Estancados'],
] as const

/** The email exactly as it was sent the first time: a retry repeats it, so Resend can recognize its key. */
interface DigestContent {
  to: string
  subject: string
  html: string
  text: string
}

const isDigestContent = (value: unknown): value is DigestContent =>
  !!value &&
  typeof value === 'object' &&
  ['to', 'subject', 'html', 'text'].every(field => typeof (value as Record<string, unknown>)[field] === 'string')

/** A tick's first read: pure, so a connection blip (the stampede at the top of the hour) gets two more tries. */
const entryRead = <T>(context: string, read: () => Promise<T>) =>
  retry(read, { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context })

/** «3 · Café Ana, Taquería Lalo y 1 más»: the total and up to five names — never a phone or an email (spec §5.10). */
function sectionLine({ rows, total }: PendingSection): string {
  const names = rows.slice(0, NAMES_PER_SECTION).map(row => row.name.replace(/\s+/g, ' ').trim())
  if (!names.length) return String(total)
  const more = total - names.length
  return `${total} · ${names.join(', ')}${more > 0 ? ` y ${more} más` : ''}`
}

/**
 * The person's digest, or null when nothing is pending (ruling 32): their overdue, today's, without a next step and stale
 * accounts; an admin also counts the new ones nobody owns and the pending activities nobody is in charge of (ruling 12).
 * Archived accounts never count (ruling 30): `getPending` leaves them out, and so does the count here.
 */
async function digestFor(access: CrmAccess, now: Date): Promise<Omit<DigestContent, 'to'> | null> {
  const pending: Pending = await getPending(access, now)
  const orphans = access.admin
    ? await prisma.crmActivity.count({
        where: { doneAt: null, assigneeStaffId: null, account: { AND: [scopeWhere(access, 'ver'), { archivedAt: null }] } },
      })
    : 0
  const own = DIGEST_SECTIONS.reduce((sum, [key]) => sum + pending[key].total, 0)
  if (!own && !(access.admin && (pending.nuevosSinDueno.total || orphans))) return null

  const subtitle = `${pending.vencidas.total} vencidas y ${pending.hoy.total} para hoy`
  const rows: Array<[string, string]> = DIGEST_SECTIONS.map(([key, label]) => [label, sectionLine(pending[key])])
  if (access.admin) {
    rows.push(['Sin dueño', sectionLine(pending.nuevosSinDueno)])
    if (orphans) rows.push(['Actividades sin responsable', String(orphans)])
  }
  return {
    subject: `${DIGEST_TITLE}: ${subtitle}`,
    ...avoqadoEmail({ title: DIGEST_TITLE, subtitle, heading: 'Resumen', rows, nota: DIGEST_NOTA }),
  }
}

/**
 * Closes a row we hold for good: «FALLO» with no tries left, so no later run retakes it. Its content goes too (D1): it
 * names people, and a row that will never be resent has no use for it.
 */
const closeForGood = (id: string, now: Date) =>
  prisma.crmDigestSend.updateMany({
    where: { id, reservedAt: now },
    data: { status: 'FALLO', attempts: MAX_ATTEMPTS, content: Prisma.DbNull },
  })

/**
 * Sends a reserved row's email with the person's key for the day and marks the row — only while it is still ours (a run
 * that took over 10 minutes may have lost it to another). If the process dies after Resend took the email and before
 * this mark, the row stays reserved, a later run retakes it and sends the SAME content with the SAME key: Resend
 * recognizes it and does not deliver it again. A refusal that will not change (`transient: false`: an undeliverable
 * address, a demo) closes the row instead of using up the tries; a throw counts as passing, like the email service's own.
 * An address with a hard bounce or a complaint (`frenadoPorReputacion`) closes the row for good too; if that lookup throws,
 * it counts as a failed send (nothing goes out, the row keeps its tries).
 */
async function deliver(row: { id: string; staffId: string }, day: string, content: DigestContent, now: Date): Promise<void> {
  // 🔴 Fuera de producción sólo sale a la lista de prueba. La fila se cierra con el estado que ya existe para «esto no va a
  // salir nunca» (FALLO sin intentos que gastar): ningún tick posterior la retoma ni la cuenta como pendiente.
  if (!puedeMandarFueraDeProduccion(content.to)) {
    logger.info('[CRM] A daily digest was not sent: the address is outside the test list', { staffId: row.staffId, day })
    await closeForGood(row.id, now)
    return
  }
  let ok = false
  let permanent = false
  let suppressed: 'REBOTE' | 'QUEJA' | false = false
  try {
    // 🔴 Un rebote duro o una queja frenan el resumen y cierran la fila para siempre; la baja de marketing no. Si la consulta
    // truena cae al `catch` de abajo, igual que un envío fallido: no sale y la fila sigue con intentos por gastar.
    suppressed = await frenadoPorReputacion(content.to)
    if (!suppressed) {
      const result = await emailService.sendEmailWithResult({ ...content, idempotencyKey: `crm-aviso:${row.staffId}:${day}` })
      ok = result.ok
      permanent = !ok && result.transient === false
      if (!ok)
        logger.warn('[CRM] A daily digest did not go out', { staffId: row.staffId, day, error: result.errorCode ?? 'not sent', permanent })
    }
  } catch (error) {
    logger.warn('[CRM] A daily digest did not go out', { staffId: row.staffId, day, error: errorText(error) })
  }
  if (suppressed) {
    logger.info('[CRM] A daily digest was not sent: the address bounced or complained', { staffId: row.staffId, day, motivo: suppressed })
    await closeForGood(row.id, now)
    return
  }
  if (permanent) {
    await closeForGood(row.id, now)
    return
  }
  // 🔴 One transaction (Codex A r2): the last try used up and its content cleared land together, or neither does (the row
  // stays reserved and a later run retakes it with the same key).
  await prisma.$transaction(async tx => {
    await tx.crmDigestSend.updateMany({
      where: { id: row.id, reservedAt: now },
      // Sent: its content (it names people) is no longer needed to repeat it (D1). A failure keeps it to resend the same email.
      data: ok ? { status: 'ENVIADO', content: Prisma.DbNull } : { status: 'FALLO', attempts: { increment: 1 } },
    })
    // The last try used up: it will never be resent, so its content goes too (D1).
    if (!ok)
      await tx.crmDigestSend.updateMany({
        where: { id: row.id, reservedAt: now, status: 'FALLO', attempts: { gte: MAX_ATTEMPTS } },
        data: { content: Prisma.DbNull },
      })
  })
}

/**
 * Takes back what an earlier run left halfway today: rows reserved more than 10 minutes ago (the process died, before
 * or after sending) and failures with tries left. Each is taken with a compare-and-set on its status and reservation, so
 * two runs never both send it, nor resend one its slow holder just marked. Before sending, access is asked again: who
 * lost «Ver» since 8:30 (deactivated, key taken away) gets nothing, and the row closes for good.
 */
async function retakeLeftovers(day: string, now: Date): Promise<void> {
  const leftovers = await entryRead('crm-daily-digest.leftovers', () =>
    prisma.crmDigestSend.findMany({
      where: {
        day,
        kind: DIGEST_KIND,
        OR: [
          { status: 'APARTADO', reservedAt: { lt: new Date(now.getTime() - RESERVATION_TIMEOUT_MS) } },
          { status: 'FALLO', attempts: { lt: MAX_ATTEMPTS } },
        ],
      },
      select: { id: true, staffId: true, status: true, reservedAt: true, content: true },
      orderBy: [{ reservedAt: 'asc' }, { id: 'asc' }],
      take: TEAM_CAP,
    }),
  )
  for (const row of leftovers) {
    try {
      if (!isDigestContent(row.content)) {
        logger.error('[CRM] A reserved daily digest has no saved email to repeat', { id: row.id, staffId: row.staffId, day })
        continue
      }
      const { count } = await prisma.crmDigestSend.updateMany({
        where: { id: row.id, status: row.status, reservedAt: row.reservedAt },
        data: { status: 'APARTADO', reservedAt: now },
      })
      if (count !== 1) continue
      // Same rule as the first send — and its claim of an unclaimed row is as intended (see `sendNew`).
      const access = await getCrmAccess(row.staffId)
      if (!access?.ver) {
        logger.info('[CRM] A daily digest was not retried: that person no longer has CRM access', { staffId: row.staffId, day })
        await closeForGood(row.id, now)
        continue
      }
      await deliver(row, day, row.content, now)
    } catch (error) {
      logger.error('[CRM] A daily digest could not be retried', { id: row.id, staffId: row.staffId, day, error: errorText(error) })
    }
  }
}

/**
 * Today's digest for everyone with «Ver» who has no row yet and has something pending: the summary is built ONCE and
 * saved with the reservation; the insert only lets one run win (P2002 = another run already took this person today).
 * Access is the one rule of `getCrmAccess`; `team` only narrows who to ask.
 */
async function sendNew(day: string, now: Date): Promise<void> {
  const people = await team('ver')
  if (!people.length) return
  const started = new Set(
    (
      await prisma.crmDigestSend.findMany({
        where: { day, kind: DIGEST_KIND, staffId: { in: people.map(person => person.id) } },
        select: { staffId: true },
        take: people.length,
      })
    ).map(row => row.staffId),
  )
  for (const person of people) {
    if (started.has(person.id)) continue
    try {
      // Intended: on an unclaimed key row `getCrmAccess` claims it (`holdsRow`), but `team` already narrowed it to the one
      // person whose own first login would claim it — the job only does it earlier (review M-7).
      const access = await getCrmAccess(person.id)
      if (!access?.ver) continue
      const digest = await digestFor(access, now)
      if (!digest) continue
      const content: DigestContent = { to: person.email, ...digest }
      let reserved: { id: string; staffId: string }
      try {
        reserved = await prisma.crmDigestSend.create({
          data: { staffId: person.id, day, kind: DIGEST_KIND, status: 'APARTADO', reservedAt: now, content: { ...content } },
          select: { id: true, staffId: true },
        })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue
        throw error
      }
      await deliver(reserved, day, content, now)
    } catch (error) {
      logger.error('[CRM] The daily digest of one person failed', { staffId: person.id, day, error: errorText(error) })
    }
  }
}

/**
 * «Tus pendientes de hoy» (spec §5.4): on weekdays from 8:30 to 11:00 in Mexico City, one email per person and day with
 * what they owe — only if there is something (ruling 32). Every tick first retakes what an earlier one left halfway, then
 * reserves and sends the new ones. Sequential on purpose: the team is small and the pool is shared.
 */
export async function runDailyDigest(now = new Date()): Promise<void> {
  const [day, weekday, time] = formatInVenueTimezone(now, DEFAULT_TIMEZONE, 'yyyy-MM-dd i HH:mm').split(' ')
  if (Number(weekday) > 5 || time < WINDOW_FROM || time > WINDOW_TO) return
  // 🔴 D1: a row from an earlier day is never resent (`retakeLeftovers` only takes today's), so its content (it names people)
  // goes. A failure here does not hold up today's digest.
  await prisma.crmDigestSend
    .updateMany({ where: { day: { lt: day }, content: { not: Prisma.DbNull } }, data: { content: Prisma.DbNull } })
    .catch(error => logger.warn('[CRM] Could not clear the content of old daily digests', { day, error: errorText(error) }))
  await retakeLeftovers(day, now)
  await sendNew(day, now)
}

/**
 * «Por cobrar» — el correo diario al founder (spec 2026-11-02-por-cobrar-superadmin §7).
 *
 * Una fila por día de CDMX (`PlatformChargeDigest`, llave primaria `day`) hace que el correo salga UNA sola vez, y que quien retome una
 * entrega que un proceso muerto dejó a medias repita EXACTAMENTE el mismo correo con la misma llave (`por-cobrar:<día>`): Resend
 * entrega uno solo. Es la idea de `crm-daily-digest`, pero sin su ventana horaria: si el proceso muere en el último intento, nadie
 * volvería por esa reservación, así que lo pendiente se termina a cualquier hora.
 *
 * Cada vuelta (cada 15 min, todo el día):
 *   1. termina lo pendiente (`retakeLeftovers`), a cualquier hora;
 *   2. antes de las 9:00 de CDMX termina;
 *   3. genera las ocurrencias de todos los cobros, una vez al día por proceso (idempotente);
 *   4. si ya hay fila de hoy, termina: un cobro nuevo no provoca un segundo correo del mismo día;
 *   5. arma el correo; si no hay nada que decir termina SIN crear fila (un cobro dado de alta a las 14:00 que vence hoy sale a las
 *      14:15, y si el servidor estuvo caído a las 9 sale al volver);
 *   6. aparta el día (un choque de la llave primaria se ignora), guarda el correo y lo manda. Un rechazo permanente cierra el día.
 *
 * 🔴 La primera lectura de cada vuelta va con `retry(shouldRetryDbConnectionError)` (`.claude/rules/cron-jobs.md`). El envío y las
 * marcas NUNCA se reintentan a ciegas: un reintento pasa por la fila reservada y su llave.
 */
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import emailService from '@/services/email.service'
import { formatMoney } from '@/services/shared/receiptLayout/format'
import { DEFAULT_TIMEZONE, formatInVenueTimezone } from '@/utils/datetime'
import prisma from '@/utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { generateAllActive, shortDayEs } from './charges.service'
import { chargesSandbox } from './sandbox'
import { addDays, calendarDayToDb, dbToCalendarDay, todayInMexico } from './schedule'
import type { CalendarDay, ChargeConcept } from './types'

/** Sólo lo recibe el founder (como `venue-commission-settlement.job.ts`) y por eso no lleva liga de baja. */
const RECIPIENT = 'jose@avoqado.io'
/** El correo del día sale desde esta hora de CDMX; lo pendiente se termina a cualquier hora. */
const SEND_FROM = '09:00'
/** Una reservación más vieja que esto la dejó un proceso que murió, antes o después de mandar. */
const RESERVATION_TIMEOUT_MS = 10 * 60_000
const MAX_ATTEMPTS = 3
const DAY_MS = 24 * 60 * 60_000
/**
 * Resend recuerda una llave 24 h desde el PRIMER envío: pasado ese tiempo repetir el correo con ella mandaría otro. Se mide desde
 * `createdAt` (el primer envío) y no desde `reservedAt`, que cada retoma corre hacia adelante.
 */
const RETAKE_WINDOW_MS = DAY_MS
/** Filas por sección; lo demás se dice con «y N más». */
const SECTION_ROWS = 50
/** «Pagados sin factura» sólo mira lo pagado en los últimos 30 días, para que una factura que se decidió no reponer deje de insistir. */
const UNBILLED_DAYS = 30
/** El estándar de correos de Avoqado: asunto de 60 caracteres o menos. */
const SUBJECT_MAX = 60
const LOGO = 'https://avoqado.io/isotipo.svg'

/** El correo tal como salió la primera vez: una retoma lo repite igual, para que Resend reconozca su llave. */
interface DigestContent {
  to: string
  subject: string
  html: string
  text: string
}
type DigestEmail = Omit<DigestContent, 'to'>

const isDigestContent = (value: unknown): value is DigestContent =>
  !!value &&
  typeof value === 'object' &&
  ['to', 'subject', 'html', 'text'].every(field => typeof (value as Record<string, unknown>)[field] === 'string')

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)

/** Un nombre o un concepto lo escribió una persona: saltos de línea y espacios de más no deben partir el texto. */
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()

/** Como el resto de los correos al equipo: `SUPERADMIN_URL`, y el SUPERADMIN de producción si no está. */
const porCobrarUrl = () => `${(process.env.SUPERADMIN_URL || 'https://superadmin.avoqado.io').replace(/\/$/, '')}/por-cobrar`

// ── Qué dice el correo ──────────────────────────────────────────────────────────────────────────────────────────────────────

const ROW_SELECT = {
  dueDate: true,
  paidAt: true,
  totalCents: true,
  concepts: true,
  charge: { select: { customerName: true } },
} satisfies Prisma.PlatformChargeOccurrenceSelect

type OccurrenceRow = Prisma.PlatformChargeOccurrenceGetPayload<{ select: typeof ROW_SELECT }>

interface Section {
  title: string
  /** Cómo se cuenta en el asunto: singular y plural. */
  subject: [one: string, many: string]
  where: Prisma.PlatformChargeOccurrenceWhereInput
  /** Estable: termina en `id`. */
  orderBy: Prisma.PlatformChargeOccurrenceOrderByWithRelationInput[]
  /** La fecha de cada fila; de lo que vence hoy no se dice nada. */
  when: (row: OccurrenceRow) => string | null
}

interface Line {
  customer: string
  detail: string
  total: string
}

interface LoadedSection {
  title: string
  subject: [one: string, many: string]
  /** Cuántas filas cumplen el filtro (un `count` con el MISMO `where` que la lectura de las filas). */
  total: number
  /** Las que no caben en `SECTION_ROWS`: el «y N más». */
  more: number
  lines: Line[]
}

/**
 * «Hoy» y «Vencidos» son PENDIENTES por día de CDMX (a las 23:30 de CDMX, que en UTC ya es mañana, lo de hoy sigue siendo «Hoy»).
 * «Pagados sin factura» son las automáticas pagadas en los últimos 30 días sin factura VIVA: una fila en `STAMPING` o `STAMP_FAILED`
 * todavía no es una factura, así que sí sale; con `STAMPED` o `CANCEL_REQUESTED` ya hay una y no sale. Lo próximo no entra.
 */
function sectionsFor(now: Date): Section[] {
  const todayDb = calendarDayToDb(todayInMexico(now))
  const byCustomer = { charge: { customerName: 'asc' as const } }
  return [
    {
      title: 'Hoy',
      subject: ['hoy', 'hoy'],
      where: { status: 'PENDING', dueDate: todayDb },
      orderBy: [byCustomer, { id: 'asc' }],
      when: () => null,
    },
    {
      title: 'Vencidos',
      subject: ['vencido', 'vencidos'],
      where: { status: 'PENDING', dueDate: { lt: todayDb } },
      orderBy: [{ dueDate: 'asc' }, byCustomer, { id: 'asc' }],
      when: row => `venció el ${shortDayEs(dbToCalendarDay(row.dueDate))}`,
    },
    {
      title: 'Pagados sin factura',
      subject: ['sin factura', 'sin factura'],
      where: {
        status: 'PAID',
        invoiceMode: 'AUTOMATIC',
        paidAt: { gte: new Date(now.getTime() - UNBILLED_DAYS * DAY_MS) },
        invoices: { none: { status: { in: ['STAMPED', 'CANCEL_REQUESTED'] } } },
      },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      when: row => (row.paidAt ? `pagado el ${shortDayEs(todayInMexico(row.paidAt))}` : null),
    },
  ]
}

/** Los conceptos de la foto de la ocurrencia, en una línea. Es un JSON de la base: se lee sin fiarse de su forma. */
const conceptsText = (concepts: Prisma.JsonValue): string =>
  (Array.isArray(concepts) ? (concepts as unknown as Array<Partial<ChargeConcept> | null>) : [])
    .map(concept => oneLine(String(concept?.description ?? '')))
    .filter(Boolean)
    .join(', ')

async function loadSection(section: Section): Promise<LoadedSection> {
  const [rows, total] = await Promise.all([
    prisma.platformChargeOccurrence.findMany({ where: section.where, orderBy: section.orderBy, take: SECTION_ROWS, select: ROW_SELECT }),
    prisma.platformChargeOccurrence.count({ where: section.where }),
  ])
  return {
    title: section.title,
    subject: section.subject,
    total,
    more: Math.max(total - rows.length, 0),
    lines: rows.map(row => ({
      customer: oneLine(row.charge.customerName),
      // Dinero: centavos enteros hasta el último momento, formateados sin dividir (nunca pasan por un flotante).
      detail: [conceptsText(row.concepts), section.when(row)].filter(Boolean).join(' · '),
      total: formatMoney(row.totalCents),
    })),
  }
}

/** «[PRUEBA] Por cobrar: 2 hoy, 1 vencido»: lo que no cabe en 60 caracteres se queda en el cuerpo. */
function subjectFor(prefix: string, sections: LoadedSection[]): string {
  const parts = sections.map(section => `${section.total} ${section.total === 1 ? section.subject[0] : section.subject[1]}`)
  let subject = `${prefix}Por cobrar: ${parts[0]}`
  for (const part of parts.slice(1)) {
    if (`${subject}, ${part}`.length > SUBJECT_MAX) break
    subject = `${subject}, ${part}`
  }
  return subject
}

const sectionHtml = (section: LoadedSection) => `
    <h2 style="margin:32px 0 12px 0;font-size:13px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(section.title)} (${section.total})</h2>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">${section.lines
      .map(
        line => `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;">
          <div style="font-size:14px;font-weight:500;color:#000;">${escapeHtml(line.customer)}</div>
          <div style="font-size:12px;color:#666;">${escapeHtml(line.detail)}</div>
        </td>
        <td style="padding:12px 16px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;font-size:14px;font-weight:600;color:#000;">${escapeHtml(line.total)}</td>
      </tr>`,
      )
      .join('')}
    </table>${section.more > 0 ? `\n    <p style="margin:8px 0 0 0;font-size:13px;color:#666;">y ${section.more} más</p>` : ''}`

/** El correo (estándar `docs/guides/EMAIL_STANDARDS.md`: isotipo arriba y abajo, botón negro, HTML y texto, sin emoji). */
function renderDigest(subject: string, sections: LoadedSection[], now: Date): DigestEmail {
  const url = porCobrarUrl()
  const dateText = now.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: DEFAULT_TIMEZONE,
  })
  const date = dateText.charAt(0).toUpperCase() + dateText.slice(1)

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;margin:0;padding:0;background-color:#ffffff;color:#000000;">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;">
    <div style="padding-bottom:32px;">
      <img src="${LOGO}" alt="Avoqado" width="32" height="32" style="display:inline-block;vertical-align:middle;">
      <span style="font-size:18px;font-weight:700;color:#000;vertical-align:middle;margin-left:8px;">Avoqado</span>
    </div>
    <h1 style="margin:0 0 8px 0;font-size:28px;font-weight:400;color:#000;line-height:1.2;">Por cobrar</h1>
    <p style="margin:0 0 24px 0;font-size:14px;color:#666;">${escapeHtml(date)}</p>${sections.map(sectionHtml).join('')}
    <div style="margin:32px 0;text-align:left;">
      <a href="${escapeHtml(url)}" style="display:inline-block;background-color:#000000;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">Abrir Por cobrar</a>
    </div>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0;">
    <div style="padding-top:8px;">
      <div style="margin-bottom:16px;">
        <img src="${LOGO}" alt="Avoqado" width="24" height="24" style="display:inline-block;vertical-align:middle;">
        <span style="font-size:14px;font-weight:700;color:#000;vertical-align:middle;margin-left:6px;">Avoqado</span>
      </div>
      <p style="margin:0 0 8px 0;font-size:12px;color:#999;">Servicios Tecnologicos Avo S.A. de C.V.</p>
      <p style="margin:0;font-size:12px;color:#999;">Aviso interno: sólo lo recibe el equipo de Avoqado. <a href="https://avoqado.io/privacy" style="color:#666;text-decoration:underline;">Política de Privacidad</a></p>
    </div>
  </div>
</body>
</html>`

  const text = [
    'Por cobrar',
    date,
    '',
    ...sections.flatMap(section => [
      `${section.title.toUpperCase()} (${section.total})`,
      ...section.lines.map(line => `- ${line.customer}: ${line.total}${line.detail ? ` (${line.detail})` : ''}`),
      ...(section.more > 0 ? [`y ${section.more} más`] : []),
      '',
    ]),
    `Abrir Por cobrar: ${url}`,
    '',
    '---',
    'Servicios Tecnologicos Avo S.A. de C.V.',
    'Aviso interno: sólo lo recibe el equipo de Avoqado.',
  ].join('\n')

  return { subject, html, text }
}

/**
 * El correo de hoy, o `null` si no hay nada que decir (ni «Hoy», ni «Vencidos», ni «Pagados sin factura»): lo próximo no cuenta.
 * No escribe nada: reservar el día es de `runPlatformChargeDigest`.
 *
 * Con `PLATFORM_CHARGES_SANDBOX=true` sólo cambia el asunto («[PRUEBA] …»). Es la misma regla de `sandbox.ts`, que además se niega a
 * trabajar en un servidor de producción: aquí también, para que esa configuración equivocada no pase en silencio.
 */
export async function buildPlatformChargeDigest(now: Date): Promise<DigestEmail | null> {
  // El «emisor» no importa para un correo: sin llave guardada, sólo queda la regla de producción.
  const prefix = chargesSandbox({ providerKeyEnc: null }) ? '[PRUEBA] ' : ''
  const sections: LoadedSection[] = []
  for (const section of sectionsFor(now)) sections.push(await loadSection(section))
  const withRows = sections.filter(section => section.total > 0)
  if (withRows.length === 0) return null
  return renderDigest(subjectFor(prefix, withRows), withRows, now)
}

// ── Reservar, mandar y terminar lo que quedó a medias ───────────────────────────────────────────────────────────────────────

/** La primera lectura de una vuelta es pura: un corte de conexión (la estampida de la hora en punto) tiene dos intentos más. */
const entryRead = <T>(context: string, read: () => Promise<T>) =>
  retry(read, { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context })

/**
 * Manda el correo guardado de `day` con su llave y marca la fila — sólo mientras siga siendo nuestra (`reservedAt` es la marca de quien
 * la tiene: una vuelta que tardó más de 10 min pudo perderla). Si el proceso muere después de que Resend tomó el correo y antes de
 * esta marca, la fila queda reservada, una retoma manda el MISMO contenido con la MISMA llave y Resend no lo entrega otra vez. Un
 * rechazo que no va a cambiar (`transient: false`) cierra el día sin gastar intentos; un envío que lanza cuenta como un intento.
 */
async function deliver(day: CalendarDay, content: DigestContent, now: Date): Promise<void> {
  let ok = false
  let permanent = false
  try {
    const result = await emailService.sendEmailWithResult({ ...content, idempotencyKey: `por-cobrar:${day}` })
    ok = result.ok
    permanent = !ok && result.transient === false
    if (!ok) {
      logger.warn('[platform-charges] El correo diario de «Por cobrar» no salió', { day, error: result.errorCode ?? 'not sent', permanent })
    }
  } catch (error) {
    logger.warn('[platform-charges] El correo diario de «Por cobrar» no salió', { day, error: errorText(error), permanent })
  }
  await prisma.platformChargeDigest.updateMany({
    where: { day, reservedAt: now },
    data: ok
      ? { status: 'ENVIADO' }
      : permanent
        ? { status: 'FALLO', attempts: MAX_ATTEMPTS }
        : { status: 'FALLO', attempts: { increment: 1 } },
  })
}

/**
 * Termina lo que una vuelta anterior dejó a medias: filas de hoy o de ayer, de menos de 24 h, `APARTADO` desde hace más de 10 min (el
 * proceso murió antes o después de mandar) o `FALLO` con menos de 3 intentos. Cada una se toma con un compare-and-set sobre su estado y
 * su reservación, así que dos vueltas nunca la mandan las dos, ni se manda otra vez lo que su dueño lento acaba de marcar.
 */
async function retakeLeftovers(today: CalendarDay, now: Date): Promise<void> {
  const leftovers = await entryRead('platform-charge-digest.leftovers', () =>
    prisma.platformChargeDigest.findMany({
      where: {
        day: { in: [addDays(today, -1), today] },
        createdAt: { gt: new Date(now.getTime() - RETAKE_WINDOW_MS) },
        OR: [
          { status: 'APARTADO', reservedAt: { lt: new Date(now.getTime() - RESERVATION_TIMEOUT_MS) } },
          { status: 'FALLO', attempts: { lt: MAX_ATTEMPTS } },
        ],
      },
      select: { day: true, status: true, reservedAt: true, content: true },
      orderBy: { day: 'asc' },
      take: 2,
    }),
  )
  for (const row of leftovers) {
    try {
      if (!isDigestContent(row.content)) {
        logger.error('[platform-charges] Un correo diario reservado no trae el correo guardado para repetirlo', { day: row.day })
        continue
      }
      const { count } = await prisma.platformChargeDigest.updateMany({
        where: { day: row.day, status: row.status, reservedAt: row.reservedAt },
        data: { status: 'APARTADO', reservedAt: now },
      })
      if (count !== 1) continue
      await deliver(row.day, row.content, now)
    } catch (error) {
      // Una fila que falla no frena a las demás ni al correo de hoy.
      logger.error('[platform-charges] El correo diario no se pudo retomar', { day: row.day, error: errorText(error) })
    }
  }
}

/** El día de CDMX para el que este proceso ya generó las ocurrencias de todos los cobros: `generateAllActive` corre una vez al día por proceso. */
let generatedOn: CalendarDay | null = null

/**
 * La generación diaria de ocurrencias (spec §3.3) viaja en esta tarea. Es idempotente, así que un reinicio sólo la repite. Si falla
 * se registra y no se marca como hecha: el correo no depende de ella (lo que vence en la semana ya se generó al crear o editar) y la
 * vuelta siguiente la reintenta.
 */
async function generateOncePerDay(today: CalendarDay, now: Date): Promise<void> {
  if (generatedOn === today) return
  try {
    await generateAllActive(now)
    generatedOn = today
  } catch (error) {
    logger.error('[platform-charges] No se pudieron generar las ocurrencias del día; se reintenta en la vuelta siguiente', {
      day: today,
      error: errorText(error),
    })
  }
}

/** Sólo para las pruebas: cada una arranca como un proceso nuevo. */
export function __resetPlatformChargeDigestForTests(): void {
  generatedOn = null
}

/**
 * Una vuelta de la tarea (ver el encabezado). Secuencial a propósito: es un correo al día y el pool es compartido. Lo que lance
 * (la base caída, una marca que no se pudo escribir) lo atrapa la tarea; la fila reservada deja que la vuelta siguiente lo retome.
 */
export async function runPlatformChargeDigest(now: Date = new Date()): Promise<void> {
  const today = todayInMexico(now)
  await retakeLeftovers(today, now)
  if (formatInVenueTimezone(now, DEFAULT_TIMEZONE, 'HH:mm') < SEND_FROM) return

  await generateOncePerDay(today, now)
  // Cualquier fila de hoy, sea cual sea su estado: un cobro que aparece después de mandar el correo no provoca otro.
  if (await prisma.platformChargeDigest.findUnique({ where: { day: today }, select: { day: true } })) return

  const email = await buildPlatformChargeDigest(now)
  if (!email) return // nada que decir: sin fila, para que un cobro de las 14:00 salga a las 14:15

  const content: DigestContent = { to: RECIPIENT, ...email }
  try {
    await prisma.platformChargeDigest.create({
      data: { day: today, status: 'APARTADO', reservedAt: now, createdAt: now, content: { ...content } },
    })
  } catch (error) {
    // La llave primaria decide quién manda: otra vuelta u otro proceso ya apartó hoy.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return
    throw error
  }
  await deliver(today, content, now)
}

// Los correos del aviso al equipo de Avoqado. Plantillas puras (sin reloj ni base): el mismo `meta` da el mismo correo, y eso
// es lo que deja reintentar con la misma llave de Resend. Sólo muestran lo que trae `meta`: nunca texto escrito por el
// cliente (R1-01). Estructura de `sendLowStockDigestEmail` (docs/guides/EMAIL_STANDARDS.md).
import type { StaffRole, SupportDataResult, SupportNoticeKind, SupportNoticeStatus } from '@prisma/client'
import { escapeHtml } from '@/controllers/public/publicHtml'
import { DEFAULT_ROLE_DISPLAY_NAMES } from '@/utils/roleDisplay'
import { venueDayKey } from '@/utils/venueDateKeys'
import type { HandoffMeta } from './handoff.service'
import { SUPPORT_APP_LABELS, SUPPORT_HANDOFF_GREETING } from './texts'

export interface EmailContent {
  to: string
  subject: string
  html: string
  text: string
}

const LOGO = 'https://avoqado.io/isotipo.svg'
const PRIVACY = 'https://avoqado.io/privacy'
const CDMX = 'America/Mexico_City'
const WHAT: Record<HandoffMeta['reason'], string> = {
  REQUESTED: 'pidió una persona',
  TWO_FAILURES: 'no encontré dos veces y aceptó',
  OLD_VERSION: 'tenía una versión vieja y aceptó',
  DATA: 'no pudo consultar un dato y aceptó',
}
export const SEVERAL_PROFILES = 'Número registrado en varios perfiles'
/** Ayuda pública: quien pidió una persona escribió desde un número que no es de ninguna cuenta. */
export const UNREGISTERED_NUMBER = 'Número no registrado'
/** DATA without a capability (out of the catalog, la B off, not linked, superadmin). */
const OTHER_DATA = 'otro dato'
/** The subject's topic of a DATA handoff: WHAT.DATA does not fit the 30 characters of a part (the body keeps WHAT.DATA). */
const DATA_SUBJECT = 'quería un dato'

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const hourOf = (iso: string) =>
  capitalized(new Intl.DateTimeFormat('es-MX', { timeZone: CDMX, dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso)))
// Noon UTC of a CDMX day is still that day in CDMX.
const dayOf = (day: string) =>
  capitalized(new Intl.DateTimeFormat('es-MX', { timeZone: CDMX, dateStyle: 'full' }).format(new Date(`${day}T12:00:00Z`)))
const appOf = (app: string | null) => (app ? (SUPPORT_APP_LABELS[app] ?? app) : 'Sin elegir')
const roleOf = (role: string | null) => (role ? (DEFAULT_ROLE_DISPLAY_NAMES[role as StaffRole] ?? role) : 'Sin puesto')
const whatsappUrl = (phone: string) => `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(SUPPORT_HANDOFF_GREETING)}`
/** Emoji and their pieces: pictographs, flags (regional indicators), skin tones, keycaps, variation selector and joiner. */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u{20E3}\u{FE0F}\u{200D}]/gu
/** At most `max` characters (code points, never half a surrogate pair), with «…» when cut. */
function clip(value: string, max: number): string {
  const chars = Array.from(value)
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`
}
/** Each part of the subject: no emoji, at most 30 characters, never empty. */
function part(value: string): string {
  const clean = value.replace(EMOJI, '').replace(/\s+/g, ' ').trim()
  return clean ? clip(clean, 30) : 'Sin nombre'
}
/** HTML for every client: anything outside ASCII as an entity. */
const htmlSafe = (html: string) => html.replace(/[\u{80}-\u{10FFFF}]/gu, c => `&#${c.codePointAt(0)};`)
/** Plain text in plain ASCII (EMAIL_STANDARDS, rule 5): accents folded, typographic marks made plain, the rest (emoji, ¿ ¡) out. */
const ascii = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00B7/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\S\n]/g, ' ')
    .replace(/[^\n -~]/g, '')

type Row = [label: string, value: string, detail?: string]
function personRows(meta: HandoffMeta): Row[] {
  const venues = (p: HandoffMeta['people'][number]) => p.venues.map(v => v.name).join(', ') || 'Sin sucursal'
  if (!meta.people.length) return [['Persona', meta.unregistered ? UNREGISTERED_NUMBER : 'Sin perfil']]
  if (!meta.multipleProfiles && meta.people.length === 1) {
    const [p] = meta.people
    return [
      ['Persona', p.name || 'Sin nombre'],
      ['Puesto', roleOf(p.role)],
      ['Negocio', p.organization ?? 'Sin negocio'],
      ['Sucursal', venues(p)],
    ]
  }
  // Several profiles: all of them, without picking one.
  return [
    ['Persona', SEVERAL_PROFILES],
    ...meta.people.map(
      (p, i): Row => [`Perfil ${i + 1}`, p.name || 'Sin nombre', [roleOf(p.role), p.organization ?? 'Sin negocio', venues(p)].join(' · ')],
    ),
  ]
}
function conversationRows(meta: HandoffMeta): Row[] {
  return [
    ['Número', meta.phone],
    ['App', appOf(meta.app)],
    ['Versión', meta.appVersion ?? 'Sin indicar'],
    ...(meta.deviceFamily ? [['Equipo', meta.deviceFamily] as Row] : []),
    ['Qué pasó', WHAT[meta.reason]],
    ...(meta.reason === 'DATA' || meta.dataCapability ? [['Dato que intentó', meta.dataCapability ?? OTHER_DATA] as Row] : []),
    ['Lo que intentó el asistente', meta.guides.join(', ') || 'Ninguna guía'],
    ['Hora', hourOf(meta.requestedAt)],
  ]
}

const H2 = (label: string) =>
  `<h2 style="margin: 32px 0 12px; font-size: 13px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(label)}</h2>`
const table = (rows: Row[]) => `
    <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
${rows
  .map(
    ([label, value, detail]) => `      <tr>
        <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb; width: 160px; font-size: 13px; color: #666;">${escapeHtml(label)}</td>
        <td style="padding: 12px 16px; border-bottom: 1px solid #e5e7eb; font-size: 14px; color: #000;">${escapeHtml(value)}${
          detail ? `<br><span style="font-size: 13px; color: #666;">${escapeHtml(detail)}</span>` : ''
        }</td>
      </tr>`,
  )
  .join('\n')}
    </table>`
const button = (meta: HandoffMeta) => `
    <div style="margin: 24px 0 0; text-align: left;">
      <a href="${escapeHtml(whatsappUrl(meta.phone))}" style="display: inline-block; background-color: #000000; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600;">Escribirle por WhatsApp</a>
    </div>`
const textRows = (rows: Row[]) =>
  rows.map(([label, value, detail]) => `${label}: ${value}${detail ? ` (${detail.replace(/ · /g, ', ')})` : ''}`)

function page(subject: string, title: string, date: string, intro: string, body: string): string {
  return htmlSafe(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; margin: 0; padding: 0; background-color: #ffffff; color: #000000;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header with Logo -->
    <div style="padding-bottom: 32px;">
      <img src="${LOGO}" alt="Avoqado" width="32" height="32" style="display: inline-block; vertical-align: middle;">
      <span style="font-size: 18px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 8px;">Avoqado</span>
    </div>

    <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 400; color: #000; line-height: 1.2;">${escapeHtml(title)}</h1>
    <p style="margin: 0 0 24px 0; font-size: 14px; color: #666;">${escapeHtml(date)}</p>
    <p style="margin: 0 0 8px 0; font-size: 14px; color: #000;">${escapeHtml(intro)}</p>
${body}

    <p style="margin: 32px 0 0 0; font-size: 13px; color: #666;">Por privacidad, este aviso no incluye lo que escribió la persona.</p>

    <!-- Divider -->
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

    <!-- Footer -->
    <div style="padding-top: 8px;">
      <div style="margin-bottom: 16px;">
        <img src="${LOGO}" alt="Avoqado" width="24" height="24" style="display: inline-block; vertical-align: middle;">
        <span style="font-size: 14px; font-weight: 700; color: #000; vertical-align: middle; margin-left: 6px;">Avoqado</span>
      </div>
      <p style="margin: 0 0 8px 0; font-size: 12px; color: #999;">Servicios Tecnologicos Avo S.A. de C.V.</p>
      <p style="margin: 0; font-size: 12px; color: #999;">Recibes este aviso porque esta dirección atiende el soporte de Avoqado. <a href="${PRIVACY}" style="color: #666; text-decoration: underline;">Aviso de privacidad</a></p>
    </div>

  </div>
</body>
</html>`)
}
const plainText = (lines: string[]) =>
  ascii(
    [
      ...lines,
      '',
      'Por privacidad, este aviso no incluye lo que escribió la persona.',
      '---',
      'Servicios Tecnologicos Avo S.A. de C.V.',
      `Aviso de privacidad: ${PRIVACY}`,
    ].join('\n'),
  )

/** El aviso de una persona que pidió ayuda: sólo lo que trae `meta`. */
export function buildHandoffEmail(meta: HandoffMeta, to: string): EmailContent {
  const business = meta.unregistered
    ? UNREGISTERED_NUMBER
    : meta.multipleProfiles
      ? 'Varios perfiles'
      : (meta.people[0]?.organization ?? meta.people[0]?.venues[0]?.name ?? 'Sin negocio')
  const subject = ['Soporte', business, appOf(meta.app), meta.guides[0] ?? (meta.reason === 'DATA' ? DATA_SUBJECT : WHAT.REQUESTED)]
    .map(part)
    .join(' · ')
  const title = 'Una persona pidió ayuda por WhatsApp'
  const intro = 'Escríbele desde el WhatsApp de soporte: el botón de abajo abre la plática con su número.'
  const people = personRows(meta),
    conversation = conversationRows(meta)
  const html = page(
    subject,
    title,
    hourOf(meta.requestedAt),
    intro,
    `${H2('Persona')}${table(people)}
${H2('Conversación')}${table(conversation)}
${button(meta)}`,
  )
  const text = plainText([
    title,
    hourOf(meta.requestedAt),
    '',
    intro,
    '',
    ...textRows(people),
    '',
    ...textRows(conversation),
    '',
    `Escribirle por WhatsApp: ${whatsappUrl(meta.phone)}`,
  ])
  return { to, subject, html, text }
}

/** One notice of the digest in two short lines: hour · business · venues, then person, app and version, and what happened. */
function compact(meta: HandoffMeta): [first: string, second: string] {
  const hour = new Intl.DateTimeFormat('es-MX', { timeZone: CDMX, timeStyle: 'short' }).format(new Date(meta.requestedAt))
  // Clipped so that 100 of them stay under Gmail's limit; the full names stay on each HELD row until the 30-day purge.
  const venues = (p: HandoffMeta['people'][number]) => clip(p.venues.map(v => v.name).join(', ') || 'Sin sucursal', 60)
  const name = (p: HandoffMeta['people'][number]) => `${clip(p.name || 'Sin nombre', 40)} (${roleOf(p.role)})`
  const business = (p: HandoffMeta['people'][number]) => clip(p.organization ?? 'Sin negocio', 40)
  const single = !meta.multipleProfiles && meta.people.length === 1 ? meta.people[0] : null
  const where = single
    ? `${business(single)} · ${venues(single)}`
    : meta.people.length
      ? SEVERAL_PROFILES
      : meta.unregistered
        ? UNREGISTERED_NUMBER
        : 'Sin perfil'
  // Several profiles: every one of them, without picking.
  const who = single ? name(single) : meta.people.map(p => `${name(p)}: ${business(p)} · ${venues(p)}`).join('; ')
  const app = [appOf(meta.app), meta.appVersion].filter(Boolean).join(' ')
  return [`${hour} · ${where}`, [who, app, WHAT[meta.reason]].filter(Boolean).join(' · ')]
}

/**
 * Los avisos que los topes del día retuvieron (HELD), en un solo correo al día siguiente. Compacto: hasta 100 avisos caben
 * bajo los ~102 KB en que Gmail recorta un correo.
 */
export function buildHeldDigestEmail(day: string, items: HandoffMeta[], to: string): EmailContent {
  const subject = `Soporte · Resumen del día · ${day}`
  const title = 'Avisos retenidos del día'
  const intro = `${items.length} ${items.length === 1 ? 'aviso se retuvo' : 'avisos se retuvieron'} por los topes del día. Escríbeles desde el WhatsApp de soporte.`
  const rows = items
    .map(meta => {
      const [first, second] = compact(meta)
      return `      <tr><td style="padding: 10px 16px; border-bottom: 1px solid #e5e7eb; font-size: 14px; color: #000;">${escapeHtml(first)}<br><span style="font-size: 13px; color: #666;">${escapeHtml(second)}</span><br><a href="${escapeHtml(whatsappUrl(meta.phone))}" style="font-size: 13px; font-weight: 600; color: #000000;">Escribirle por WhatsApp</a></td></tr>`
    })
    .join('\n')
  const html = page(
    subject,
    title,
    dayOf(day),
    intro,
    `${H2('Avisos')}
    <table cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
${rows}
    </table>`,
  )
  const text = plainText([
    title,
    dayOf(day),
    '',
    intro,
    ...items.flatMap(meta => {
      const [first, second] = compact(meta)
      return ['', `- ${first}`, `  ${second}`, `  Escribirle por WhatsApp: ${whatsappUrl(meta.phone)}`]
    }),
  ])
  return { to, subject, html, text }
}

/**
 * La lista semanal: sólo conteos, armada de la base cuando su semana ya cerró. Se guarda en `meta` (sus fechas vuelven como
 * ISO) y el correo sale de ahí en cada intento. app null → «sin app».
 */
export interface WeeklyReport {
  from: Date
  to: Date
  /** «no encontré», «juez rechazó», «pidió aclarar» */
  failures: { app: string | null; kind: 'UNKNOWN' | 'JUDGE_LITERAL' | 'CLARIFIED'; count: number }[]
  /** Las 20 guías con más fallas y «y N más». */
  guides: { id: string; title: string; count: number }[]
  guidesMore: number
  handoffs: { app: string | null; status: SupportNoticeStatus; reason: string; count: number }[]
  undelivered: { kind: SupportNoticeKind; status: 'FAILED' | 'SKIPPED' | 'UNCERTAIN'; count: number }[]
  /**
   * La B: las consultas de datos por capacidad (su llave y su etiqueta, resuelta al armar la lista) y resultado. Opcional: una
   * lista guardada antes de la B sigue saliendo; una guardada sin `label` imprime la llave.
   */
  data?: { capability: string; label?: string; result: SupportDataResult; count: number }[]
}
/** In this order in the email. */
const FAILED_AS: Record<WeeklyReport['failures'][number]['kind'], string> = {
  UNKNOWN: 'no encontré',
  JUDGE_LITERAL: 'juez rechazó',
  CLARIFIED: 'pidió aclarar',
}
const STATUS: Record<SupportNoticeStatus, string> = {
  PENDING: 'pendiente',
  SENDING: 'enviándose',
  SENT: 'enviado',
  FAILED: 'falló',
  SKIPPED: 'no se mandó',
  HELD: 'en el resumen del día',
  UNCERTAIN: 'aviso incierto',
}
const NOTICE: Record<SupportNoticeKind, string> = {
  HANDOFF: 'Pasar a una persona',
  DAILY_DIGEST: 'Resumen del día',
  WEEKLY_REPORT: 'Lista semanal',
}
/** In this order in the email. */
const DATA_RESULT: Record<SupportDataResult, string> = {
  ANSWERED: 'contestadas',
  NO_PERMISSION: 'sin permiso',
  PLAN_REQUIRED: 'sin el plan',
  NEEDS_UNLOCK: 'sin el toque del día',
  PARAM_INVALID: 'no se entendió',
  NOT_OFFERED: 'no se ofrece ahí',
  OVER_CAP: 'no se pudo calcular con exactitud',
  QUERY_FAILED: 'falló la lectura',
  CHECK_FAILED: 'falló el cotejo',
}
const weeklyApp = (app: string | null) => (app ? appOf(app) : 'Sin app')
const num = (count: number) => count.toLocaleString('es-MX')
const sum = (rows: { count: number }[]) => rows.reduce((total, row) => total + row.count, 0)
const counted = (rows: { count: number }[], one: string, many: string) => {
  const total = sum(rows)
  return `${num(total)} ${total === 1 ? one : many}`
}

/** La lista semanal: sólo conteos, nunca texto. Pura: del `meta` guardado (fechas ISO) sale el mismo correo. */
export function buildWeeklyEmail(report: WeeklyReport, to: string): EmailContent {
  const from = new Date(report.from),
    last = new Date(new Date(report.to).getTime() - 1)
  const subject = `Soporte · Lista semanal · ${venueDayKey(from, CDMX)} al ${venueDayKey(last, CDMX)}`
  const long = new Intl.DateTimeFormat('es-MX', { timeZone: CDMX, dateStyle: 'long' })
  const title = 'Lista semanal del asistente de soporte'
  const date = `Del ${long.format(from)} al ${long.format(last)}`
  const failures = [...new Set(report.failures.map(f => f.app))].map((app): Row => {
    const mine = report.failures.filter(f => f.app === app)
    const counts = Object.entries(FAILED_AS).flatMap(([kind, label]) =>
      mine.filter(f => f.kind === kind).map(f => `${label}: ${num(f.count)}`),
    )
    return [weeklyApp(app), counts.join(' · ')]
  })
  const guides: Row[] = [
    ...report.guides.map((g): Row => [`${num(g.count)} ${g.count === 1 ? 'vez' : 'veces'}`, g.title]),
    ...(report.guidesMore ? [['Más guías', `y ${num(report.guidesMore)} más`] as Row] : []),
  ]
  const handoffs = report.handoffs.map(
    (h): Row => [weeklyApp(h.app), `${num(h.count)} · ${WHAT[h.reason as HandoffMeta['reason']] ?? h.reason}`, STATUS[h.status]],
  )
  const undelivered = report.undelivered.map((u): Row => [NOTICE[u.kind], `${num(u.count)} · ${STATUS[u.status]}`])
  // One row per capability, with the label saved in meta (or its key); never a figure, a venue or a person.
  const data = report.data ?? []
  const queries = [...new Set(data.map(d => d.capability))].map((key): Row => {
    const mine = data.filter(d => d.capability === key)
    const counts = Object.entries(DATA_RESULT).flatMap(([result, label]) =>
      mine.filter(d => d.result === result).map(d => `${label}: ${num(d.count)}`),
    )
    return [mine[0].label ?? key, counts.join(' · ')]
  })
  const all: [label: string, rows: Row[]][] = [
    ['Lo que el asistente no contestó', failures],
    ['Guías de esas respuestas', guides],
    ['Pasados a una persona', handoffs],
    ['Avisos no entregados', undelivered],
    ['Consultas de datos', queries],
  ]
  const sections = all.filter(([, rows]) => rows.length)
  // The data questions join the totals only when there are some: a week without them keeps the sentence as it was.
  const totals = [
    `${counted(report.failures, 'pregunta', 'preguntas')} que el asistente no contestó`,
    `${counted(report.handoffs, 'pasada', 'pasadas')} a una persona`,
    counted(report.undelivered, 'aviso no entregado', 'avisos no entregados'),
    ...(sum(data) ? [counted(data, 'consulta de datos', 'consultas de datos')] : []),
  ]
  const intro = sections.length ? `${totals.slice(0, -1).join(', ')} y ${totals[totals.length - 1]}.` : 'Nada que reportar esta semana.'
  const kept = 'Esta lista sólo trae conteos: el texto de las preguntas se queda en la base 30 días.'
  const html = page(
    subject,
    title,
    date,
    intro,
    `${sections.map(([label, rows]) => `${H2(label)}${table(rows)}`).join('\n')}
    <p style="margin: 24px 0 0 0; font-size: 13px; color: #666;">${escapeHtml(kept)}</p>`,
  )
  const text = plainText([title, date, '', intro, ...sections.flatMap(([label, rows]) => ['', label, ...textRows(rows)]), '', kept])
  return { to, subject, html, text }
}

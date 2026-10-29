/**
 * D4 — avisos de «No asistió»: correcciones que piden a una persona, llegadas del kiosco por revisar y el resumen por
 * clase. Panel, kiosco, MCP y el trabajo automático sólo llaman a estas funciones.
 *
 * Entrega AL MENOS UNA VEZ por destinatario (decisión 8 del plan):
 *   1. el CORREO va primero, directo por Resend;
 *   2. la CAMPANITA después, sólo canal IN_APP: es la marca de «a esta persona ya se le mandó».
 * Si el proveedor falla, no hay campanita y el siguiente tick reintenta; si el proceso muere entre los dos, el correo se
 * repite (mejor dos que ninguno). Cuando ya les llegó a TODOS, la marca es una que el usuario no puede borrar (la
 * campanita sí, desde el buzón): `noticeSentAt` en la corrección y `RESERVATION_NO_SHOW_SUMMARY_SENT` en ActivityLog
 * para el resumen de una clase. El aviso del kiosco no tiene tick que lo retome: su correo se reintenta en el momento.
 *
 * 🔴 La campanita NO pasa por `sendNotification`: una preferencia con EMAIL haría que ése mandara OTRO correo, y en
 * horas de silencio no crea la fila — la marca nunca existiría y el aviso se repetiría cada tick.
 *
 * Destinatarios: OWNER/ADMIN/MANAGER activos de la sucursal (como `quienDebeEnterarse` del aviso de retardo) y los
 * dueños activos de su organización (como OWNER, igual que `checkPermission`), con `reservations:read` EFECTIVO,
 * evaluado con el mismo resolver que `checkPermission` (antimeta del spec: que un correo llegue a quien no puede ver
 * reservaciones). Sin EMAIL en su preferencia (o dados de baja) reciben sólo la campanita.
 */
import { NotificationChannel, NotificationPriority, NotificationType, OrgRole, Prisma, StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import socketManager from '@/communication/sockets'
import { BASE_URL, FRONTEND_URL } from '@/config/env'
import { evaluateRolePermission } from '@/middlewares/checkPermission.middleware'
import { sendNotificationEmail } from '@/services/resend.service'
import { getReservationSettings } from '@/services/dashboard/reservationSettings.service'
import { signUnsubscribeToken } from '@/utils/unsubscribeToken'
import { classifyUndeliverable } from '@/utils/undeliverableEmail'
import { formatInVenueTimezone, zonaValida } from '@/utils/datetime'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { activityActorFields } from '@/services/reservation/checkIn.service'

/** Textos de los pendientes (Global Constraints del plan D4). Los mismos en panel, POS y MCP. */
export const PENDING_TEXT: Record<string, string> = {
  CLASS_UNPAID: 'Esta clase no estaba pagada: cóbrala en caja',
  CREDIT_NOT_RECONSUMED: 'No había clase que descontar: cóbrala o regálala',
  FEE_CAPTURED: 'La multa ya se cobró a la tarjeta: si corresponde, reembólsala desde el pago',
  KIOSK_TOO_OLD: 'Llegada del kiosco de hace más de 3 días: revisa si sí llegó',
  KIOSK_UNVERIFIED: 'El kiosco mandó una llegada que no se pudo comprobar: revisa si sí llegó',
}

const MIN = 60_000
const MAX_DESTINATARIOS = 50
/** El barrido no pisa a `afterNoShowCorrection`, que corre justo al corregir. */
const FLUSH_GRACIA_MS = 2 * MIN
/** Más vieja que esto, la corrección ya no se avisa sola (el pendiente sigue a la vista en la reserva). */
const FLUSH_VENTANA_MS = 72 * 60 * MIN
const FLUSH_LECTURA = 200
const FLUSH_TOPE = 20
const RESUMEN_ESPERA_MS = 5 * MIN
const RESUMEN_VENTANA_MS = 24 * 60 * MIN
// ponytail: cada tick vuelve a leer hasta 200 clases de las últimas 24 h (también las ya avisadas: su marca las descarta
// DESPUÉS de leerlas). Con más de 200 clases con faltas en 24 h se pierden los reintentos de las más viejas (las nuevas
// nunca: se leen primero); si llega ese volumen, una columna «resumen enviado» en ClassSession filtrada en la lectura.
const RESUMEN_LECTURA = 200
const RESUMEN_TOPE = 20
const RESUMEN_MAX_PERSONAS = 100
/** Resend permite ~2 envíos por segundo (mismo respiro que el resumen de inventario bajo). */
const PAUSA_ENTRE_CORREOS_MS = 500
/** Aviso sin tick que lo retome (kiosco): 3 intentos, esperando ~2 s y ~4 s; ningún reintento empieza pasados 15 s del aviso. */
const CORREO_INTENTOS = 3
const CORREO_ESPERA_MS = 2_000
const CORREO_TOPE_MS = 15_000
/** La marca de «el resumen de esta clase ya les llegó a todos» (r3 #3), con el actor del trabajo automático. */
const RESUMEN_ENVIADO = 'RESERVATION_NO_SHOW_SUMMARY_SENT'
const ACTOR_AVISOS = { type: 'SERVICE', servicePrincipalId: 'reservation-auto-no-show' } as const

type Destinatario = { staffId: string; email: string | null }

/** Lo que se lanza no siempre es un Error (`throw null`): leer `.message` ahí lanzaría desde el catch de un «nunca lanza». */
const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** «Ana», «gómez» → «Ana G.» (la regla de la lista del kiosco). */
function nombreCorto(customer: { firstName: string | null; lastName: string | null } | null, guestName: string | null): string {
  const partes = customer ? [customer.firstName ?? '', customer.lastName ?? ''] : (guestName ?? '').trim().split(/\s+/)
  const nombre = (partes[0] ?? '').trim()
  const apellido = partes.slice(1).join(' ').trim()
  if (!nombre && !apellido) return 'Invitado'
  return apellido ? `${nombre} ${apellido[0].toUpperCase()}.` : nombre
}

/** La plantilla genérica pega título y mensaje en el HTML tal cual: sin `<`/`>` un nombre no puede volverse etiqueta. */
const sinEtiquetas = (s: string) => s.replace(/[<>]/g, '')

const hora = (d: Date, timezone: string | null) => formatInVenueTimezone(d, zonaValida(timezone), 'HH:mm')

/**
 * Quién se entera en esta sucursal de este tipo de aviso. `email` es null si no lo quiere por correo.
 * Fuera: sin `reservations:read` efectivo, o con el aviso apagado (`enabled: false` o sin canales).
 */
async function destinatarios(venueId: string, type: NotificationType): Promise<Destinatario[]> {
  const deLaSucursal = await prisma.staffVenue.findMany({
    where: { venueId, active: true, role: { in: [StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER] }, staff: { active: true } },
    select: { staffId: true, role: true, permissionSet: true, staff: { select: { email: true } } },
    orderBy: { staffId: 'asc' },
    take: MAX_DESTINATARIOS,
  })
  // 🔴 El DUEÑO DE LA ORGANIZACIÓN opera como OWNER sin fila en la sucursal o con una menor (Codex r4 #2): la precedencia
  // de `resolverRolEnLaBase` (checkPermission), con su misma consulta pero para todos a la vez. Una fila SUPERADMIN activa
  // gana, y su Conjunto de Permisos es el de su fila en esta sucursal, aunque esté apagada.
  const duenos = await prisma.staffOrganization.findMany({
    where: { role: OrgRole.OWNER, isActive: true, staff: { active: true }, organization: { venues: { some: { id: venueId } } } },
    select: {
      staffId: true,
      staff: { select: { email: true, venues: { where: { venueId }, select: { role: true, active: true, permissionSet: true } } } },
    },
    orderBy: { staffId: 'asc' },
    take: MAX_DESTINATARIOS,
  })
  const porPersona = new Map(
    deLaSucursal.map(f => [f.staffId, { staffId: f.staffId, role: f.role, permissionSet: f.permissionSet, email: f.staff.email }]),
  )
  for (const d of duenos) {
    const fila = d.staff.venues[0]
    const role = fila?.active && fila.role === StaffRole.SUPERADMIN ? StaffRole.SUPERADMIN : StaffRole.OWNER
    porPersona.set(d.staffId, { staffId: d.staffId, role, permissionSet: fila?.permissionSet ?? null, email: d.staff.email })
  }
  // Una sola vez por persona, y el tope sobre la unión (las dos lecturas ya vienen en orden y con tope).
  const filas = [...porPersona.values()]
    .sort((a, b) => (a.staffId < b.staffId ? -1 : a.staffId > b.staffId ? 1 : 0))
    .slice(0, MAX_DESTINATARIOS)

  // Sin Conjunto de Permisos, el permiso depende sólo del rol: una consulta por rol, no por persona.
  const porRol = new Map<StaffRole, Promise<boolean>>()
  const puede = (f: (typeof filas)[number]) => {
    if (f.permissionSet)
      return evaluateRolePermission({ venueId, role: f.role, permissionSet: f.permissionSet, permission: 'reservations:read' })
    if (!porRol.has(f.role)) porRol.set(f.role, evaluateRolePermission({ venueId, role: f.role, permission: 'reservations:read' }))
    return porRol.get(f.role)!
  }
  const conPermiso: typeof filas = []
  for (const f of filas) if (await puede(f)) conPermiso.push(f)
  if (conPermiso.length === 0) return []

  const prefs = await prisma.notificationPreference.findMany({
    where: { venueId, type, staffId: { in: conPermiso.map(f => f.staffId) } },
    select: { staffId: true, enabled: true, channels: true },
    take: conPermiso.length,
  })
  const pref = new Map(prefs.map(p => [p.staffId, p]))
  return conPermiso.flatMap(f => {
    const p = pref.get(f.staffId)
    if (p && (!p.enabled || p.channels.length === 0)) return []
    // Sin fila = default del tipo, [IN_APP, EMAIL] (igual que `emailUnsubscribe.service`).
    const quiereCorreo = !p || p.channels.includes(NotificationChannel.EMAIL)
    return [{ staffId: f.staffId, email: quiereCorreo ? f.email : null }]
  })
}

interface Aviso {
  venueId: string
  venueSlug: string
  type: NotificationType
  entityType: string
  entityId: string
  subject: string
  title: string
  /** Campanita. */
  message: string
  /** Correo (si no, el de la campanita). */
  emailMessage?: string
  /** Relativa al negocio (`reservations/<id>`): la campanita del DASHBOARD le antepone `/venues/<slug>/`. */
  actionUrl: string
  actionLabel: string
  priority: NotificationPriority
  metadata: Prisma.InputJsonObject
}

const pausa = (ms: number) => new Promise(r => setTimeout(r, ms))

/** El correo con `retry` (espera creciente con jitter); ningún reintento empieza después de `hasta`. `false` si no salió. */
const conReintento = (enviar: () => Promise<boolean>, hasta: number): Promise<boolean> =>
  retry(
    async () => {
      if (!(await enviar())) throw new Error('el proveedor no aceptó el correo')
    },
    {
      retries: CORREO_INTENTOS - 1,
      initialDelay: CORREO_ESPERA_MS,
      shouldRetry: () => Date.now() < hasta,
      context: 'no-show-notices.correo',
    },
  ).then(
    () => true,
    () => false,
  )

/**
 * El orden del lote de un tick: primero lo que NADIE ha recibido todavía, de lo más nuevo a lo más viejo; con lo que
 * sobre, los reintentos (alguien ya tiene su campanita), de lo más viejo a lo más nuevo. Así una dirección que falla
 * siempre no deja esperando a lo nuevo de todos los negocios. Lo más nuevo va primero también entre lo «nuevo»: si el
 * único destinatario tiene el correo roto, nada suyo llega a tener campanita y todo se ve «nuevo» para siempre.
 * ponytail: con 20 o más pendientes más nuevos atorados para siempre (un negocio con todos sus correos rotos), un
 * pendiente viejo que nunca se intentó espera hasta vencer; si pasa, un tope de lugares por negocio o un contador de
 * intentos por pendiente.
 */
function nuevasPrimero<T extends { id: string }>(deNuevaAVieja: T[], conAlguna: Set<string>): T[] {
  return [...deNuevaAVieja.filter(x => !conAlguna.has(x.id)), ...deNuevaAVieja.filter(x => conAlguna.has(x.id)).reverse()]
}

/**
 * Entrega un aviso a quien todavía no tiene su campanita. `true` si al terminar TODOS la tienen (o no hay a quién).
 * `faltan` deja pasar una lista ya filtrada (el resumen la calcula en lote). `enProceso`: no hay fila que un tick vuelva
 * a tomar, así que el correo se reintenta aquí (`CORREO_INTENTOS`, hasta ~15 s por aviso) y, si igual no sale, queda la
 * campanita sola con un error en el log (mejor la campanita que nada).
 * ponytail: esos reintentos viven en memoria. Si el proceso muere a media espera, el correo de esa persona se pierde (y
 * su campanita y las de quienes faltaban); las campanitas ya creadas quedan. Si pasa, una fila que el barrido retome.
 */
async function entregar(aviso: Aviso, faltan?: Destinatario[], enProceso = false): Promise<boolean> {
  const todos = faltan ?? (await destinatarios(aviso.venueId, aviso.type))
  if (todos.length === 0) return true

  const yaTienen = await prisma.notification.findMany({
    where: {
      venueId: aviso.venueId,
      type: aviso.type,
      entityType: aviso.entityType,
      entityId: aviso.entityId,
      recipientId: { in: todos.map(d => d.staffId) },
    },
    select: { recipientId: true },
    take: todos.length,
  })
  const avisados = new Set(yaTienen.map(n => n.recipientId))
  const pendientes = todos.filter(d => !avisados.has(d.staffId))

  // Sin llave de Resend (local) el correo nunca sale: se trata como «no lo quiere por correo», no como falla, o la
  // campanita nunca nacería y el aviso se repetiría cada tick.
  const hayCorreo = !!process.env.RESEND_API_KEY
  const linkCorreo = `${FRONTEND_URL}/venues/${aviso.venueSlug}/${aviso.actionUrl}`
  const apiBase = BASE_URL || 'http://localhost:3000'
  let completo = true
  let correos = 0
  const hasta = Date.now() + CORREO_TOPE_MS

  for (const d of pendientes) {
    if (hayCorreo && d.email && !classifyUndeliverable(d.email)) {
      if (correos++ > 0) await pausa(PAUSA_ENTRE_CORREOS_MS)
      const token = signUnsubscribeToken({ staffId: d.staffId, venueId: aviso.venueId, category: 'RESERVATIONS' })
      const email = d.email
      const enviar = () =>
        sendNotificationEmail(
          email,
          sinEtiquetas(aviso.subject),
          sinEtiquetas(aviso.title),
          sinEtiquetas(aviso.emailMessage ?? aviso.message),
          linkCorreo,
          aviso.actionLabel,
          { unsubscribeUrl: `${apiBase}/api/v1/public/unsubscribe?token=${token}` },
        )
      const ok = enProceso ? await conReintento(enviar, hasta) : await enviar()
      if (!ok && !enProceso) {
        // Sin campanita: es la marca de «ya se mandó». El siguiente tick lo reintenta.
        completo = false
        logger.warn(`[no-show-notices] no salió el correo a ${d.staffId} (${aviso.entityType} ${aviso.entityId}); se reintenta`)
        continue
      }
      if (!ok)
        logger.error('[no-show-notices] no salió el correo ni reintentándolo; queda sólo la campanita', {
          staffId: d.staffId,
          entityType: aviso.entityType,
          entityId: aviso.entityId,
          ...aviso.metadata,
        })
    }
    await campanita(aviso, d.staffId)
  }
  return completo
}

async function campanita(aviso: Aviso, recipientId: string): Promise<void> {
  const n = await prisma.notification.create({
    data: {
      recipientId,
      venueId: aviso.venueId,
      type: aviso.type,
      title: aviso.title,
      message: aviso.message,
      actionUrl: aviso.actionUrl,
      actionLabel: aviso.actionLabel,
      entityType: aviso.entityType,
      entityId: aviso.entityId,
      metadata: aviso.metadata,
      priority: aviso.priority,
      channels: [NotificationChannel.IN_APP],
      sentAt: new Date(),
    },
  })
  socketManager.getBroadcastingService()?.broadcastNewNotification({
    notificationId: n.id,
    recipientId,
    venueId: aviso.venueId,
    userId: recipientId,
    type: n.type,
    title: n.title,
    message: n.message,
    priority: n.priority as 'LOW' | 'NORMAL' | 'HIGH',
    isRead: n.isRead,
    actionUrl: n.actionUrl || undefined,
    actionLabel: n.actionLabel || undefined,
    metadata: (n.metadata as Record<string, any>) || undefined,
  })
}

const RESERVA_SELECT = {
  id: true,
  startsAt: true,
  checkedInAt: true,
  guestName: true,
  customer: { select: { firstName: true, lastName: true } },
  product: { select: { name: true } },
  classSession: { select: { startsAt: true, product: { select: { name: true } } } },
  venue: { select: { name: true, slug: true, timezone: true } },
} satisfies Prisma.ReservationSelect
type ReservaAviso = Prisma.ReservationGetPayload<{ select: typeof RESERVA_SELECT }>

const claseDe = (r: ReservaAviso) => r.classSession?.product?.name ?? r.product?.name ?? 'su reserva'
const inicioDe = (r: ReservaAviso) => r.classSession?.startsAt ?? r.startsAt

/** Lo que una persona tiene que resolver, un renglón por pendiente. */
const renglones = (pending: string[]) => pending.map(p => PENDING_TEXT[p] ?? p).join('\n')

/** Avisa una corrección. `true` si quedó marcada como avisada. Lanza si la base falla (los llamadores lo atrapan). */
async function avisarCorreccion(correctionId: string): Promise<boolean> {
  const c = await prisma.reservationNoShowCorrection.findUnique({
    where: { id: correctionId },
    select: {
      id: true,
      venueId: true,
      reservationId: true,
      source: true,
      pending: true,
      noticeSentAt: true,
      resolvedAt: true,
      reservation: { select: RESERVA_SELECT },
    },
  })
  if (!c || c.noticeSentAt) return false

  // Un pendiente abierto = hay pendientes y nadie lo ha marcado resuelto.
  const abiertos = c.resolvedAt ? [] : c.pending
  const kiosco = c.source === 'KIOSK'
  if (abiertos.length > 0 || kiosco) {
    const r = c.reservation
    const nombre = nombreCorto(r.customer, r.guestName)
    const clase = claseDe(r)
    const tz = r.venue.timezone
    const title = kiosco
      ? `Se corrigió sola por el kiosco: ${nombre} llegó a las ${hora(r.checkedInAt ?? inicioDe(r), tz)} a ${clase}`
      : `${nombre} sí llegó a ${clase} de las ${hora(inicioDe(r), tz)}: falta resolver algo`
    const message =
      abiertos.length > 0
        ? `${renglones(abiertos)}\nCuando lo resuelvas, toca «Marcar resuelto» en la reserva.`
        : 'La hora de llegada la marcó el kiosco. Si no es correcta, avísale a soporte.'
    const completo = await entregar({
      venueId: c.venueId,
      venueSlug: r.venue.slug,
      type: NotificationType.RESERVATION_NEEDS_REVIEW,
      entityType: 'ReservationNoShowCorrection',
      entityId: c.id,
      subject: `${r.venue.name}: revisa la asistencia de ${nombre}`,
      title,
      message,
      actionUrl: `reservations/${c.reservationId}`,
      actionLabel: 'Ver reserva',
      priority: abiertos.length > 0 ? NotificationPriority.HIGH : NotificationPriority.NORMAL,
      metadata: { reservationId: c.reservationId, correctionId: c.id, source: c.source, pending: abiertos },
    })
    if (!completo) return false
  }

  const { count } = await prisma.reservationNoShowCorrection.updateMany({
    where: { id: c.id, noticeSentAt: null },
    data: { noticeSentAt: new Date() },
  })
  return count > 0
}

/**
 * Avisa una corrección recién hecha: si deja pendientes abiertos o si la hizo el kiosco (siempre, aunque no deje nada:
 * la hora la midió el aparato). Una corrección a mano sin pendientes sólo queda marcada. Nunca lanza: lo que no salga
 * lo manda el trabajo automático (`flushPendingCorrectionNotices`).
 */
export async function afterNoShowCorrection(correctionId: string): Promise<void> {
  try {
    await avisarCorreccion(correctionId)
  } catch (e) {
    logger.error(`[no-show-notices] aviso de la corrección ${correctionId} pendiente para el barrido: ${mensaje(e)}`)
  }
}

/**
 * Reservas cuyo aviso de revisión está saliendo en este proceso (una sola instancia, sin Redis): con los reintentos del
 * correo tarda hasta ~15 s y en ese rato todavía no hay campanita que frene a un toque repetido del kiosco.
 */
const revisionEnCurso = new Set<string>()

/**
 * Aviso inmediato cuando el kiosco manda una llegada que no puede corregir sola (muy vieja o sin comprobar). Una vez
 * por (destinatario, reserva). El kiosco ya recibió su respuesta y ningún tick lo retoma: el correo se reintenta aquí.
 * Nunca lanza.
 */
export async function notifyNoShowNeedsReview(args: {
  venueId: string
  reservationId: string
  reason: 'KIOSK_TOO_OLD' | 'KIOSK_UNVERIFIED'
}): Promise<void> {
  if (revisionEnCurso.has(args.reservationId)) return
  revisionEnCurso.add(args.reservationId)
  try {
    const r = await prisma.reservation.findFirst({ where: { id: args.reservationId, venueId: args.venueId }, select: RESERVA_SELECT })
    if (!r) return
    const nombre = nombreCorto(r.customer, r.guestName)
    await entregar(
      {
        venueId: args.venueId,
        venueSlug: r.venue.slug,
        type: NotificationType.RESERVATION_NEEDS_REVIEW,
        entityType: 'Reservation',
        entityId: r.id,
        subject: `${r.venue.name}: revisa la asistencia de ${nombre}`,
        title: `Revisa si ${nombre} sí llegó a ${claseDe(r)} de las ${hora(inicioDe(r), r.venue.timezone)}`,
        message: PENDING_TEXT[args.reason],
        actionUrl: `reservations/${r.id}`,
        actionLabel: 'Ver reserva',
        priority: NotificationPriority.HIGH,
        metadata: { reservationId: r.id, reason: args.reason },
      },
      undefined,
      true,
    )
  } catch (e) {
    logger.error(`[no-show-notices] no se pudo avisar la revisión de ${args.reservationId}: ${mensaje(e)}`)
  } finally {
    revisionEnCurso.delete(args.reservationId)
  }
}

/** Avisa las correcciones que siguen sin avisar (el proceso murió o falló el correo). Devuelve cuántas quedaron avisadas. */
export async function flushPendingCorrectionNotices(now: Date): Promise<number> {
  // Lectura de entrada del tick: con reintento de conexión (`.claude/rules/cron-jobs.md`); los envíos, nunca.
  const leidas = await retry(
    () =>
      prisma.reservationNoShowCorrection.findMany({
        where: {
          noticeSentAt: null,
          createdAt: { gte: new Date(now.getTime() - FLUSH_VENTANA_MS), lte: new Date(now.getTime() - FLUSH_GRACIA_MS) },
        },
        select: { id: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: FLUSH_LECTURA,
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'no-show-notices.flush' },
  )
  if (leidas.length === 0) return 0
  const conCampanita = await prisma.notification.findMany({
    where: {
      type: NotificationType.RESERVATION_NEEDS_REVIEW,
      entityType: 'ReservationNoShowCorrection',
      entityId: { in: leidas.map(c => c.id) },
    },
    select: { entityId: true },
    take: leidas.length * MAX_DESTINATARIOS,
  })
  const pendientes = nuevasPrimero(leidas, new Set(conCampanita.map(n => n.entityId!))).slice(0, FLUSH_TOPE)

  let avisadas = 0
  for (const { id } of pendientes) {
    try {
      if (await avisarCorreccion(id)) avisadas++
    } catch (e) {
      logger.error(`[no-show-notices] barrido: falló la corrección ${id}: ${mensaje(e)}`)
    }
  }
  return avisadas
}

/**
 * Marca que el resumen de la clase ya les llegó a todos. Nunca lanza: sin la marca, el siguiente tick la escribe (todos
 * tienen ya su campanita) o, si alguien la borró en ese rato, se le reenvía.
 */
async function sellarResumen(cs: { id: string; venueId: string; venue: { organizationId: string } }): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        ...activityActorFields(ACTOR_AVISOS, cs.venue.organizationId),
        venueId: cs.venueId,
        action: RESUMEN_ENVIADO,
        entity: 'ClassSession',
        entityId: cs.id,
      },
    })
  } catch (e) {
    logger.error(`[no-show-notices] no se pudo marcar como enviado el resumen de la clase ${cs.id}: ${mensaje(e)}`)
  }
}

/**
 * Resumen por clase de quiénes quedaron «No asistió», con una liga por persona. Sale cuando la clase pasó su corte
 * (`startsAt + noShowGraceMin`) hace ≥ 5 min y ya no le quedan PENDING/CONFIRMED (el trabajo automático terminó con
 * ella), con las que SIGUEN en NO_SHOW. Una vez por clase: cuando les llegó a todos, la marca `RESUMEN_ENVIADO` en
 * ActivityLog; mientras tanto, una vez por (destinatario, clase) con la campanita `ClassSession`.
 * Devuelve cuántas clases quedaron avisadas a todos en este tick.
 */
export async function sendClassNoShowSummaries(now: Date): Promise<number> {
  const limite = new Date(now.getTime() - RESUMEN_ESPERA_MS)
  // Las más nuevas primero al LEER (que una cola de clases ya avisadas no tape a las nuevas); el lote se arma con
  // `nuevasPrimero`.
  const leidas = await retry(
    () =>
      prisma.classSession.findMany({
        where: {
          startsAt: { gte: new Date(now.getTime() - RESUMEN_VENTANA_MS), lte: limite },
          reservations: { some: { status: 'NO_SHOW' }, none: { status: { in: ['PENDING', 'CONFIRMED'] } } },
        },
        select: {
          id: true,
          venueId: true,
          startsAt: true,
          product: { select: { name: true } },
          venue: { select: { name: true, slug: true, timezone: true, organizationId: true } },
        },
        orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
        take: RESUMEN_LECTURA,
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'no-show-notices.summaries' },
  )
  if (leidas.length === 0) return 0

  // El corte de cada negocio (tolerancia), una lectura por negocio.
  const gracia = new Map<string, number>()
  const listas: typeof leidas = []
  for (const cs of leidas) {
    if (!gracia.has(cs.venueId)) gracia.set(cs.venueId, (await getReservationSettings(cs.venueId)).scheduling.noShowGraceMin ?? 0)
    if (cs.startsAt.getTime() + gracia.get(cs.venueId)! * MIN <= limite.getTime()) listas.push(cs)
  }
  if (listas.length === 0) return 0

  // Las ya avisadas a todos fuera, por su marca (el gerente puede borrar su campanita; esta marca, no). Una lectura acotada
  // a los ids del lote (índice `entity, entityId`); `groupBy` da una fila por clase aunque una marca saliera repetida.
  const selladas = await prisma.activityLog.groupBy({
    by: ['entityId'],
    where: { action: RESUMEN_ENVIADO, entity: 'ClassSession', entityId: { in: listas.map(cs => cs.id) } },
  })
  const yaSelladas = new Set(selladas.map(s => s.entityId))
  const porAvisar = listas.filter(cs => !yaSelladas.has(cs.id))
  if (porAvisar.length === 0) return 0

  // ponytail: mientras la entrega sea parcial (a alguien le sigue fallando el correo) no hay marca y se deduplica por la
  // campanita de cada quien: si alguien borra la suya en ese rato (≤ 24 h), se le reenvía. Si molesta, una marca por
  // destinatario.
  const yaTienen = await prisma.notification.findMany({
    where: {
      type: NotificationType.RESERVATION_NO_SHOW_SUMMARY,
      entityType: 'ClassSession',
      entityId: { in: porAvisar.map(cs => cs.id) },
    },
    select: { entityId: true, recipientId: true },
    take: porAvisar.length * MAX_DESTINATARIOS,
  })
  const avisados = new Set(yaTienen.map(n => `${n.entityId}:${n.recipientId}`))
  const conAlguna = new Set(yaTienen.map(n => n.entityId!))

  const porNegocio = new Map<string, Destinatario[]>()
  const trabajo: Array<{ cs: (typeof porAvisar)[number]; faltan: Destinatario[] }> = []
  for (const cs of nuevasPrimero(porAvisar, conAlguna)) {
    if (trabajo.length >= RESUMEN_TOPE) break
    if (!porNegocio.has(cs.venueId))
      porNegocio.set(cs.venueId, await destinatarios(cs.venueId, NotificationType.RESERVATION_NO_SHOW_SUMMARY))
    const faltan = porNegocio.get(cs.venueId)!.filter(d => !avisados.has(`${cs.id}:${d.staffId}`))
    if (faltan.length > 0) trabajo.push({ cs, faltan })
    // Todos tienen su campanita y no hay marca: el proceso murió entre la última y la marca. Se sella, sin reenviar.
    else if (conAlguna.has(cs.id)) await sellarResumen(cs)
  }
  if (trabajo.length === 0) return 0

  let avisadas = 0
  for (const { cs, faltan } of trabajo) {
    try {
      // Una lectura POR CLASE: con una sola para todas, una clase con muchas faltas se come el tope de las demás.
      const where = { classSessionId: cs.id, status: 'NO_SHOW' as const }
      const personas = await prisma.reservation.findMany({
        where,
        select: { id: true, guestName: true, customer: { select: { firstName: true, lastName: true } } },
        orderBy: [{ noShowAt: 'asc' }, { id: 'asc' }],
        take: RESUMEN_MAX_PERSONAS,
      })
      if (personas.length === 0) continue // alguien corrigió la falta antes del envío
      // Con el tope lleno puede haber más: el TOTAL sale de un conteo, y lo que no cabe se dice («y N más»), nunca se
      // presenta una lista cortada como si fuera completa.
      const total =
        personas.length < RESUMEN_MAX_PERSONAS ? personas.length : Math.max(personas.length, await prisma.reservation.count({ where }))
      const resto = total - personas.length
      const nombres = personas.map(r => ({ id: r.id, nombre: nombreCorto(r.customer, r.guestName) }))
      const lista = nombres.map(n => n.nombre).join(', ')
      const clase = `${cs.product.name} de las ${hora(cs.startsAt, cs.venue.timezone)}`
      const title = total === 1 ? `${nombres[0].nombre} no asistió a ${clase}` : `${total} personas no asistieron a ${clase}`
      const liga = (id: string) => `${FRONTEND_URL}/venues/${cs.venue.slug}/reservations/${id}`
      // La clase en el panel (la liga que ya entiende el calendario: `?clase=<id>`), relativa al negocio.
      const claseUrl = `reservations/calendar?clase=${encodeURIComponent(cs.id)}`
      const masPanel = `y ${resto} más: ábrelas en el panel`
      const ok = await entregar(
        {
          venueId: cs.venueId,
          venueSlug: cs.venue.slug,
          type: NotificationType.RESERVATION_NO_SHOW_SUMMARY,
          entityType: 'ClassSession',
          entityId: cs.id,
          subject: `${cs.venue.name}: ${title}`,
          title,
          // «Beto R.» ya trae su punto: no se le pone otro.
          message:
            resto > 0
              ? `${lista} ${masPanel}. Si alguien sí llegó, abre su reserva y toca «Sí llegó».`
              : `${lista}${lista.endsWith('.') ? '' : '.'} Si alguien sí llegó, abre su reserva y toca «Sí llegó».`,
          emailMessage:
            `Si alguien sí llegó, abre su reserva y toca «Sí llegó»:\n${nombres.map(n => `${n.nombre}: ${liga(n.id)}`).join('\n')}` +
            (resto > 0 ? `\n${masPanel}\n${FRONTEND_URL}/venues/${cs.venue.slug}/${claseUrl}` : ''),
          actionUrl: resto > 0 ? claseUrl : nombres.length === 1 ? `reservations/${nombres[0].id}` : 'reservations',
          actionLabel: resto > 0 ? 'Ver la clase' : nombres.length === 1 ? 'Ver reserva' : 'Ver reservaciones',
          priority: NotificationPriority.NORMAL,
          metadata: { classSessionId: cs.id, reservationIds: nombres.map(n => n.id), noShowsTotal: total },
        },
        faltan,
      )
      if (ok) {
        await sellarResumen(cs)
        avisadas++
      }
    } catch (e) {
      logger.error(`[no-show-notices] resumen de la clase ${cs.id}: ${mensaje(e)}`)
    }
  }
  return avisadas
}

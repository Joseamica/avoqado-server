// src/services/mobile/avisoDeVentaSinRed.ts
import { NotificationChannel, NotificationPriority, NotificationType, StaffRole } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * «Cobrar sin red» (S7): una venta que la terminal hizo sin red y que, al subir, llegó con problema. El dinero ya se cobró, así que
 * nunca se pierde en silencio: OWNER y ADMIN activos del negocio reciben un aviso en el panel y queda `VENTA_SIN_RED_<AVISO>` en la
 * bitácora.
 * - `RECHAZADA`: el servidor no la registró con una respuesta que la terminal da por DEFINITIVA (400, 404, 422, o un 409
 *   `IDEMPOTENCY_KEY_REUSED`); la venta sigue en la terminal como «con problema» y se puede registrar a mano.
 * - `REINTENTANDO`: el servidor todavía no la acepta (401, 403 y los demás 4xx que la terminal REINTENTA sola): se dice qué revisar
 *   (permiso, sesión) y NUNCA «regístrala a mano» (Codex servidor r1 #4: al devolver el permiso la cola la subiría otra vez).
 * - `PRECIO_CAMBIADO`: se registró, pero el total del servidor ya no es lo cobrado (precio visto no reconocido, saldo o sobrepago).
 * - `TURNO_CERRADO`: se registró sin turno porque el suyo ya se cerró (`SALE_SHIFT_CLOSED`); se concilia contra SU corte.
 *
 * Sólo para la cola de una terminal: `isOfflineReplay` y un token con serial de terminal (la cola de Android no lo trae).
 */
export type AvisoVentaSinRed = 'RECHAZADA' | 'REINTENTANDO' | 'PRECIO_CAMBIADO' | 'TURNO_CERRADO'

export interface DatosDelAviso {
  /** La llave de la venta (`externalId` de la orden = `idempotencyKey` del pago): con ella se deduplica. */
  externalId: string
  terminalSerial?: string
  montoCents?: number
  motivo?: string
  orderId?: string
  /** Quien cobró (el usuario del token), para la bitácora. */
  staffId?: string
}

const TANDA = 50
const ENTIDAD = 'VentaSinRed'
/**
 * Avisos en curso: la terminal reintenta sin esperar a que termine el aviso del intento anterior, y el dedupe de la base
 * (consulta-luego-escribe) no ve lo que todavía no se escribe. Medido contra Postgres: dos 403 seguidos daban 4 notificaciones.
 * ponytail: candado en memoria, basta con UNA instancia del servidor (hoy, sin Redis); con varias, `pg_advisory_xact_lock` por llave.
 */
const enCurso = new Set<string>()
const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })

// S3: el POS (ANDROID/iOS) no tiene serial de terminal: su venta apartada también avisa, como «Un aparato».
const deLaTerminal = (d: DatosDelAviso) => (d.terminalSerial ? `La terminal ${d.terminalSerial}` : 'Un aparato')
const porMonto = (d: DatosDelAviso) => (typeof d.montoCents === 'number' ? ` por ${MXN.format(d.montoCents / 100)}` : '')

const TEXTOS: Record<AvisoVentaSinRed, (d: DatosDelAviso) => { title: string; message: string; priority: NotificationPriority }> = {
  RECHAZADA: d => ({
    title: 'Una venta sin conexión no se pudo registrar',
    message: `${deLaTerminal(d)} cobró una venta${porMonto(d)} sin conexión y, al subirla, el sistema no la registró${d.motivo ? ` («${d.motivo}»)` : ''}. El dinero ya se cobró: la venta sigue guardada en la terminal como «con problema». Revísala con quien cobró y, si hace falta, regístrala a mano.`,
    priority: NotificationPriority.HIGH,
  }),
  REINTENTANDO: d => ({
    title: 'Una venta sin conexión todavía no se puede subir',
    message: `${deLaTerminal(d)} cobró una venta${porMonto(d)} sin conexión y el sistema todavía no la acepta${d.motivo ? ` («${d.motivo}»)` : ''}. El dinero ya se cobró y la terminal la sigue reintentando sola: no la registres a mano, se registraría dos veces. Revisa que quien cobró siga activo y con permiso para cobrar en este negocio, y que la sesión de la terminal siga abierta; en cuanto se corrija, la venta sube sola.`,
    priority: NotificationPriority.HIGH,
  }),
  PRECIO_CAMBIADO: d => ({
    title: 'Una venta sin conexión no cuadra con lo cobrado',
    message: `${deLaTerminal(d)} subió una venta${porMonto(d)} que hizo sin conexión, pero el total del sistema ya no es lo que se cobró${d.motivo ? `: ${d.motivo}` : ''}. Revisa la orden.`,
    priority: NotificationPriority.NORMAL,
  }),
  TURNO_CERRADO: d => ({
    title: 'Llegó una venta de un turno ya cerrado',
    message: `${deLaTerminal(d)} subió una venta${porMonto(d)} que hizo sin conexión en un turno que ya se cerró. No se sumó al turno abierto ni cambió el corte firmado: concíliala contra el corte de su turno.`,
    priority: NotificationPriority.HIGH,
  }),
}

/**
 * Avisa a OWNER y ADMIN activos, uno por persona, venta y aviso (como `notifyShopify`: tandas con cursor y dedupe con una consulta
 * agrupada), y anota la bitácora una sola vez por venta y aviso. Nunca lanza: lo llaman después de responder.
 *
 * ⚠️ LÍMITE DECLARADO: el dedupe de la base no es atómico. Dentro de un proceso lo cubre `enCurso`; dos instancias a la vez podrían
 * repetir un aviso. El daño es una repetición, nunca una pérdida.
 */
export async function avisarVentaSinRed(venueId: string, aviso: AvisoVentaSinRed, data: DatosDelAviso): Promise<void> {
  const clave = `${venueId}:${aviso}:${data.externalId}`
  // El intento en curso ya avisa; si fallara, el siguiente reintento de la terminal vuelve a intentarlo.
  if (enCurso.has(clave)) return
  enCurso.add(clave)
  try {
    await avisarContandoFallas(venueId, aviso, data)
  } catch (err) {
    logger.error(`[VENTA SIN RED] no se pudo avisar ${aviso} de ${data.externalId} al negocio ${venueId}: ${(err as Error).message}`)
  } finally {
    enCurso.delete(clave)
  }
}

/**
 * S3 «Efectivo sin red en el turno correcto» (Codex plan r3 #6 y r4 #3): el emisor DURABLE del aviso de una venta apartada, el que usa
 * el trabajador de efectos del cobro (`AVISO_TURNO_CERRADO`). A diferencia de `avisarVentaSinRed`, LANZA mientras no conste la
 * notificación de cada OWNER/ADMIN activo —o si otra ejecución tiene la llave en vuelo (`AVISO_EN_CURSO`)—, para que el efecto se
 * quede pendiente y se reintente; nunca queda «hecho» sin notificación. Un negocio que ya no existe no tiene a quién avisar: termina.
 */
export async function enviarAvisoDeVentaSinRed(venueId: string, aviso: AvisoVentaSinRed, data: DatosDelAviso): Promise<void> {
  const clave = `${venueId}:${aviso}:${data.externalId}`
  if (enCurso.has(clave)) throw new Error('AVISO_EN_CURSO')
  enCurso.add(clave)
  try {
    const fallas = await avisarContandoFallas(venueId, aviso, data)
    if (fallas > 0) throw new Error(`AVISO_INCOMPLETO: ${fallas} notificación(es) sin crear`)
  } finally {
    enCurso.delete(clave)
  }
}

/** El cuerpo común: bitácora una vez, una notificación por persona que falte. Devuelve cuántas no se pudieron crear. */
async function avisarContandoFallas(venueId: string, aviso: AvisoVentaSinRed, data: DatosDelAviso): Promise<number> {
  let fallas = 0
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { slug: true } })
  if (!venue) return 0
  const action = `VENTA_SIN_RED_${aviso}`
  const yaAnotada = await prisma.activityLog.findFirst({
    where: { venueId, action, entity: ENTIDAD, entityId: data.externalId },
    select: { id: true },
  })
  if (!yaAnotada) {
    await logAction({
      venueId,
      staffId: data.staffId ?? null,
      action,
      entity: ENTIDAD,
      entityId: data.externalId,
      data: {
        terminalSerial: data.terminalSerial ?? null,
        montoCents: data.montoCents ?? null,
        motivo: data.motivo ?? null,
        orderId: data.orderId ?? null,
      },
    })
  }

  // El envío carga correo, push y WhatsApp: se importa aquí para que los servicios de cobro no los arrastren al cargar.
  const { getNotificationPreferences, sendNotification } = await import('@/services/dashboard/notification.service')
  const llave = `${aviso}:${data.externalId}`
  const texto = TEXTOS[aviso](data)
  let cursor: string | undefined
  for (;;) {
    const tanda = await prisma.staffVenue.findMany({
      where: { venueId, active: true, role: { in: [StaffRole.OWNER, StaffRole.ADMIN] }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, staffId: true },
      orderBy: { id: 'asc' },
      take: TANDA,
    })
    if (tanda.length === 0) return fallas
    const ids = [...new Set(tanda.map(t => t.staffId))]
    const ya = await prisma.notification.groupBy({
      by: ['recipientId'],
      where: { venueId, type: NotificationType.ALERT, entityType: ENTIDAD, entityId: llave, recipientId: { in: ids } },
    })
    const avisados = new Set(ya.map(n => n.recipientId))
    for (const staffId of ids) {
      if (avisados.has(staffId)) continue
      try {
        const creada = await sendNotification({
          recipientId: staffId,
          venueId,
          type: NotificationType.ALERT,
          title: texto.title,
          message: texto.message,
          ...(data.orderId ? { actionUrl: `/venues/${venue.slug}/orders/${data.orderId}`, actionLabel: 'Ver la orden' } : {}),
          entityType: ENTIDAD,
          entityId: llave,
          priority: texto.priority,
          channels: [NotificationChannel.IN_APP],
          metadata: { aviso, ...data },
        })
        // 🔴 Codex r1 (código) #3: `sendNotification` devuelve `null` SIN crear la fila en dos casos. Si la persona apagó este tipo de
        // aviso, se respeta su decisión (cuenta como avisada); si sólo está en su horario de silencio, NO: queda pendiente y el
        // trabajador de efectos lo reintenta cuando termine.
        if (!creada && (await getNotificationPreferences(staffId, venueId, NotificationType.ALERT)).enabled) {
          fallas++
          logger.info(`[VENTA SIN RED] ${aviso} para ${staffId} pospuesto (horario de silencio)`)
        }
      } catch (err) {
        fallas++
        logger.error(`[VENTA SIN RED] no se pudo avisar ${aviso} a ${staffId}: ${(err as Error).message}`)
      }
    }
    if (tanda.length < TANDA) return fallas
    cursor = tanda[tanda.length - 1].id
  }
}

/**
 * 4xx que la terminal reintenta sola y que no merecen aviso (un conflicto pasajero, demasiadas peticiones). Un 5xx tampoco: la
 * venta aún puede registrarse en el siguiente intento, y avisar «rechazada» invitaría a registrarla a mano dos veces.
 */
const SIN_AVISO = new Set([409, 429])
/** Los que la terminal da por DEFINITIVOS (`SyncOutcome.kt`, `PERMANENT_HTTP_CODES`): sólo éstos dicen «regístrala a mano». */
const DEFINITIVOS = new Set([400, 404, 422])
/** Un 409 con esta llave ocupada por OTRA operación nunca se resuelve repitiendo la misma petición (Codex servidor r1 #7). */
const LLAVE_OCUPADA = 'IDEMPOTENCY_KEY_REUSED'

/**
 * Middleware de las puertas de la cola (crear orden y pagar de mobile, `/tpv/fast` y `/tpv/orders/:o`). Va DESPUÉS de autenticar y
 * ANTES de `checkPermission`, y se cuelga de `finish`: así también avisa del 403 del permiso y de los 400 que el controlador
 * devuelve directo o por el manejador de errores. Nunca cambia la respuesta: sólo la lee.
 */
export function avisarSiLaVentaDeLaColaFalla(req: Request, res: Response, next: NextFunction): void {
  const cuerpo = req.body ?? {}
  const serial = req.authContext?.terminalSerialNumber
  // Se toman aquí y no en `finish`: si el error sale del router hacia el manejador de errores, Express restaura `req.params`.
  const { venueId, orderId } = req.params
  // El cuerpo todavía no pasó por ningún validador: la llave se acota al largo de la columna de la orden.
  const externalId = [cuerpo.externalId, cuerpo.idempotencyKey, orderId].find(
    (v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 255,
  )
  // Sólo la cola de una terminal, y sólo hacia el negocio de su token: un token nunca hace avisar a un negocio ajeno.
  if (cuerpo.isOfflineReplay !== true || !serial || !venueId || venueId !== req.authContext?.venueId || !externalId) return next()

  let mensaje: string | undefined
  let codigo: unknown
  const json = res.json.bind(res)
  res.json = ((respuesta?: any) => {
    // Algunos mensajes repiten lo que mandó el cliente: se acota antes de llevarlo al aviso.
    if (typeof respuesta?.message === 'string') mensaje = respuesta.message.slice(0, 300)
    codigo = respuesta?.code
    return json(respuesta)
  }) as Response['json']

  res.on('finish', () => {
    const status = res.statusCode
    if (status < 400 || status >= 500) return
    const definitiva = DEFINITIVOS.has(status) || (status === 409 && codigo === LLAVE_OCUPADA)
    if (!definitiva && SIN_AVISO.has(status)) return
    void avisarVentaSinRed(venueId, definitiva ? 'RECHAZADA' : 'REINTENTANDO', {
      externalId,
      terminalSerial: serial,
      montoCents: typeof cuerpo.amount === 'number' ? cuerpo.amount : undefined,
      motivo: mensaje ? `${mensaje} (${status})` : `respuesta ${status}`,
      orderId,
      staffId: req.authContext?.userId,
    })
  })
  next()
}

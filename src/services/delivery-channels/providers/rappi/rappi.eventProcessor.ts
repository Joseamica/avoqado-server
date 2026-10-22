/**
 * Del aviso de Rappi a una venta aceptada, sin intervención humana.
 *
 * Es el espejo de `uber.eventProcessor.ts`, con las CUATRO diferencias que Rappi impone —
 * cada una está aquí porque hacer lo mismo que Uber sería un bug:
 *
 *  1. **No hay `fetchOrder`**: el pedido viene COMPLETO en el webhook. Ir a buscarlo sería
 *     una llamada de más contra la tasa de éxito del 98% que exigen.
 *  2. **El reloj es de 4–6 minutos**, no ~11.5 (su propia documentación se contradice: el
 *     ciclo de vida dice 6, el FAQ dice 4 — se asume el corto). El orden accept-primero
 *     importa todavía más que en Uber.
 *  3. **Aceptar exige `cookingTime`** — pero Rappi lo manda en el propio pedido, con su
 *     rango permitido. Se le devuelve el suyo, recortado.
 *  4. **Un programado NO es una venta**: sus montos vienen en CERO por diseño. Se registra
 *     el aviso y nada más; la venta nace cuando Rappi libera el `NEW_ORDER` real. (Uber sí
 *     ingiere sus programados porque SÍ manda los montos — la divergencia es de ellos.)
 */
import { DeliveryChannelStatus, DeliveryOrderEventStatus, DeliveryProvider, OrderAcceptanceMode, Prisma } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { cancelDeliveryOrder } from '../../core/cancelDeliveryOrder.service'
import { ingestDeliveryOrder } from '../../core/deliveryOrderIngestion.service'
import { cerrarEventoReclamado, reclamarEvento, renovarReclamo } from '../../core/deliveryWebhookEvent.service'
import { configComoObjeto, leerMenuEnRevision } from '../../core/llavesDelSistema'
import { rappiAdapter, RAPPI_EVENTS } from './rappi.adapter'
import {
  analizarHistorial,
  anotarAceptacion,
  leerEstado,
  leerRespuestaDelHistorial,
  type EventoDelHistorial,
  type EvidenciaDeAceptacion,
  type LecturaDelHistorial,
} from './rappi.estadoDelPedido'
import { tiempoDeCoccion, VariantePendienteError, type RappiOrderPayload } from './rappi.mapper'
import { leerEstadoAprovisionamiento, type ResultadoRappiTienda } from './rappi.selfOnboarding'
import { llaveDeAvisoDePedido } from './rappi.webhookIngress'

export type RappiProcessOutcome =
  | 'PROCESSED' // pedido aceptado en Rappi y convertido en venta
  | 'ALREADY_DONE' // reintento inofensivo
  | 'NOT_AN_ORDER' // evento informativo (repartidor, PING…)
  | 'ORPHANED' // llegó de una tienda sin vincular a ningún venue
  | 'CANCELLED' // Rappi canceló: dejó de ser venta y salió de cocina (o nunca llegó a serlo: CANCELADO_ANTES_DE_REGISTRAR)
  | 'SCHEDULED_NOTED' // programado registrado; la venta nace cuando lo liberen
  | 'MENU_VERDICT' // llegó la aprobación (o el rechazo) del menú
  | 'STORE_STATE' // la tienda cambió de estado del lado de Rappi (o llegó su aprovisionamiento)
  | 'IN_FLIGHT' // otro proceso tiene el evento reclamado (o se lo quitó a medias): no se toca, lo termina su dueño
  | 'FAILED'

export interface RappiProcessResult {
  outcome: RappiProcessOutcome
  orderId?: string
  accepted?: boolean
  error?: string
}

/**
 * Cuánto dura el reclamo del evento. Se renueva (`sigueSiendoMio`) antes de CADA paso que no se puede repetir: antes de leer
 * el historial de un canal deshabilitado, antes de aceptar, antes de leer el historial tras un 400 de «aceptar» y antes de
 * ingerir. Así sólo vence si el proceso murió o si un paso se colgó más de 45 s (cada llamada a Rappi ya trae su timeout de
 * 10 s). Escribir la marca de aceptación y cerrar NO renuevan: van condicionados al token, y con otro dueño no escriben nada.
 * El carril de Rappi del job (cada 30 s) retoma lo que quedó a medias: ≤ 45 s de vencimiento + ≤ 30 s del siguiente tick.
 */
export const RECLAMO_RAPPI_MS = 45_000

/**
 * 🔴 Los códigos con que un evento queda FAILED para siempre: la reconciliación ya no lo vuelve a tomar. Es una COPIA de
 * `TERMINAL_ERRORS` del job, que es la autoridad (una prueba de este procesador compara las dos listas). La usa la
 * cancelación en espera: un NEW_ORDER con uno de estos ya no se va a registrar, así que no hay a quién esperar.
 * OJO: `HISTORIAL_NO_LEIDO` NO va aquí: el historial no se pudo leer y el pedido todavía se puede registrar (se reintenta).
 */
export const ERRORES_TERMINALES: readonly string[] = [
  'ORPHANED',
  'PEDIDO_YA_NO_ACTIVO',
  'CHANNEL_DISABLED',
  'ACEPTACION_INCIERTA',
  'CANCELADO_ANTES_DE_REGISTRAR',
  'VARIANTE_BLOQUE_2B',
  'VARIANTE_SIN_CALIBRAR',
]

/**
 * 🔴 El historial del pedido en Rappi NO se pudo leer (timeout, 5xx, cuerpo ilegible). Es REINTENTABLE a propósito: no está en
 * `ERRORES_TERMINALES` ni en `TERMINAL_ERRORS` del job (Codex b1 #2).
 */
const HISTORIAL_NO_LEIDO = 'HISTORIAL_NO_LEIDO'

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * F6: el tipo de cancelación que manda Rappi en `event` (`canceled_with_charge`…), o «sin tipo». El sandbox no mandó
 * ninguna cancelación: se asume la forma del ORDER_OTHER_EVENT medido el 21-oct (`{"event": …, "order_id": …}`).
 */
function motivoDeCancelacion(payload: Prisma.JsonValue): string {
  const tipo = esObjeto(payload) && typeof payload.event === 'string' ? payload.event.trim().slice(0, 100) : ''
  return `cancelado por Rappi: ${tipo || 'sin tipo'}`
}

/**
 * El aviso de cancelación (`ORDER_EVENT_CANCEL`) ya guardado de un pedido, de su vínculo. Acotada: UNA fila y el `select`
 * mínimo (su `payload` trae el tipo para el motivo).
 *
 * 🔴 Por la llave ÚNICA `dedupKey`, la misma que el ingreso le pone a ese aviso (`llaveDeAvisoDePedido`), con la tienda DEL
 * EVENTO (`storeId`): es el valor que el ingreso usó al guardarlo. El `externalLocationId` del vínculo es el de HOY, y si el
 * vínculo cambió de tienda ya no es el de los avisos guardados: la búsqueda no los encontraría. Antes recorría los eventos
 * del vínculo por el prefijo `(provider, channelLinkId)` del índice compuesto, dos veces por pedido: crecía con la tienda.
 * El `channelLinkId` se conserva para encontrar exactamente lo mismo que antes (nunca el aviso de otro vínculo).
 */
function avisoDeCancelacion(externalOrderId: string, storeId: string | null, vinculoId: string) {
  return prisma.deliveryOrderEvent.findFirst({
    where: {
      dedupKey: llaveDeAvisoDePedido(RAPPI_EVENTS.ORDER_EVENT_CANCEL, storeId, externalOrderId),
      channelLinkId: vinculoId,
    },
    select: { id: true, payload: true },
  })
}

/**
 * El `NEW_ORDER` guardado de un pedido (del vínculo de la cancelación, si lo tiene). Acotada: UNA fila, el `select` mínimo.
 * Con vínculo, por la llave única con la tienda del evento (como `avisoDeCancelacion`). Sin vínculo se conserva la búsqueda
 * por el pedido: es rara (una cancelación de una tienda sin vincular) y la reconciliación no la vuelve a tomar (la deja
 * ORPHANED).
 */
function avisoDelPedido(externalOrderId: string, storeId: string | null, vinculoId: string | null) {
  return prisma.deliveryOrderEvent.findFirst({
    where: vinculoId
      ? { dedupKey: llaveDeAvisoDePedido(RAPPI_EVENTS.NEW_ORDER, storeId, externalOrderId), channelLinkId: vinculoId }
      : { provider: DeliveryProvider.RAPPI, eventType: RAPPI_EVENTS.NEW_ORDER, externalOrderId },
    select: { id: true, status: true, error: true },
  })
}

/**
 * La zona IANA del negocio, para leer la hora del pedido (`created_at` llega SIN zona y en la de la tienda). UNA lectura
 * acotada por la llave primaria, con el `select` mínimo: el vínculo no la trae. Si falla, el pedido entra igual con la de
 * México (`undefined` ⇒ default del mapeo): una hora corrida se corrige, un pedido perdido no.
 */
async function zonaDelNegocio(venueId: string, eventRowId: string): Promise<string | undefined> {
  try {
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
    return venue?.timezone ?? undefined
  } catch (err) {
    logger.warn('🛵 [Rappi] no se pudo leer la zona del negocio: la hora del pedido se lee en la de México', {
      eventRowId,
      venueId,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/** Dependencias inyectables: sin esto no se puede probar sin red. */
export interface RappiProcessDeps {
  aceptar?: (orderId: string, storeId: string, cookingTime: number) => Promise<{ ok: boolean; status: number; raw: string }>
  /** `confirmarTienda` de UNA tienda del lote. Fallan el evento un throw, un `DEFERRED` y un `SUBSCRIBE_FAILED`. */
  confirmar?: (r: ResultadoRappiTienda & { batchId?: string; operation?: 'PROVISION' | 'DEPROVISION' }) => Promise<string>
  /** El historial del pedido del lado de Rappi. `null` = no se pudo leer; `[]` = se leyó y no hay eventos. */
  historial?: (orderId: string) => Promise<EventoDelHistorial[] | null>
}

export async function processRappiEvent(eventRowId: string, deps: RappiProcessDeps = {}): Promise<RappiProcessResult> {
  const aceptar =
    deps.aceptar ??
    (async (orderId: string, storeId: string, cookingTime: number) => {
      // Perezoso: `rappi.client` lee `@/config/env` al cargarse (regla del repo).
      const { aceptarPedidoRappi } = await import('./rappi.client')
      return aceptarPedidoRappi(orderId, storeId, cookingTime)
    })
  const confirmar =
    deps.confirmar ??
    (async (r: ResultadoRappiTienda & { batchId?: string; operation?: 'PROVISION' | 'DEPROVISION' }) => {
      const [{ confirmarTienda }, { suscribirTiendaAEventos }] = await Promise.all([
        import('./rappi.provisioning'),
        import('./rappi.client'),
      ])
      return confirmarTienda(r, { suscribir: suscribirTiendaAEventos })
    })
  const historial =
    deps.historial ??
    (async (orderId: string) => {
      const { historialDelPedidoRappi } = await import('./rappi.client')
      return leerRespuestaDelHistorial(await historialDelPedidoRappi(orderId))
    })

  const previa = await prisma.deliveryOrderEvent.findUnique({
    where: { id: eventRowId },
    select: { status: true, orderId: true, eventType: true },
  })
  if (!previa) return { outcome: 'FAILED', error: `El evento ${eventRowId} no existe` }

  // Idempotente: el despacho es at-least-once, y el sondeo puede volver a topar el mismo pedido.
  if (previa.status === DeliveryOrderEventStatus.PROCESSED) {
    return { outcome: 'ALREADY_DONE', orderId: previa.orderId ?? undefined }
  }

  // 🔴 El reclamo, justo después del corte de PROCESSED: la petición viva y los carriles del job pueden tomar el MISMO
  // evento a la vez, y sin esto los dos aceptan y registran el pedido (dos comandas, la comida dos veces). Sin
  // reclamo no se toca nada — ni se cierra: el resultado lo escribe su dueño. Desde aquí, TODO cierre va con el token.
  const token = await reclamarEvento(eventRowId, RECLAMO_RAPPI_MS)
  if (!token) {
    logger.info('🛵 [Rappi] el evento lo tiene reclamado otro proceso: se deja', { eventRowId, eventType: previa.eventType })
    return { outcome: 'IN_FLIGHT' }
  }

  // 🔴 La fila se RELEE con el reclamo en la mano, y se decide con ESTA lectura: la marca de aceptación que dejó un dueño
  // anterior (aceptó, anotó y se le venció el reclamo antes de registrar) no está en la lectura de arriba, y decidir con
  // ella volvería a aceptar. Si la fila ya no existe no hay nada que cerrar.
  const evento = await prisma.deliveryOrderEvent.findUnique({
    where: { id: eventRowId },
    include: { channelLink: true },
  })
  if (!evento) return { outcome: 'FAILED', error: `El evento ${eventRowId} no existe` }

  const cerrar = (status: DeliveryOrderEventStatus, ...resto: [orderId?: string, error?: string]) =>
    cerrarEventoReclamado(eventRowId, token, status, ...resto)
  /** Renueva el reclamo antes de un paso que no se puede repetir; `false` = otro lo tomó y este proceso se detiene. */
  const sigueSiendoMio = async (antesDe: string, yaAceptado = false) => {
    if (await renovarReclamo(eventRowId, token, RECLAMO_RAPPI_MS)) return true
    const datos = { eventRowId, antesDe, accepted: yaAceptado }
    // Ya aceptado en Rappi, la venta la tiene que registrar el nuevo dueño: si no lo logra, hay dinero sin venta.
    if (yaAceptado) logger.error('🚨 [Rappi] pedido ACEPTADO y se perdió el reclamo antes de ingerir: lo registra su nuevo dueño', datos)
    else logger.warn('🛵 [Rappi] se perdió el reclamo del evento: lo sigue su nuevo dueño, este proceso se detiene', datos)
    return false
  }
  /** Lee el historial del pedido en Rappi. `null` = no se pudo leer (red, no-2xx, cuerpo ilegible): nunca lanza. */
  const lecturaDelHistorial = async (orderId: string | null): Promise<LecturaDelHistorial | null> => {
    if (!orderId) return null
    try {
      const eventos = await historial(orderId)
      return eventos ? analizarHistorial(eventos) : null
    } catch (err) {
      logger.warn('🛵 [Rappi] no se pudo leer el historial del pedido', {
        eventRowId,
        orderId,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }
  /**
   * 🔴 «No pude leer el historial» NO es «lo leí y no hay evidencia» (Codex b1 #2). Cerrar terminal perdía para siempre un
   * pedido que Rappi SÍ aceptó, aunque el historial volviera al minuto. Queda FAILED REINTENTABLE (`HISTORIAL_NO_LEIDO`): el
   * job lo retoma con su espera normal, y el reintento vuelve a preguntar —aceptar (400 otra vez) y el historial— sin
   * registrar nada a ciegas. Si el historial no vuelve nunca, el job agota sus intentos y lo deja POISON con su 🚨.
   */
  const cerrarSinHistorial = async (situacion: string, datos: Record<string, unknown>): Promise<RappiProcessResult> => {
    await cerrar(DeliveryOrderEventStatus.FAILED, undefined, HISTORIAL_NO_LEIDO)
    logger.error(
      `🚨 [Rappi] ${situacion} y el historial del pedido NO se pudo leer — no se registra a ciegas; queda FAILED y se reintenta`,
      {
        eventRowId,
        ...datos,
        historialLeido: false,
      },
    )
    return { outcome: 'FAILED', error: HISTORIAL_NO_LEIDO }
  }
  /**
   * La marca de aceptación, ANTES de registrar la venta. `null` = quedó escrita y se sigue. Si no, el resultado con que este
   * proceso se detiene: `IN_FLIGHT` si el reclamo ya es de otro (lo registra su dueño), o `FAILED` si la escritura lanzó — el
   * reintento recibe 400 al aceptar y lo recupera por el historial. Nunca se registra sin la marca.
   */
  const marcarAntesDeRegistrar = async (evidencia: EvidenciaDeAceptacion): Promise<RappiProcessResult | null> => {
    try {
      if (await anotarAceptacion(eventRowId, token, evidencia)) return null
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await cerrar(DeliveryOrderEventStatus.FAILED, undefined, `MARCA: ${msg.slice(0, 400)}`)
      logger.error('🚨 [Rappi] pedido ACEPTADO y la marca no se pudo escribir — queda FAILED; el reintento lo recupera por el historial', {
        eventRowId,
        evidencia,
        accepted: true,
        error: msg,
      })
      return { outcome: 'FAILED', accepted: true, error: msg }
    }
    logger.error('🚨 [Rappi] pedido ACEPTADO y la marca no se escribió (el reclamo ya es de otro): lo registra su nuevo dueño', {
      eventRowId,
      evidencia,
    })
    return { outcome: 'IN_FLIGHT', accepted: true }
  }

  // 🔴 El tipo viene de la FILA (que lo estampó la RUTA), no del payload: varios cuerpos de
  // Rappi no traen tipo, y dos de ellos son literalmente idénticos entre sí.
  const tipo = rappiAdapter.classifyEvent(evento.eventType)
  const identidad = rappiAdapter.extractIdentity(evento.payload)

  // ── Cancelación ─────────────────────────────────────────────────────────────────────
  // Antes del guard de vínculo, igual que Uber: una orden ya existente se cancela aunque el
  // canal se haya desconectado. `ORDER_NOT_FOUND` NO es error — para el programado cancelado
  // es lo NORMAL (nunca fue venta), y para un cancel adelantado el evento queda registrado.
  // El tipo de cancelación de Rappi viaja en el motivo (F6): al log y al `DELIVERY_ORDER_CANCELLED` de ActivityLog.
  if (tipo === 'CANCEL') {
    if (!identidad.orderId) {
      await cerrar(DeliveryOrderEventStatus.FAILED, undefined, 'CANCEL_SIN_ORDER_ID')
      return { outcome: 'FAILED', error: 'CANCEL_SIN_ORDER_ID' }
    }
    const r = await cancelDeliveryOrder(identidad.orderId, DeliveryProvider.RAPPI, motivoDeCancelacion(evento.payload))
    // 🔴 La venta todavía no existe, pero su NEW_ORDER sí y se puede registrar todavía (en vuelo, o FAILED reintentable):
    // dejar esta cancelación PROCESSED la perdía, y el pedido se registraba después como venta viva. Queda FAILED para que
    // el job la reintente con su espera normal; para entonces el NEW_ORDER ya la vio (la busca antes de aceptar y después
    // de registrar) o la venta ya existe y se cancela aquí. Con un NEW_ORDER terminado o que nunca llegó, nada que esperar.
    if (r.outcome === 'ORDER_NOT_FOUND' && evento.eventType === RAPPI_EVENTS.ORDER_EVENT_CANCEL) {
      const pedido = await avisoDelPedido(identidad.orderId, identidad.storeId, evento.channelLink?.id ?? null)
      const seRegistraTodavia =
        pedido && pedido.status !== DeliveryOrderEventStatus.PROCESSED && !(pedido.error && ERRORES_TERMINALES.includes(pedido.error))
      if (seRegistraTodavia) {
        await cerrar(DeliveryOrderEventStatus.FAILED, undefined, 'CANCELACION_EN_ESPERA')
        logger.warn('🛵 [Rappi] cancelación de un pedido que todavía se está registrando: queda en espera y el job la reintenta', {
          eventRowId,
          orderId: identidad.orderId,
          venueId: evento.venueId,
          eventoDelPedido: pedido.id,
          estadoDelPedido: pedido.status,
        })
        return { outcome: 'FAILED', error: 'CANCELACION_EN_ESPERA' }
      }
    }
    await cerrar(DeliveryOrderEventStatus.PROCESSED, r.orderId)
    return { outcome: 'CANCELLED', orderId: r.orderId }
  }

  // ── Programado: se ANOTA, no se vende ───────────────────────────────────────────────
  // 🔴 Sus montos vienen en cero POR DISEÑO (documentado). Ingerirlo escribiría una venta de
  // $0 marcada como pagada — el bug que ya ocurrió una vez con Uber. La venta real llega como
  // `NEW_ORDER` cuando Rappi libera el pedido; este evento sólo sirve de aviso a cocina.
  if (tipo === 'SCHEDULED_ORDER') {
    await cerrar(DeliveryOrderEventStatus.PROCESSED)
    logger.info('📅 [Rappi] pedido PROGRAMADO anotado — la venta nace cuando lo liberen', {
      eventRowId,
      orderId: identidad.orderId,
      venueId: evento.venueId,
    })
    return { outcome: 'SCHEDULED_NOTED', orderId: identidad.orderId ?? undefined }
  }

  // ── El veredicto del menú ───────────────────────────────────────────────────────────
  // 🔴 En Rappi el 200 del POST de menú significa "en revisión". ESTO es lo que significa
  // publicado (`MENU_APPROVED`) o rechazado (`MENU_REJECTED` — que viene SIN motivo, así que
  // lo único honesto es gritar y apuntar a la validación previa de `rappi.menuMapper`).
  if (tipo === 'MENU_REFRESH') {
    if (!evento.channelLink) {
      await cerrar(DeliveryOrderEventStatus.FAILED, undefined, 'SIN_VINCULO')
      return { outcome: 'ORPHANED' }
    }

    const aprobado = evento.eventType === RAPPI_EVENTS.MENU_APPROVED
    const linkId = evento.channelLink.id
    // 🔴 `config` se relee con la fila BLOQUEADA, no de la copia que trajo el evento: escribir esa copia
    // vieja borraba lo que otro escritor guardó mientras tanto (la reclamación del aprovisionamiento).
    // La pendiente es `menuEnRevision`: la escribe el sincronizador ANTES del POST (Tarea 15). La regla de la hora de firma
    // y el cierre del evento en la misma transacción llegan con la Tarea 16.
    const huellaPendiente = await prisma.$transaction(async tx => {
      const [fila] = await tx.$queryRaw<Array<{ config: Prisma.JsonValue }>>`
        SELECT "config" FROM "DeliveryChannelLink" WHERE "id" = ${linkId} FOR UPDATE`
      const config = configComoObjeto(fila?.config) as Prisma.JsonObject
      const huella = leerMenuEnRevision(config)?.huella ?? null
      if (aprobado) {
        await tx.deliveryChannelLink.update({
          where: { id: linkId },
          // La huella se sella AQUÍ — no al publicar. Si no había pendiente (publicación manual, o de antes de
          // este mecanismo), al menos queda la fecha. Aprobado, un rechazo anterior deja de ser lo vigente.
          data: {
            lastMenuSyncAt: new Date(),
            ...(huella ? { lastMenuHash: huella, config: { ...config, menuEnRevision: null, menuRechazado: null } } : {}),
          },
        })
      } else if (huella) {
        // El rechazo la limpia y la anota como rechazada: sin esto el sincronizador republicaba el mismo menú cada 5 min.
        await tx.deliveryChannelLink.update({
          where: { id: linkId },
          data: { config: { ...config, menuEnRevision: null, menuRechazado: { huella, en: new Date().toISOString() } } },
        })
      }
      return huella
    })

    if (aprobado) {
      logger.info('📋 [Rappi] menú APROBADO — ahora sí está publicado', {
        eventRowId,
        linkId: evento.channelLink.id,
        venueId: evento.venueId,
        selladoConHuella: Boolean(huellaPendiente),
      })
    } else {
      // Sin huella sellada, `menuSyncStatusOf` seguirá diciendo NUNCA_PUBLICADO/desfasado —
      // que es la verdad, y es lo que hace visible el problema en el dashboard y el MCP.
      logger.error('🚨 [Rappi] menú RECHAZADO — y Rappi NO dice por qué. Revisar contra las reglas de rappi.menuMapper', {
        eventRowId,
        linkId: evento.channelLink.id,
        venueId: evento.venueId,
      })
    }

    await cerrar(DeliveryOrderEventStatus.PROCESSED)
    return { outcome: 'MENU_VERDICT' }
  }

  // ── Estado de la tienda del lado de Rappi ───────────────────────────────────────────
  if (tipo === 'STORE_STATE') {
    // El resultado del aprovisionamiento: su cuerpo no trae `store_id` de primer nivel, así que
    // nunca hay vínculo — cada tienda la resuelve `confirmarTienda`, que sólo PROMUEVE un vínculo
    // nuestro y lo prueba con el lote. 🔴 El `batchId` vive arriba, no en cada resultado: sin
    // pasarlo, toda confirmación sale IGNORED. IGNORED no falla el evento. Un throw, un DEFERRED
    // (llegó antes de que guardáramos el lote: Rappi no lo reenvía) o un SUBSCRIBE_FAILED (Rappi ya
    // dijo ACTIVE y falta nuestra suscripción: no puede depender de que el dueño recargue la página)
    // lo dejan FAILED para que la reconciliación lo reintente — seguro: la confirmación es idempotente.
    if (evento.eventType === RAPPI_EVENTS.STORE_PROVISIONING_STATUS) {
      // La operación también viaja: un DEPROVISION de Rappi da de baja una tienda ya conectada.
      const { batchId, operation, results } = leerEstadoAprovisionamiento(evento.payload)
      const pendientes: string[] = []
      try {
        for (const r of results) {
          const c = await confirmar({ ...r, ...(batchId ? { batchId } : {}), ...(operation ? { operation } : {}) })
          if (c === 'DEFERRED' || c === 'SUBSCRIBE_FAILED') pendientes.push(c)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await cerrar(DeliveryOrderEventStatus.FAILED, undefined, `PROVISIONING: ${msg.slice(0, 400)}`)
        logger.error('🚨 [Rappi] confirmar el aprovisionamiento lanzó — queda FAILED para reprocesar', { eventRowId, batchId, error: msg })
        return { outcome: 'FAILED', error: msg }
      }
      if (pendientes.length) {
        const error = pendientes.includes('DEFERRED') ? 'PROVISIONING_DEFERRED' : 'PROVISIONING_SUBSCRIBE_FAILED'
        await cerrar(DeliveryOrderEventStatus.FAILED, undefined, error)
        logger.warn('🛵 [Rappi] aprovisionamiento con tiendas por reintentar (sin lote guardado o sin suscribir) — queda FAILED', {
          eventRowId,
          batchId,
          pendientes,
        })
        return { outcome: 'FAILED', error }
      }
      await cerrar(DeliveryOrderEventStatus.PROCESSED)
      return { outcome: 'STORE_STATE' }
    }
    if (evento.eventType === RAPPI_EVENTS.STORE_CONNECTIVITY && evento.channelLink) {
      const cuerpo = evento.payload as { enabled?: boolean; message?: string }
      if (cuerpo.enabled === false) {
        // Rappi apagó la tienda de SU lado. Se refleja para no repetir el canal muerto de
        // "La Ribera" (figuraba ACTIVE con el acceso revocado). El sentido contrario NO se
        // automatiza: si está PAUSED puede ser la pausa del dueño, y reactivarla sola
        // reabriría una tienda que él cerró a propósito.
        // 🔴 SÓLO ACTIVE → PAUSED, con el filtro EN el UPDATE: un PENDING pausado se saltaba la
        // confirmación del aprovisionamiento, y un DISABLED pausado eludía el guard de pedidos.
        const { count } = await prisma.deliveryChannelLink.updateMany({
          where: { id: evento.channelLink.id, status: DeliveryChannelStatus.ACTIVE },
          data: { status: DeliveryChannelStatus.PAUSED },
        })
        const datos = { eventRowId, linkId: evento.channelLink.id, venueId: evento.venueId, mensaje: cuerpo.message }
        if (count) logger.error('🚨 [Rappi] la tienda quedó DESHABILITADA del lado de Rappi', datos)
        else
          logger.warn('🏪 [Rappi] Rappi apagó una tienda que no estaba ACTIVE: no se toca', { ...datos, status: evento.channelLink.status })
      } else {
        logger.info('🏪 [Rappi] la tienda cambió de estado del lado del proveedor', {
          eventRowId,
          linkId: evento.channelLink.id,
          enabled: cuerpo.enabled,
        })
      }
    }
    await cerrar(DeliveryOrderEventStatus.PROCESSED)
    return { outcome: 'STORE_STATE' }
  }

  // ── Eventos informativos ────────────────────────────────────────────────────────────
  // En Rappi, `ORDER_OTHER_EVENT` es el CICLO DE VIDA DEL REPARTIDOR (asignado, llegó, ETA),
  // no un cambio del pedido por el cliente como en Uber. Información útil, cero mutación.
  if (tipo === 'FULFILLMENT_CHANGED' || tipo === 'IGNORED') {
    await cerrar(DeliveryOrderEventStatus.PROCESSED)
    return { outcome: 'NOT_AN_ORDER' }
  }

  // ── Pedido nuevo ────────────────────────────────────────────────────────────────────
  if (tipo !== 'NEW_ORDER') {
    await cerrar(DeliveryOrderEventStatus.PROCESSED)
    return { outcome: 'NOT_AN_ORDER' }
  }

  if (!evento.channelLink) {
    // La tienda no está vinculada a ningún venue. El evento queda FAILED y visible: hay un
    // PEDIDO REAL de un cliente en él, y enterrarlo sería perderle la comida a alguien.
    await cerrar(DeliveryOrderEventStatus.FAILED, undefined, 'TIENDA_SIN_VINCULO')
    logger.error('🚨 [Rappi] llegó un pedido de una tienda SIN VINCULAR', { eventRowId, storeId: identidad.storeId })
    return { outcome: 'ORPHANED' }
  }

  // 🔴 Lo que Rappi YA hizo con el pedido, de la fila releída tras el reclamo. Con la marca, Rappi ya lo aceptó (un intento
  // anterior vio su sí) y NO se vuelve a aceptar: contestaría 400.
  const estado = leerEstado(evento.resourcePayload)
  /** Rappi lo aceptó según su historial y la marca todavía no está (se escribe antes de registrar). */
  let aceptadoSegunHistorial = false

  // 🔴 ¿Rappi ya avisó que lo canceló? No ordena sus webhooks: el ORDER_EVENT_CANCEL puede llegar ANTES que este pedido, o
  // entre dos intentos. Se mira con el reclamo en la mano y la fila releída, ANTES de aceptar y de cualquier otra decisión
  // (también la del canal deshabilitado): un pedido cancelado ni se acepta ni se registra.
  if (identidad.orderId) {
    const aviso = await avisoDeCancelacion(identidad.orderId, identidad.storeId, evento.channelLink.id)
    if (aviso) {
      const motivo = motivoDeCancelacion(aviso.payload)
      const datos = {
        eventRowId,
        orderId: identidad.orderId,
        venueId: evento.venueId,
        linkId: evento.channelLink.id,
        avisoDeCancelacion: aviso.id,
        motivo,
      }
      if (estado.aceptacion) {
        // Un intento anterior ya vio el sí de Rappi (la marca) y pudo dejar la venta registrada antes de morir: se retira.
        const r = await cancelDeliveryOrder(identidad.orderId, DeliveryProvider.RAPPI, motivo)
        if (r.orderId) {
          await cerrar(DeliveryOrderEventStatus.PROCESSED, r.orderId)
          return { outcome: 'CANCELLED', orderId: r.orderId, accepted: true }
        }
        await cerrar(DeliveryOrderEventStatus.FAILED, undefined, 'CANCELADO_ANTES_DE_REGISTRAR')
        // Como «taken y después cancelado» en el historial: Rappi lo tenía aceptado a nuestro nombre y nunca fue venta.
        logger.error(
          '🚨 [Rappi] Rappi canceló un pedido que ya había ACEPTADO y que nunca se registró — no se registra; revisar con Rappi',
          datos,
        )
        return { outcome: 'CANCELLED', accepted: true, error: 'CANCELADO_ANTES_DE_REGISTRAR' }
      }
      await cerrar(DeliveryOrderEventStatus.FAILED, undefined, 'CANCELADO_ANTES_DE_REGISTRAR')
      logger.warn('🛵 [Rappi] el pedido llegó con su cancelación ya guardada: ni se acepta ni se registra', datos)
      return { outcome: 'CANCELLED', error: 'CANCELADO_ANTES_DE_REGISTRAR' }
    }
  }

  // 🔴 Un canal DESHABILITADO no toma pedidos nuevos: ni se acepta ni se registra (Rappi lo
  // cancela solo al vencer su reloj). Las cancelaciones sí pasan — van arriba, antes del guard.
  // SALVO que Rappi ya lo haya aceptado (la marca, o su historial, leído UNA vez): el cliente ya pagó y el pedido es nuestro,
  // así que se registra igual y se grita, para que alguien lo prepare o lo resuelva con Rappi. 🔴 Un historial que NO se pudo
  // leer no decide nada (Codex b1 #2): el pedido pudo quedar aceptado antes de que apagaran el canal, y cerrarlo
  // CHANNEL_DISABLED (terminal) lo perdía. Queda HISTORIAL_NO_LEIDO y se reintenta.
  if (evento.channelLink.status === DeliveryChannelStatus.DISABLED) {
    let lectura: LecturaDelHistorial | null = null
    // Sin id del pedido no hay historial que pedir (y reintentarlo no cambiaría nada): CHANNEL_DISABLED como siempre.
    if (!estado.aceptacion && identidad.orderId) {
      if (!(await sigueSiendoMio('leer el historial'))) return { outcome: 'IN_FLIGHT' }
      lectura = await lecturaDelHistorial(identidad.orderId)
      if (!lectura) {
        return cerrarSinHistorial('llegó un pedido a un canal DESHABILITADO', {
          orderId: identidad.orderId,
          venueId: evento.venueId,
          linkId: evento.channelLink.id,
        })
      }
      aceptadoSegunHistorial = lectura.veredicto === 'ACEPTADO'
    }
    if (!estado.aceptacion && !aceptadoSegunHistorial) {
      await cerrar(DeliveryOrderEventStatus.FAILED, undefined, 'CHANNEL_DISABLED')
      logger.error('🚨 [Rappi] llegó un pedido a un canal DESHABILITADO — no se aceptó ni se registró', {
        eventRowId,
        linkId: evento.channelLink.id,
        venueId: evento.venueId,
        orderId: identidad.orderId,
        // `false` sólo si el pedido no trae id (no hubo a quién preguntar): un historial caído ya no llega aquí.
        historialLeido: lectura !== null,
        eventosDelHistorial: lectura?.nombres ?? null,
      })
      return { outcome: 'FAILED', error: 'CHANNEL_DISABLED' }
    }
    logger.error('🚨 [Rappi] pedido a un canal DESHABILITADO que Rappi YA aceptó — se registra igual (el cliente ya pagó)', {
      eventRowId,
      linkId: evento.channelLink.id,
      venueId: evento.venueId,
      orderId: identidad.orderId,
      evidencia: estado.aceptacion?.evidencia ?? 'HISTORIAL_TAKEN',
    })
  }
  const yaAceptado = Boolean(estado.aceptacion) || aceptadoSegunHistorial

  // Traducir ANTES de aceptar: si el dinero no cuadra (la red contra el error de unidades),
  // NO se acepta un pedido que no podemos registrar — lanza, queda FAILED, y se revisa.
  // La hora del pedido llega sin zona y en la de la tienda: se lee en la del negocio.
  const zonaHoraria = await zonaDelNegocio(evento.channelLink.venueId, eventRowId)
  let normalizado
  try {
    normalizado = rappiAdapter.normalizeOrder(evento.payload, { zonaHoraria })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 🔴 Una variante que esta fase no registra (efectivo con repartidor propio o para recoger: el bloque 2b; o una sin
    // calibrar) queda FAILED con su código EXACTO: el job lo reconoce como terminal y no la vuelve a tomar —reintentarla no
    // cambia nada—. No se acepta: Rappi la cancela sola al vencer su reloj. Una persona tiene que enterarse.
    if (err instanceof VariantePendienteError) {
      await cerrar(DeliveryOrderEventStatus.FAILED, undefined, err.codigo)
      const datos = { eventRowId, orderId: identidad.orderId, venueId: evento.venueId, codigo: err.codigo, motivo: msg }
      if (yaAceptado)
        logger.error('🚨 [Rappi] pedido YA ACEPTADO en Rappi con una variante pendiente — no se registra; reconciliar a mano', {
          ...datos,
          accepted: true,
        })
      else logger.error('🚨 [Rappi] pedido con una variante pendiente — no se aceptó ni se registra (Rappi lo cancela solo)', datos)
      return { outcome: 'FAILED', error: err.codigo, ...(yaAceptado ? { accepted: true } : {}) }
    }
    await cerrar(DeliveryOrderEventStatus.FAILED, undefined, msg.slice(0, 500))
    if (yaAceptado)
      logger.error('🚨 [Rappi] pedido YA ACEPTADO en Rappi que NO se pudo traducir — reconciliar a mano', { eventRowId, error: msg })
    else logger.error('🚨 [Rappi] el pedido NO se pudo traducir — no se aceptó', { eventRowId, error: msg })
    return { outcome: 'FAILED', error: msg, ...(yaAceptado ? { accepted: true } : {}) }
  }

  // 🔴 ACEPTAR PRIMERO, con el reloj de 4–6 min corriendo — SIEMPRE, sin mirar el modo del vínculo.
  // Rappi no admite modo manual: cancela solo el pedido que no se acepta en ese plazo, así que una
  // cocina que «decide desde el POS» lo dejaría vencer. Un vínculo que haya quedado en MANUAL de antes
  // (la migración los pasa a AUTO, pero un despliegue a medias no debe costar pedidos) se trata como AUTO.
  // El orden es el mismo que Uber y por la misma razón: lo que no se puede recuperar es el plazo. Si
  // la ingesta falla después, el evento queda FAILED para reconciliar; al revés, un pedido
  // perfectamente ingerido se cancela solo.
  // 🔴 Y la marca de aceptación va ANTES de registrar: si el proceso muere después del sí de Rappi, el reintento sabe que
  // el pedido ya es nuestro (con la marca, o con el historial si murió antes de escribirla) y lo registra UNA vez.
  if (estado.aceptacion) {
    // Rappi ya dijo que sí en un intento anterior: se registra sin volver a aceptar.
  } else if (aceptadoSegunHistorial) {
    const detenido = await marcarAntesDeRegistrar('HISTORIAL_TAKEN')
    if (detenido) return detenido
  } else {
    const detail = (evento.payload as RappiOrderPayload).order_detail ?? {}
    const storeId = identidad.storeId ?? evento.channelLink.externalLocationId
    if (!(await sigueSiendoMio('aceptar'))) return { outcome: 'IN_FLIGHT' }
    let r
    try {
      r = await aceptar(normalizado.externalId, storeId, tiempoDeCoccion(detail))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await cerrar(DeliveryOrderEventStatus.FAILED, undefined, `ACCEPT: ${msg.slice(0, 400)}`)
      logger.error('🚨 [Rappi] aceptar el pedido lanzó — queda FAILED para reconciliar', {
        eventRowId,
        orderId: normalizado.externalId,
        error: msg,
      })
      return { outcome: 'FAILED', accepted: false, error: msg }
    }
    if (r.ok) {
      const detenido = await marcarAntesDeRegistrar('HTTP_2XX')
      if (detenido) return detenido
    } else if (r.status === 400) {
      // 🔴 Un 400 puede ser «ya lo aceptaste» (el proceso murió entre el sí de Rappi y la marca) o «ya no está activo» (venció
      // o se canceló). Sólo el historial de Rappi lo distingue, y sin un historial que lo diga NO se registra: sería a ciegas.
      // Pero «no se pudo leer» (timeout, 5xx) no es «se leyó y no lo dice»: lo primero se reintenta, lo segundo es terminal.
      if (!(await sigueSiendoMio('leer el historial'))) return { outcome: 'IN_FLIGHT' }
      const lectura = await lecturaDelHistorial(normalizado.externalId)
      if (!lectura) {
        return cerrarSinHistorial('aceptar contestó 400', {
          orderId: normalizado.externalId,
          venueId: evento.venueId,
          storeId,
          linkId: evento.channelLink.id,
          respuesta: r.raw.slice(0, 300),
        })
      }
      // Los NOMBRES del historial van en estos logs: así se ajusta la expresión con lo que Rappi de verdad manda (M5).
      if (lectura.veredicto === 'YA_NO_ACTIVO') {
        await cerrar(DeliveryOrderEventStatus.FAILED, undefined, 'PEDIDO_YA_NO_ACTIVO')
        const datos = { eventRowId, orderId: normalizado.externalId, venueId: evento.venueId, eventosDelHistorial: lectura.nombres }
        // Con `taken` Y un cierre, Rappi lo tuvo ACEPTADO a nuestro nombre y después lo cerró, y aquí nunca fue venta: lo
        // revisa una persona. Sin `taken` es lo normal de un pedido que nadie aceptó a tiempo.
        if (lectura.traeAceptacion)
          logger.error(
            '🚨 [Rappi] aceptar contestó 400: el pedido no está activo y Rappi lo había ACEPTADO antes (taken y después un cierre) — no se registra; revisar con Rappi',
            datos,
          )
        else
          logger.warn('🛵 [Rappi] aceptar contestó 400 y el pedido ya no está activo en Rappi (cancelado o vencido): no se registra', datos)
        return { outcome: 'FAILED', accepted: false, error: 'PEDIDO_YA_NO_ACTIVO' }
      }
      if (lectura.veredicto !== 'ACEPTADO') {
        // Se LEYÓ y no hay evidencia de aceptación (vacío, o sólo eventos del repartidor): reintentar no la va a inventar.
        await cerrar(DeliveryOrderEventStatus.FAILED, undefined, 'ACEPTACION_INCIERTA')
        logger.error('🚨 [Rappi] aceptar contestó 400 y el historial no dice si Rappi lo aceptó — NO se registra; revisar con Rappi', {
          eventRowId,
          orderId: normalizado.externalId,
          venueId: evento.venueId,
          storeId,
          linkId: evento.channelLink.id,
          historialLeido: true,
          eventosDelHistorial: lectura.nombres,
          respuesta: r.raw.slice(0, 300),
        })
        return { outcome: 'FAILED', error: 'ACEPTACION_INCIERTA' }
      }
      logger.warn('🛵 [Rappi] aceptar contestó 400 pero el historial dice que Rappi YA lo aceptó: se registra una vez', {
        eventRowId,
        orderId: normalizado.externalId,
      })
      const detenido = await marcarAntesDeRegistrar('HISTORIAL_TAKEN')
      if (detenido) return detenido
    } else {
      await cerrar(DeliveryOrderEventStatus.FAILED, undefined, `ACCEPT_${r.status}: ${r.raw.slice(0, 300)}`)
      logger.error('🚨 [Rappi] no se pudo ACEPTAR el pedido — el reloj lo va a cancelar', {
        eventRowId,
        orderId: normalizado.externalId,
        status: r.status,
      })
      return { outcome: 'FAILED', error: `ACCEPT_${r.status}` }
    }
  }

  if (!(await sigueSiendoMio('ingerir', true))) return { outcome: 'IN_FLIGHT', accepted: true }
  let ingesta: Awaited<ReturnType<typeof ingestDeliveryOrder>>
  try {
    // 🔴 La ingesta decide PENDING/CONFIRMED y el ticket de cocina según el modo del vínculo que recibe.
    // Como el pedido YA se aceptó en Rappi, se le entrega el vínculo en AUTO aunque la fila diga otra cosa.
    ingesta = await ingestDeliveryOrder(normalizado, { ...evento.channelLink, orderAcceptanceMode: OrderAcceptanceMode.AUTO })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // El pedido ya se aceptó: el dinero del cliente está comprometido y la venta NO quedó
    // registrada: FAILED visible para reconciliar con el comercio, jamás silencio.
    await cerrar(DeliveryOrderEventStatus.FAILED, undefined, `INGEST: ${msg.slice(0, 400)}`)
    logger.error('🚨 [Rappi] pedido ACEPTADO pero la ingesta falló — reconciliar a mano', {
      eventRowId,
      orderId: normalizado.externalId,
      accepted: true,
      error: msg,
    })
    return { outcome: 'FAILED', error: msg, accepted: true }
  }
  const orderId = ingesta.order.id

  // 🔴 La cancelación que llegó MIENTRAS se aceptaba y se registraba: la búsqueda de antes de aceptar no la vio, y ella misma
  // no encontró la venta (aún no existía) y quedó esperando. Se busca otra vez, ya con la venta creada, y se cancela AQUÍ:
  // `cancelDeliveryOrder` la deja CANCELLED y retira la comanda que la ingesta acaba de crear. No depende del nombre del
  // evento en el historial: un pedido aceptado y cancelado con un nombre que `leerHistorial` no conoce también cae aquí.
  let canceladaTrasRegistrar = false
  try {
    const aviso = await avisoDeCancelacion(normalizado.externalId, identidad.storeId, evento.channelLink.id)
    if (aviso) {
      const motivo = motivoDeCancelacion(aviso.payload)
      const r = await cancelDeliveryOrder(normalizado.externalId, DeliveryProvider.RAPPI, motivo)
      // La venta se acaba de registrar: si la cancelación no la encuentra, algo no cuadra y no se da por cancelada (el
      // catch la deja FAILED reintentable). ALREADY_CANCELLED sí es cancelada, pero la canceló otro: el log no dice «se canceló».
      if (r.outcome === 'ORDER_NOT_FOUND') throw new Error('la cancelación no encontró la venta que se acaba de registrar')
      canceladaTrasRegistrar = true
      logger.warn(
        r.outcome === 'CANCELLED'
          ? '🛵 [Rappi] la cancelación de Rappi llegó mientras se registraba el pedido: se canceló al terminar de registrarlo'
          : '🛵 [Rappi] la cancelación de Rappi llegó mientras se registraba el pedido: la venta ya estaba cancelada (la canceló otro proceso)',
        { eventRowId, orderId, venueId: evento.venueId, avisoDeCancelacion: aviso.id, motivo, resultado: r.outcome },
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // La venta quedó registrada y su cancelación no se pudo revisar: FAILED reintentable. El reintento no vuelve a aceptar
    // (está la marca), re-ingiere sin duplicar y vuelve a buscar la cancelación.
    await cerrar(DeliveryOrderEventStatus.FAILED, orderId, `CANCELAR_TRAS_REGISTRAR: ${msg.slice(0, 400)}`)
    logger.error('🚨 [Rappi] pedido registrado y no se pudo revisar su cancelación — queda FAILED para reintentar', {
      eventRowId,
      orderId,
      venueId: evento.venueId,
      accepted: true,
      error: msg,
    })
    return { outcome: 'FAILED', orderId, accepted: true, error: `CANCELAR_TRAS_REGISTRAR: ${msg}` }
  }

  // 🔴 La comanda nunca se pierde en silencio. La ingesta guarda la venta aunque la comanda falle (perder la venta sería
  // peor), y sólo lo dice en el log: cerrar PROCESSED aquí dejaba un pedido aceptado y cobrado que la cocina nunca ve. Queda
  // FAILED REINTENTABLE (no está en `ERRORES_TERMINALES`): el job lo retoma con su espera normal, el reintento no vuelve a
  // aceptar (está la marca) y la ingesta repone la comanda que falta. Una venta cancelada (por la ingesta, bajo el candado
  // de la orden, o aquí arriba) no necesita comanda; un programado tampoco todavía.
  const cancelada = canceladaTrasRegistrar || ingesta.cancelada
  if (!ingesta.hayComanda && !cancelada && !normalizado.scheduledFor) {
    await cerrar(DeliveryOrderEventStatus.FAILED, orderId, 'COMANDA_NO_CREADA')
    logger.error('🚨 [Rappi] pedido ACEPTADO y registrado, pero la comanda NO llegó a la cocina — queda FAILED y se reintenta', {
      eventRowId,
      orderId,
      venueId: evento.venueId,
      linkId: evento.channelLink.id,
      accepted: true,
    })
    return { outcome: 'FAILED', orderId, accepted: true, error: 'COMANDA_NO_CREADA' }
  }
  await cerrar(DeliveryOrderEventStatus.PROCESSED, orderId)
  return { outcome: cancelada ? 'CANCELLED' : 'PROCESSED', orderId, accepted: true }
}

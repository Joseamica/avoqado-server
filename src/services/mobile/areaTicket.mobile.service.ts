/**
 * Vales por área (AREA_TICKETS) — cuenta compartida entre áreas emisoras.
 *
 * Spec CONGELADO: `avoqado-android/docs/superpowers/specs/2026-07-28-vales-por-area-y-bascula-design.md`
 * (§1 flujo · §5 server · §6 contrato de API · §9 alcance semana 1 · §10 pruebas)
 *
 * ── El flujo, en una respiración ─────────────────────────────────────────────────
 *
 *   Área 1: pesa el jamón → ABRE la cuenta → imprime su vale → SE QUEDA EL PRODUCTO
 *   Área 2..N: escanea ese vale → AGREGA a la MISMA cuenta → imprime su vale
 *   Caja: escanea cualquier vale → RECLAMA la cuenta → suma papas → cobra UNA vez
 *   Área: el cliente vuelve con el ticket pagado → escanea → ve SÓLO SUS renglones
 *         → entrega y marca ENTREGADO
 *
 * El cliente nunca ve el cambio: sigue recibiendo su papelito en cada área. El papel
 * es el token. Lo que cambia es que por dentro es UNA cuenta, no tres tickets que
 * alguien tenga que fusionar (fusionar no era construible: la orden nace al pagar y
 * `mergeFrom` exige sesión de mesa — en la caja no hay ninguna de las dos).
 *
 * ── 🔴 Este MVP es ONLINE, y se dice así ─────────────────────────────────────────
 *
 * NO hay intents de sincronización para vales (§1.2): el reducer offline está gateado
 * COMPLETO por `TABLE_SERVICE`, el hub LAN arrienda leases de mesa pero NO replica
 * cuentas, y sin red el papel no prueba `PAID` (el vale sin pagar y el ticket pagado
 * llevan el mismo código — entregar de todos modos abre fraude). Si se cae el WiFi el
 * flujo de vales se detiene, igual que hoy se detiene el sistema actual del cliente.
 * Lo que NO se detiene es la venta directa de mostrador, que ya funciona offline y no
 * se toca aquí.
 *
 * ── Gating (§2) ──────────────────────────────────────────────────────────────────
 *
 * `AREA_TICKETS` es **PRO** (blanket — NO va en `PREMIUM_ONLY_CODES`, meterlo ahí lo
 * volvería PREMIUM). Y el gate se aplica **sólo a ABRIR** un vale: consultar, agregar
 * a uno ya abierto, reclamar, cobrar y **entregar** siguen funcionando aunque el plan
 * venza — hay producto de un cliente guardado en el mostrador y dejarlo secuestrado
 * detrás de un paywall sería indefendible.
 */

import { Prisma } from '@prisma/client'

import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { MAX_DEVICE_PARTITION, MIN_DEVICE_PARTITION, parseAreaTicketCode } from '../../lib/areaTicketCode'
import prisma from '../../utils/prismaClient'
import { validateStaffVenue } from '../../utils/staff-venue.util'
import { logAction } from '../dashboard/activity-log.service'
import { assertVenueSalesEnabled } from '../venueSalesGuard'
import { buildOrderItemsData, CreateOrderItemInput } from './order.mobile.service'
import { formatVenueTime } from '@/utils/datetime'

// MARK: - Constantes de contrato

/**
 * Cuánto vive un claim de caja antes de caducar SOLO (§5.4).
 *
 * 🔴 No es un candado: es un LEASE. Un candado sin caducidad deja la cuenta muerta si
 * la caja se cuelga o se queda sin batería, con el producto del cliente atrapado en
 * el área. Cinco minutos es más de lo que tarda cualquier cobro real y menos de lo
 * que aguanta un cliente parado en el mostrador.
 */
export const AREA_TICKET_CLAIM_TTL_MS = 5 * 60 * 1000

/**
 * Ventana que mira la pantalla de "vales pendientes". Un vale pagado y no entregado
 * de hace dos semanas ya no es operación, es un reporte — y sin la ventana la consulta
 * escanea el histórico completo del venue en cada refresco de la tablet.
 */
const PENDING_LOOKBACK_DAYS = 7

/**
 * Estados de la cuenta (§5.4).
 *
 * 🔴 NO SE PERSISTEN COMO COLUMNA, se DERIVAN. Una columna de estado paralela a
 * `paymentStatus` / `status` / las filas de `OrderFulfillment` se desincroniza en
 * cuanto un cobro con tarjeta, un reembolso o una cancelación pasan por otra ruta —
 * y el precio de esa desincronización es que un área entregue producto de una cuenta
 * NO pagada. Una sola fuente de verdad por aspecto:
 *
 *   · pagado    → `Order.paymentStatus`
 *   · cancelado → `Order.status`
 *   · entregado → filas de `OrderFulfillment` vs. áreas con renglones
 *   · reclamado → `Order.claimedAt` (+ TTL)
 */
export type AreaTicketState = 'OPEN' | 'CHECKOUT_CLAIMED' | 'ALREADY_PAID' | 'DELIVERED' | 'CANCELLED'
export type AreaTicketResolution = AreaTicketState | 'NOT_FOUND'

// MARK: - Tipos de respuesta

export interface AreaTicketLineView {
  id: string
  productId: string | null
  productName: string | null
  quantity: number
  unitPrice: number
  /** Kilos, sólo en líneas de venta por peso. */
  weightQuantity: number | null
  total: number
  discountAmount: number
  notes: string | null
  /** `null` = línea de caja: se entrega al momento y no aparece en pendientes. */
  fulfillmentAreaId: string | null
  fulfillmentAreaName: string | null
  /** true cuando el área que la surtió ya la marcó entregada. */
  delivered: boolean
}

export interface AreaTicketView {
  orderId: string
  orderNumber: string
  code: string
  state: AreaTicketState
  paymentStatus: string
  subtotal: number
  discountAmount: number
  total: number
  /** Terminal que tiene la cuenta reclamada AHORA (claim vivo). */
  claimedByTerminalId: string | null
  claimedAt: Date | null
  /** Áreas que ya entregaron, con hora y persona — el "ya entregado a las 14:31 por Rosa". */
  fulfillments: Array<{
    fulfillmentAreaId: string
    fulfillmentAreaName: string
    deliveredAt: Date
    deliveredByStaffName: string | null
  }>
  items: AreaTicketLineView[]
  createdAt: Date
}

export interface AreaTicketResolveResponse {
  state: AreaTicketResolution
  /** Mensaje LISTO PARA MOSTRARLE AL CAJERO, en español. Siempre presente. */
  message: string
  ticket: AreaTicketView | null
}

// MARK: - Helpers internos

const areaTicketInclude = {
  // Zona del venue: los mensajes de hora los lee alguien parado en el mostrador.
  // Sin esto se formatean en la zona del PROCESO (UTC en Fly.io) y salen 6 h corridas.
  venue: { select: { timezone: true } },
  items: {
    include: {
      fulfillmentArea: { select: { id: true, name: true } },
      fulfillmentLines: { select: { id: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  fulfillments: {
    include: {
      fulfillmentArea: { select: { id: true, name: true } },
      deliveredByStaff: { select: { firstName: true, lastName: true } },
    },
  },
} as const

/** ¿El claim sigue vivo? Un claim viejo NO bloquea nada (§5.4). */
export function isClaimLive(claimedAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!claimedAt) return false
  return now.getTime() - new Date(claimedAt).getTime() < AREA_TICKET_CLAIM_TTL_MS
}

/**
 * Deriva el estado de la cuenta. PURA — sin I/O, para poder probarla sin base de
 * datos y para que el mismo razonamiento se lea de un golpe.
 *
 * Orden de precedencia (importa): cancelada > pagada+entregada > pagada > reclamada > abierta.
 */
export function deriveAreaTicketState(
  order: {
    status: string
    paymentStatus: string
    claimedAt: Date | null
    items: Array<{ fulfillmentAreaId: string | null }>
    fulfillments: Array<{ fulfillmentAreaId: string }>
  },
  now: Date = new Date(),
): AreaTicketState {
  if (order.status === 'CANCELLED' || order.status === 'DELETED') return 'CANCELLED'

  if (order.paymentStatus === 'PAID') {
    // Áreas que tienen renglones en esta cuenta. Las líneas de caja
    // (fulfillmentAreaId = null) NO cuentan: se entregan al momento.
    const areasWithLines = new Set(order.items.map(i => i.fulfillmentAreaId).filter((id): id is string => !!id))
    const areasDelivered = new Set(order.fulfillments.map(f => f.fulfillmentAreaId))
    // Una cuenta sin áreas (sólo caja) nace entregada al pagarse.
    const allDelivered = [...areasWithLines].every(id => areasDelivered.has(id))
    return allDelivered ? 'DELIVERED' : 'ALREADY_PAID'
  }

  if (isClaimLive(order.claimedAt, now)) return 'CHECKOUT_CLAIMED'
  return 'OPEN'
}

/** Mensaje en español para cada estado. Nunca un 404 mudo (§5.1). */
function messageForState(state: AreaTicketResolution, ticket: AreaTicketView | null): string {
  switch (state) {
    case 'OPEN':
      return 'Cuenta abierta.'
    case 'CHECKOUT_CLAIMED':
      return 'La caja está cobrando esta cuenta.'
    case 'ALREADY_PAID':
      return 'Este vale ya está pagado. Entrega el producto y márcalo como entregado.'
    case 'DELIVERED': {
      const last = ticket?.fulfillments?.[ticket.fulfillments.length - 1]
      if (last) {
        // TODO(vales): `AreaTicketView` todavía NO expone `venueTimezone`, así que esto cae al
        // default (`America/Mexico_City`). Para Culiacán (`America/Mazatlan`) eso se pasa por una
        // hora — mucho mejor que las 7 de UTC que había antes, pero sigue mal. Hay que colgar la
        // zona del venue en la vista y pasarla aquí.
        const hora = formatVenueTime(last.deliveredAt)
        return last.deliveredByStaffName
          ? `Este vale ya se entregó a las ${hora} por ${last.deliveredByStaffName}.`
          : `Este vale ya se entregó a las ${hora}.`
      }
      return 'Este vale ya se entregó.'
    }
    case 'CANCELLED':
      return 'Esta cuenta fue cancelada.'
    case 'NOT_FOUND':
      return 'Ese código no corresponde a ningún vale de este local. Verifica los 10 dígitos.'
  }
}

function toAreaTicketView(order: any, now: Date = new Date()): AreaTicketView {
  const state = deriveAreaTicketState(order, now)
  const claimLive = isClaimLive(order.claimedAt, now)
  const areasDelivered = new Set<string>(order.fulfillments.map((f: any) => f.fulfillmentAreaId))

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    code: order.areaTicketCode,
    state,
    paymentStatus: order.paymentStatus,
    subtotal: Number(order.subtotal),
    discountAmount: Number(order.discountAmount || 0),
    total: Number(order.total),
    // Un claim caducado se reporta como "no reclamada": si el cliente viera el id de
    // una terminal que ya soltó la cuenta, creería que sigue bloqueada.
    claimedByTerminalId: claimLive ? order.claimedByTerminalId : null,
    claimedAt: claimLive ? order.claimedAt : null,
    fulfillments: order.fulfillments.map((f: any) => ({
      fulfillmentAreaId: f.fulfillmentAreaId,
      fulfillmentAreaName: f.fulfillmentArea?.name ?? '',
      deliveredAt: f.deliveredAt,
      deliveredByStaffName: f.deliveredByStaff
        ? `${f.deliveredByStaff.firstName ?? ''} ${f.deliveredByStaff.lastName ?? ''}`.trim() || null
        : null,
    })),
    items: order.items.map((item: any) => ({
      id: item.id,
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      weightQuantity: item.weightQuantity != null ? Number(item.weightQuantity) : null,
      total: Number(item.total),
      discountAmount: Number(item.discountAmount || 0),
      notes: item.notes,
      fulfillmentAreaId: item.fulfillmentAreaId,
      fulfillmentAreaName: item.fulfillmentArea?.name ?? null,
      delivered: item.fulfillmentAreaId ? areasDelivered.has(item.fulfillmentAreaId) : false,
    })),
    createdAt: order.createdAt,
  }
}

/**
 * Resuelve la terminal que hace la petición a partir del `X-Device-Id`.
 *
 * 🔴 El área de un renglón sale de AQUÍ, nunca del payload (§5.3): un cliente puede
 * mandar el id de área que se le antoje, y con eso podría hacer que la cremería
 * aparezca surtiendo el pan de otro.
 */
async function resolveTerminal(venueId: string, deviceUid: string | null | undefined) {
  const uid = deviceUid?.trim()
  if (!uid) {
    throw new BadRequestError('Falta el identificador del dispositivo (X-Device-Id). Vuelve a iniciar sesión.')
  }
  const terminal = await prisma.terminal.findFirst({
    where: { venueId, deviceUid: uid },
    select: { id: true, name: true, partition: true, fulfillmentAreaId: true, areaTicketLastCounter: true },
  })
  if (!terminal) {
    // El registro pasivo corre DESPUÉS de responder (res.on('finish')), así que en el
    // primerísimo request la terminal puede no existir todavía. El cliente pide su
    // partición al entrar, que es justo lo que crea/completa este renglón.
    throw new ConflictError(
      'Este dispositivo todavía no está registrado en el local. Vuelve a iniciar sesión para asignarle su partición.',
      'DEVICE_NOT_REGISTERED',
    )
  }
  return terminal
}

/** Carga la cuenta por código, con todo lo necesario para derivar su estado. */
async function findTicketByCode(venueId: string, code: string) {
  return prisma.order.findUnique({
    where: { venueId_areaTicketCode: { venueId, areaTicketCode: code } },
    include: areaTicketInclude,
  })
}

// MARK: - §6 · POST /mobile/devices/partition

export interface AssignPartitionInput {
  deviceUid: string
  staffId?: string | null
  /** Área a la que pertenece este dispositivo, si el instalador ya la enlazó. */
  fulfillmentAreaId?: string | null
}

export interface AssignPartitionResponse {
  terminalId: string
  partition: number
  /** Mayor contador ya visto por el server. El cliente arranca en `lastCounter + 1`. */
  lastCounter: number
  /** Área enlazada a este dispositivo (null = caja). */
  fulfillmentAreaId: string | null
  fulfillmentAreaName: string | null
  fulfillmentMode: string | null
}

/**
 * Asigna (o devuelve) la partición del dispositivo — §5.2.
 *
 * El registro de dispositivos que ya existía es **pasivo**: graba una `Terminal`
 * después de responder y **no le devuelve nada al cliente**. Sin un punto de entrega
 * explícito y TRANSACCIONAL, dos dispositivos pueden acuñar la misma secuencia y dos
 * clientes distintos terminan compartiendo cuenta.
 *
 * Idempotente: un dispositivo que ya tiene partición recibe la SUYA, siempre la misma.
 */
export async function assignDevicePartition(venueId: string, input: AssignPartitionInput): Promise<AssignPartitionResponse> {
  const deviceUid = input.deviceUid?.trim()
  if (!deviceUid) {
    throw new BadRequestError('Falta el identificador del dispositivo (X-Device-Id).')
  }

  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)

  const assigned = await prisma.$transaction(async tx => {
    const terminal = await tx.terminal.findFirst({
      where: { venueId, deviceUid },
      select: { id: true, partition: true, areaTicketLastCounter: true, fulfillmentAreaId: true },
    })
    if (!terminal) {
      throw new ConflictError(
        'Este dispositivo todavía no está registrado en el local. Abre la app con sesión iniciada y vuelve a intentar.',
        'DEVICE_NOT_REGISTERED',
      )
    }

    // Ya tiene: devuélvele la suya. Reasignar rompería la unicidad histórica de los
    // vales que ya imprimió.
    if (terminal.partition != null) {
      return { terminal, partition: terminal.partition, created: false }
    }

    // 🔴 LAS PARTICIONES NO SE RECICLAN mientras exista cualquier terminal que la
    // tenga — ni siquiera retirada. Reusar el número de un aparato dado de baja haría
    // que un vale impreso ayer resuelva la cuenta de otro cliente hoy.
    const taken = await tx.terminal.findMany({
      where: { venueId, partition: { not: null } },
      select: { partition: true },
    })
    const used = new Set(taken.map(t => t.partition!))
    let next: number | null = null
    for (let candidate = MIN_DEVICE_PARTITION; candidate <= MAX_DEVICE_PARTITION; candidate++) {
      if (!used.has(candidate)) {
        next = candidate
        break
      }
    }
    if (next == null) {
      throw new ConflictError(
        `Este local ya usó las ${MAX_DEVICE_PARTITION - MIN_DEVICE_PARTITION + 1} particiones de dispositivo disponibles. Retira dispositivos viejos desde el dashboard.`,
        'AREA_PARTITIONS_EXHAUSTED',
      )
    }

    const updated = await tx.terminal.update({
      where: { id: terminal.id },
      data: {
        partition: next,
        // El binding terminal→área sólo se escribe si viene explícito Y la terminal
        // aún no tiene una: la configuración la siembra el instalador, no la app.
        ...(input.fulfillmentAreaId && !terminal.fulfillmentAreaId ? { fulfillmentAreaId: input.fulfillmentAreaId } : {}),
      },
      select: { id: true, partition: true, areaTicketLastCounter: true, fulfillmentAreaId: true },
    })
    return { terminal: updated, partition: next, created: true }
  })

  // El área (nombre + modo) se lee fuera de la transacción: es sólo presentación.
  const area = assigned.terminal.fulfillmentAreaId
    ? await prisma.fulfillmentArea.findFirst({
        where: { id: assigned.terminal.fulfillmentAreaId, venueId },
        select: { id: true, name: true, fulfillmentMode: true },
      })
    : null

  if (assigned.created) {
    logger.info(`🎟️ [AREA TICKETS] Partición ${assigned.partition} asignada | venue=${venueId} terminal=${assigned.terminal.id}`)
    void logAction({
      staffId,
      venueId,
      action: 'DEVICE_PARTITION_ASSIGNED',
      entity: 'Terminal',
      entityId: assigned.terminal.id,
      data: { partition: assigned.partition, deviceUid, fulfillmentAreaId: assigned.terminal.fulfillmentAreaId },
    })
  }

  return {
    terminalId: assigned.terminal.id,
    partition: assigned.partition,
    lastCounter: assigned.terminal.areaTicketLastCounter ?? 0,
    fulfillmentAreaId: area?.id ?? null,
    fulfillmentAreaName: area?.name ?? null,
    fulfillmentMode: area?.fulfillmentMode ?? null,
  }
}

// MARK: - §6 · POST /mobile/venues/:venueId/area-tickets

export interface OpenAreaTicketInput {
  /** Código ACUÑADO POR EL CLIENTE (`9 PP NNNNNN C`). El server lo valida, no lo inventa. */
  code: string
  deviceUid: string
  staffId?: string | null
  items: CreateOrderItemInput[]
  customerName?: string | null
  note?: string | null
  source?: 'AVOQADO_IOS' | 'AVOQADO_ANDROID' | 'TPV' | 'POS'
}

/**
 * Abre la cuenta con el código que acuñó el área — §5.1, §5.2.
 *
 * Validaciones, en orden y por una razón:
 *  1. El código es de ESTE dispositivo (su `PP` == su partición). Si no, alguien está
 *     acuñando códigos ajenos y el siguiente vale colisionaría.
 *  2. El contador no RETROCEDE (`AREA_CODE_REPLAY`). Un restore de iOS puede revivir
 *     un `UserDefaults` viejo y hacer que el aparato reacuñe códigos ya usados.
 *  3. El código no existe ya (idempotencia: un reintento devuelve la misma cuenta).
 */
export async function openAreaTicket(venueId: string, input: OpenAreaTicketInput): Promise<AreaTicketView> {
  const parsed = parseAreaTicketCode(input.code)
  if (!parsed) {
    // Rechazo SIN TOCAR LA BASE (§10): un verificador inválido no merece una query.
    throw new BadRequestError('El código del vale no es válido (10 dígitos, empieza en 9, verificador correcto).')
  }

  await assertVenueSalesEnabled(venueId)

  const terminal = await resolveTerminal(venueId, input.deviceUid)
  if (terminal.partition == null) {
    throw new ConflictError('Este dispositivo no tiene partición asignada. Vuelve a iniciar sesión.', 'DEVICE_PARTITION_MISSING')
  }
  if (terminal.partition !== parsed.partition) {
    throw new ConflictError(
      `Ese vale es de otro dispositivo (partición ${parsed.partition}, este es ${terminal.partition}).`,
      'AREA_CODE_WRONG_PARTITION',
    )
  }

  // Idempotencia: el mismo código ya abierto devuelve la MISMA cuenta. Un reintento
  // por respuesta perdida no puede abrir dos cuentas ni "gastar" el código.
  const existing = await findTicketByCode(venueId, parsed.code)
  if (existing) {
    logger.warn(`🔄 [AREA TICKETS] Reintento de apertura con código ya usado (${parsed.code}) — devuelvo la cuenta existente`)
    return toAreaTicketView(existing)
  }

  if (parsed.counter <= terminal.areaTicketLastCounter) {
    throw new ConflictError(
      'Este dispositivo repitió un número de vale ya usado. Vuelve a iniciar sesión para pedir una partición nueva.',
      'AREA_CODE_REPLAY',
    )
  }

  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)

  // 🔴 El área la pone el SERVER desde el binding de la terminal, jamás el payload.
  const { itemsData, subtotal, itemDiscountTotal } = await buildOrderItemsData(venueId, input.items, terminal.fulfillmentAreaId)
  const total = subtotal - itemDiscountTotal

  try {
    const created = await prisma.$transaction(async tx => {
      const order = await tx.order.create({
        data: {
          venueId,
          orderNumber: `ORD-${Date.now()}`,
          areaTicketCode: parsed.code,
          terminalId: terminal.id,
          servedById: staffId || null,
          createdById: staffId || null,
          status: 'CONFIRMED',
          paymentStatus: 'PENDING',
          kitchenStatus: 'PENDING',
          type: 'TAKEOUT',
          source: input.source || 'AVOQADO_ANDROID',
          customerName: input.customerName || null,
          specialRequests: input.note || null,
          subtotal: new Prisma.Decimal(subtotal),
          discountAmount: new Prisma.Decimal(itemDiscountTotal),
          taxAmount: new Prisma.Decimal(0),
          tipAmount: new Prisma.Decimal(0),
          total: new Prisma.Decimal(total),
          remainingBalance: new Prisma.Decimal(total),
          version: 1,
          items: { create: itemsData },
        },
        include: areaTicketInclude,
      })

      // El máximo visto sube DENTRO de la misma transacción que crea la cuenta: si el
      // insert falla, el contador no avanza y el dispositivo puede reintentar el mismo
      // número. Un `updateMany` condicional para no bajarlo nunca ante una carrera.
      await tx.terminal.updateMany({
        where: { id: terminal.id, areaTicketLastCounter: { lt: parsed.counter } },
        data: { areaTicketLastCounter: parsed.counter },
      })

      return order
    })

    logger.info(`🎟️ [AREA TICKETS] Vale abierto ${parsed.code} | venue=${venueId} order=${created.id} area=${terminal.fulfillmentAreaId}`)
    return toAreaTicketView(created)
  } catch (error: any) {
    // Carrera de dos requests idénticos: el índice único [venueId, areaTicketCode]
    // deja pasar uno; al otro le devolvemos el ganador en vez de un error.
    if (error?.code === 'P2002') {
      const winner = await findTicketByCode(venueId, parsed.code)
      if (winner) return toAreaTicketView(winner)
    }
    throw error
  }
}

// MARK: - §6 · GET /mobile/venues/:venueId/area-tickets/:code

/**
 * Resuelve un vale — §5.1. **NUNCA un 404 mudo**: el cajero lo re-teclea tres veces
 * antes de entender. Siempre vuelve un `state` y un `message` en español.
 *
 * Un vale ya entregado responde `DELIVERED` y **no devuelve la cuenta**: es lo que
 * evita que el mismo papel se canjee dos veces, que es donde está el producto de
 * mayor valor por kilo.
 */
export async function resolveAreaTicket(venueId: string, rawCode: string): Promise<AreaTicketResolveResponse> {
  const parsed = parseAreaTicketCode(rawCode)
  if (!parsed) {
    // Sin tocar la base: verificador inválido = error de dedo, no una consulta.
    return { state: 'NOT_FOUND', message: messageForState('NOT_FOUND', null), ticket: null }
  }

  const order = await findTicketByCode(venueId, parsed.code)
  if (!order) {
    return { state: 'NOT_FOUND', message: messageForState('NOT_FOUND', null), ticket: null }
  }

  const ticket = toAreaTicketView(order)
  return {
    state: ticket.state,
    message: messageForState(ticket.state, ticket),
    // El vale entregado SÍ devuelve la cuenta (el área necesita ver qué entregó y
    // cuándo para explicárselo al cliente), pero su `state` deja clarísimo que ya no
    // hay nada que entregar. La pantalla de entrega bloquea por `state`, no por
    // ausencia de datos — esconder los datos sólo produce un cajero desconcertado.
    ticket,
  }
}

// MARK: - §6 · POST /mobile/venues/:venueId/area-tickets/:code/items

export interface AddAreaTicketItemsInput {
  deviceUid: string
  staffId?: string | null
  items: CreateOrderItemInput[]
}

/**
 * Agrega renglones a una cuenta ya abierta (área o caja) — §5.3, §5.4.
 *
 * 🔴 En `CHECKOUT_CLAIMED` las áreas NO pueden agregar. Sin eso el área suma jamón
 * mientras la caja cobra y el total se mueve bajo los pies del cajero. La terminal que
 * TIENE el claim sí puede agregar: es la caja sumando las papas y los refrescos.
 */
export async function addAreaTicketItems(venueId: string, rawCode: string, input: AddAreaTicketItemsInput): Promise<AreaTicketView> {
  const parsed = parseAreaTicketCode(rawCode)
  if (!parsed) {
    throw new BadRequestError('El código del vale no es válido.')
  }

  await assertVenueSalesEnabled(venueId)

  const terminal = await resolveTerminal(venueId, input.deviceUid)
  const order = await findTicketByCode(venueId, parsed.code)
  if (!order) {
    throw new NotFoundError(messageForState('NOT_FOUND', null))
  }

  const state = deriveAreaTicketState(order as any)
  if (state === 'CANCELLED') throw new ConflictError('Esta cuenta fue cancelada.', 'AREA_TICKET_CANCELLED')
  if (state === 'ALREADY_PAID' || state === 'DELIVERED') {
    throw new ConflictError('Este vale ya está pagado; no se le pueden agregar renglones.', 'AREA_TICKET_ALREADY_PAID')
  }
  if (state === 'CHECKOUT_CLAIMED' && order.claimedByTerminalId !== terminal.id) {
    throw new ConflictError('La caja está cobrando esta cuenta. Espera a que termine.', 'AREA_TICKET_CLAIMED_BY_OTHER')
  }

  await validateStaffVenue(input.staffId ?? undefined, venueId)

  // Misma aritmética que abrir la cuenta y que el mostrador: una sola función.
  const { itemsData } = await buildOrderItemsData(venueId, input.items, terminal.fulfillmentAreaId)

  const updated = await prisma.$transaction(async tx => {
    // CAS sobre `version`: si otro dispositivo agregó entre la lectura y este write,
    // count = 0 y el cliente reescanea, en vez de pisar los totales del otro.
    const bumped = await tx.order.updateMany({
      where: { id: order.id, venueId, version: order.version, paymentStatus: { in: ['PENDING', 'PARTIAL'] } },
      data: { version: { increment: 1 } },
    })
    if (bumped.count === 0) {
      throw new ConflictError('La cuenta cambió en otro dispositivo. Vuelve a escanear el vale.', 'VERSION_CONFLICT')
    }

    // Uno por uno (no `createMany`): sólo el create anidado escribe los modificadores
    // del renglón, y un renglón sin sus modificadores es un cobro incompleto.
    for (const item of itemsData) {
      await tx.orderItem.create({ data: { ...item, orderId: order.id } })
    }

    // 🔴 Los totales se RECOMPUTAN desde TODOS los renglones, no se incrementan a
    // ciegas. Un incremento asume que nada más tocó la cuenta; recomputar es correcto
    // aunque otro flujo (cortesía, descuento de cuenta) haya pasado por en medio, y
    // preserva propina y cobro por servicio, que no son renglones.
    const allItems = await tx.orderItem.findMany({
      where: { orderId: order.id },
      select: { total: true, discountAmount: true },
    })
    const newSubtotal = allItems.reduce((sum, i) => sum + Number(i.total), 0)
    const newItemDiscount = allItems.reduce((sum, i) => sum + Number(i.discountAmount || 0), 0)
    const tipAmount = Number(order.tipAmount || 0)
    const serviceCharge = Number(order.serviceChargeAmount || 0)
    const newTotal = newSubtotal - newItemDiscount + serviceCharge + tipAmount
    const paidAmount = Number(order.paidAmount || 0)

    await tx.order.update({
      where: { id: order.id },
      data: {
        subtotal: new Prisma.Decimal(newSubtotal),
        discountAmount: new Prisma.Decimal(newItemDiscount),
        total: new Prisma.Decimal(newTotal),
        remainingBalance: new Prisma.Decimal(Math.max(0, newTotal - paidAmount)),
      },
    })

    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: areaTicketInclude })
  })

  logger.info(`🎟️ [AREA TICKETS] ${itemsData.length} renglón(es) agregados al vale ${parsed.code} | area=${terminal.fulfillmentAreaId}`)
  return toAreaTicketView(updated)
}

// MARK: - §6 · POST /mobile/venues/:venueId/area-tickets/:code/claim

export interface ClaimAreaTicketInput {
  deviceUid: string
  staffId?: string | null
}

/**
 * La caja reclama la cuenta para cobrarla — §5.4.
 *
 * Idempotente para la MISMA terminal: vuelve a reclamar = renovar el claim (que es lo
 * que hace la caja mientras el cajero teclea). Otra terminal con el claim VIVO recibe
 * 409; con el claim CADUCADO se lo lleva, porque una caja colgada no puede secuestrar
 * la cuenta y dejar el producto del cliente atrapado en el área.
 */
export async function claimAreaTicket(venueId: string, rawCode: string, input: ClaimAreaTicketInput): Promise<AreaTicketView> {
  const parsed = parseAreaTicketCode(rawCode)
  if (!parsed) {
    throw new BadRequestError('El código del vale no es válido.')
  }

  const terminal = await resolveTerminal(venueId, input.deviceUid)
  const order = await findTicketByCode(venueId, parsed.code)
  if (!order) {
    throw new NotFoundError(messageForState('NOT_FOUND', null))
  }

  const state = deriveAreaTicketState(order as any)
  if (state === 'CANCELLED') throw new ConflictError('Esta cuenta fue cancelada.', 'AREA_TICKET_CANCELLED')
  if (state === 'ALREADY_PAID' || state === 'DELIVERED') {
    throw new ConflictError('Este vale ya está pagado.', 'AREA_TICKET_ALREADY_PAID')
  }
  if (state === 'CHECKOUT_CLAIMED' && order.claimedByTerminalId !== terminal.id) {
    throw new ConflictError('Otra caja está cobrando esta cuenta.', 'AREA_TICKET_CLAIMED_BY_OTHER')
  }

  const now = new Date()
  const claimCutoff = new Date(now.getTime() - AREA_TICKET_CLAIM_TTL_MS)

  // Transición condicional: sólo se lleva el claim quien lo tenía, o quien llega
  // cuando ya caducó / no había ninguno. Dos cajas escaneando a la vez: una gana.
  const claimed = await prisma.order.updateMany({
    where: {
      id: order.id,
      venueId,
      paymentStatus: { in: ['PENDING', 'PARTIAL'] },
      OR: [{ claimedAt: null }, { claimedAt: { lt: claimCutoff } }, { claimedByTerminalId: terminal.id }],
    },
    data: { claimedByTerminalId: terminal.id, claimedAt: now },
  })
  if (claimed.count === 0) {
    throw new ConflictError('Otra caja acaba de tomar esta cuenta. Vuelve a escanear el vale.', 'AREA_TICKET_CLAIMED_BY_OTHER')
  }

  logger.info(`🎟️ [AREA TICKETS] Vale ${parsed.code} reclamado por la caja | terminal=${terminal.id}`)
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: areaTicketInclude })
  return toAreaTicketView(fresh, now)
}

// MARK: - §6 · POST /mobile/orders/:id/fulfill

export interface FulfillOrderAreaInput {
  fulfillmentAreaId: string
  deviceUid?: string | null
  staffId?: string | null
}

export interface FulfillOrderAreaResponse {
  fulfillmentId: string
  orderId: string
  fulfillmentAreaId: string
  fulfillmentAreaName: string
  deliveredAt: Date
  deliveredByStaffName: string | null
  /** false = ya estaba entregado; la respuesta describe la entrega ORIGINAL. */
  created: boolean
  /** Mensaje en español, listo para la pantalla. */
  message: string
  orderItemIds: string[]
}

/**
 * Marca ENTREGADOS todos los renglones de UN área en una cuenta — §5.5.
 *
 * 🔴 **Idempotente**: el segundo intento NO es un error, devuelve *"ya entregado a las
 * 14:31 por Rosa"*. Un error ahí haría que el área dudara y entregara dos veces.
 *
 * 🔴 **Exige `PAID`**: fijo, no configurable. Todo el motivo de que esto exista es que
 * hoy nada impide canjear el mismo vale dos veces, y ahí está el producto de mayor
 * valor por kilo.
 *
 * 🔴 **Renglón COMPLETO, sin parcialidad**. No hay `deliveredQty` ni estado PARTIAL:
 * el modelo simple no los soporta y a medias es peor que no tenerlos (§5.5).
 */
export async function fulfillOrderArea(
  venueId: string,
  orderId: string,
  input: FulfillOrderAreaInput,
  /** Interno: evita recursión infinita si el P2002 no se explica por una fila existente. */
  isP2002Retry = false,
): Promise<FulfillOrderAreaResponse> {
  const areaId = input.fulfillmentAreaId?.trim()
  if (!areaId) {
    throw new BadRequestError('fulfillmentAreaId es requerido.')
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId, venueId },
    include: areaTicketInclude,
  })
  if (!order) {
    throw new NotFoundError('Esa cuenta no existe en este local.')
  }

  const area = await prisma.fulfillmentArea.findFirst({ where: { id: areaId, venueId }, select: { id: true, name: true } })
  if (!area) {
    throw new NotFoundError('Esa área de entrega no existe en este local.')
  }

  // Idempotencia PRIMERO: si ya se entregó, respondemos con el registro original SIN
  // volver a validar el pago. Una cuenta reembolsada después de entregar no puede
  // convertir el reintento en un error — el producto ya salió y el área necesita ver
  // quién lo entregó.
  const already = order.fulfillments.find((f: any) => f.fulfillmentAreaId === areaId)
  if (already) {
    const staffName = already.deliveredByStaff
      ? `${already.deliveredByStaff.firstName ?? ''} ${already.deliveredByStaff.lastName ?? ''}`.trim() || null
      : null
    const hora = formatVenueTime(already.deliveredAt, (order as any).venue?.timezone)
    const lines = await prisma.orderFulfillmentLine.findMany({ where: { fulfillmentId: already.id }, select: { orderItemId: true } })
    return {
      fulfillmentId: already.id,
      orderId,
      fulfillmentAreaId: areaId,
      fulfillmentAreaName: area.name,
      deliveredAt: already.deliveredAt,
      deliveredByStaffName: staffName,
      created: false,
      message: staffName ? `Ya se entregó a las ${hora} por ${staffName}.` : `Ya se entregó a las ${hora}.`,
      orderItemIds: lines.map(l => l.orderItemId),
    }
  }

  if (order.status === 'CANCELLED' || order.status === 'DELETED') {
    throw new ConflictError('Esta cuenta fue cancelada; no hay nada que entregar.', 'AREA_TICKET_CANCELLED')
  }
  if (order.paymentStatus !== 'PAID') {
    throw new ConflictError('Esta cuenta todavía no está pagada. El cliente tiene que pasar a la caja.', 'ORDER_NOT_PAID')
  }

  const areaItems = order.items.filter((item: any) => item.fulfillmentAreaId === areaId)
  if (areaItems.length === 0) {
    throw new ConflictError('Esta cuenta no tiene renglones de tu área.', 'AREA_TICKET_NO_LINES_FOR_AREA')
  }

  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)
  const terminal = input.deviceUid
    ? await prisma.terminal.findFirst({ where: { venueId, deviceUid: input.deviceUid.trim() }, select: { id: true } })
    : null

  try {
    const fulfillment = await prisma.$transaction(async tx => {
      const created = await tx.orderFulfillment.create({
        data: {
          orderId,
          fulfillmentAreaId: areaId,
          deliveredByStaffId: staffId || null,
          terminalId: terminal?.id ?? null,
          lines: { create: areaItems.map((item: any) => ({ orderItemId: item.id })) },
        },
        include: { deliveredByStaff: { select: { firstName: true, lastName: true } } },
      })
      return created
    })

    const staffName = fulfillment.deliveredByStaff
      ? `${fulfillment.deliveredByStaff.firstName ?? ''} ${fulfillment.deliveredByStaff.lastName ?? ''}`.trim() || null
      : null

    logger.info(`📦 [AREA TICKETS] Entrega registrada | order=${orderId} area=${area.name} lineas=${areaItems.length}`)

    // Auditable de verdad: es la prueba de que el producto salió, y de quién lo sacó.
    // (El alta de la cuenta y el agregar renglones NO se auditan: son alto volumen y
    // la regla del repo pide no inundar la bitácora que el dueño usa para anomalías.)
    void logAction({
      staffId,
      venueId,
      action: 'AREA_TICKET_FULFILLED',
      entity: 'OrderFulfillment',
      entityId: fulfillment.id,
      data: {
        orderId,
        areaTicketCode: order.areaTicketCode,
        fulfillmentAreaId: areaId,
        fulfillmentAreaName: area.name,
        orderItemIds: areaItems.map((i: any) => i.id),
      },
    })

    return {
      fulfillmentId: fulfillment.id,
      orderId,
      fulfillmentAreaId: areaId,
      fulfillmentAreaName: area.name,
      deliveredAt: fulfillment.deliveredAt,
      deliveredByStaffName: staffName,
      created: true,
      message: 'Entregado.',
      orderItemIds: areaItems.map((i: any) => i.id),
    }
  } catch (error: any) {
    // Carrera: dos tablets del área marcando entregado a la vez. El
    // @@unique([orderId, fulfillmentAreaId]) deja pasar una; a la otra le devolvemos
    // la entrega ganadora, nunca un error.
    if (error?.code === 'P2002' && !isP2002Retry) {
      logger.info(`🔄 [AREA TICKETS] Entrega concurrente resuelta por el índice único | order=${orderId} area=${areaId}`)
      // UN solo reintento: la relectura debe encontrar la fila ganadora y salir por el
      // camino idempotente. Si volviera a chocar, el P2002 no viene de este índice y
      // recursar para siempre sería peor que propagar el error.
      return fulfillOrderArea(venueId, orderId, input, true)
    }
    throw error
  }
}

// MARK: - §6 · GET /mobile/venues/:venueId/fulfillment/pending

export interface PendingFulfillmentTicket {
  orderId: string
  orderNumber: string
  code: string | null
  fulfillmentAreaId: string
  fulfillmentAreaName: string
  paidAt: Date
  customerName: string | null
  lineCount: number
  total: number
  items: Array<{ id: string; productName: string | null; quantity: number; weightQuantity: number | null; total: number }>
}

/**
 * Vales PAGADOS y NO ENTREGADOS, por área — §5.5.
 *
 * Sin esta pantalla el área guarda producto perecedero a ciegas: nadie sabe cuántos
 * paquetes de jamón llevan una hora esperando a un cliente que quizá ya se fue.
 *
 * Por defecto responde con el área de la terminal que pregunta; el dashboard puede
 * pedir otra con `fulfillmentAreaId`.
 */
export async function listPendingFulfillment(
  venueId: string,
  input: { fulfillmentAreaId?: string | null; deviceUid?: string | null },
): Promise<{ fulfillmentAreaId: string | null; tickets: PendingFulfillmentTicket[] }> {
  let areaId = input.fulfillmentAreaId?.trim() || null

  if (!areaId && input.deviceUid) {
    const terminal = await prisma.terminal.findFirst({
      where: { venueId, deviceUid: input.deviceUid.trim() },
      select: { fulfillmentAreaId: true },
    })
    areaId = terminal?.fulfillmentAreaId ?? null
  }

  if (!areaId) {
    // Sin área no hay pendientes: una terminal de caja entrega al momento y no guarda
    // nada. Lista vacía, no error — la pantalla simplemente no aplica ahí.
    return { fulfillmentAreaId: null, tickets: [] }
  }

  const since = new Date(Date.now() - PENDING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)

  const orders = await prisma.order.findMany({
    where: {
      venueId,
      areaTicketCode: { not: null },
      paymentStatus: 'PAID',
      status: { notIn: ['CANCELLED', 'DELETED'] },
      createdAt: { gte: since },
      // Tiene renglones de esta área…
      items: { some: { fulfillmentAreaId: areaId } },
      // …y NINGUNA entrega registrada para ella.
      fulfillments: { none: { fulfillmentAreaId: areaId } },
    },
    select: {
      id: true,
      orderNumber: true,
      areaTicketCode: true,
      customerName: true,
      updatedAt: true,
      items: {
        where: { fulfillmentAreaId: areaId },
        select: { id: true, productName: true, quantity: true, weightQuantity: true, total: true },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { updatedAt: 'asc' }, // el que lleva más tiempo esperando, primero
    take: 200,
  })

  const area = await prisma.fulfillmentArea.findFirst({ where: { id: areaId, venueId }, select: { name: true } })

  return {
    fulfillmentAreaId: areaId,
    tickets: orders.map(order => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      code: order.areaTicketCode,
      fulfillmentAreaId: areaId!,
      fulfillmentAreaName: area?.name ?? '',
      // `updatedAt` es lo más cercano a "cuándo se pagó" sin una columna nueva: la
      // última escritura de una cuenta pagada y no entregada ES el cobro.
      paidAt: order.updatedAt,
      customerName: order.customerName,
      lineCount: order.items.length,
      total: order.items.reduce((sum, i) => sum + Number(i.total), 0),
      items: order.items.map(i => ({
        id: i.id,
        productName: i.productName,
        quantity: i.quantity,
        weightQuantity: i.weightQuantity != null ? Number(i.weightQuantity) : null,
        total: Number(i.total),
      })),
    })),
  }
}

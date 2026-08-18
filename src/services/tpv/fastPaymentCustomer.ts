import { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'

/**
 * El CLIENTE de una venta rápida (`POST /fast`).
 *
 * 🔴 El defecto que este módulo repara (dos auditorías independientes, reproducido en un
 * POS Android real): el cajero elegía cliente, cobraba, y la orden `FAST-*` nacía con
 * `customerId NULL`. Se perdían historial, CFDI y atribución. El campo ni siquiera
 * llegaba al servicio: `recordPaymentBodySchema` no lo declaraba y `validation.ts`
 * reemplaza `req.body` con el resultado de Zod, así que un campo no declarado se
 * DESCARTA en silencio.
 *
 * Vive aparte de `payment.tpv.service.ts` a propósito: ese archivo es el código de
 * dinero más delicado de la plataforma y esto no necesita estar dentro para hacer su
 * trabajo.
 *
 * ## La regla que gobierna todo el módulo: NINGÚN fallo de aquí tumba un cobro
 *
 * Cuando `/fast` se llama, el dinero YA se recibió (efectivo en mano, o tarjeta ya
 * aprobada por Blumon). Un 404 por un cliente inválido mandaría el cobro a la cola de
 * reintentos del POS con un error PERMANENTE: nunca aterriza y el cajero se queda con un
 * banner que no puede quitar. Por eso todas las funciones de este archivo devuelven un
 * veredicto y **nunca lanzan**.
 *
 * Contrasta a propósito con `POST /orders` (`order.mobile.service.ts`), que SÍ lanza
 * `NotFoundError` ante un cliente ajeno: ahí todavía no se ha movido dinero, así que
 * fallar es gratis y es lo correcto. Mismo criterio que ya usa `createOrderWithItems`
 * con un `reservationId` desconocido: se tira el vínculo con aviso, nunca la venta.
 */

/** En qué terminó el intento de vincular al cliente. Aditivo: viaja en la respuesta. */
export type FastPaymentCustomerLinkStatus =
  /** El cobro no traía cliente. Venta anónima normal — no es un error. */
  | 'NOT_REQUESTED'
  /** Vinculado: `Order.customerId` + `OrderCustomer` primario. */
  | 'LINKED'
  /** El id no existe, o es de OTRO venue. La venta se registró anónima. */
  | 'NOT_FOUND'
  /** Reintento idempotente sobre una venta que YA tenía otro cliente. No se reasignó. */
  | 'CONFLICT'
  /** No se pudo verificar (fallo de infra). La venta se registró anónima. */
  | 'UNVERIFIED'

export interface FastPaymentCustomerLink {
  status: FastPaymentCustomerLinkStatus
  /** El cliente que QUEDÓ en la venta (null si ninguno). */
  customerId: string | null
  /** El que pidió el POS, para que el cliente móvil pueda ofrecer reintentar. */
  requestedCustomerId: string | null
  /** Texto en español listo para pintar. `null` cuando no hay nada que avisar. */
  warning: string | null
}

/** Lo que se necesita del cliente para denormalizar en la orden. */
interface CustomerSnapshot {
  id: string
  venueId: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
}

const CUSTOMER_SELECT = {
  id: true,
  venueId: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
} as const

export const NO_CUSTOMER_REQUESTED: FastPaymentCustomerLink = {
  status: 'NOT_REQUESTED',
  customerId: null,
  requestedCustomerId: null,
  warning: null,
}

const WARNING_NOT_FOUND = 'El cliente seleccionado no existe en este negocio. La venta se registró sin cliente.'
const WARNING_UNVERIFIED = 'No se pudo verificar el cliente. La venta se registró sin cliente.'
const WARNING_CONFLICT = 'La venta ya tenía otro cliente asignado; no se reasignó.'

/**
 * `"  cust-1  "` → `"cust-1"`; vacío / null / no-string → `null`.
 *
 * El schema valida forma (string no vacío), no formato: un id mal formado NO puede
 * rechazar el registro de dinero ya cobrado — misma lección que `terminalPaymentRequestId`
 * (min(1), no min(8)), donde un id de 7 caracteres bloqueó un cobro para siempre.
 */
export function normalizeRequestedCustomerId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** El nombre visible de un cliente — mismo criterio que `order.mobile.service.ts`. */
function customerDisplayName(customer: CustomerSnapshot): string | null {
  const fullName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim()
  return fullName || customer.email || customer.phone || null
}

/**
 * ¿Este cliente es de ESTE negocio? Devuelve el snapshot o un veredicto, nunca lanza.
 *
 * 🔴 Aislamiento de inquilino: un cliente de otro venue JAMÁS se vincula. Se compara
 * `customer.venueId` con el venue del token — exactamente la misma regla que
 * `order.mobile.service.ts:723` y `attachCustomerToOrder`.
 */
async function loadVenueCustomer(
  venueId: string,
  requestedCustomerId: string,
): Promise<{ customer: CustomerSnapshot } | { failure: 'NOT_FOUND' | 'UNVERIFIED' }> {
  let customer: CustomerSnapshot | null
  try {
    customer = (await prisma.customer.findUnique({
      where: { id: requestedCustomerId },
      select: CUSTOMER_SELECT,
    })) as CustomerSnapshot | null
  } catch (err) {
    // Fail-open: un fallo de infraestructura no puede impedir registrar dinero.
    logger.error('⚠️ [FastPayment] No se pudo verificar el cliente — la venta se registra sin cliente', {
      venueId,
      requestedCustomerId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { failure: 'UNVERIFIED' }
  }

  if (!customer) {
    // Un id que no existe es casi siempre un dato viejo del POS. Ruido, no alerta.
    logger.warn('⚠️ [FastPayment] Cliente inexistente — la venta se registra sin cliente', { venueId, requestedCustomerId })
    return { failure: 'NOT_FOUND' }
  }

  if (customer.venueId !== venueId) {
    // 🔴 CRUCE DE INQUILINOS: un id de cliente de OTRO negocio llegando a /fast es bug de
    // cliente o sondeo — alguien tiene que mirarlo. `🚨` es el token estable con el que
    // Better Stack alerta, el mismo que usa el cruce análogo de esta misma función
    // (`payment.tpv.service.ts`, solicitud de arbitraje de otro venue).
    logger.error('🚨 [FastPayment] El cliente pertenece a OTRO venue — no se vincula y la venta se registra sin cliente', {
      venueId,
      requestedCustomerId,
      clienteVenueId: customer.venueId,
    })
    // Hacia afuera se responde NOT_FOUND a secas: nunca se le confirma al llamador que
    // ese id existe en otro inquilino.
    return { failure: 'NOT_FOUND' }
  }

  return { customer }
}

/** El fragmento de `Order.create` que deja al cliente escrito en la MISMA transacción. */
export interface FastOrderCustomerData {
  customerId: string | null
  customerName?: string | null
  customerPhone?: string | null
  customerEmail?: string | null
  orderCustomers?: { create: Array<{ customerId: string; isPrimary: true }> }
}

/**
 * Resuelve el cliente ANTES de abrir la transacción del cobro, y devuelve el fragmento
 * de datos que `order.create` debe incluir.
 *
 * 🔴 El vínculo se escribe DENTRO del mismo `order.create` (no en un attach posterior):
 * un segundo paso podría fallar DESPUÉS de registrar el dinero y dejar la venta sin
 * cliente otra vez — que es justo el bug que se está arreglando.
 */
export async function resolveFastOrderCustomer(
  venueId: string,
  rawCustomerId: unknown,
): Promise<{ link: FastPaymentCustomerLink; orderData: FastOrderCustomerData | null }> {
  const requestedCustomerId = normalizeRequestedCustomerId(rawCustomerId)
  if (!requestedCustomerId) {
    // Sin cliente la venta rápida es byte-por-byte la de siempre: ni una consulta extra
    // en el camino más caliente del producto.
    return { link: NO_CUSTOMER_REQUESTED, orderData: null }
  }

  const loaded = await loadVenueCustomer(venueId, requestedCustomerId)

  if ('failure' in loaded) {
    return {
      link: {
        status: loaded.failure,
        customerId: null,
        requestedCustomerId,
        warning: loaded.failure === 'NOT_FOUND' ? WARNING_NOT_FOUND : WARNING_UNVERIFIED,
      },
      // `customerId: null` explícito — deja la venta anónima sin depender de un default.
      orderData: { customerId: null },
    }
  }

  const { customer } = loaded
  return {
    link: { status: 'LINKED', customerId: customer.id, requestedCustomerId, warning: null },
    orderData: {
      customerId: customer.id,
      // Denormalizado igual que `attachCustomerToOrder`: el recibo y el CFDI leen de aquí.
      customerName: customerDisplayName(customer),
      customerPhone: customer.phone || null,
      customerEmail: customer.email || null,
      // Vínculo moderno, primario. `POST /orders` escribe exactamente esto.
      orderCustomers: { create: [{ customerId: customer.id, isPrimary: true }] },
    },
  }
}

/** Los DOS anclajes de atribución de una orden, leídos juntos. */
interface OrderAttribution {
  /** `Order.customerId` — el vínculo legacy y el que alimenta recibo/CFDI. */
  orderCustomerId: string | null
  /** El `OrderCustomer` marcado primario — el que cobra la lealtad. */
  primaryId: string | null
  /** Nuestra fila en `OrderCustomer`, si ya existe. */
  ourRow: { id: string; isPrimary: boolean } | null
  /** Quién manda hoy en la atribución (cualquiera de los dos anclajes). */
  owner: string | null
}

/**
 * 🔴 "¿Esta venta ya tiene cliente?" NO se contesta con `Order.customerId` solo.
 *
 * `addCustomerToOrder` de la TPV (`order.tpv.service.ts`) escribe `OrderCustomer` y
 * **jamás toca `Order.customerId`**. Mirar sólo el campo legacy hace invisible a un
 * cliente puesto desde la terminal, y lleva a "rellenar" una venta que ya tenía dueño.
 *
 * Se lee con el venue del token: el pago se resolvió por `referenceNumber`/`idempotencyKey`,
 * no por tenant, así que aquí se vuelve a anclar la orden a su negocio.
 */
async function readOrderAttribution(venueId: string, orderId: string, customerId?: string): Promise<OrderAttribution | null> {
  const order = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { id: true, customerId: true } })
  if (!order) return null

  const filas = await prisma.orderCustomer.findMany({
    where: { orderId },
    select: { id: true, customerId: true, isPrimary: true },
  })

  const primary = filas.find(f => f.isPrimary) ?? null
  const ourRow = customerId ? (filas.find(f => f.customerId === customerId) ?? null) : null

  return {
    orderCustomerId: order.customerId,
    primaryId: primary?.customerId ?? null,
    ourRow: ourRow ? { id: ourRow.id, isPrimary: ourRow.isPrimary } : null,
    owner: order.customerId ?? primary?.customerId ?? null,
  }
}

type AttributionVerdict = { kind: 'conflict'; holder: string } | { kind: 'alreadyOurs' } | { kind: 'fill' }

/**
 * ¿Podemos escribir sobre esta orden?
 *
 * - `conflict`: **cualquiera** de los dos anclajes apunta a otra persona. Basta uno.
 *   No se toca nada — ni siquiera para "arreglar" el otro anclaje: una orden con
 *   `Order.customerId = A` y primario `B` es un estado inconsistente que este camino no
 *   tiene autoridad para resolver, y elegir uno reatribuiría dinero ya cobrado.
 *   `holder` es el anclaje QUE CHOCA, no el "dueño nominal": si la orden dice que es de
 *   nuestro cliente pero la lealtad la cobra otro, lo que el cajero necesita ver es el otro.
 * - `alreadyOurs`: los dos anclajes ya son nuestro cliente. No-op.
 * - `fill`: hay hueco. Se escribe.
 */
function judgeAttribution(estado: OrderAttribution, customerId: string): AttributionVerdict {
  const enConflicto = [estado.orderCustomerId, estado.primaryId].find(a => a != null && a !== customerId)
  if (enConflicto) return { kind: 'conflict', holder: enConflicto }
  if (estado.orderCustomerId === customerId && estado.primaryId === customerId) return { kind: 'alreadyOurs' }
  return { kind: 'fill' }
}

/**
 * Rellena el cliente sobre una orden que YA existe. Sólo RELLENA: nunca reasigna.
 *
 * 🔴 Para qué existe: `/fast` deduplica por `idempotencyKey`. Si el primer intento entró
 * SIN cliente (POS viejo, o el cajero lo eligió después) y el reintento SÍ lo trae, sin
 * esto la venta se queda anónima para siempre — la idempotencia devuelve el pago
 * existente y nadie vuelve a mirar el cliente. Codex lo señaló explícitamente.
 *
 * Rellenar un hueco es aditivo y no toca dinero. **Reasignar no**: cambiar el cliente de
 * una venta ya cerrada movería historial, lealtad y CFDI de una persona a otra por el
 * simple hecho de reenviar un payload viejo. Por eso, si la orden ya tiene OTRO cliente,
 * se devuelve `CONFLICT` y no se escribe nada.
 *
 * Nunca lanza: el pago ya existe y devolverlo no puede fallar por esto.
 */
export async function linkCustomerToExistingOrder(
  venueId: string,
  orderId: string | null | undefined,
  rawCustomerId: unknown,
): Promise<FastPaymentCustomerLink> {
  const requestedCustomerId = normalizeRequestedCustomerId(rawCustomerId)
  if (!requestedCustomerId) return NO_CUSTOMER_REQUESTED

  const unverified: FastPaymentCustomerLink = {
    status: 'UNVERIFIED',
    customerId: null,
    requestedCustomerId,
    warning: WARNING_UNVERIFIED,
  }

  if (!orderId) return unverified

  try {
    const loaded = await loadVenueCustomer(venueId, requestedCustomerId)
    if ('failure' in loaded) {
      return {
        status: loaded.failure,
        customerId: null,
        requestedCustomerId,
        warning: loaded.failure === 'NOT_FOUND' ? WARNING_NOT_FOUND : WARNING_UNVERIFIED,
      }
    }

    const { customer } = loaded

    const estado = await readOrderAttribution(venueId, orderId, customer.id)
    if (!estado) return unverified

    const veredicto = judgeAttribution(estado, customer.id)

    if (veredicto.kind === 'conflict') {
      logger.warn('⚠️ [FastPayment] La venta ya tenía otro cliente — no se reasigna', {
        venueId,
        orderId,
        clienteActual: veredicto.holder,
        clienteSolicitado: customer.id,
      })
      return { status: 'CONFLICT', customerId: veredicto.holder, requestedCustomerId, warning: WARNING_CONFLICT }
    }

    if (veredicto.kind === 'alreadyOurs') {
      // Reintento con el MISMO cliente y todo ya escrito: no-op idempotente.
      return { status: 'LINKED', customerId: customer.id, requestedCustomerId, warning: null }
    }

    try {
      await prisma.$transaction(async tx => {
        if (!estado.ourRow) {
          // 🔴 `isPrimary` NO se hardcodea a `true`: hay un índice único PARCIAL
          // (`OrderCustomer_orderId_isPrimary_unique`, migración 20251211171115) que
          // permite UN solo primario por orden. Escribir `true` a ciegas revienta con
          // P2002 sobre una orden que ya tenía primario. Es exactamente lo que hace la
          // referencia que este módulo espeja (`attachCustomerToOrder`,
          // `order.mobile.service.ts:2823`): `isPrimary: !hasPrimaryCustomer`.
          await tx.orderCustomer.create({ data: { orderId, customerId: customer.id, isPrimary: !estado.primaryId } })
        } else if (!estado.ourRow.isPrimary && !estado.primaryId) {
          // Ya estaba vinculado pero SIN primario en la orden: se promueve, igual que
          // `order.mobile.service.ts:2826-2829`. Sin esto la lealtad (que lee
          // `isPrimary`) y los denormalizados de la orden apuntarían a personas
          // distintas — la atribución partida en dos.
          await tx.orderCustomer.update({ where: { id: estado.ourRow.id }, data: { isPrimary: true } })
        }
        await tx.order.update({
          where: { id: orderId },
          data: {
            customerId: customer.id,
            customerName: customerDisplayName(customer),
            customerPhone: customer.phone || null,
            customerEmail: customer.email || null,
          },
        })
      })
    } catch (err) {
      // 🔴 Carrera perdida contra el índice único parcial: otro escritor se volvió
      // primario entre nuestra lectura y nuestra escritura. NO es "no se pudo verificar"
      // — es que la venta YA tiene dueño. Se le pregunta a la tabla en vez de adivinar
      // (mismo criterio que `verifyDelegatedPaymentLanded`), porque el mensaje honesto
      // aquí importa: decir "la venta se registró sin cliente" cuando sí tiene cliente
      // es mentirle al cajero dos veces.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const relectura = await readOrderAttribution(venueId, orderId, customer.id)
        const veredictoReal = relectura ? judgeAttribution(relectura, customer.id) : null

        if (veredictoReal?.kind === 'conflict') {
          logger.warn('⚠️ [FastPayment] Otro escritor tomó el cliente primario primero — no se reasigna', {
            venueId,
            orderId,
            clienteActual: veredictoReal.holder,
            clienteSolicitado: customer.id,
          })
          return { status: 'CONFLICT', customerId: veredictoReal.holder, requestedCustomerId, warning: WARNING_CONFLICT }
        }
        if (relectura && relectura.owner === customer.id) {
          // La carrera la ganó una petición que escribió EXACTAMENTE lo mismo.
          return { status: 'LINKED', customerId: customer.id, requestedCustomerId, warning: null }
        }
      }
      throw err
    }

    logger.info('✅ [FastPayment] Cliente rellenado sobre una venta que había nacido anónima', {
      venueId,
      orderId,
      customerId: customer.id,
    })

    return { status: 'LINKED', customerId: customer.id, requestedCustomerId, warning: null }
  } catch (err) {
    logger.error('⚠️ [FastPayment] No se pudo rellenar el cliente sobre la venta existente', {
      venueId,
      orderId,
      requestedCustomerId,
      error: err instanceof Error ? err.message : String(err),
    })
    return unverified
  }
}

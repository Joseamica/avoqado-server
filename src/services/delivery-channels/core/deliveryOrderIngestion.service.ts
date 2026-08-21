import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import {
  DeliveryChannelLink,
  Order,
  OrderAcceptanceMode,
  OrderType,
  OriginSystem,
  PaymentFundsFlow,
  PaymentMethod,
  PaymentSource,
  PaymentStatus,
  Prisma,
  SplitType,
  TransactionStatus,
} from '@prisma/client'
import { socketManager } from '../../../communication/sockets/managers/socketManager'
import { SocketEventType } from '../../../communication/sockets/types'
import { dispatchOrderStatus } from './statusDispatcher.service'
import { applySalePosting, createSalePostingInTx } from '../../inventory/inventoryPosting.service'
import { NormalizedDeliveryOrder } from './types'
import { assertDeliveryMoneyInvariants } from './money'
import { ensureDeliveryTenderType } from './deliveryTenderProvisioning.service'
import { toKdsModifierLabels } from '../../mobile/kds.mobile.service'
import {
  assertLegacyCatalogGovernanceForVenue,
  writeLegacyServiceProductCreationAuditForVenue,
} from '../../master-catalog/catalogGovernance.service'

const PLACEHOLDER_CATEGORY_SLUG = 'delivery-desconocido'

const D = (v: string) => new Prisma.Decimal(v)

/**
 * Slug determinístico para el sku placeholder de un item sin externalId: lowercase,
 * no-alfanumérico → '-', recortado a 40 chars. Determinístico (nunca `Date.now()`) para que
 * el MISMO item sin externalId en pedidos distintos reutilice el mismo producto placeholder
 * (`findUnique` por venueId_sku lo encuentra) en vez de crear uno nuevo cada vez.
 */
function toPlaceholderSlug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (cleaned || 'item').slice(0, 40)
}

/**
 * Resuelve el Product.id de Avoqado para un item de delivery por su sku (= Product.sku,
 * externalId del canal o el fallback determinístico si el canal no mandó externalId — ver
 * toPlaceholderSlug). Si el sku no existe en el catálogo (menú desincronizado con el canal),
 * crea un producto placeholder inactivo bajo la categoría `delivery-desconocido`
 * (find-or-create) para no bloquear la ingesta — el staff lo re-mapea después desde el
 * dashboard.
 */
async function resolveProductId(
  tx: Prisma.TransactionClient,
  venueId: string,
  sku: string,
  name: string,
  unitPrice: string,
  /** `{PROVIDER}:{id del item en el catálogo del proveedor}` — la vía preferente. */
  externalIdProveedor?: string | null,
): Promise<string> {
  // 🔴 PRIMERO por el id del proveedor. Es lo que Avoqado escribió al publicar el menú, así
  // que identifica el producto aunque el comercio le cambie el SKU o el nombre después.
  // Buscar sólo por SKU (como hacía antes) creaba un producto placeholder NUEVO en cada
  // pedido de un producto que sí existía en el catálogo.
  if (externalIdProveedor) {
    const porExternalId = await tx.product.findFirst({ where: { venueId, externalId: externalIdProveedor } })
    if (porExternalId) return porExternalId.id
  }

  const existing = await tx.product.findUnique({ where: { venueId_sku: { venueId, sku } } })
  if (existing) return existing.id

  logger.warn(`[🛵 DeliveryIngest] PLU/sku desconocido '${sku}' en venue ${venueId} — creando placeholder`)
  await assertLegacyCatalogGovernanceForVenue(tx, {
    venueId,
    operation: 'CREATE',
    willBeVendable: false,
    actor: { type: 'SERVICE', servicePrincipalId: 'DELIVERY_INGESTION' },
  })
  // WHY: A concurrent ingestion may have created the same deterministic SKU
  // while this transaction waited for the Venue fence; reuse it without a
  // duplicate CREATE audit or a P2002 that would roll back the Order.
  const createdWhileWaiting = await tx.product.findUnique({ where: { venueId_sku: { venueId, sku } } })
  if (createdWhileWaiting) return createdWhileWaiting.id

  let category = await tx.menuCategory.findUnique({ where: { venueId_slug: { venueId, slug: PLACEHOLDER_CATEGORY_SLUG } } })
  if (!category) {
    category = await tx.menuCategory.create({
      data: { venueId, name: 'Delivery (sin mapear)', slug: PLACEHOLDER_CATEGORY_SLUG, active: false },
    })
  }

  const created = await tx.product.create({
    data: {
      venueId,
      createdById: null,
      sku,
      name,
      price: D(unitPrice),
      categoryId: category.id,
      active: false,
    },
  })
  await writeLegacyServiceProductCreationAuditForVenue(tx, {
    venueId,
    productId: created.id,
    actor: { type: 'SERVICE', servicePrincipalId: 'DELIVERY_INGESTION' },
  })
  return created.id
}

/**
 * Convierte una NormalizedDeliveryOrder (contrato unificado, Tarea 2) en una Order real de
 * Avoqado con su Payment externo ya liquidado (Avoqado no procesó el dinero — fee 0
 * explícito) y emite el socket de tiempo real. Patrón calcado de processPosOrderEvent
 * (src/services/pos-sync/posSyncOrder.service.ts): upsert por venueId_externalId para
 * idempotencia, payments guardados detrás de un count===0, y el socket se emite DESPUÉS de
 * que la transacción confirma (su fallo nunca tumba la ingesta).
 */
export async function ingestDeliveryOrder(
  normalized: NormalizedDeliveryOrder,
  link: DeliveryChannelLink,
): Promise<{ order: Order; created: boolean }> {
  // 🔴 Dinero primero: un pedido cuyo reparto no cuadra NUNCA debe tocar la base — se
  // verifica ANTES de resolver el venue o abrir la transacción. Compara también contra los
  // renglones (Hallazgo 2, auditoría externa 2026-08-20): saleAmount debe cuadrar con la suma
  // de los items, no sólo el split consigo mismo.
  assertDeliveryMoneyInvariants(normalized.payment, normalized.items)

  const venue = await prisma.venue.findUnique({ where: { id: link.venueId } })
  if (!venue) throw new Error(`Venue ${link.venueId} del channel link no existe`)

  const p = normalized.payment
  const subtotal = D(p.saleAmount)
  const merchantFees = D(p.merchantFees)
  const tip = D(p.tipAmount)
  // Semántica canónica de la plataforma (decisión founder 2026-08-18, spec §6 "propina
  // dentro/fuera del total"): Order.total NUNCA incluye propina — Payment.tipAmount es la
  // verdad. Antes el total incluía la propina Y `Payment.tipAmount` la repetía: se contaba
  // dos veces. Ese defecto es la razón por la que Uber llegó a tener su propia ingesta.
  const total = subtotal.plus(merchantFees)
  const pagadoExterno = D(p.externallyPaidSale).plus(D(p.externallyPaidTip))
  const porCobrar = D(p.cashDueSale).plus(D(p.cashDueTip))
  const paymentStatus = porCobrar.isZero() ? PaymentStatus.PAID : pagadoExterno.isZero() ? PaymentStatus.PENDING : PaymentStatus.PARTIAL

  // 🔴 El folio del pedido se namespacea por proveedor. `Order.externalId` es único por
  // venue, y dos marketplaces pueden repetir número de pedido: sin el prefijo, el pedido
  // #1234 de Rappi pisaría al #1234 de Uber en el mismo negocio.
  const externalIdNamespaceado = `${link.provider}:${normalized.externalId}`

  // Fuera de la transacción a propósito: crea sus propias filas y es idempotente, así que
  // reintentarlo es inofensivo y no alarga el lock de la orden.
  const tender = await ensureDeliveryTenderType(venue.id, link.provider)

  const existing = await prisma.order.findUnique({
    where: { venueId_externalId: { venueId: venue.id, externalId: externalIdNamespaceado } },
  })
  const isNew = !existing
  // Holder para que TS no estreche la asignación dentro del callback async.
  const postingState: { id: string | null } = { id: null }

  const order = await prisma.$transaction(async tx => {
    const order = await tx.order.upsert({
      where: { venueId_externalId: { venueId: venue.id, externalId: externalIdNamespaceado } },
      update: { posRawData: normalized.raw as Prisma.InputJsonValue, syncedAt: new Date() },
      create: {
        externalId: externalIdNamespaceado,
        orderNumber: normalized.displayId,
        source: normalized.source,
        originSystem: OriginSystem.DELIVERY_PLATFORM,
        type: OrderType.DELIVERY,
        status: 'CONFIRMED', // AUTO-accept: entra confirmada directo a cocina (independiente del dinero)
        kitchenStatus: 'PENDING',
        paymentStatus,
        subtotal,
        // México: el IVA ya va incluido en el precio — el impuesto que reporta el
        // proveedor no es fuente fiscal (spec §5 de Uber, aplicado igual aquí).
        taxAmount: new Prisma.Decimal(0),
        tipAmount: tip,
        total,
        // Partial payment tracking: cuánto liquidó la plataforma vs. cuánto queda por
        // cobrar en persona (efectivo contra entrega).
        paidAmount: pagadoExterno,
        remainingBalance: porCobrar,
        posRawData: normalized.raw as Prisma.InputJsonValue,
        createdAt: normalized.placedAt,
        syncedAt: new Date(),
        venue: { connect: { id: venue.id } },
      },
    })

    if (isNew) {
      // Renglones recién creados: el vale de inventario se arma con ELLOS (ids
      // reales), no con los items normalizados del canal.
      const createdItems: unknown[] = []
      // Índice explícito (no forEach con await): distintos pedidos con payloads idénticos
      // reintentados producen el MISMO índice por línea → externalId sigue siendo idempotente.
      // Necesario porque un pedido puede repetir el mismo externalId en 2 líneas (p.ej.
      // "Taco" solo + "Taco" con extra queso) — usar solo `${externalId}-${item.externalId}`
      // chocaría con @@unique([orderId, externalId]) de OrderItem (P2002) y tumbaría la tx
      // completa, perdiendo el pedido pagado permanentemente (ver C1 en el review original).
      for (let idx = 0; idx < normalized.items.length; idx++) {
        const item = normalized.items[idx]
        // sku determinístico: el externalId del canal, o (si vino vacío) un placeholder
        // derivado del NOMBRE — nunca `Date.now()`, que generaría un producto nuevo por
        // ocurrencia.
        const sku = item.externalId || `delivery-unknown-${toPlaceholderSlug(item.name)}`
        const productId = await resolveProductId(
          tx,
          venue.id,
          sku,
          item.name,
          item.unitPrice,
          item.externalId ? `${link.provider}:${item.externalId}` : null,
        )
        const createdItem = await tx.orderItem.create({
          data: {
            orderId: order.id,
            productId,
            productName: item.name,
            productSku: sku,
            quantity: item.quantity,
            unitPrice: D(item.unitPrice),
            // El mapper del proveedor ya entrega el total de línea (unitPrice×quantity +
            // modificadores) como string decimal — se usa TAL CUAL, sin recomputar aquí.
            total: D(item.total),
            taxAmount: new Prisma.Decimal(0),
            // Nace del canal de delivery, no del POS: los reportes por origen lo separan.
            originSystem: OriginSystem.DELIVERY_PLATFORM,
            externalId: `${externalIdNamespaceado}-${item.externalId || 'noplu'}-${idx}`,
          },
        })
        createdItems.push(createdItem)

        // Modifiers: filas OrderItemModifier reales (contrato unificado, igual que
        // — ya NO texto concatenado en notes (v1 legacy).
        // `modifier.price` ya viene multiplicado por la cantidad del padre (Tarea 2); sólo
        // falta la cantidad PROPIA del modifier para el monto total de esa línea.
        for (const m of item.modifiers ?? []) {
          await tx.orderItemModifier.create({
            data: { orderItemId: createdItem.id, modifierId: null, name: m.name, quantity: m.quantity, price: D(m.price) },
          })
        }
      }

      // 🔴 El bug que este cambio mata: antes `Payment.amount` era `normalized.total`
      // (que YA incluía la propina) y `Payment.tipAmount` la volvía a sumar aparte. Ahora
      // el reparto es explícito: `amount` = la venta liquidada por la plataforma, SIN
      // propina; `tipAmount` = la propina liquidada, aparte. `netAmount` se ajusta igual
      // (Avoqado no cobra fee sobre este dinero, así que netAmount == amount).
      if (pagadoExterno.greaterThan(0)) {
        const existingPayments = await tx.payment.count({ where: { orderId: order.id } })
        if (existingPayments === 0) {
          const payment = await tx.payment.create({
            data: {
              amount: D(p.externallyPaidSale),
              tipAmount: D(p.externallyPaidTip),
              method: PaymentMethod.OTHER,
              source: PaymentSource.DELIVERY_PLATFORM,
              // 🔴 La plataforma liquida este dinero, NO Avoqado. `fundsFlow` es la ÚNICA
              // autoridad de esa pregunta (`shared/tenderSemantics.ts`): sin él, este cobro
              // se contaría como efectivo esperado en el cajón y el arqueo no cuadraría.
              fundsFlow: PaymentFundsFlow.EXTERNAL_RECORDED,
              // Tipo de pago del canal (auto-provisionado, idempotente): es el snapshot que
              // `shared/tenderSemantics.ts` lee para responder "¿está en el cajón?" y
              // "¿lo deposita Avoqado?". Sin él, el pago cae al fallback legacy.
              tenderType: { connect: { id: tender.id } },
              tenderRevision: tender.revision,
              externalSource: normalized.source, // 'UBER_EATS' | 'RAPPI' | ...
              status: TransactionStatus.COMPLETED,
              splitType: SplitType.FULLPAYMENT,
              processor: link.provider.toLowerCase(),
              // Avoqado NO procesó este dinero: fee 0, neto = monto. La comisión de la
              // plataforma es entre restaurante y plataforma (fuera de Avoqado).
              feePercentage: new Prisma.Decimal(0),
              feeAmount: new Prisma.Decimal(0),
              netAmount: D(p.externallyPaidSale),
              originSystem: OriginSystem.DELIVERY_PLATFORM,
              externalId: `${externalIdNamespaceado}-platform`,
              posRawData: normalized.raw as Prisma.InputJsonValue,
              venue: { connect: { id: venue.id } },
              order: { connect: { id: order.id } },
            },
          })
          await tx.paymentAllocation.create({
            data: { amount: payment.amount, payment: { connect: { id: payment.id } }, order: { connect: { id: order.id } } },
          })
        }
      }

      // Inventario: el pedido entra PAGADO EN SU TOTALIDAD (nada por cobrar en persona)
      // con renglones resueltos a productos REALES del catálogo, así que descuenta como
      // cualquier otra venta — decisión del founder (2026-08-16) con paridad Toast/Square,
      // donde un pedido de tercero es una orden más y deplete el stock igual. Regla de la
      // plataforma: "stock deduction ONLY when fully paid" — por eso se gatea en
      // porCobrar.isZero(), no en "hubo algún pago externo" (eso permitiría descontar un
      // pedido parcialmente pagado).
      //
      // El vale nace en ESTA transacción (si la ingesta se cae, no queda un descuento
      // huérfano) y se aplica tras el commit.
      if (porCobrar.isZero()) {
        const posting = await createSalePostingInTx(tx, {
          venueId: venue.id,
          orderId: order.id,
          items: createdItems as any,
        })
        postingState.id = posting?.id ?? null
      }
    }
    return order
  })

  // Aplicar el descuento YA COMMITEADA la ingesta. Nunca puede tumbar un pedido
  // que el canal ya cobró: si truena, el vale queda pendiente y el sweeper lo
  // retoma. El pedido es un hecho; la deducción es reintentable.
  if (postingState.id) {
    try {
      await applySalePosting(postingState.id, null)
    } catch (error) {
      logger.error('⚠️ No se pudo aplicar el descuento de inventario del pedido de delivery (el pedido sigue en pie)', {
        orderId: order.id,
        postingId: postingState.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 🔴 QUE LLEGUE A LA COCINA. El KDS lee de su PROPIA tabla (`KdsOrder`), no de `Order`, y
  // hasta hoy sólo se llenaba cuando un cliente llamaba el endpoint a mano — cosa que un
  // pedido de marketplace no tiene quién haga. Resultado medido el 2026-08-20: el pedido
  // real de Uber (#77645) quedó CONFIRMED con CERO filas de KDS. O sea: lo aceptamos en
  // Uber, el cliente esperando su comida, y la cocina sin enterarse.
  //
  // Sólo en la PRIMERA ingesta: una actualización de un pedido ya en marcha no puede
  // reimprimir la comanda ni duplicarla en la pantalla.
  //
  // NO FATAL y fuera de la transacción, igual que el socket: si el KDS falla, la venta ya
  // está guardada y el pedido sigue apareciendo en la lista de órdenes. Perder la venta por
  // no poder pintar un ticket sería peor que el problema que resuelve. Pero el log es
  // `error` y no `warn` a propósito: que no llegue a la cocina es grave, no cosmético.
  if (isNew) {
    try {
      await prisma.kdsOrder.create({
        data: {
          venueId: venue.id,
          orderNumber: order.orderNumber,
          orderType: 'DELIVERY',
          orderId: order.id,
          items: {
            create: normalized.items.map(it => ({
              productName: it.name,
              quantity: it.quantity,
              // 🔴 Por el normalizador COMPARTIDO, nunca serializando la forma del proveedor.
              // Guardar aquí `[{name, quantity}]` mientras el POS guardaba `["texto"]` en la
              // MISMA columna llegó hasta la cocina: Android pintó el JSON crudo y iOS perdió
              // el modificador en silencio (visto en una Sunmi D3 con un pedido real de Uber).
              modifiers: it.modifiers?.length ? JSON.stringify(toKdsModifierLabels(it.modifiers)) : null,
              // Lo que el cliente escribió para este renglón. Es lo que separa servir bien
              // de servir mal, y el único lugar del sistema donde hoy sobrevive.
              notes: it.notes ?? null,
            })),
          },
        },
      })
    } catch (error) {
      logger.error('[❌ DeliveryIngest] el pedido NO llegó a la cocina (venta guardada, comanda no)', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        venueId: venue.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  try {
    socketManager.broadcastToVenue(venue.id, isNew ? SocketEventType.ORDER_CREATED : SocketEventType.ORDER_UPDATED, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      venueId: venue.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      source: order.source,
      externalId: order.externalId,
      eventType: isNew ? 'created' : 'updated',
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error('[❌ DeliveryIngest] Socket emit falló (no fatal)', { orderId: order.id, error })
  }

  // Modo AUTO: el pedido ya entró CONFIRMED (arriba, status del create) — le avisamos al
  // canal que lo aceptamos. Solo en la primera ingesta (isNew): una actualización de un
  // pedido ya aceptado jamás debe re-disparar el accept. Doble defensa: dispatchOrderStatus
  // YA traga sus propios errores (statusDispatcher.service.ts), pero este try/catch +
  // .catch() asegura que NADA de esta llamada (ni siquiera un throw síncrono al invocarla)
  // tumbe la ingesta — el pedido ya está persistido, eso jamás se revierte por un fallo aquí.
  if (isNew && link.orderAcceptanceMode === OrderAcceptanceMode.AUTO) {
    try {
      void dispatchOrderStatus(order, 'ACCEPTED', link).catch(error => {
        logger.error('[❌ DeliveryIngest] AUTO-accept dispatch falló (async, no fatal)', {
          orderId: order.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      })
    } catch (error) {
      logger.error('[❌ DeliveryIngest] AUTO-accept dispatch falló al invocar (sync, no fatal)', {
        orderId: order.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  return { order, created: isNew }
}

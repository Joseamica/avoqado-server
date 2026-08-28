import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import {
  DeliveryChannelLink,
  Order,
  OrderAcceptanceMode,
  OrderStatus,
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
import { computeTenderCommission } from '../../dashboard/tenderType.dashboard.service'
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
): Promise<{ order: Order; created: boolean; kitchenTicketCreated: boolean }> {
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

  // 🔴 Sin comisión configurada, los reportes de este negocio SOBREESTIMAN su ingreso: la
  // venta entra completa y lo que el marketplace se queda no aparece en ningún lado. No se
  // inventa un porcentaje —cada comercio negocia el suyo— pero tampoco se calla.
  if (tender.commissionPercent == null) {
    logger.warn('⚠️ [DeliveryIngest] el tipo de pago del canal NO tiene comisión configurada — los reportes sobreestiman el ingreso', {
      venueId: venue.id,
      provider: link.provider,
      tenderTypeId: tender.id,
      accion: 'configúrala en Ajustes → Tipos de pago (el comercio negocia su % con el proveedor)',
    })
  }

  // 🔴 "¿Es nueva?" se resuelve DENTRO de la transacción, junto al upsert que la crea
  // (hallazgo de Codex). Preguntándolo antes, dos procesadores del mismo pedido leían los dos
  // "no existe", los dos creían haberla creado, y el perdedor chocaba contra los renglones
  // únicos — con el pedido ya aceptado en Uber. Dentro de la transacción la lectura y la
  // escritura son el mismo instante lógico.
  // (La concurrencia realista ya está acotada por dos lados: el ingreso del webhook descarta
  //  el duplicado con su índice único, y el job de reconciliación ya no se encima consigo
  //  mismo. Esto cierra el resto.)
  const nuevaState: { valor: boolean } = { valor: false }
  // Holder para que TS no estreche la asignación dentro del callback async.
  const postingState: { id: string | null } = { id: null }
  // Fuera de la transacción a propósito: la comanda se arma DESPUÉS y necesita los productos
  // que se resolvieron adentro, para poder rutear cada renglón a su estación.
  const renglonesCreados: Array<{ productId: string | null }> = []

  const order = await prisma.$transaction(
    async tx => {
      const yaExistia = await tx.order.findUnique({
        where: { venueId_externalId: { venueId: venue.id, externalId: externalIdNamespaceado } },
        select: { id: true },
      })
      nuevaState.valor = !yaExistia
      // Nombre local para el resto de la transacción. El de afuera se declara al cerrarla.
      const esNueva = nuevaState.valor

      const order = await tx.order.upsert({
        where: { venueId_externalId: { venueId: venue.id, externalId: externalIdNamespaceado } },
        update: { posRawData: normalized.raw as Prisma.InputJsonValue, syncedAt: new Date() },
        create: {
          externalId: externalIdNamespaceado,
          orderNumber: normalized.displayId,
          source: normalized.source,
          originSystem: OriginSystem.DELIVERY_PLATFORM,
          type: OrderType.DELIVERY,
          scheduledFor: normalized.scheduledFor ?? null,
          // 🔴 CONFIRMED significa "ya le dijimos que sí al proveedor". En modo MANUAL NO se lo
          // dijimos —nadie lo ha aceptado todavía— y marcarlo confirmado era una mentira con
          // tres consecuencias: el POS no podía saber cuáles falta aceptar, el tablero decía
          // que todo iba bien mientras el reloj de 11.5 min corría, y `denyDeliveryOrder`
          // elegía CANCELAR en vez de RECHAZAR (protocolo equivocado y peor para el cliente,
          // que ya creía tener su pedido confirmado).
          status: link.orderAcceptanceMode === OrderAcceptanceMode.MANUAL ? OrderStatus.PENDING : OrderStatus.CONFIRMED,
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

      if (esNueva) {
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
          // `externalData` es el SKU que Avoqado escribió al publicar el menú; el
          // `externalId` pertenece al catálogo del proveedor. Resolverlos al revés crea
          // placeholders para productos que sí existen (Rappi devuelve ambos campos).
          // Si el proveedor no devuelve nuestro SKU, el id externo sigue siendo el fallback
          // determinístico — nunca `Date.now()`, que generaría un producto por ocurrencia.
          const sku = item.externalData || item.externalId || `delivery-unknown-${toPlaceholderSlug(item.name)}`
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
              // 🔴 La instrucción del cliente ("Sin cebolla, por favor") — el mapper la extrae y
              // ANTES se perdía aquí: la comanda salía sin ella y la cocina preparaba el platillo
              // equivocado. Encontrado con un pedido REAL del sandbox (D8180, 27-ago); ningún
              // test lo vio porque todos verifican al mapper, y el mapper estaba bien.
              notes: item.notes ?? null,
              // Nace del canal de delivery, no del POS: los reportes por origen lo separan.
              originSystem: OriginSystem.DELIVERY_PLATFORM,
              externalId: `${externalIdNamespaceado}-${item.externalId || 'noplu'}-${idx}`,
            },
          })
          createdItems.push(createdItem)
          renglonesCreados.push({ productId: createdItem.productId })

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
                // 🔴 LA COMISIÓN DEL MARKETPLACE, congelada en el cobro igual que hace el TPV.
                //
                // Sin esto, los cortes, reportes y contabilidad del negocio mostraban la venta
                // COMPLETA como ingreso: $100 de Uber se veían como $100 cuando Uber deposita
                // ~$70. El dueño creía ganar 30% más de lo que gana, en cada pedido, para
                // siempre — y lo descubría cuando el depósito no cuadraba con sus números.
                //
                // El porcentaje sale del tipo de pago del canal, que el dueño edita en la
                // pantalla de tipos de pago (`VenueTenderType.commissionPercent`, cuyo propio
                // comentario en el schema dice literalmente "e.g. Uber ~30%"). Se congela aquí
                // y no se lee después: si mañana renegocia su comisión, los pedidos viejos
                // deben seguir contando lo que de verdad les costó.
                tenderCommissionPercent: tender.commissionPercent,
                tenderCommissionAmount: computeTenderCommission(tender.commissionPercent, D(p.externallyPaidSale)),
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
      // El default de Prisma (5 s) NO alcanza con la máquina cargada: un pedido REAL de Uber
      // murió a los 5,056 ms a media transacción y el canal nunca lo aceptó. Ingerir un pedido
      // que el canal YA cobró no puede perderse por lentitud del host.
    },
    { timeout: 20_000, maxWait: 10_000 },
  )

  // Lo decidió la transacción (ver `nuevaState` arriba). Va AQUÍ, pegado a su cierre, y no
  // más abajo: declararlo después de su primer uso compila igual y revienta en runtime con
  // "Cannot access 'isNew' before initialization" — lo cazaron los tests, no el typecheck.
  const isNew = nuevaState.valor

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
  // 🔴 Un pedido PROGRAMADO no va a la cocina todavía. El cliente lo pidió a las 3pm para
  // las 8pm: cocinarlo al recibirlo tira la comida y ocupa la pantalla toda la tarde con algo
  // que no toca. La comanda se crea cuando el proveedor avisa que ya es hora
  // (`releaseScheduledOrder`, disparado por `orders.release`).
  if (isNew && normalized.scheduledFor) {
    logger.info('🕗 [DeliveryIngest] pedido PROGRAMADO — no va a cocina hasta su hora', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      para: normalized.scheduledFor.toISOString(),
    })
  }

  // Una sola consulta para las categorías de todos los renglones: el ruteo las necesita y
  // pedirlas una por una multiplicaría los viajes a la base en el camino de un pedido.
  //
  // 🔴 Y va envuelta: esta búsqueda sólo sirve para que la comanda salga en la impresora
  // correcta. Si falla, lo que se pierde es el ruteo —el renglón cae al ticket "SIN
  // ESTACIÓN", que igual se imprime—. Dejarla propagar tumbaría la INGESTA COMPLETA del
  // pedido: el cliente ya pagó en Uber y su venta no existiría en el sistema, por no haber
  // podido averiguar a qué categoría pertenece un taco.
  // Las categorías de todos los renglones en UNA consulta: el ruteo de impresión las
  // necesita, y pedirlas una por una multiplicaría los viajes a la base en el camino de un
  // pedido que ya está pagado.
  //
  // 🔴 Y va envuelta en try/catch a propósito. Esta búsqueda sólo sirve para que la comanda
  // salga en la impresora correcta; si falla, lo que se pierde es el ruteo —el renglón cae
  // al ticket "SIN ESTACIÓN", que igual se imprime—. Dejarla propagar tumbaría la INGESTA
  // COMPLETA: el cliente ya pagó en Uber y su venta no existiría en el sistema, por no haber
  // podido averiguar a qué categoría pertenece un taco.

  // 🔴 En un REINTENTO (la venta ya existía) `renglonesCreados` viene VACÍO: se llena sólo
  // dentro de la transacción que crea los renglones. Sin esto, la comanda repuesta más abajo
  // volvía sin `productId` ni `categoryId` — o sea sin ruteo: todo al ticket "SIN ESTACIÓN"
  // en vez de a la cocina y la barra que corresponden (hallazgo de Codex, 2ª pasada). Se
  // releen los renglones que YA existen, en el mismo orden en que se crearon.
  if (renglonesCreados.length === 0) {
    try {
      // 🔴 NO por `createdAt`: los renglones se crean dentro de UNA transacción y pueden
      // compartir marca de tiempo, así que ese orden no es estable — y si se desordena, la
      // comanda rutea el renglón equivocado a la estación equivocada. Se aparea por el
      // ÍNDICE que el propio `externalId` lleva al final (`…-<idx>`), que es determinista.
      const yaExistentes = await prisma.orderItem.findMany({
        where: { orderId: order.id },
        select: { productId: true, externalId: true },
      })
      const porIndice = new Map<number, string | null>()
      for (const r of yaExistentes) {
        const m = /-(\d+)$/.exec(r.externalId ?? '')
        if (m) porIndice.set(Number(m[1]), r.productId)
      }
      for (let idx = 0; idx < normalized.items.length; idx++) {
        renglonesCreados.push({ productId: porIndice.get(idx) ?? null })
      }
    } catch {
      // Mismo criterio que abajo: sin ruteo se imprime igual; sin comanda, no.
    }
  }

  const idsProducto = renglonesCreados.map(i => i.productId).filter((v): v is string => Boolean(v))
  const categoriaPorProducto = new Map<string, string | null>()
  if (idsProducto.length) {
    try {
      const filas = await prisma.product.findMany({ where: { id: { in: idsProducto } }, select: { id: true, categoryId: true } })
      for (const p of filas ?? []) categoriaPorProducto.set(p.id, p.categoryId)
    } catch (error) {
      logger.warn('[DeliveryIngest] no se pudieron leer las categorías para rutear la comanda (se imprime sin estación)', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  let kitchenTicketCreated = false
  // 🔴 NO basta con `isNew` (hallazgo de Codex, 27-ago). Los webhooks son at-least-once y la
  // comanda se crea FUERA de la transacción que guardó la venta: si el proceso muere entre
  // las dos, el reintento ve la orden ya existente (`isNew=false`), se salta la comanda y
  // marca el evento como procesado. Resultado: un pedido cobrado que la cocina nunca ve, sin
  // un solo error en el log. Se repone comprobando si la comanda existe de verdad.
  // (`KdsOrder.orderId` no es único, así que dos procesadores simultáneos podrían crear dos;
  //  es un empate mucho menos dañino que no imprimir nada, y el mismo que ya existía.)
  const comandaYaExiste = isNew ? false : (await prisma.kdsOrder.count({ where: { orderId: order.id } })) > 0
  if (!comandaYaExiste && !normalized.scheduledFor) {
    try {
      await prisma.kdsOrder.create({
        data: {
          venueId: venue.id,
          orderNumber: order.orderNumber,
          orderType: 'DELIVERY',
          orderId: order.id,
          items: {
            create: normalized.items.map((it, idx) => ({
              productName: it.name,
              quantity: it.quantity,
              // Los ids que hacen RUTEABLE la comanda: sin ellos, los tacos y la cerveza
              // salen en el mismo papel. `renglonesCreados` ya trae el producto que resolvió la
              // transacción de arriba — no se vuelve a buscar. Se aparean por índice porque
              // se crearon recorriendo `normalized.items` en este mismo orden.
              productId: renglonesCreados[idx]?.productId ?? null,
              categoryId: categoriaPorProducto.get(renglonesCreados[idx]?.productId ?? '') ?? null,
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
      kitchenTicketCreated = true
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

  return { order, created: isNew, kitchenTicketCreated }
}

/**
 * Credit Pack Mobile Service (iOS/Android POS — staff-facing)
 *
 * The public/consumer flow (creditPack.public.service.ts) sells packs online via
 * Stripe Checkout. In the POS the staff sells a pack IN PERSON — the customer pays
 * through the normal POS (cash/terminal) and this grants the credits directly, with
 * no Stripe session. Listing, balance and redemption reuse the existing services;
 * only the in-person grant is new here.
 */

import { Prisma, CreditPurchaseStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '@/utils/serializableRetry'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import type { CreditPackSnapshot } from '@/services/shared/creditPacksOnPaidOrder'

type PackWithItems = {
  id: string
  venueId: string
  price: Prisma.Decimal | number
  active: boolean
  validityDays: number | null
  maxPerCustomer: number | null
  /** `id` = el `CreditPackItem` del catálogo (POS y kiosco lo mandan). `null` = renglón nacido de la FOTO (0.d). */
  items: { id: string | null; productId: string; quantity: number }[]
}

/**
 * Concede el paquete DENTRO de una transacción ya abierta.
 *
 * El tope por cliente se cuenta aquí —no antes— a propósito: contarlo fuera es la
 * carrera que deja pasar dos compras simultaneas, porque las dos leen el mismo
 * conteo antes de que ninguna escriba. Con el conteo adentro y aislamiento
 * Serializable, la segunda ve a la primera o la transacción se reintenta.
 *
 * `orderItemId` ata la compra al renglón que la vendió (su unicidad es la llave de la entrega desde la foto, 0.d).
 * `countSpend: false` no suma a `totalSpent`: lo usa esa entrega porque el cobro de la orden ya lo cuenta.
 * `deliveryKey` es la llave de la entrega del POS: su unicidad por negocio deja a lo más una compra (D4).
 */
export async function grantPackInTx(
  tx: TxConReintento,
  args: {
    pack: PackWithItems
    venueId: string
    customerId: string
    staffId?: string | null
    amountPaid: Prisma.Decimal
    paymentId?: string | null
    orderItemId?: string | null
    deliveryKey?: string | null
    note?: string
    countSpend?: boolean
  },
) {
  const { pack, venueId, customerId, staffId, amountPaid, paymentId, orderItemId, deliveryKey, note, countSpend = true } = args

  if (pack.maxPerCustomer != null) {
    const priorCount = await tx.creditPackPurchase.count({
      where: {
        venueId,
        customerId,
        creditPackId: pack.id,
        status: { not: CreditPurchaseStatus.REFUNDED },
      },
    })
    if (priorCount >= pack.maxPerCustomer) {
      throw new BadRequestError(`El cliente alcanzó el máximo de ${pack.maxPerCustomer} compra(s) de este paquete`)
    }
  }

  const expiresAt = pack.validityDays ? new Date(Date.now() + pack.validityDays * 24 * 60 * 60 * 1000) : null

  const newPurchase = await tx.creditPackPurchase.create({
    data: {
      venueId,
      customerId,
      creditPackId: pack.id,
      amountPaid,
      expiresAt,
      status: CreditPurchaseStatus.ACTIVE,
      ...(paymentId ? { paymentId } : {}),
      ...(orderItemId ? { orderItemId } : {}),
      ...(deliveryKey ? { deliveryKey } : {}),
    },
  })

  for (const item of pack.items) {
    const balance = await tx.creditItemBalance.create({
      data: {
        creditPackPurchaseId: newPurchase.id,
        creditPackItemId: item.id,
        productId: item.productId,
        originalQuantity: item.quantity,
        remainingQuantity: item.quantity,
      },
    })

    await tx.creditTransaction.create({
      data: {
        venueId,
        customerId,
        creditPackPurchaseId: newPurchase.id,
        creditItemBalanceId: balance.id,
        type: 'PURCHASE',
        quantity: item.quantity,
        reason: note,
        createdById: staffId ?? undefined,
      },
    })
  }

  if (countSpend) {
    await tx.customer.update({
      where: { id: customerId },
      data: { totalSpent: { increment: amountPaid } },
    })
  }

  return newPurchase
}

const PURCHASE_INCLUDE = {
  creditPack: { select: { name: true } },
  itemBalances: {
    include: { product: { select: { id: true, name: true, imageUrl: true } } },
  },
} as const

/**
 * La compra que ya hizo esta llave, si la hay. Es de otro paquete o de otro cliente sólo si alguien reusó la llave: nunca se
 * contesta una compra ajena como si fuera la suya.
 */
async function compraDeLaLlave(venueId: string, deliveryKey: string, packId: string, customerId: string) {
  const compra = await prisma.creditPackPurchase.findUnique({
    where: { venueId_deliveryKey: { venueId, deliveryKey } },
    include: PURCHASE_INCLUDE,
  })
  if (compra && (compra.creditPackId !== packId || compra.customerId !== customerId)) {
    throw new ConflictError('Esa llave de entrega ya se usó en otra venta')
  }
  return compra
}

/**
 * Grant a credit pack to a customer after an in-person sale. Mirrors
 * fulfillPurchase's creation (purchase + per-item balances + PURCHASE ledger
 * entries + customer.totalSpent) but records the POS payment instead of a Stripe
 * session. `amountPaid` defaults to the pack's list price.
 *
 * 🔴 D4 (5-nov): con `deliveryKey` la entrega es idempotente. La llave se mira ANTES que el paquete y el cliente: si se perdió
 * la respuesta y la dueña apagó el paquete mientras, el reintento contesta la misma compra, no un rechazo.
 * Sin llave (apps viejas, iOS, MCP) cada llamada crea una compra, como siempre.
 *
 * Con `cobradoEnOrden` (D17, 5-nov) el paquete se cobró en una orden del carrito, cuyo cobro ya sumó al «Total gastado» del
 * cliente: la entrega no lo vuelve a sumar. Sin él (ficha del cliente, que cobra a mano sin orden; apps viejas; MCP) suma como siempre.
 * A propósito (founder, 6-nov, «A»): el gasto del paquete es de quien figura en la venta, como cualquier producto. Si a media
 * venta dividida cambian de cliente, el receptor del paquete no suma gasto: comprobarlo aquí reabría el doble (Codex r3).
 *
 * Con `foto` (la que firmó este servidor, ver `leerFotoDelPaquete`) se entrega lo VENDIDO aunque el paquete ya cambió o se apagó:
 * el dinero ya entró. El tope por cliente sí se revisa, con el valor vigente: es una regla del negocio, no parte de lo vendido.
 */
export async function sellPackInPerson(
  venueId: string,
  packId: string,
  customerId: string,
  staffId: string,
  opts?: { note?: string; deliveryKey?: string; foto?: CreditPackSnapshot | null; cobradoEnOrden?: boolean },
) {
  const deliveryKey = opts?.deliveryKey
  if (deliveryKey) {
    const previa = await compraDeLaLlave(venueId, deliveryKey, packId, customerId)
    if (previa) {
      logger.info('⏭️ [CREDIT PACK] Llave ya entregada: se contesta la misma compra', { purchaseId: previa.id, venueId, deliveryKey })
      return previa
    }
  }

  const pack = await prisma.creditPack.findUnique({
    where: { id: packId },
    include: { items: true },
  })
  if (!pack || pack.venueId !== venueId) throw new NotFoundError('Paquete no encontrado')
  const foto = opts?.foto?.creditPackId === packId ? opts.foto : null
  if (!foto) {
    if (!pack.active) throw new BadRequestError('El paquete no está activo')
    if (pack.items.length === 0) throw new BadRequestError('El paquete no incluye artículos')
  }

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
    select: { id: true },
  })
  if (!customer) throw new NotFoundError('Cliente no encontrado')

  if (foto) {
    // SIN filtrar active/deletedAt: un producto archivado se entrega igual; sólo falta si se borró de verdad o es de otro negocio.
    const ids = foto.items.map(i => i.productId)
    const productos = await prisma.product.findMany({ where: { id: { in: ids }, venueId }, select: { id: true }, take: ids.length })
    if (productos.length !== ids.length) throw new BadRequestError('Un producto del paquete vendido ya no existe en este negocio')
  }

  // 🔴 El monto lo pone el SERVIDOR, nunca quien llama. Antes venía en el body
  // (`opts.amountPaid`), así que un cliente podía acreditarse un paquete de $1,500
  // declarando que pagó $1 — y `Customer.totalSpent` y los reportes se lo creían.
  // Para una venta con descuento real existe el otro carril: el cobro se registra
  // como Payment y se acredita con `fulfillCreditPackPurchaseFromPayment`, que toma
  // el monto del cobro. La foto también es del servidor: sólo llega aquí si él la firmó.
  const amountPaid = new Prisma.Decimal(foto?.price ?? pack.price)
  const vendido: PackWithItems = foto
    ? {
        id: pack.id,
        venueId,
        price: amountPaid,
        active: true,
        validityDays: foto.validityDays,
        maxPerCustomer: pack.maxPerCustomer,
        items: foto.items.map(i => ({ id: null, productId: i.productId, quantity: i.quantity })),
      }
    : (pack as PackWithItems)

  let purchase
  try {
    purchase = await withDeadlockRetry(
      async tx =>
        grantPackInTx(tx, {
          pack: vendido,
          venueId,
          customerId,
          staffId,
          amountPaid,
          deliveryKey,
          note: opts?.note,
          // 🔴 D17: vendido desde el carrito, el cobro de la orden ya sumó al «Total gastado»; aquí no se repite.
          countSpend: !opts?.cobradoEnOrden,
        }),
      { etiqueta: 'sellPackInPerson', isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  } catch (err) {
    // Dos a la vez con la misma llave: pasa una sola. La perdedora tropieza con el índice único (P2002), con la serialización
    // (P2034) o con el tope que ya cuenta a la ganadora; sea cual sea, si la llave ya tiene compra, ésa es la respuesta.
    const ganadora = deliveryKey ? await compraDeLaLlave(venueId, deliveryKey, packId, customerId) : null
    if (ganadora) return ganadora
    throw err
  }

  logger.info('✅ [CREDIT PACK] In-person sale', { purchaseId: purchase.id, venueId, packId, customerId, staffId })

  const enriched = await prisma.creditPackPurchase.findUnique({
    where: { id: purchase.id },
    include: PURCHASE_INCLUDE,
  })
  return enriched ?? purchase
}

/**
 * Acredita un paquete DESPUES de un cobro real (POS / terminal PAX / kiosco).
 *
 * Es el gemelo en persona de `fulfillPurchase` (Stripe): allí la idempotencia la da
 * `stripeCheckoutSessionId @unique`; aquí la da `paymentId @unique`. Importa porque el
 * kiosco conserva el mismo `requestId` del PAX tras un timeout y vuelve a preguntar: sin
 * esta llave, el mismo cobro acreditaba el paquete dos veces.
 *
 * El monto sale del COBRO, no de quien llama — así un descuento aplicado en el POS queda
 * reflejado tal cual, sin abrir la puerta a que el body decida cuánto se pagó.
 */
export async function fulfillCreditPackPurchaseFromPayment(args: {
  paymentId: string
  venueId: string
  packId: string
  customerId: string
  staffId?: string | null
  note?: string
}) {
  const { paymentId, venueId, packId, customerId, staffId, note } = args

  // Idempotencia: este cobro ya acreditó su paquete.
  const already = await prisma.creditPackPurchase.findUnique({ where: { paymentId } })
  if (already) {
    logger.info('⏭️ [CREDIT PACK] Cobro ya acreditado', { paymentId, purchaseId: already.id })
    return already
  }

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, venueId: true, status: true, amount: true },
  })
  if (!payment) throw new NotFoundError('Cobro no encontrado')
  if (payment.venueId !== venueId) throw new NotFoundError('Cobro no encontrado')
  if (payment.status !== 'COMPLETED') {
    throw new BadRequestError('El cobro todavía no está completado')
  }

  const pack = await prisma.creditPack.findFirst({ where: { id: packId, venueId }, include: { items: true } })
  if (!pack) throw new NotFoundError('Paquete no encontrado')
  if (!pack.active) throw new BadRequestError('El paquete no está activo')
  if (pack.items.length === 0) throw new BadRequestError('El paquete no incluye artículos')

  const customer = await prisma.customer.findFirst({ where: { id: customerId, venueId }, select: { id: true } })
  if (!customer) throw new NotFoundError('Cliente no encontrado')

  const amountPaid = new Prisma.Decimal(payment.amount)

  let purchase
  try {
    purchase = await withDeadlockRetry(
      async tx => grantPackInTx(tx, { pack: pack as PackWithItems, venueId, customerId, staffId, amountPaid, paymentId, note }),
      { etiqueta: 'fulfillCreditPackPurchaseFromPayment', isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  } catch (err) {
    // Dos llamadas a la vez con el mismo cobro: la unicidad de `paymentId` deja pasar
    // una sola. La perdedora devuelve la compra que sí quedó, no un error.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.creditPackPurchase.findUnique({ where: { paymentId } })
      if (winner) return winner
    }
    throw err
  }

  logger.info('✅ [CREDIT PACK] Acreditado desde cobro', { purchaseId: purchase.id, paymentId, venueId, packId, customerId })

  const enriched = await prisma.creditPackPurchase.findUnique({
    where: { id: purchase.id },
    include: PURCHASE_INCLUDE,
  })
  return enriched ?? purchase
}

/**
 * A customer's ACTIVE, non-expired credit balances, by customerId (the POS already
 * knows the customer). Shape mirrors the public lookupCustomerCredits so the client
 * can reuse the same decoding.
 */
export async function getCustomerCreditsById(venueId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  })
  if (!customer) throw new NotFoundError('Cliente no encontrado')

  const purchases = await prisma.creditPackPurchase.findMany({
    where: {
      venueId,
      customerId,
      status: CreditPurchaseStatus.ACTIVE,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: {
      creditPack: { select: { name: true } },
      itemBalances: {
        where: { remainingQuantity: { gt: 0 } },
        include: { product: { select: { id: true, name: true, type: true, imageUrl: true } } },
      },
    },
    orderBy: { expiresAt: 'asc' },
  })

  return {
    customer,
    purchases: purchases.filter(p => p.itemBalances.length > 0),
  }
}

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
import logger from '@/config/logger'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

type PackWithItems = {
  id: string
  venueId: string
  price: Prisma.Decimal | number
  active: boolean
  validityDays: number | null
  maxPerCustomer: number | null
  items: { id: string; productId: string; quantity: number }[]
}

/**
 * Concede el paquete DENTRO de una transacción ya abierta.
 *
 * El tope por cliente se cuenta aquí —no antes— a propósito: contarlo fuera es la
 * carrera que deja pasar dos compras simultaneas, porque las dos leen el mismo
 * conteo antes de que ninguna escriba. Con el conteo adentro y aislamiento
 * Serializable, la segunda ve a la primera o la transacción se reintenta.
 */
async function grantPackInTx(
  tx: Prisma.TransactionClient,
  args: {
    pack: PackWithItems
    venueId: string
    customerId: string
    staffId?: string | null
    amountPaid: Prisma.Decimal
    paymentId?: string | null
    note?: string
  },
) {
  const { pack, venueId, customerId, staffId, amountPaid, paymentId, note } = args

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

  await tx.customer.update({
    where: { id: customerId },
    data: { totalSpent: { increment: amountPaid } },
  })

  return newPurchase
}

const PURCHASE_INCLUDE = {
  creditPack: { select: { name: true } },
  itemBalances: {
    include: { product: { select: { id: true, name: true, imageUrl: true } } },
  },
} as const

/**
 * Grant a credit pack to a customer after an in-person sale. Mirrors
 * fulfillPurchase's creation (purchase + per-item balances + PURCHASE ledger
 * entries + customer.totalSpent) but records the POS payment instead of a Stripe
 * session. `amountPaid` defaults to the pack's list price.
 */
export async function sellPackInPerson(
  venueId: string,
  packId: string,
  customerId: string,
  staffId: string,
  opts?: { note?: string },
) {
  const pack = await prisma.creditPack.findUnique({
    where: { id: packId },
    include: { items: true },
  })
  if (!pack || pack.venueId !== venueId) throw new NotFoundError('Paquete no encontrado')
  if (!pack.active) throw new BadRequestError('El paquete no está activo')
  if (pack.items.length === 0) throw new BadRequestError('El paquete no incluye artículos')

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
    select: { id: true },
  })
  if (!customer) throw new NotFoundError('Cliente no encontrado')

  // 🔴 El monto lo pone el SERVIDOR, nunca quien llama. Antes venía en el body
  // (`opts.amountPaid`), así que un cliente podía acreditarse un paquete de $1,500
  // declarando que pagó $1 — y `Customer.totalSpent` y los reportes se lo creían.
  // Para una venta con descuento real existe el otro carril: el cobro se registra
  // como Payment y se acredita con `fulfillCreditPackPurchaseFromPayment`, que toma
  // el monto del cobro.
  const amountPaid = new Prisma.Decimal(pack.price)

  const purchase = await prisma.$transaction(
    async tx => grantPackInTx(tx, { pack: pack as PackWithItems, venueId, customerId, staffId, amountPaid, note: opts?.note }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )

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
    purchase = await prisma.$transaction(
      async tx =>
        grantPackInTx(tx, { pack: pack as PackWithItems, venueId, customerId, staffId, amountPaid, paymentId, note }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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

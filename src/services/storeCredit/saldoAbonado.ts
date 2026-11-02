// src/services/storeCredit/saldoAbonado.ts
/**
 * Lo que la app ve del saldo a favor que se le abonó a una clienta, leído de la libreta (spec 2026-10-30-saldo-a-favor §5.4 y §5.5):
 * la MISMA forma para el Reembolso del POS (S4), el Cambio (S5) y la reimpresión del ticket. Sin dependencias del núcleo del
 * reembolso a propósito: el Cambio la lee dentro de su transacción y el núcleo ya depende del Cambio (no se cierra un ciclo).
 */
import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { telefonoDeTarjeta } from '../giftCards/giftCardEntrega'

/** Lo que la app ve del saldo que se le dio a la clienta (la misma forma que el Cambio, spec §5.4). */
export interface StoreCreditDelReembolso {
  customerId: string | null
  customerName: string
  amountCents: number
  newBalanceCents: number
  /** Los últimos 4 del teléfono con que se gasta (`recipientPhone`), no el de la ficha. */
  phoneLast4: string
  /** El teléfono de la ficha no es el del sobre: la cajera lo avisa y un gerente lo cambia en el DASHBOARD (Codex r3, h3). */
  phoneMismatch: boolean
}

/**
 * A quién y cuánto se abonó por cada devolución a saldo, leído del movimiento `saldo-a-favor:<id del REFUND>` de la libreta (S2) y de
 * su sobre. Lo usan la respuesta del Reembolso, la del Cambio (dentro de SU transacción: `db`) y la lista y el detalle de transacciones
 * del POS (reimpresión del ticket). Acotado por los ids que recibe (una página).
 */
export async function saldosAFavorDeReembolsos(
  venueId: string,
  refundIds: string[],
  db: Pick<Prisma.TransactionClient, 'giftCardActivity'> = prisma,
): Promise<Map<string, StoreCreditDelReembolso>> {
  if (refundIds.length === 0) return new Map()
  const movimientos = await db.giftCardActivity.findMany({
    where: { venueId, operationKey: { in: refundIds.map(id => `saldo-a-favor:${id}`) } },
    select: {
      refundPaymentId: true,
      amount: true,
      balanceAfter: true,
      giftCard: {
        select: {
          customerId: true,
          recipientName: true,
          recipientPhone: true,
          customer: { select: { firstName: true, lastName: true, phone: true } },
        },
      },
    },
    take: refundIds.length,
  })
  const out = new Map<string, StoreCreditDelReembolso>()
  for (const m of movimientos) {
    if (!m.refundPaymentId) continue
    const { customer, recipientPhone } = m.giftCard
    const ficha = telefonoDeTarjeta(customer?.phone)
    out.set(m.refundPaymentId, {
      customerId: m.giftCard.customerId,
      customerName: `${customer?.firstName ?? ''} ${customer?.lastName ?? ''}`.trim() || m.giftCard.recipientName || 'Cliente',
      amountCents: Math.round(m.amount.toNumber() * 100),
      newBalanceCents: Math.round(m.balanceAfter.toNumber() * 100),
      phoneLast4: (recipientPhone ?? '').slice(-4),
      phoneMismatch: ficha === null || telefonoDeTarjeta(recipientPhone) !== ficha,
    })
  }
  return out
}

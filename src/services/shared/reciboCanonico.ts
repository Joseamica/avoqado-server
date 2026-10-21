import { Prisma, PrismaClient } from '@prisma/client'

/**
 * 🔴 IVA por producto, plan 7a (r4 R4-A1): el recibo CANÓNICO de un cobro es el más antiguo por (createdAt, id). Toda
 * reutilización por paymentId pasa por aquí para que el POS, el TPV, el dashboard y el correo muestren el MISMO comprobante.
 * Los duplicados históricos no se tocan: su accessKey sigue abriéndose.
 */
export const ORDEN_RECIBO_CANONICO: Prisma.DigitalReceiptOrderByWithRelationInput[] = [{ createdAt: 'asc' }, { id: 'asc' }]

/** Para `include: { receipts: RECIBO_CANONICO }`: `receipts[0]` es el canónico. */
export const RECIBO_CANONICO = { orderBy: ORDEN_RECIBO_CANONICO, take: 1 } as const

export function reciboCanonicoDelPago<T extends Prisma.DigitalReceiptSelect>(
  db: Prisma.TransactionClient | PrismaClient,
  paymentId: string,
  opciones?: { where?: Prisma.DigitalReceiptWhereInput; select?: T },
) {
  return db.digitalReceipt.findFirst({ where: { ...opciones?.where, paymentId }, orderBy: ORDEN_RECIBO_CANONICO, select: opciones?.select })
}

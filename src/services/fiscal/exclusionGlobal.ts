import type { Prisma } from '@prisma/client'

/** La reserva de la global incorpora su exclusión en la tarea 10. */
export async function excluirSiEstaEnGlobal(_tx: Prisma.TransactionClient, _orderId: string): Promise<string | null> {
  return null
}

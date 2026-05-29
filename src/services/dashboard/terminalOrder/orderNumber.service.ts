import prisma from '@/utils/prismaClient'

/**
 * Generates a sequential order number like AVO-0001, AVO-0002…
 *
 * NOT atomic — uses count(). For low-throughput admin orders (TPV purchases
 * happen at most a few times per day per venue) this is fine. If contention
 * becomes a problem, swap for a Postgres sequence.
 */
export async function generateOrderNumber(): Promise<string> {
  const existing = await prisma.terminalOrder.count()
  const next = existing + 1
  return `AVO-${String(next).padStart(4, '0')}`
}

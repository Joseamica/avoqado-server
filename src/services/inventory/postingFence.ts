/**
 * La cerca del vale de inventario: un renglón nunca descuenta dos veces.
 *
 * El aplicador (`applySalePosting`) reclama el vale con un sello (`InventoryPosting.updatedAt` = `claimStamp`). Si se
 * atora más de `APPLYING_LEASE_MS`, otro trabajador puede re-reclamarlo y aplicar. Revisar el sello ANTES del efecto
 * no basta: entre la revisión y el descuento el otro ya pudo descontar (Codex r3 #1, plan-r1 #1, plan-r2 H1).
 *
 * Por eso cada transacción que escribe un movimiento con `postingLineId` llama a `assertPostingFence` como PRIMERA
 * instrucción: bloquea la fila del vale y aborta si su sello ya no es el del trabajador. Re-reclamar (un `updateMany`
 * sobre esa misma fila) espera a que termine el efecto en curso; el efecto de un trabajador que ya perdió la cerca
 * aborta y se deshace con su transacción.
 */
import { Prisma } from '@prisma/client'

export type PostingFence = { postingId: string; claimStamp: Date }

export class PostingFenceLostError extends Error {
  constructor(postingId: string) {
    super(`El vale de inventario ${postingId} lo re-reclamó otro trabajador`)
    this.name = 'PostingFenceLostError'
  }
}

let antesDeLaCerca: ((fence: PostingFence) => Promise<void>) | null = null

/** SÓLO PRUEBAS: pausa al trabajador DENTRO de la transacción del descuento, justo antes de bloquear el vale. */
export function __pausarAntesDeLaCercaEnPruebas(gancho: typeof antesDeLaCerca): void {
  antesDeLaCerca = gancho
}

/** Sin `fence` no hace nada: los llamadores sin vale (dashboard, merma, conteos) no cambian. */
export async function assertPostingFence(tx: Prisma.TransactionClient, fence: PostingFence | undefined): Promise<void> {
  if (!fence) return
  if (antesDeLaCerca) await antesDeLaCerca(fence)
  // Leer (no comparar en SQL) el `timestamp` evita el bind de fecha con la zona de la sesión (critical-warnings).
  const filas = await tx.$queryRaw<Array<{ updatedAt: Date }>>`
    SELECT "updatedAt" FROM "InventoryPosting" WHERE id = ${fence.postingId} FOR UPDATE
  `
  if (filas[0]?.updatedAt?.getTime() !== fence.claimStamp.getTime()) throw new PostingFenceLostError(fence.postingId)
}

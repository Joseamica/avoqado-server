// src/services/storeCredit/primerSobreLock.ts
/**
 * El candado «primer-sobre» (spec 2026-10-30-saldo-a-favor §5.5; Codex r1 h10, r2 h4, r3 h2). Cierra la carrera entre la
 * «devolución sin venta» (que se rechaza en cuanto la sucursal tiene un sobre activado) y el PRIMER saldo a favor de la sucursal.
 * 🔴 Siempre es el PRIMER candado de su transacción, antes de Orders, Payments, sobres y turno: así todos van en el mismo orden
 * («primer-sobre» → filas → turno) y no se cruzan. Cada llamador queda inventariado en financialRowLockOrder.reviewed.json.
 */
import type { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

/** La devolución sin venta lo toma SIEMPRE y, ya con él, vuelve a comprobar que no haya sobres activados (S6). */
export async function tomarCandadoPrimerSobreEnTx(tx: Tx, venueId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'primer-sobre:' + venueId}))::text`
}

/**
 * El Cambio y el Reembolso a saldo a favor lo toman sólo mientras la sucursal no tenga ningún sobre activado (después del primero
 * no cuesta nada). Sin segunda comprobación: el sobre se escribe igual con o sin otro activado, y un candado de transacción no se
 * suelta antes; la que decide con lo que ve tras el candado es la devolución sin venta.
 */
export async function tomarCandadoPrimerSobreSiHaceFaltaEnTx(tx: Tx, venueId: string): Promise<void> {
  const activado = await tx.giftCard.findFirst({ where: { venueId, activatedAt: { not: null } }, select: { id: true } })
  if (!activado) await tomarCandadoPrimerSobreEnTx(tx, venueId)
}

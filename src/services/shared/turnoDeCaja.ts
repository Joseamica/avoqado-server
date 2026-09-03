import type { Prisma, PrismaClient } from '@prisma/client'

/** Acepta el cliente de Prisma o un `tx`: los sitios que atan dinero llaman desde ambos. */
export type ShiftReader = Pick<PrismaClient, 'shift'> | Pick<Prisma.TransactionClient, 'shift'>

/**
 * El turno de caja es del NEGOCIO, no de la persona (decisión del founder, 2-sep-2026).
 *
 * Antes cada cobro buscaba «el turno abierto de QUIEN cobra» (`{ venueId, staffId, OPEN }`),
 * y el selector «Vendedor» de Cobrar cambia ese `staffId` en cada cobro: quien no había
 * abierto turno cobraba FUERA de todo turno, sin aviso. Testarudo, 1-sep-2026: 78 de 92
 * cobros ($10,337 de $12,002) sin turno; el dashboard decía $1,772.
 *
 * `openShiftForVenue` ya obliga a UN turno abierto por venue, así que «el abierto del
 * negocio» es único. Quién vendió sigue viviendo en `Payment.processedById`.
 *
 * 🔴 Es el ÚNICO sitio que resuelve el turno abierto para atar dinero, y
 * `tests/unit/services/shared/turnoDeCaja.guard.test.ts` es la prueba estática que falla si
 * alguien vuelve a filtrar por `staffId` en los 8 sitios que antes lo hacían (7 archivos):
 *
 *   1. `tpv/payment.tpv.service.ts`      → `recordOrderPayment` y `recordFastPayment` (2)
 *   2. `tpv/refund.tpv.service.ts`       → `recordRefund`
 *   3. `tpv/order.tpv.service.ts`        → `createOrderWithItems` (dentro de `tx`)
 *   4. `dashboard/manualPayment.service.ts`   → `createManualPayment` (dentro de `tx`)
 *   5. `dashboard/refund.dashboard.service.ts` → `issueRefund`
 *   6. `mobile/order.mobile.service.ts`  → `payCashOrder`
 *   7. `mobile/refund.mobile.service.ts` → `createRefund` (dentro de `tx`)
 *
 * ⚠️ No confundir con `getCurrentShift` (`tpv/shift.tpv.service.ts`), que consulta
 * `{ venueId, endTime: null }` SIN `status` porque es para la PANTALLA. Aquí se exige
 * `status: 'OPEN'` a propósito: mientras un turno está en `CLOSING` (cierre en curso) este
 * helper devuelve `null` y un cobro en esa ventana de milisegundos cae sin turno — límite
 * conocido y aceptado (decisión del controlador, 2-sep-2026); lo rediseña la Fase 2.
 */
export async function turnoAbiertoDelNegocio(db: ShiftReader, venueId: string): Promise<{ id: string } | null> {
  const shift = await db.shift.findFirst({
    where: { venueId, status: 'OPEN', endTime: null },
    orderBy: { startTime: 'desc' },
    select: { id: true },
  })
  return shift ? { id: shift.id } : null
}

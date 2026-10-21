/**
 * Las ventas de los turnos SIN cerrar, sin las cuentas de tarjetas de regalo (R3; Codex #5 del cierre). Módulo propio (cierre r1): lo
 * usan la TPV (`getCurrentShift`), el panel (detalle, lista y resumen de turnos) y `list_shifts` del MCP sin que el panel importe el
 * servicio de turnos de la TPV, que ya importa el del panel.
 */
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '@/utils/prismaClient'
import { WHERE_ORDEN_DE_TARJETAS } from '@/services/giftCards/giftCardMarks'

/**
 * R3 (r1 B-3, r2 #2): las ventas de un turno SIN CERRAR, en UNA consulta agregada que ya excluye las cuentas de tarjetas de regalo
 * (su dinero sí entró: los totales por método y el cajón no cambian). Nunca la resta de dos lecturas: una carga que entrara entre
 * ambas dejaría el total en negativo. La sondea la PAX (`getCurrentShift`): sigue siendo una agregación en la base.
 *
 * Codex #5 (cierre): el acumulado `Shift.totalSales` de un turno abierto lo incrementa CUALQUIER cobro (`paymentShiftClaim`), así
 * que la lista y el resumen de turnos del panel y `list_shifts` del MCP leen esta cifra para la fila de un turno sin cerrar; el
 * cierre ya firma el total sin tarjetas (`aggregateShiftPayments`).
 *
 * 🔴 `NOT` de la marca, y sin rama `orderId: null`: `Payment.orderId` es obligatorio (Prisma rechaza `null` en ese filtro, medido
 * el 15-oct), y el SQL que genera es `NOT (EXISTS(renglón con tarjeta) AND la orden existe)`: un cobro cuya orden no se pudiera
 * unir seguiría contando, nunca se pierde en silencio (memoria «predicado-not-en-sql-con-columnas-null-excluye-en-silencio»).
 */
export async function ventasDelTurnoSinTarjetas(venueId: string, shiftId: string): Promise<Decimal> {
  const ventasDelTurno = await prisma.payment.aggregate({
    where: {
      venueId,
      shiftId,
      status: 'COMPLETED',
      NOT: { order: WHERE_ORDEN_DE_TARJETAS },
    },
    _sum: { amount: true },
  })
  return new Decimal(ventasDelTurno?._sum?.amount ?? 0)
}

/**
 * Lo mismo para VARIOS turnos en UNA consulta agrupada (cierre r1, capacidad): la lista y el resumen de turnos del panel y
 * `list_shifts`. Un turno sin cobros (o sólo con cargas de tarjetas) vale 0. Sin turnos, no consulta.
 */
export async function ventasSinTarjetasPorTurno(venueId: string, shiftIds: string[]): Promise<Map<string, Decimal>> {
  const ventas = new Map(shiftIds.map(id => [id, new Decimal(0)]))
  if (shiftIds.length === 0) return ventas
  const filas = await prisma.payment.groupBy({
    by: ['shiftId'],
    where: { venueId, shiftId: { in: shiftIds }, status: 'COMPLETED', NOT: { order: WHERE_ORDEN_DE_TARJETAS } },
    _sum: { amount: true },
  })
  for (const fila of filas ?? []) if (fila.shiftId) ventas.set(fila.shiftId, new Decimal(fila._sum?.amount ?? 0))
  return ventas
}

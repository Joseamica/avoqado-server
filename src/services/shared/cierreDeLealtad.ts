import prisma from '../../utils/prismaClient'
import { MARCA_LEALTAD_REABIERTA } from './lealtadReabierta'

/**
 * Las DOS escrituras que terminan una corrida de lealtad sobre la venta (`Order`): cerrarla como procesada o dejarle el error.
 *
 * Viven aparte porque las usan dos llamadores con la MISMA regla: `awardLoyaltyForPaidOrder` (el cobro, que cierra en cuanto
 * termina) y `otorgarLealtadRespetandoReembolsos` (la liga tardía, el reconciliador y la reparación), que cierra él mismo SÓLO
 * después de su comprobación final de reembolso y de completar la reversión (H1, auditoría de Codex del código, 15-oct-2026).
 */

/**
 * Cierra la lealtad de la venta (`loyaltyProcessedAt`). Devuelve cuántas filas cerró (0 = ya estaba cerrada, o la guarda B1 lo
 * impidió).
 *
 * 🔴 B1 (auditoría de Codex, ronda B, 14-oct-2026): una corrida que leyó «sin cliente» sólo cierra si la orden SIGUE sin
 * cliente. El cobro corre esto en el instante; si el barista liga al cliente justo entonces, la liga REABRE la lealtad en su
 * transacción (`reabrirLealtadSiAplica`) y este cierre, ya viejo, la borraría: si además falla el intento de la liga, el
 * reconciliador nunca vuelve a ver la venta y el sello se pierde en silencio. La corrida que SÍ vio clientes cierra como
 * siempre (idempotente).
 * 🔴 Y la MARCA de fila (medición de S3b contra Postgres): si este cierre ESPERA el candado de fila que tiene la transacción de
 * la liga, al soltarse Postgres relee sólo las columnas de la fila y la subconsulta sigue diciendo «sin clientes». La
 * reapertura deja `loyaltyLastError = MARCA_LEALTAD_REABIERTA`; con ella puesta, este cierre no pasa. `{ not }` en SQL deja
 * fuera el NULL: por eso va junto con `null` en un OR.
 */
export async function cerrarLealtadDeLaVenta(venueId: string, orderId: string, cierre: { leyoSinCliente: boolean }): Promise<number> {
  const r = await prisma.order.updateMany({
    where: {
      id: orderId,
      venueId,
      loyaltyEligibleAt: { not: null },
      loyaltyProcessedAt: null,
      ...(cierre.leyoSinCliente
        ? {
            orderCustomers: { none: {} },
            OR: [{ loyaltyLastError: null }, { loyaltyLastError: { not: MARCA_LEALTAD_REABIERTA } }],
          }
        : {}),
    },
    data: { loyaltyProcessedAt: new Date(), loyaltyProcessingAt: null, loyaltyLastError: null },
  })
  return r.count
}

/**
 * Deja el error de una corrida de lealtad en la venta (que sigue pendiente para el reconciliador).
 *
 * 🔴 H2 (auditoría de Codex del código + revisión final Minor 3, 15-oct-2026): NUNCA pisa la marca de una liga tardía
 * (`MARCA_LEALTAD_REABIERTA`). El cruce de tres: la liga tiene el candado de la fila (ya escribió la marca); esta escritura de
 * fallo espera PRIMERO; detrás espera el cierre «sin cliente» de otra corrida. Al soltarse la liga, esta escritura pasaba antes,
 * cambiaba la marca por su texto, y el cierre —que sólo relee las columnas de la fila— ya no la veía. La condición va en la
 * MISMA sentencia: Postgres la relee al soltarse el candado. Con la marca puesta el error sólo queda en el log (quien llama ya
 * lo registró); la venta sigue pendiente igual.
 */
export async function registrarErrorDeLealtad(venueId: string, orderId: string, texto: string): Promise<void> {
  await prisma.order.updateMany({
    where: {
      id: orderId,
      venueId,
      loyaltyEligibleAt: { not: null },
      loyaltyProcessedAt: null,
      // `{ not }` en SQL deja fuera el NULL: por eso va junto con `null` en un OR.
      OR: [{ loyaltyLastError: null }, { loyaltyLastError: { not: MARCA_LEALTAD_REABIERTA } }],
    },
    data: { loyaltyLastError: texto.slice(0, 4000) },
  })
}

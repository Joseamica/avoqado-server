// src/services/marketing/campaignProgress.service.ts
import { CustomerCampaignDeliveryStatus as D, CustomerCampaignStatus as C } from '@prisma/client'
import prisma from '@/utils/prismaClient'

/**
 * Cuántos correos de una campaña salieron, fallaron o se omitieron, y en qué va — contado de
 * sus envíos (D37, 25-nov-2026).
 *
 * 🔴 `CustomerCampaign.sentCount/failedCount/skippedCount` nacen en 0 y NADIE los sube (el
 * schema los llama «cache reconstruible desde las deliveries»), y la campaña se queda en
 * `ENQUEUED` para siempre: cada envío se anota sólo en SU fila. Por eso «Entregados» salía en
 * 0. Contar al leer no agrega escritores ni carreras, y corrige también lo ya mandado; no leas
 * esas columnas.
 *
 * - Enviados (`sentCount`) = `SENT`: el proveedor lo aceptó y no ha rebotado. No es «llegó»: el
 *   aviso de entrega de Resend no se guarda. Mailchimp cuenta igual sus «entregas exitosas» (los
 *   que no rebotaron).
 * - Fallaron (`failedCount`) = `DEAD` (se agotaron los intentos) + `FAILED` (rebotó o lo
 *   marcaron como spam).
 * - Omitidos (`skippedCount`) = `SKIPPED` (quitó su permiso, correo bloqueado, venció…).
 * - `UNKNOWN` no suma a ninguno: no se sabe si salió.
 *
 * Estado mostrado, sólo si la base dice `ENQUEUED`/`SENDING`: ninguno `PENDING`/`SENDING`/
 * `RETRYING` → Enviada (también si ya no queda ninguna fila); todos `PENDING` → En cola; si no,
 * Enviando. Cancelada, bloqueada y vencida se quedan como están (sus números sí se cuentan).
 *
 * ponytail: un `groupBy` por página (tope 100 campañas) recorre todos sus envíos; con la cuota
 * mensual por negocio son pocos miles. Si algún día pesa, guardar el resumen por campaña.
 */
export type AvanceDeEnvio = { status: C; sentCount: number; failedCount: number; skippedCount: number }

const PENDIENTES: D[] = [D.PENDING, D.SENDING, D.RETRYING]

export async function conAvanceReal<T extends { id: string; status: C }>(
  venueId: string,
  campanas: T[],
): Promise<Array<T & AvanceDeEnvio>> {
  // Un borrador o una programada no tiene envíos: se crean en la MISMA transacción que la pasa a
  // `ENQUEUED`. Contarla sólo serviría para mezclar dos momentos (la fila leída en borrador y sus
  // envíos recién creados) y devolver «Borrador · 1 enviado».
  const ids = campanas.filter(c => c.status !== C.DRAFT && c.status !== C.SCHEDULED).map(c => c.id)
  const grupos =
    ids.length === 0
      ? []
      : await prisma.customerCampaignDelivery.groupBy({
          by: ['campaignId', 'status'],
          where: { venueId, campaignId: { in: ids } },
          _count: { _all: true },
        })

  const porCampana = new Map<string, Map<D, number>>()
  for (const g of grupos) {
    if (!g.campaignId) continue
    const conteo = porCampana.get(g.campaignId) ?? new Map<D, number>()
    conteo.set(g.status, g._count._all)
    porCampana.set(g.campaignId, conteo)
  }

  return campanas.map(c => {
    const conteo = porCampana.get(c.id) ?? new Map<D, number>()
    const n = (...estados: D[]) => estados.reduce((suma, e) => suma + (conteo.get(e) ?? 0), 0)

    let status = c.status
    if (status === C.ENQUEUED || status === C.SENDING) {
      const total = [...conteo.values()].reduce((suma, v) => suma + v, 0)
      status = n(...PENDIENTES) === 0 ? C.SENT : n(D.PENDING) === total ? C.ENQUEUED : C.SENDING
    }

    return { ...c, status, sentCount: n(D.SENT), failedCount: n(D.DEAD, D.FAILED), skippedCount: n(D.SKIPPED) }
  })
}

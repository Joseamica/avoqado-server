import type { Prisma } from '@prisma/client'

import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'

/** Una tarjeta que llega a registrarse menos de esto después de su intento no es «tardía»: es el registro normal. */
export const TARDIA_DESDE_MS = 60_000
const METODOS_DE_TARJETA = ['CREDIT_CARD', 'DEBIT_CARD'] as const
const esTarjeta = (m: string | null | undefined) => METODOS_DE_TARJETA.includes(m as (typeof METODOS_DE_TARJETA)[number])

export const ACCION_TARJETA_CONFIRMADA_TARDE = 'LATE_CARD_RECORDED'

/** La hora del intento que manda la TPV (epoch ms, número o texto de dígitos). Ilegible o en el futuro ⇒ null: no se avisa. */
export function leerHoraDelIntento(valor: unknown, llegada: Date): Date | null {
  const ms = typeof valor === 'number' ? valor : typeof valor === 'string' && /^\d{1,16}$/.test(valor) ? Number(valor) : NaN
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > llegada.getTime()) return null
  return new Date(ms)
}

/**
 * Lo que se guarda en `processorData` de la tarjeta: la hora del intento, sólo si es tarjeta y legible. Guardarla en la MISMA
 * transacción del Payment es lo que deja repetir la revisión en un reintento con su llave (si el servidor murió antes del aviso).
 */
export function horaDelIntentoParaGuardar(p: { method?: string | null; capturadoEnAparato?: unknown }, llegada: Date) {
  if (!esTarjeta(p.method)) return {}
  const intento = leerHoraDelIntento(p.capturadoEnAparato, llegada)
  return intento ? { capturadoEnAparato: intento.getTime() } : {}
}

export type TarjetaGuardada = {
  id: string
  venueId: string
  orderId: string | null
  terminalId: string | null
  method: string | null
  status: string
  amount: Prisma.Decimal | number
  tipAmount?: Prisma.Decimal | number | null
  createdAt: Date
  processorData: unknown
  processedById?: string | null
}

/**
 * D7 (encargo a25cd7; founder 2-nov «B»: se deja cobrar y sólo se avisa). En PAGO RÁPIDO cada `/fast` crea su propia venta, así que
 * no hay cuenta con la cual chocar: si una tarjeta quedó «por confirmar», la cajera pudo cobrar esa venta de otra forma (efectivo) y
 * DESPUÉS el banco la aprueba (la TPV la registra sola, tarde). Entran dos ventas y nadie se entera. Aquí se avisa al dueño cada vez
 * que llega aprobada una tarjeta TARDE (su intento empezó ≥ 1 min antes de registrarse): «revisa si se cobró de otra forma».
 *
 * A propósito NO se empareja con un efectivo: dos rondas de Codex mostraron que adivinar «qué efectivo era» (orden de llegada,
 * hora del aparato, otras ventas del mismo importe) siempre deja huecos; la persona lo resuelve viendo la terminal y la hora.
 *
 * 🔴 Nunca rechaza ni demora: se llama con `void` después del commit, sin consultas de más en un cobro normal (sólo la tarjeta
 * tardía pregunta si ya avisó). Sin la hora del intento (TPV que no la manda) no hay aviso, como hoy. Con cuenta
 * (`recordOrderPayment`) no aplica: ahí la tarjeta tardía ya salta como sobrepago si pasa de la cuenta.
 * ponytail: dos revisiones simultáneas de la misma tarjeta pueden escribir dos filas (la búsqueda previa no es candado); es un aviso.
 */
export async function revisarTarjetaTardia(tarjeta: TarjetaGuardada): Promise<void> {
  try {
    if (tarjeta.status !== 'COMPLETED' || !esTarjeta(tarjeta.method)) return
    const pd = tarjeta.processorData && typeof tarjeta.processorData === 'object' ? (tarjeta.processorData as Record<string, unknown>) : {}
    const intento = leerHoraDelIntento(pd.capturadoEnAparato, tarjeta.createdAt)
    if (!intento || tarjeta.createdAt.getTime() - intento.getTime() < TARDIA_DESDE_MS) return
    const { id: paymentId, venueId } = tarjeta
    // Una vez por tarjeta: la revisión se repite en el reintento con su llave.
    const yaEsta = await prisma.activityLog.findFirst({
      where: { venueId, action: ACCION_TARJETA_CONFIRMADA_TARDE, entityId: paymentId },
      select: { id: true },
    })
    if (yaEsta) return
    const datos = {
      paymentId,
      orderId: tarjeta.orderId,
      terminalId: tarjeta.terminalId,
      amount: Number(tarjeta.amount),
      tipAmount: Number(tarjeta.tipAmount ?? 0),
      attemptStartedAt: intento.toISOString(),
      recordedAt: tarjeta.createdAt.toISOString(),
      minutesLate: Math.round((tarjeta.createdAt.getTime() - intento.getTime()) / 60_000),
    }
    // Better Stack vigila «🚨 [Tarjeta tardía]».
    logger.error('🚨 [Tarjeta tardía] Llegó aprobada tarde una tarjeta de Pago rápido: revisar si esa venta se cobró de otra forma', {
      venueId,
      ...datos,
    })
    await logAction({
      action: ACCION_TARJETA_CONFIRMADA_TARDE,
      entity: 'Payment',
      entityId: paymentId,
      venueId,
      staffId: tarjeta.processedById ?? null,
      data: datos,
    })
  } catch (error) {
    logger.warn('⚠️ [Tarjeta tardía] no se pudo dejar el aviso de la tarjeta tardía; el cobro ya quedó', {
      venueId: tarjeta.venueId,
      paymentId: tarjeta.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

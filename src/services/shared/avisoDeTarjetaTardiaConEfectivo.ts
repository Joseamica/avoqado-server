import type { Prisma } from '@prisma/client'

import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { DRAWER_CASH_WHERE, paymentCountsAsDrawerCash, type TenderSemanticsPayment } from './tenderSemantics'

/** Una tarjeta que llega a registrarse menos de esto después de su intento no es «tardía»: es el registro normal. */
export const TARDIA_DESDE_MS = 60_000
/** El efectivo que cuenta es el que la cajera cobró poco después de que la tarjeta quedó por confirmar, no el del resto del día. */
export const EFECTIVO_HASTA_MS = 30 * 60_000
/** Desde el efectivo, hasta cuándo se buscan tarjetas tardías que ya llegaron (la recuperación de la TPV no tarda días). */
const TARJETA_HASTA_MS = 24 * 60 * 60_000
const CANDIDATOS = 5
const TARJETAS_CANDIDATAS = 20
const METODOS_DE_TARJETA = ['CREDIT_CARD', 'DEBIT_CARD'] as const
const esTarjeta = (m: string | null | undefined) => METODOS_DE_TARJETA.includes(m as (typeof METODOS_DE_TARJETA)[number])

export const ACCION_TARJETA_TARDIA_CON_EFECTIVO = 'LATE_CARD_AFTER_CASH'

/** La hora del intento que manda la TPV (epoch ms, número o texto de dígitos). Ilegible o en el futuro ⇒ null: no se avisa. */
export function leerHoraDelIntento(valor: unknown, llegada: Date): Date | null {
  const ms = typeof valor === 'number' ? valor : typeof valor === 'string' && /^\d{1,16}$/.test(valor) ? Number(valor) : NaN
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > llegada.getTime()) return null
  return new Date(ms)
}

/**
 * Lo que se guarda en `processorData` de la tarjeta: la hora del intento, sólo si es tarjeta y legible. Guardarla es lo que deja
 * revisar el par desde los dos lados (la tarjeta llega antes o después que el efectivo) y repetir la revisión tras un reinicio.
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
  createdAt: Date
  processorData: unknown
  processedById?: string | null
}
export type EfectivoGuardado = TenderSemanticsPayment & {
  id: string
  venueId: string
  orderId: string | null
  terminalId: string | null
  status: string
  amount: Prisma.Decimal | number
  createdAt: Date
  clientCreatedAt?: Date | null
}

/** La ventana del efectivo de ESTA tarjeta: desde su intento hasta 30 min después, nunca después de que llegó. Null = no es tardía. */
function ventanaDelEfectivo(t: Pick<TarjetaGuardada, 'status' | 'method' | 'terminalId' | 'createdAt' | 'processorData'>) {
  if (t.status !== 'COMPLETED' || !esTarjeta(t.method) || !t.terminalId) return null
  const pd = t.processorData && typeof t.processorData === 'object' ? (t.processorData as Record<string, unknown>) : {}
  const intento = leerHoraDelIntento(pd.capturadoEnAparato, t.createdAt)
  if (!intento || t.createdAt.getTime() - intento.getTime() < TARDIA_DESDE_MS) return null
  return { intento, fin: new Date(Math.min(t.createdAt.getTime(), intento.getTime() + EFECTIVO_HASTA_MS)) }
}

/** La hora en que se COBRÓ el efectivo: la del aparato si llegó de su cola (D93), si no, la llegada. */
const horaDelEfectivo = (e: { clientCreatedAt?: Date | null; createdAt: Date }) => e.clientCreatedAt ?? e.createdAt

async function dejarRastro(tarjeta: TarjetaGuardada, intento: Date, efectivos: { id: string; orderId: string | null }[]) {
  const { id: paymentId, venueId } = tarjeta
  // Una vez por tarjeta: la revisión corre desde los dos lados y otra vez en un reintento con su llave.
  const yaEsta = await prisma.activityLog.findFirst({
    where: { venueId, action: ACCION_TARJETA_TARDIA_CON_EFECTIVO, entityId: paymentId },
    select: { id: true },
  })
  if (yaEsta) return
  const datos = {
    paymentId,
    orderId: tarjeta.orderId,
    amount: Number(tarjeta.amount),
    cashPaymentIds: efectivos.map(p => p.id),
    cashOrderIds: efectivos.map(p => p.orderId),
    attemptStartedAt: intento.toISOString(),
    recordedAt: tarjeta.createdAt.toISOString(),
  }
  // Better Stack vigila «🚨 [Tarjeta tardía]».
  logger.error('🚨 [Tarjeta tardía] Llegó aprobada una tarjeta que estaba por confirmar y en medio se cobró en efectivo lo mismo', {
    venueId,
    terminalId: tarjeta.terminalId,
    ...datos,
  })
  await logAction({
    action: ACCION_TARJETA_TARDIA_CON_EFECTIVO,
    entity: 'Payment',
    entityId: paymentId,
    venueId,
    staffId: tarjeta.processedById ?? null,
    data: datos,
  })
}

/**
 * D7 (encargo a25cd7; founder 2-nov «B»: se deja cobrar y sólo se avisa). En PAGO RÁPIDO cada `/fast` crea su propia venta, así que
 * no hay cuenta con la cual chocar: si una tarjeta quedó «por confirmar», la cajera cobró esa venta en efectivo y DESPUÉS el banco
 * la aprueba (la TPV la registra sola, tarde), entran dos ventas y nadie se entera. Esto deja el rastro `LATE_CARD_AFTER_CASH`: una
 * tarjeta que llega tarde (su intento empezó ≥ 1 min antes) y un efectivo del mismo importe en la misma terminal cobrado entre su
 * intento y 30 min después (a la hora del aparato si subió de su cola). Se revisa desde los dos lados, porque sin red la tarjeta y
 * el efectivo suben en cualquier orden: al registrar la tarjeta (también en un reintento con su llave) y al registrar el efectivo.
 *
 * 🔴 Nunca rechaza ni demora: se llama con `void` después del commit. Sin la hora del intento (TPV que no la manda) no hay aviso,
 * como hoy. Con cuenta (`recordOrderPayment`) no aplica: ahí la tarjeta tardía ya salta como sobrepago.
 * ponytail: dos revisiones simultáneas del mismo par pueden escribir dos filas (la búsqueda previa no es candado); es un aviso.
 */
export async function revisarTarjetaTardia(tarjeta: TarjetaGuardada): Promise<void> {
  try {
    const ventana = ventanaDelEfectivo(tarjeta)
    if (!ventana) return
    const efectivos = await prisma.payment.findMany({
      where: {
        venueId: tarjeta.venueId,
        terminalId: tarjeta.terminalId,
        status: 'COMPLETED',
        amount: tarjeta.amount,
        id: { not: tarjeta.id },
        AND: [
          DRAWER_CASH_WHERE,
          {
            OR: [
              { clientCreatedAt: { gte: ventana.intento, lte: ventana.fin } },
              { clientCreatedAt: null, createdAt: { gte: ventana.intento, lte: ventana.fin } },
            ],
          },
        ],
      },
      select: { id: true, orderId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: CANDIDATOS,
    })
    if (efectivos.length > 0) await dejarRastro(tarjeta, ventana.intento, efectivos)
  } catch (error) {
    logger.warn('⚠️ [Tarjeta tardía] no se pudo revisar si hubo efectivo en medio; el cobro ya quedó', {
      venueId: tarjeta.venueId,
      paymentId: tarjeta.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** El otro lado: llega un efectivo y busca una tarjeta tardía de esa terminal que ya se registró y cuya ventana lo contiene. */
export async function revisarEfectivoContraTarjetasTardias(efectivo: EfectivoGuardado): Promise<void> {
  try {
    if (efectivo.status !== 'COMPLETED' || !efectivo.terminalId || !paymentCountsAsDrawerCash(efectivo)) return
    const hora = horaDelEfectivo(efectivo)
    const tarjetas = await prisma.payment.findMany({
      where: {
        venueId: efectivo.venueId,
        terminalId: efectivo.terminalId,
        status: 'COMPLETED',
        amount: efectivo.amount,
        method: { in: [...METODOS_DE_TARJETA] },
        id: { not: efectivo.id },
        // Una tarjeta cuya ventana contiene este efectivo llegó DESPUÉS de que se cobró (su ventana termina en su llegada).
        createdAt: { gte: hora, lte: new Date(hora.getTime() + TARJETA_HASTA_MS) },
      },
      select: {
        id: true,
        venueId: true,
        orderId: true,
        terminalId: true,
        method: true,
        status: true,
        amount: true,
        createdAt: true,
        processorData: true,
        processedById: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: TARJETAS_CANDIDATAS,
    })
    for (const tarjeta of tarjetas) {
      const ventana = ventanaDelEfectivo(tarjeta)
      if (!ventana || hora < ventana.intento || hora > ventana.fin) continue
      await dejarRastro(tarjeta, ventana.intento, [{ id: efectivo.id, orderId: efectivo.orderId }])
    }
  } catch (error) {
    logger.warn('⚠️ [Tarjeta tardía] no se pudo revisar el efectivo contra tarjetas tardías; el cobro ya quedó', {
      venueId: efectivo.venueId,
      paymentId: efectivo.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

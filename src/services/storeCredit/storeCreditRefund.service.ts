// src/services/storeCredit/storeCreditRefund.service.ts
/**
 * El Reembolso del POS (`POST /mobile/venues/:v/payments/:id/refund`) con el saldo a favor (spec 2026-10-30-saldo-a-favor §4, §5.5):
 * - `refundMethod: 'STORE_CREDIT'` abona lo devuelto al sobre de la clienta elegida (mamá → hija), en la MISMA transacción que la
 *   devolución (`issueRefund` con `aSaldoAFavor`); llave obligatoria;
 * - «Sólo saldo a favor»: con devolución de mercancía u «Otro» y sin defecto, sólo sale como saldo o a su mismo sobre;
 * - una repetición por llave (la app murió tras el commit, reenvía otra cajera) se reconoce bajo el candado del cobro ANTES de toda regla
 *   que pueda cambiar entre el envío y el reenvío, y responde lo mismo (S10, I1: `reglasBajoCandado`).
 * 🔴 Todo rechazo `STORE_CREDIT_` es un 4xx SIN escritura: las apps borran lo pendiente con ese prefijo. Y con destino saldo a favor,
 * todo rechazo del servicio lo trae (S10, I2: `comoRechazoDeSaldo`).
 */
import { Prisma } from '@prisma/client'
import AppError, { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import * as refundDashboardService from '../dashboard/refund.dashboard.service'
import type { CobroBloqueado, IssueRefundInput, IssueRefundResult } from '../dashboard/refund.dashboard.service'
import { logAction } from '../dashboard/activity-log.service'
import { abonarSaldoAFavorEnTx } from '../giftCards/giftCardLedger'
import { GiftCardError } from '../giftCards/giftCardErrors'
import { sinSaldoAFavorPorque, type CobroParaDevolver, type DevolverCon } from '../tpv/terminalRefundTarget'
import { prepararMediosDeSaldoAFavor, storeCreditAvailable } from './storeCreditTender'
import { saldosAFavorDeReembolsos, type StoreCreditDelReembolso } from './saldoAbonado'
import { rechazarSiLaTerminalEstaDevolviendo } from './terminalRefundMarker'
import { comoRechazoDeSaldo } from './rechazoDeSaldo'
import { soloSaldoEfectivo } from './soloSaldoEfectivo'

// La forma y su lector viven en `saldoAbonado.ts` (sin dependencias del núcleo del reembolso: el Cambio también la lee); se re-exportan
// para los lectores de siempre (la lista y el detalle de transacciones del POS).
export { saldosAFavorDeReembolsos, type StoreCreditDelReembolso }

const SIN_LLAVES = 'Pide a Avoqado que active el saldo a favor.'

export type PosRefundInput = Omit<IssueRefundInput, 'refundMethod' | 'aSaldoAFavor'> & {
  refundMethod?: DevolverCon
  /** Con `STORE_CREDIT`: a quién se le abona (no tiene que ser la clienta de la venta). */
  customerId?: string
  /** «Es por defecto»: con «Sólo saldo a favor» deja devolver como se pagó (LFPC art. 92). */
  defective?: boolean
}

/** ¿Puede la cajera escoger «Saldo a favor» para este cobro? El POS lo pinta en gris con `reason` cuando no. */
export function opcionDeSaldoAFavor(cobro: CobroParaDevolver): { available: boolean; reason?: string } {
  if (!storeCreditAvailable()) return { available: false, reason: SIN_LLAVES }
  const motivo = sinSaldoAFavorPorque(cobro)
  return motivo ? { available: false, reason: motivo } : { available: true }
}

/** Motivos que «Sólo saldo a favor» restringe; cobro por error, fraudulento y cuenta cancelada salen libres. */
const MOTIVOS_DE_SOLO_SALDO = new Set<string>(['RETURNED_GOODS', 'OTHER'])

/**
 * «Sólo saldo a favor» (spec §4): con devolución de mercancía u «Otro» y sin defecto, lo único que sale es el saldo a favor, o regresar
 * al mismo sobre lo que se pagó con saldo (Codex r2 h5: si no, una compra pagada con saldo no tendría a dónde devolverse).
 */
export function soloSaldoLoImpide(p: {
  storeCreditOnly: boolean
  reason: string
  defective?: boolean
  refundMethod?: DevolverCon
  pagadoConSaldo: boolean
}): boolean {
  if (!p.storeCreditOnly || p.defective || !MOTIVOS_DE_SOLO_SALDO.has(p.reason)) return false
  if (p.refundMethod === 'STORE_CREDIT') return false
  return !(p.refundMethod === undefined && p.pagadoConSaldo)
}

const cobroParaDevolver = (venueId: string, paymentId: string) =>
  prisma.payment.findFirst({
    where: { id: paymentId, venueId },
    select: {
      method: true,
      source: true,
      externalSource: true,
      tenderSatFormaPago: true,
      fundsFlow: true,
      tenderTypeId: true,
      tenderCountsAsCash: true,
      tenderType: { select: { systemKind: true } },
    },
  })

export async function issuePosRefund(
  input: PosRefundInput,
): Promise<Omit<IssueRefundResult, 'abono'> & { storeCredit?: StoreCreditDelReembolso }> {
  try {
    return await reembolsoDelPos(input)
  } catch (error) {
    // S10 (I2): con destino saldo a favor, todo rechazo sale con el prefijo `STORE_CREDIT_`; lo demás, exactamente como hoy.
    throw input.refundMethod === 'STORE_CREDIT' ? comoRechazoDeSaldo(error) : error
  }
}

async function reembolsoDelPos(
  input: PosRefundInput,
): Promise<Omit<IssueRefundResult, 'abono'> & { storeCredit?: StoreCreditDelReembolso }> {
  const { refundMethod, customerId, defective, ...base } = input
  const aSaldo = refundMethod === 'STORE_CREDIT'
  if (aSaldo && !input.idempotencyKey) {
    throw new BadRequestError(
      'Falta la llave del reembolso a saldo a favor. Actualiza la app e inténtalo de nuevo.',
      'STORE_CREDIT_IDEMPOTENCY_KEY_REQUIRED',
    )
  }
  if (aSaldo && !customerId) {
    throw new GiftCardError('STORE_CREDIT_CUSTOMER_REQUIRED', 'Elige a quién se le abona el saldo a favor.', 400)
  }

  // 🔴 S10 (I1): afuera, sin candado, sólo lo que NO cambia entre el envío y el reenvío: la petición y el medio del cobro (un cobro no
  // cambia de medio). Lo que sí cambia —las llaves, la marca de la terminal, «Sólo saldo a favor»— lo mira el núcleo con el cobro
  // bloqueado y DESPUÉS de reconocer la llave (`reglasBajoCandado`): una repetición siempre contesta lo escrito, nunca un rechazo
  // `STORE_CREDIT_` mientras la primera petición todavía espera el candado y luego abona.
  if (aSaldo) {
    const cobro = await cobroParaDevolver(input.venueId, input.paymentId)
    const motivo = cobro ? sinSaldoAFavorPorque({ ...cobro, tenderSystemKind: cobro.tenderType?.systemKind ?? null }) : null
    if (motivo) throw new AppError(motivo, 422, true, 'STORE_CREDIT_NOT_ALLOWED')
    // Con el cliente global y FUERA de la transacción de dinero (S1): un P2002 adentro la abortaría entera. Sin llaves no hace falta
    // (el núcleo rechaza con STORE_CREDIT_UNAVAILABLE); un medio oculto que queda sin usar no hace daño (spec §5.1).
    if (storeCreditAvailable()) await prepararMediosDeSaldoAFavor(input.venueId)
  }

  const reglasBajoCandado = async (tx: Prisma.TransactionClient, cobro: CobroBloqueado): Promise<void> => {
    if (aSaldo) {
      if (!storeCreditAvailable()) throw new AppError(SIN_LLAVES, 422, true, 'STORE_CREDIT_UNAVAILABLE')
      // S7: la terminal está devolviendo este cobro (o la raíz de su crédito) al banco → 409 sin escribir.
      await rechazarSiLaTerminalEstaDevolviendo(input.venueId, { paymentId: input.paymentId }, tx)
      return
    }
    if (defective || !MOTIVOS_DE_SOLO_SALDO.has(input.reason)) return
    const ajustes = await tx.venueSettings.findUnique({ where: { venueId: input.venueId }, select: { storeCreditOnly: true } })
    if (
      soloSaldoLoImpide({
        storeCreditOnly: soloSaldoEfectivo(ajustes?.storeCreditOnly), // D-1: sin llaves no restringe
        reason: input.reason,
        defective,
        refundMethod,
        pagadoConSaldo: cobro.original.tenderSystemKind === 'GIFT_CARD',
      })
    ) {
      throw new BadRequestError(
        'Este negocio devuelve sólo como saldo a favor. Elige Saldo a favor, o marca que es por defecto o cobro por error.',
        'STORE_CREDIT_ONLY',
      )
    }
  }

  const { abono, ...result } = await refundDashboardService.issueRefund({
    ...base,
    reglasBajoCandado,
    ...(refundMethod === 'STORE_CREDIT'
      ? {
          aSaldoAFavor: {
            customerId: customerId!,
            abonar: async (tx, refundPaymentId, preparado, fila) => {
              // Con sesión siempre hay quien abona; sin ella se cae la transacción en vez de escribir un id vacío en la libreta.
              if (!input.staffId) throw new Error('Reembolso a saldo a favor sin la persona de la sesión')
              const venta = await tx.order.findFirst({ where: { id: fila.orderId, venueId: input.venueId }, select: { orderNumber: true } })
              return abonarSaldoAFavorEnTx(tx, {
                preparado,
                monto: new Prisma.Decimal(fila.montoCents).div(100),
                staffId: input.staffId,
                origen: { orderId: fila.orderId, refundPaymentId },
                folio: venta?.orderNumber ?? refundPaymentId.slice(-6),
                tipo: 'REEMBOLSO',
              })
            },
          },
        }
      : { refundMethod }),
  })
  if (!aSaldo) return result

  // Lo abonado se lee de la libreta: la misma respuesta para el envío y para una repetición (que no trae `abono`).
  const storeCredit = (await saldosAFavorDeReembolsos(input.venueId, [result.refundId])).get(result.refundId)
  if (abono && storeCredit) {
    void logAction({
      staffId: input.staffId ?? null,
      venueId: input.venueId,
      action: 'REFUND_TO_STORE_CREDIT',
      entity: 'Payment',
      entityId: result.refundId,
      data: {
        originalPaymentId: result.originalPaymentId,
        giftCardId: abono.giftCardId,
        customerId: storeCredit.customerId,
        customerName: storeCredit.customerName,
        amount: storeCredit.amountCents / 100, // pesos
        newBalance: storeCredit.newBalanceCents / 100,
        phoneMismatch: storeCredit.phoneMismatch,
        reason: input.reason,
      },
    })
  }
  return { ...result, ...(storeCredit ? { storeCredit } : {}) }
}

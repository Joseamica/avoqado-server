// src/services/storeCredit/storeCreditRefund.service.ts
/**
 * El Reembolso del POS (`POST /mobile/venues/:v/payments/:id/refund`) con el saldo a favor (spec 2026-10-30-saldo-a-favor §4, §5.5):
 * - `refundMethod: 'STORE_CREDIT'` abona lo devuelto al sobre de la clienta elegida (mamá → hija), en la MISMA transacción que la
 *   devolución (`issueRefund` con `aSaldoAFavor`); llave obligatoria;
 * - «Sólo saldo a favor»: con devolución de mercancía u «Otro» y sin defecto, sólo sale como saldo o a su mismo sobre;
 * - una repetición por llave (la app murió tras el commit, reenvía otra cajera) se reconoce ANTES de cualquier regla y responde lo mismo.
 * 🔴 Todo rechazo `STORE_CREDIT_` es un 4xx SIN escritura: las apps borran lo pendiente con ese prefijo.
 */
import { Prisma } from '@prisma/client'
import AppError, { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import * as refundDashboardService from '../dashboard/refund.dashboard.service'
import type { IssueRefundInput, IssueRefundResult } from '../dashboard/refund.dashboard.service'
import { logAction } from '../dashboard/activity-log.service'
import { abonarSaldoAFavorEnTx } from '../giftCards/giftCardLedger'
import { GiftCardError } from '../giftCards/giftCardErrors'
import { sinSaldoAFavorPorque, type CobroParaDevolver, type DevolverCon } from '../tpv/terminalRefundTarget'
import { prepararMediosDeSaldoAFavor, storeCreditAvailable } from './storeCreditTender'
import { saldosAFavorDeReembolsos, type StoreCreditDelReembolso } from './saldoAbonado'
import { rechazarSiLaTerminalEstaDevolviendo } from './terminalRefundMarker'

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

  // 🔴 Lo ya escrito con esta llave se contesta como se escribió, ANTES de las reglas: si entre el envío y el reenvío se apagaron las
  // llaves o se prendió «sólo saldo», un rechazo `STORE_CREDIT_` haría que la app borrara un reembolso que SÍ existe.
  const yaEscrito = input.idempotencyKey
    ? await prisma.payment.findUnique({
        where: { venueId_idempotencyKey: { venueId: input.venueId, idempotencyKey: input.idempotencyKey } },
        select: { id: true },
      })
    : null

  if (!yaEscrito) {
    const restringido = !defective && MOTIVOS_DE_SOLO_SALDO.has(input.reason) && !aSaldo
    const ajustes = restringido
      ? await prisma.venueSettings.findUnique({ where: { venueId: input.venueId }, select: { storeCreditOnly: true } })
      : null
    // El cobro sólo se lee si hace falta (a saldo, o «sólo saldo» prendido); no cambia de medio, así que leerlo aquí es seguro.
    const cobro = aSaldo || ajustes?.storeCreditOnly ? await cobroParaDevolver(input.venueId, input.paymentId) : null
    const tenderSystemKind = cobro?.tenderType?.systemKind ?? null
    if (
      soloSaldoLoImpide({
        storeCreditOnly: ajustes?.storeCreditOnly ?? false,
        reason: input.reason,
        defective,
        refundMethod,
        pagadoConSaldo: tenderSystemKind === 'GIFT_CARD',
      })
    ) {
      throw new BadRequestError(
        'Este negocio devuelve sólo como saldo a favor. Elige Saldo a favor, o marca que es por defecto o cobro por error.',
        'STORE_CREDIT_ONLY',
      )
    }
    if (aSaldo) {
      if (!storeCreditAvailable()) throw new AppError(SIN_LLAVES, 422, true, 'STORE_CREDIT_UNAVAILABLE')
      const motivo = cobro ? sinSaldoAFavorPorque({ ...cobro, tenderSystemKind }) : null
      if (motivo) throw new AppError(motivo, 422, true, 'STORE_CREDIT_NOT_ALLOWED')
      // S7: la terminal está devolviendo este cobro (o la raíz de su crédito) al banco → 409 sin escribir.
      await rechazarSiLaTerminalEstaDevolviendo(input.venueId, { paymentId: input.paymentId })
      // Con el cliente global y FUERA de la transacción de dinero (S1): un P2002 adentro la abortaría entera.
      await prepararMediosDeSaldoAFavor(input.venueId)
    }
  }

  const { abono, ...result } = await refundDashboardService.issueRefund({
    ...base,
    ...(refundMethod === 'STORE_CREDIT'
      ? {
          aSaldoAFavor: {
            customerId: customerId!,
            abonar: async (tx, refundPaymentId, preparado, fila) => {
              const venta = await tx.order.findFirst({ where: { id: fila.orderId, venueId: input.venueId }, select: { orderNumber: true } })
              return abonarSaldoAFavorEnTx(tx, {
                preparado,
                monto: new Prisma.Decimal(fila.montoCents).div(100),
                staffId: input.staffId ?? '',
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

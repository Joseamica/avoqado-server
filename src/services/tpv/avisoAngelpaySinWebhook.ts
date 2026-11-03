/**
 * D11: una cuenta activa de AngelPay SIN aviso del banco acaba de cobrar con tarjeta. Sin aviso, ese cobro no se concilia solo, y hasta
 * hoy nadie se enteraba (medido en producción el 21-oct: 13 cuentas activas sin aviso; dos de ellas cobraron). Se avisa a soporte: 🚨 en
 * cada cobro nuevo y correo una vez por cuenta en la ventana.
 *
 * 🔴 Corre DESPUÉS del commit y nadie lo espera: nunca altera ni demora el cobro. El servidor se apaga ante un rechazo sin atrapar
 * (`src/server.ts`), así que aquí todo termina atrapado. Si el proceso muere antes de mandar el correo se pierde; el 🚨 y el estado
 * «Sin registrar» del detalle de la cuenta quedan.
 *
 * Sólo mira que falte el canal. Que una cuenta ya registrada no reciba avisos es otra condición y es de D5: no se alerta aquí.
 */
import logger from '../../config/logger'
import { getVenueName } from '../../observability/venueNames'
import prisma from '../../utils/prismaClient'
import { sendOpsAlert } from '../alerts/opsAlert.service'
import { REFUND_PAYMENT_TYPE } from '../shared/orderBalance'
import { paymentIsAvoqadoSettled, type TenderSemanticsPayment } from '../shared/tenderSemantics'

export const VENTANA_DEL_CORREO_MS = 24 * 60 * 60_000
/** Las cuentas reales son decenas. El tope sólo acota la memoria; pasarlo únicamente cuesta repetir un correo. */
export const TOPE_DE_CUENTAS = 1_000

// `Map` conserva el orden de inserción: la primera es la más vieja. En memoria a propósito: un reinicio, o una segunda instancia,
// repite un correo, nunca pierde uno (`.claude/rules/una-sola-instancia.md`). No es evidencia ni candado de nada.
const ultimoCorreoPorCuenta = new Map<string, number>()

export function __reiniciarCorreosParaPruebas(): void {
  ultimoCorreoPorCuenta.clear()
}

function tocaCorreo(merchantAccountId: string, ahora: number): boolean {
  const ultimo = ultimoCorreoPorCuenta.get(merchantAccountId)
  if (ultimo !== undefined && ahora - ultimo < VENTANA_DEL_CORREO_MS) return false
  // Borrar y volver a poner deja el orden de inserción = el del último correo.
  ultimoCorreoPorCuenta.delete(merchantAccountId)
  if (ultimoCorreoPorCuenta.size >= TOPE_DE_CUENTAS) {
    ultimoCorreoPorCuenta.delete(ultimoCorreoPorCuenta.keys().next().value as string)
  }
  ultimoCorreoPorCuenta.set(merchantAccountId, ahora)
  return true
}

export interface CobroParaAviso extends TenderSemanticsPayment {
  id: string
  merchantAccountId?: string | null
  status: string
  type?: string | null
}

async function revisar(cobro: CobroParaAviso, venueId: string): Promise<void> {
  const { merchantAccountId } = cobro
  if (!merchantAccountId || cobro.status !== 'COMPLETED' || cobro.type === REFUND_PAYMENT_TYPE || !paymentIsAvoqadoSettled(cobro)) return

  const cuenta = await prisma.merchantAccount.findFirst({
    where: { id: merchantAccountId, active: true, angelpayWebhookSecret: null, provider: { code: 'ANGELPAY' } },
    select: { displayName: true, externalMerchantId: true },
  })
  if (!cuenta) return

  logger.error('🚨 [AngelPay] Esta cuenta cobra sin aviso del banco configurado: registrarlo en SUPERADMIN', {
    venueId,
    venueName: getVenueName(venueId),
    merchantAccountId,
    externalMerchantId: cuenta.externalMerchantId,
    paymentId: cobro.id,
  })

  if (!tocaCorreo(merchantAccountId, Date.now())) return
  const nombre = cuenta.displayName ?? cuenta.externalMerchantId
  const enviado = await sendOpsAlert({
    subject: `AngelPay sin aviso del banco: ${nombre} (${getVenueName(venueId) ?? venueId}) ya cobró`,
    lines: [
      `La cuenta ${nombre} (comercio ${cuenta.externalMerchantId}) acaba de cobrar con tarjeta y no tiene aviso del banco: sus cobros no se concilian solos.`,
      'Regístralo en SUPERADMIN → Merchants → esta cuenta → Aviso del banco, con la llave de API de la cuenta.',
    ],
  })
  // Un correo que no salió no gasta la ventana: lo intenta el siguiente cobro.
  if (!enviado) ultimoCorreoPorCuenta.delete(merchantAccountId)
}

/** Se llama con `void`, como los demás avisos del cobro. La promesa nunca se rechaza: ni si truena el logger. */
export function avisarSiCobraSinAviso(cobro: CobroParaAviso, venueId: string): Promise<void> {
  return revisar(cobro, venueId)
    .catch(error => {
      logger.warn('⚠️ [AngelPay] No se pudo revisar si la cuenta del cobro tiene aviso del banco; el cobro ya quedó', {
        venueId,
        merchantAccountId: cobro.merchantAccountId,
        paymentId: cobro.id,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    .catch(() => undefined)
}

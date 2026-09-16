/**
 * Procedencia de un Payment respecto de una solicitud POS → terminal (Codex R12-6, checkpoint 1 del webhook).
 *
 * UN solo criterio —el del cierre financiero— para las dos preguntas que antes se contestaban distinto:
 *  · «¿este Payment recién registrado puede LIGAR esta solicitud?» (`closeRowFromPaymentTx`, fase `ligar`), y
 *  · «¿el `paymentId` que la fila ya trae es de verdad SU cobro?» (el árbitro S0 y el propio cierre, fase `ganador`).
 * La segunda pregunta no existía: el árbitro le creía a `row.paymentId` con sólo encontrar un Payment del mismo venue, y un
 * resultado no-success del socket podía escribir ahí una venta ajena — que después convertía el cargo auténtico en «segunda
 * captura». Un puntero SIN procedencia no es un ganador: se ignora (con 🚨 y bitácora) y el cargo auténtico liga la fila.
 *
 * Todo camino legítimo que escribe un ganador ETIQUETA al Payment con la solicitud (`Payment.terminalPaymentRequestId` o
 * `processorData.terminalPaymentRequestId`): el cierre por REST la escribe junto con la fila, el cierre por socket la exige
 * y el barrido de recuperación también. Por eso en la fase `ganador` la etiqueta de ESTA solicitud es obligatoria; en la
 * fase `ligar` el Payment acaba de nacer y la etiqueta la escribe el propio cierre — sólo se rechaza la de OTRA solicitud.
 * Módulo PURO (sin Prisma ni logger); la elegibilidad por estado/método/orden va como fragmento `where` para que la
 * consulta y la comprobación en memoria digan lo mismo.
 */
import { PaymentMethod, PaymentType, TransactionStatus } from '@prisma/client'
import { terminalIdentityKey } from '../../utils/terminalSerial'

export type FaseDeProcedencia = 'ligar' | 'ganador'

export type PagoConProcedencia = {
  processorData: unknown
  terminalPaymentRequestId: string | null
  terminal: { serialNumber: string | null } | null
}

export type SolicitudDeProcedencia = { requestId: string; orderId: string | null; terminalId: string }

export type Procedencia =
  | { acreditada: true; serial: string; serialPersistido: string | null; metadata: Record<string, unknown> }
  | {
      acreditada: false
      reason: 'PAYMENT_TAGGED_FOR_ANOTHER_REQUEST' | 'NOT_TAGGED_FOR_THIS_REQUEST' | 'NO_TERMINAL_IDENTITY' | 'TERMINAL_MISMATCH'
    }

/** Estados que puede tener un Payment según la fase: para ligar tiene que estar COMPLETED; un ganador reembolsado sigue siéndolo. */
export const ESTADOS_POR_FASE: Record<FaseDeProcedencia, TransactionStatus[]> = {
  ligar: [TransactionStatus.COMPLETED],
  ganador: [TransactionStatus.COMPLETED, TransactionStatus.REFUNDED],
}

/**
 * Elegibilidad como cobro de una solicitud, expresada como `where` de Prisma: pago con tarjeta, no un REFUND, en el estado de
 * la fase, y de la MISMA orden cuando la solicitud tiene una. Lo comparten el cierre financiero, el árbitro y el barrido.
 */
export function whereElegibleComoCobroDeSolicitud(solicitud: { orderId: string | null }, fase: FaseDeProcedencia) {
  return {
    status: { in: ESTADOS_POR_FASE[fase] },
    method: { in: [PaymentMethod.CREDIT_CARD, PaymentMethod.DEBIT_CARD] },
    OR: [{ type: null }, { type: { not: PaymentType.REFUND } }],
    ...(solicitud.orderId ? { orderId: solicitud.orderId } : {}),
  }
}

export function metadataDe(processorData: unknown): Record<string, unknown> {
  return processorData && typeof processorData === 'object' && !Array.isArray(processorData)
    ? (processorData as Record<string, unknown>)
    : {}
}

/**
 * La procedencia en memoria, sobre un Payment que YA pasó la elegibilidad de `whereElegibleComoCobroDeSolicitud`:
 * la etiqueta (columna o `processorData`) y la identidad física del aparato (`Payment.terminal` → serial autenticado que
 * aporta el llamador → serial persistido en `processorData`), comparada con la terminal de la solicitud.
 */
export function procedenciaDelPagoDeSolicitud(
  pago: PagoConProcedencia,
  solicitud: SolicitudDeProcedencia,
  opciones: { fase: FaseDeProcedencia; capturedBySerial?: string | null },
): Procedencia {
  const metadata = metadataDe(pago.processorData)
  const etiqueta =
    pago.terminalPaymentRequestId ??
    (typeof metadata.terminalPaymentRequestId === 'string' ? (metadata.terminalPaymentRequestId as string) : null)
  if (etiqueta && etiqueta !== solicitud.requestId) return { acreditada: false, reason: 'PAYMENT_TAGGED_FOR_ANOTHER_REQUEST' }
  if (opciones.fase === 'ganador' && etiqueta !== solicitud.requestId) return { acreditada: false, reason: 'NOT_TAGGED_FOR_THIS_REQUEST' }
  const serialPersistido = typeof metadata.deviceSerialNumber === 'string' ? (metadata.deviceSerialNumber as string) : null
  const serial = pago.terminal?.serialNumber ?? opciones.capturedBySerial ?? serialPersistido
  if (!serial) return { acreditada: false, reason: 'NO_TERMINAL_IDENTITY' }
  if (solicitud.terminalId && terminalIdentityKey(serial) !== terminalIdentityKey(solicitud.terminalId))
    return { acreditada: false, reason: 'TERMINAL_MISMATCH' }
  return { acreditada: true, serial, serialPersistido, metadata }
}

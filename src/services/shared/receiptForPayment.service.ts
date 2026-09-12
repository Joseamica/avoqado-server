import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { generateDigitalReceipt } from '../tpv/digitalReceipt.tpv.service'
import { mapDigitalReceiptResponse, resolveAutofacturaAvailable } from '../tpv/payment.tpv.service'

/**
 * La liga del recibo digital de un pago YA cobrado, para que cualquiera de los tres POS pueda
 * dibujar el QR al **reimprimir** un ticket.
 *
 * 🔴 Por qué existe (Asana «POS - Reimpresion de Ticket sin QR de facturacion», 11-sep-2026): la
 * llave del recibo sólo viajaba en la respuesta del COBRO y ahí moría. Ninguna ruta de consulta
 * —ni el historial de la TPV (`payment.tpv.service.getPayments`) ni el detalle de transacción de
 * android/iOS (`transaction.mobile.service.getTransactionDetail`)— la devolvía, así que la
 * reimpresión no tenía con qué armar el QR aunque la plantilla supiera dibujarlo.
 *
 * Vive en `shared/` y no dentro de `digitalReceipt.tpv.service.ts` por dos razones: ese módulo lo
 * importa `payment.tpv.service.ts`, y traerse de vuelta el mapper cerraría un ciclo de imports; y
 * los dos namespaces (`/mobile` y `/tpv`) tienen que responder EXACTAMENTE lo mismo — si cada uno
 * arma su propia versión, divergen, que es justo lo que ya pasó entre el ticket del cobro y el del
 * historial.
 */
export interface ReceiptForPayment {
  accessKey: string
  receiptUrl: string
  autofacturaAvailable: boolean
}

/**
 * @param venueId Negocio dueño del pago (aislamiento de tenant — un pago de otro venue NO existe)
 * @param paymentId Pago ya cobrado del que se quiere la liga
 * @throws NotFoundError si el pago no existe o no pertenece a este venue
 */
export async function getReceiptForPayment(venueId: string, paymentId: string): Promise<ReceiptForPayment> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, venueId },
    select: { id: true, orderId: true },
  })

  if (!payment) {
    throw new NotFoundError(`Payment con ID ${paymentId} no encontrado`)
  }

  // 🔴 Se DELEGA siempre, nunca se busca el recibo por cuenta propia: `generateDigitalReceipt`
  // serializa con `FOR UPDATE` y, cuando hay duplicados históricos, se queda con el MÁS ANTIGUO.
  // Un `findFirst` local sin ese orden devolvería otra llave para el mismo pago, y el cliente
  // acabaría viendo dos recibos distintos del mismo ticket según por dónde entró.
  const receipt = await generateDigitalReceipt(payment.id)

  const autofacturaAvailable = await resolveAutofacturaAvailable(payment.orderId)

  // 🔴 Se le pasa SÓLO la llave, no la fila: `mapDigitalReceiptResponse` hace `...receipt`, así que
  // con la fila completa la respuesta llevaría el `dataSnapshot` (el ticket entero en JSON) más el
  // correo y el teléfono del cliente — datos personales que la app no necesita para pintar un QR.
  // Pasar por el mapper, en cambio, mantiene la construcción de la URL en UN solo sitio.
  return mapDigitalReceiptResponse({ accessKey: receipt.accessKey }, autofacturaAvailable) as ReceiptForPayment
}

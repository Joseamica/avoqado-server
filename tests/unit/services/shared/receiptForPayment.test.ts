/**
 * 🔴 La REIMPRESIÓN del ticket también lleva el QR de facturación.
 *
 * Asana «POS - Reimpresion de Ticket sin QR de facturacion» (11-sep-2026). El ticket que sale al
 * cobrar lleva QR desde 2025; el que sale al reimprimir desde el historial NUNCA lo tuvo — lo arma
 * otra plantilla, y sobre todo: **la llave del recibo no viaja en ninguna ruta de consulta**. Vive
 * en la respuesta del cobro (`mapDigitalReceiptResponse`) y ahí muere.
 *
 * Este servicio es la mitad de servidor: dado un pago, devuelve su liga de recibo para que
 * cualquiera de las tres apps pueda dibujar el QR al reimprimir.
 *
 * Tres cosas que se prueban porque equivocarse en ellas no da error, sólo daño:
 *  1. **Aislamiento de tenant**: se comprueba la FORMA de la consulta, no sólo que devuelva null —
 *     un mock que siempre devuelve null pasa igual aunque alguien borre el filtro por venue.
 *  2. **No se filtra el `dataSnapshot`**: `mapDigitalReceiptResponse` hace `...receipt`, así que
 *     pasarle la fila completa mandaría el ticket ENTERO en JSON más el correo y el teléfono del
 *     cliente a una app que sólo necesita una URL.
 *  3. **Una sola forma de elegir la llave**: se delega siempre en `generateDigitalReceipt`, que ya
 *     serializa con `FOR UPDATE` y se queda con el recibo MÁS ANTIGUO. Una búsqueda propia sin ese
 *     orden puede devolver otra llave cuando hay duplicados históricos.
 */

const mockGenerateDigitalReceipt = jest.fn()
const mockLoadOrderForCfdiFromDb = jest.fn()

jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: (...args: unknown[]) => mockGenerateDigitalReceipt(...args),
  generateReceiptUrl: jest.fn(),
  getDigitalReceiptByAccessKey: jest.fn(),
}))

jest.mock('@/services/fiscal/cfdi.service', () => ({
  loadOrderForCfdiFromDb: (...args: unknown[]) => mockLoadOrderForCfdiFromDb(...args),
}))

import { getReceiptForPayment } from '@/services/shared/receiptForPayment.service'
import { NotFoundError } from '@/errors/AppError'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE_ID = 'venue-1'
const PAYMENT_ID = 'pmt-1'
const ORDER_ID = 'ord-1'

/** Fila REAL de DigitalReceipt: lo que Prisma devuelve trae mucho más que la llave. */
const filaCompletaDeRecibo = {
  id: 'rcp-1',
  paymentId: PAYMENT_ID,
  accessKey: 'llave-abc',
  status: 'PENDING',
  dataSnapshot: { payment: { amount: 250 }, items: [{ productName: 'Latte' }] },
  recipientEmail: 'cliente@ejemplo.com',
  recipientPhone: '+5215512345678',
  sentAt: null,
  viewedAt: null,
  createdAt: new Date('2026-09-01T10:00:00Z'),
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGenerateDigitalReceipt.mockResolvedValue(filaCompletaDeRecibo)
  mockLoadOrderForCfdiFromDb.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: true })
  prismaMock.payment.findFirst.mockResolvedValue({ id: PAYMENT_ID, orderId: ORDER_ID } as never)
})

describe('getReceiptForPayment — la liga del recibo para reimprimir', () => {
  it('devuelve la liga del recibo del pago', async () => {
    const resultado = await getReceiptForPayment(VENUE_ID, PAYMENT_ID)

    expect(resultado.accessKey).toBe('llave-abc')
    expect(resultado.receiptUrl).toContain('/receipts/public/llave-abc')
    expect(resultado.autofacturaAvailable).toBe(true)
  })

  it('🔴 el pago de OTRO negocio no existe para este venue', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(null as never)

    await expect(getReceiptForPayment(VENUE_ID, 'pmt-ajeno')).rejects.toThrow(NotFoundError)
    expect(mockGenerateDigitalReceipt).not.toHaveBeenCalled()
  })

  it('🔴 el aislamiento vive en la CONSULTA: el where lleva venueId y paymentId', async () => {
    // Sin esto, borrar el filtro por venue no rompería ninguna prueba: el mock
    // devuelve lo mismo pase lo que pase.
    await getReceiptForPayment(VENUE_ID, PAYMENT_ID)

    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: PAYMENT_ID, venueId: VENUE_ID }),
      }),
    )
  })

  it('🔴 NO filtra el dataSnapshot ni los datos personales del cliente', async () => {
    const resultado = await getReceiptForPayment(VENUE_ID, PAYMENT_ID)

    expect(Object.keys(resultado).sort()).toEqual(['accessKey', 'autofacturaAvailable', 'receiptUrl'])
    expect(resultado).not.toHaveProperty('dataSnapshot')
    expect(resultado).not.toHaveProperty('recipientEmail')
    expect(resultado).not.toHaveProperty('recipientPhone')
  })

  it('🔴 delega en generateDigitalReceipt (única selección válida de la llave)', async () => {
    await getReceiptForPayment(VENUE_ID, PAYMENT_ID)

    // El generador ya serializa con FOR UPDATE y se queda con el recibo más antiguo.
    expect(mockGenerateDigitalReceipt).toHaveBeenCalledWith(PAYMENT_ID)
    // Y no se busca el recibo por cuenta propia, que es donde se elegiría otra llave.
    expect(prismaMock.digitalReceipt.findFirst).not.toHaveBeenCalled()
  })

  it('la segunda llamada devuelve la MISMA llave (idempotente)', async () => {
    const uno = await getReceiptForPayment(VENUE_ID, PAYMENT_ID)
    const dos = await getReceiptForPayment(VENUE_ID, PAYMENT_ID)

    expect(dos.accessKey).toBe(uno.accessKey)
  })

  it('autofacturaAvailable es false cuando el venue no puede autofacturar', async () => {
    mockLoadOrderForCfdiFromDb.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: false })

    const resultado = await getReceiptForPayment(VENUE_ID, PAYMENT_ID)

    expect(resultado.autofacturaAvailable).toBe(false)
    // La liga SÍ sale: el QR lleva al recibo aunque no se pueda facturar.
    expect(resultado.receiptUrl).toContain('/receipts/public/llave-abc')
  })

  it('🔴 si el recibo no se puede generar, el error SUBE — la app decide degradar', async () => {
    // Aquí no aplica el fail-open del camino del cobro: esto es una lectura explícita
    // para imprimir. Tragarse el error devolvería una liga vacía y el ticket saldría
    // con la leyenda sin QR, que es justo el defecto que se está cerrando.
    mockGenerateDigitalReceipt.mockRejectedValue(new Error('base caída'))

    await expect(getReceiptForPayment(VENUE_ID, PAYMENT_ID)).rejects.toThrow('base caída')
  })
})

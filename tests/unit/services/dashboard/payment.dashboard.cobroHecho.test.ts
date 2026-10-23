/**
 * Un cobro ya hecho no se corrige ni se borra desde el panel (founder 23-oct, «como Square», opción A).
 * `updatePayment`/`deletePayment` cambiaban la fila Payment sin recalcular la cuenta: una venta de $100 PAID cuyo cobro se corregía a
 * $50 seguía PAID «debe $0». Ahora el dinero de un cobro COMPLETED/REFUNDED (importe, propina, estado, forma de pago) no se toca
 * aquí y el cobro no se borra: se corrige con Reembolso. Los datos que no mueven dinero se siguen corrigiendo.
 *   npx jest --selectProjects unit --runTestsByPath tests/unit/services/dashboard/payment.dashboard.cobroHecho.test.ts
 */
import { TransactionStatus } from '@prisma/client'

import { deletePayment, updatePayment } from '@/services/dashboard/payment.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE_ID = 'venue-cobro-hecho'
const PAYMENT_ID = 'payment-hecho'
const CODIGO = 'PAYMENT_SETTLED_USE_REFUND'

const cobro = (status: TransactionStatus) => ({
  id: PAYMENT_ID,
  venueId: VENUE_ID,
  status,
  method: 'CASH',
  amount: 100,
  tipAmount: 0,
  cardBrand: null,
  maskedPan: null,
  authorizationNumber: null,
  referenceNumber: 'R1',
  entryMode: null,
  transactionCost: null,
})

function con(status: TransactionStatus) {
  const fila = cobro(status)
  prismaMock.payment.findFirst.mockResolvedValue(fila as any)
  prismaMock.payment.update.mockImplementation((async ({ data }: any) => ({ ...fila, ...data })) as any)
  return fila
}

beforeEach(() => {
  // Bajo el mutex del Payment se pregunta `cobrosDelProtocolo` (SQL): [] = un cobro fuera del protocolo de costo.
  prismaMock.$queryRaw.mockResolvedValue([])
})

describe.each([TransactionStatus.COMPLETED, TransactionStatus.REFUNDED])('cobro %s (ya movió dinero)', status => {
  it.each([
    ['amount', { amount: 50 }],
    ['tipAmount', { tipAmount: 5 }],
    ['status', { status: TransactionStatus.FAILED }],
    ['method', { method: 'CREDIT_CARD' as any }],
  ])('no deja cambiar %s: 409 «usa Reembolso» y no escribe', async (campo, cambio) => {
    con(status)
    await expect(updatePayment(VENUE_ID, PAYMENT_ID, cambio as any)).rejects.toMatchObject({
      statusCode: 409,
      code: CODIGO,
      message: expect.stringContaining('Reembolso'),
      details: expect.objectContaining({ paymentId: PAYMENT_ID, fields: [campo] }),
    })
    expect(prismaMock.payment.update).not.toHaveBeenCalled()
  })

  it('sí deja corregir lo que no mueve dinero (marca, autorización, referencia)', async () => {
    con(status)
    await expect(
      updatePayment(VENUE_ID, PAYMENT_ID, { cardBrand: 'VISA' as any, authorizationNumber: 'A9', referenceNumber: 'R2' }),
    ).resolves.toMatchObject({ referenceNumber: 'R2', authorizationNumber: 'A9' })
    expect(prismaMock.payment.update).toHaveBeenCalledTimes(1)
  })

  it('el formulario manda los MISMOS valores de dinero junto con la corrección: no cuenta como cambio', async () => {
    con(status)
    await expect(
      updatePayment(VENUE_ID, PAYMENT_ID, { amount: 100, tipAmount: 0, method: 'CASH' as any, status, referenceNumber: 'R3' }),
    ).resolves.toMatchObject({ referenceNumber: 'R3' })
    const data = prismaMock.payment.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty('amount')
    expect(data).not.toHaveProperty('tipAmount')
    expect(data).not.toHaveProperty('method')
    expect(data).not.toHaveProperty('status')
  })

  it('no se borra: 409 «usa Reembolso» y el cobro sigue', async () => {
    con(status)
    await expect(deletePayment(VENUE_ID, PAYMENT_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: CODIGO,
      message: expect.stringContaining('Reembolso'),
    })
    expect(prismaMock.payment.delete).not.toHaveBeenCalled()
    expect(prismaMock.digitalReceipt.deleteMany).not.toHaveBeenCalled()
  })
})

describe.each([TransactionStatus.PENDING, TransactionStatus.PROCESSING, TransactionStatus.FAILED])(
  'cobro %s (no movió dinero): como hoy',
  status => {
    it('se le corrige el importe', async () => {
      con(status)
      await expect(updatePayment(VENUE_ID, PAYMENT_ID, { amount: 80 })).resolves.toMatchObject({ amount: 80 })
    })

    it('se borra', async () => {
      con(status)
      await expect(deletePayment(VENUE_ID, PAYMENT_ID)).resolves.toBeUndefined()
      expect(prismaMock.payment.delete).toHaveBeenCalledTimes(1)
    })
  },
)

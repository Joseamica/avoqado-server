/**
 * S3 «Efectivo sin red en el turno correcto» (Codex r2 código #2 y #3): el reintento idempotente de un pago APARTADO de antes del
 * efecto durable asegura su `AVISO_TURNO_CERRADO`. Si la escritura falla, LANZA (el aparato reintenta con la misma llave y se vuelve a
 * asegurar); nunca responde éxito sin el efecto. Y el aviso dice el monto GUARDADO del pago, no el que trae el reintento.
 */
import { asegurarAvisoDeVentaApartada } from '@/services/tpv/paymentEffects.service'
import { prismaMock } from '../../../__helpers__/setup'

const PAGO = {
  venueId: 'venue-1',
  paymentId: 'pay-1',
  orderId: 'order-1',
  status: 'COMPLETED',
  posRawData: { cajaDeLaVentaCerrada: 'caja-A' },
  externalId: 'llave-1',
  montoPesos: '100.00',
  terminalSerial: null,
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.payment.findFirst.mockResolvedValue({ orderId: 'order-1' })
  prismaMock.paymentEffect.createMany.mockResolvedValue({ count: 1 })
})

it('la escritura del efecto falla ⇒ LANZA (el reintento no responde éxito sin el efecto); al reintentar, se crea', async () => {
  prismaMock.paymentEffect.createMany.mockRejectedValueOnce(Object.assign(new Error('conexión cerrada'), { code: 'P1017' }))
  await expect(asegurarAvisoDeVentaApartada(PAGO)).rejects.toMatchObject({ code: 'P1017' })
  await expect(asegurarAvisoDeVentaApartada(PAGO)).resolves.toBeUndefined()
  expect(prismaMock.paymentEffect.createMany).toHaveBeenCalledTimes(2)
})

it('el aviso lleva el monto GUARDADO del pago ($100 ⇒ 10000 centavos), no el del reintento', async () => {
  await asegurarAvisoDeVentaApartada(PAGO)
  const [{ data }] = prismaMock.paymentEffect.createMany.mock.calls[0]
  expect(data[0]).toMatchObject({
    kind: 'AVISO_TURNO_CERRADO',
    dedupeKey: 'aviso-turno-cerrado:pay-1',
    payload: { externalId: 'llave-1', montoCents: 10000, orderId: 'order-1', terminalSerial: null },
  })
})

it('un pago que no está COMPLETED ⇒ ni efecto ni error (el cobro nuevo tampoco lo encola)', async () => {
  await expect(asegurarAvisoDeVentaApartada({ ...PAGO, status: 'PENDING' })).resolves.toBeUndefined()
  expect(prismaMock.paymentEffect.createMany).not.toHaveBeenCalled()
})

it('un pago que no quedó apartado ⇒ nada', async () => {
  await asegurarAvisoDeVentaApartada({ ...PAGO, posRawData: {} })
  expect(prismaMock.paymentEffect.createMany).not.toHaveBeenCalled()
})

/**
 * S3 «Efectivo sin red en el turno correcto» — el efecto `AVISO_TURNO_CERRADO`: el aviso al gerente de una venta apartada nace en la
 * transacción del cobro y lo completa el trabajador. Si la notificación no consta, el efecto vuelve a PENDIENTE SIN gastar intentos
 * (como la espera de `TRANSACTION_COST`): nunca llega a DEAD_LETTER ni queda DONE sin notificación (Codex plan r4 #3).
 */
jest.mock('@/services/mobile/avisoDeVentaSinRed', () => ({ enviarAvisoDeVentaSinRed: jest.fn() }))

import { enviarAvisoDeVentaSinRed } from '@/services/mobile/avisoDeVentaSinRed'
import { runClaimedPaymentEffect } from '@/services/tpv/paymentEffects.service'

const enviar = enviarAvisoDeVentaSinRed as jest.Mock

const efecto = {
  id: 'effect-1',
  venueId: 'venue-1',
  paymentId: 'pay-1',
  orderId: 'order-1',
  kind: 'AVISO_TURNO_CERRADO',
  status: 'PROCESSING',
  claimToken: 'token-1',
  payload: { externalId: 'llave-1', montoCents: 10000, orderId: 'order-1', terminalSerial: null },
  createdAt: new Date(),
}

function db() {
  return {
    paymentEffect: {
      findFirst: jest.fn().mockResolvedValue(efecto),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
  }
}

const claim = { ...efecto, attempts: 1, leaseUntil: new Date(), dedupeKey: 'aviso-turno-cerrado:pay-1' } as never

beforeEach(() => jest.clearAllMocks())

it('es un efecto externo: lo busca por su token entre los externos y manda el aviso de turno cerrado con su payload', async () => {
  const d = db()
  enviar.mockResolvedValue(undefined)

  expect(await runClaimedPaymentEffect(claim, d as never)).toBe(true)

  expect(d.paymentEffect.findFirst.mock.calls[0][0].where.kind.in).toContain('AVISO_TURNO_CERRADO')
  expect(enviar).toHaveBeenCalledWith('venue-1', 'TURNO_CERRADO', {
    externalId: 'llave-1',
    montoCents: 10000,
    orderId: 'order-1',
    terminalSerial: undefined,
  })
  expect(d.paymentEffect.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DONE' }) }))
})

it('si el aviso no consta ⇒ PENDIENTE de nuevo, intentos en 0 y reintento en 5 min; nunca DONE', async () => {
  const d = db()
  enviar.mockRejectedValue(new Error('AVISO_INCOMPLETO: 1 notificación(es) sin crear'))
  const antes = Date.now()

  expect(await runClaimedPaymentEffect(claim, d as never)).toBe(false)

  expect(d.paymentEffect.updateMany).toHaveBeenCalledTimes(1)
  const { where, data } = d.paymentEffect.updateMany.mock.calls[0][0]
  expect(where).toEqual({ id: 'effect-1', claimToken: 'token-1', status: 'PROCESSING' })
  expect(data).toMatchObject({
    status: 'PENDING',
    attempts: 0,
    claimToken: null,
    leaseUntil: null,
    lastError: 'AVISO_TURNO_CERRADO_PENDIENTE: AVISO_INCOMPLETO: 1 notificación(es) sin crear',
  })
  expect(data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(antes + 5 * 60_000)
})

it('pasado el plazo de 7 días sin constar ⇒ SIGUE pendiente (nunca se descarta), cada hora y como ERROR visible', async () => {
  const d = db()
  d.paymentEffect.findFirst.mockResolvedValue({ ...efecto, createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) })
  enviar.mockRejectedValue(new Error('AVISO_INCOMPLETO: 2 notificación(es) sin crear'))
  const antes = Date.now()

  expect(await runClaimedPaymentEffect(claim, d as never)).toBe(false)

  const { data } = d.paymentEffect.updateMany.mock.calls[0][0]
  expect(data).toMatchObject({
    status: 'PENDING',
    attempts: 0,
    lastError: 'AVISO_TURNO_CERRADO_ATRASADO: AVISO_INCOMPLETO: 2 notificación(es) sin crear',
  })
  expect(data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(antes + 60 * 60_000)
})

it('un error que no es nuestro no se guarda como texto (puede traer datos): sólo su código', async () => {
  const d = db()
  enviar.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432 select * from …'), { code: 'P1001' }))

  await runClaimedPaymentEffect(claim, d as never)

  expect(d.paymentEffect.updateMany.mock.calls[0][0].data.lastError).toBe('AVISO_TURNO_CERRADO_PENDIENTE: P1001')
})

it('la falla genérica del trabajador (fuera de su rama) tampoco lo descarta tras 6 intentos', async () => {
  const { failClaimedPaymentEffect } = jest.requireActual('@/services/tpv/paymentEffects.service')
  const d = {
    paymentEffect: { findFirst: jest.fn().mockResolvedValue({ lastError: null }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  }

  await failClaimedPaymentEffect({ ...(claim as object), attempts: 9 } as never, new Date(), new Error('x'), d as never)

  expect(d.paymentEffect.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'PENDING', attempts: 0 })
})

import { prismaMock } from '@tests/__helpers__/setup'

const mockWrite = jest.fn()
jest.mock('@/services/online-ordering/order.service', () => ({
  __esModule: true,
  TX_OPTIONS: {},
  emitOnlineOrderCreated: jest.fn(),
  lockAdmission: jest.fn(),
  pickOrderNumber: jest.fn(async () => '0001'),
  writeOnlineOrderInTx: (...a: unknown[]) => mockWrite(...a),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))
const getAuthorization = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: () => ({ getAuthorization: (...a: unknown[]) => getAuthorization(...a) }),
}))
jest.mock('@/services/online-ordering/card/release.service', () => ({
  __esModule: true,
  CAPTURED_OUTSIDE: 'CAPTURED_OUTSIDE',
  releaseCharge: jest.fn(async () => 'RELEASED'),
}))

import logger from '@/config/logger'
import { lockAdmission } from '@/services/online-ordering/order.service'
import { releaseCharge } from '@/services/online-ordering/card/release.service'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'

const MIN = 60_000
const NOW = new Date('2026-11-20T03:30:00.000Z') // 21:30 en CDMX (UTC−6)
const autorizada = (authorizedAt?: Date) => ({
  piStatus: 'requires_capture',
  paymentIntentId: 'pi_1',
  amountCapturableCents: 25000,
  captureBefore: new Date(NOW.getTime() + 7 * 24 * 60 * MIN),
  ...(authorizedAt ? { authorizedAt } : {}),
})
const REQUEST = { externalId: 'web:k', quote: {}, customer: { name: 'A', phone: '+5255' }, note: null, whatsappConsent: false }
/** Un borrador de «Mi equipo» (con su teléfono) o de «Nadie» (la marca `customerPhone: ''` y la clienta de la sesión). */
const borrador = (nadie: boolean, request: Record<string, unknown> = {}) => ({
  id: 'ch1',
  venueId: 'v1',
  status: 'PENDING_AUTH',
  lastError: null,
  checkoutSessionId: 'cs_1',
  ecommerceMerchantId: 'm1',
  merchantSnapshot: { connectAccountId: 'acct_1', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
  amount: '250.00',
  trackingToken: 't',
  requestHash: 'h',
  customerPhone: nadie ? '' : '+525512345678',
  createdAt: new Date(NOW.getTime() - 20 * MIN),
  request: nadie
    ? { ...REQUEST, customer: { name: 'A', phone: null, email: null }, nadie: true, customerId: null, cierreDeFranja: null, ...request }
    : { ...REQUEST, ...request },
})
const escrito = () => mockWrite.mock.calls[0][1]

beforeEach(() => {
  mockWrite.mockReset()
  mockWrite.mockResolvedValue({ orderId: 'o1', onlineOrderId: 'oo1' })
  getAuthorization.mockReset()
  getAuthorization.mockResolvedValue(autorizada())
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.onlineOrderCharge.updateMany.mockReset()
  prismaMock.onlineOrderCharge.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.onlineOrderCharge.update.mockResolvedValue({} as any)
  prismaMock.onlineOrderingSettings.findUnique.mockReset()
  prismaMock.venue.findUnique.mockReset()
})

describe('confirmar un borrador de tarjeta: el modo y el plazo son los del borrador', () => {
  it('confirmar respeta la regla del borrador (nadie → false; sin nadie → true) sea cual sea el modo de hoy', async () => {
    // Hoy la tienda está en «Nadie», y el borrador nació en «Mi equipo» (T8: borrador anterior al cambio): nace «Mi equipo».
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ requiresAcceptance: false } as any)
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador(false) as any)
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('CREATED')
    expect(escrito()).toMatchObject({ requiresAcceptance: true, paymentMode: 'CARD_ONLINE' })

    // Hoy la tienda volvió a «Mi equipo», y el borrador nació en «Nadie»: nace «Nadie» (nadie lo acepta: lo abre una caja).
    mockWrite.mockClear()
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ requiresAcceptance: true } as any)
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador(true) as any)
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('CREATED')
    expect(escrito()).toMatchObject({ requiresAcceptance: false, paymentMode: 'CARD_ONLINE' })
    // El modo de hoy no se consulta: decide la marca del borrador.
    expect(prismaMock.onlineOrderingSettings.findUnique).not.toHaveBeenCalled()
  })

  it('«Mi equipo» con tarjeta sigue igual: el plazo es la hora de confirmar + 10 min, aunque Stripe diga otra hora de autorización', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador(false) as any)
    getAuthorization.mockResolvedValue(autorizada(new Date(NOW.getTime() - 9 * MIN)))
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('CREATED')
    expect(escrito().acceptDeadlineAt).toEqual(new Date(NOW.getTime() + 10 * MIN))
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'AUTHORIZED', authorizedAt: NOW }) }),
    )
  })

  it('D661 (Ruling 10): en «Nadie» el plazo corre desde la hora en que STRIPE autorizó (+ 10 min), no desde que Avoqado se enteró; y lo topa el cierre de la franja del borrador', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador(true) as any)
    const autorizo = new Date(NOW.getTime() - 3 * MIN)
    getAuthorization.mockResolvedValue(autorizada(autorizo))
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('CREATED')
    expect(escrito().acceptDeadlineAt).toEqual(new Date(autorizo.getTime() + 10 * MIN))

    // La franja cierra antes de esos 10 min: el plazo es el cierre.
    mockWrite.mockClear()
    const cierre = new Date(NOW.getTime() + 2 * MIN)
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador(true, { cierreDeFranja: cierre.toISOString() }) as any)
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('CREATED')
    expect(escrito().acceptDeadlineAt).toEqual(cierre)
  })

  it('D661 (Ruling 10): una autorización que se conoce DESPUÉS del plazo (10 min de Stripe o el cierre) se libera sin crear un pedido abrible', async () => {
    // Stripe autorizó hace 11 min (el aviso se perdió): el plazo ya pasó.
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador(true) as any)
    getAuthorization.mockResolvedValue(autorizada(new Date(NOW.getTime() - 11 * MIN)))
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('RELEASED_LATE')
    expect(mockWrite).not.toHaveBeenCalled()
    // La decisión se toma bajo el candado de admisión, y nunca pasa el cargo a AUTHORIZED: va de PENDING_AUTH a RELEASING.
    expect(lockAdmission).toHaveBeenCalled()
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', status: 'PENDING_AUTH' },
      data: { status: 'RELEASING', paymentIntentId: 'pi_1', lastError: 'NADIE_DEADLINE_PASSED', stuckAlertedAt: null },
    })
    expect(releaseCharge).toHaveBeenCalledWith('ch1')

    // Autorizó hace 2 min, pero la franja ya cerró: también se libera.
    ;(prismaMock.onlineOrderCharge.updateMany as jest.Mock).mockClear()
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(
      borrador(true, { cierreDeFranja: new Date(NOW.getTime() - 1000).toISOString() }) as any,
    )
    getAuthorization.mockResolvedValue(autorizada(new Date(NOW.getTime() - 2 * MIN)))
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('RELEASED_LATE')
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('D661 · A5: en «Nadie» liberar lo que llegó tarde es un desenlace esperado: logger.warn sin 🚨; otro motivo sigue siendo logger.error con 🚨', async () => {
    ;(logger.warn as jest.Mock).mockClear()
    ;(logger.error as jest.Mock).mockClear()
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador(true) as any)
    getAuthorization.mockResolvedValue(autorizada(new Date(NOW.getTime() - 11 * MIN)))
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('RELEASED_LATE')
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('después de su plazo'),
      expect.objectContaining({ chargeId: 'ch1', why: 'NADIE_DEADLINE_PASSED' }),
    )
    expect((logger.warn as jest.Mock).mock.calls[0][0]).not.toContain('🚨')

    // Un monto distinto al apartado sí es una anomalía.
    ;(logger.error as jest.Mock).mockClear()
    getAuthorization.mockResolvedValue({ ...autorizada(new Date(NOW.getTime() - MIN)), amountCapturableCents: 100 })
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('RELEASED_LATE')
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('🚨'), expect.objectContaining({ why: 'AMOUNT_MISMATCH' }))
  })

  it('D661 (3C): sin la hora de autorización de Stripe, el plazo de «Nadie» cuenta desde la confirmación y queda un logger.warn con el cargo', async () => {
    ;(logger.warn as jest.Mock).mockClear()
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador(true) as any)
    getAuthorization.mockResolvedValue(autorizada()) // el adaptador no trajo `authorizedAt`
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('CREATED')
    expect(escrito().acceptDeadlineAt).toEqual(new Date(NOW.getTime() + 10 * MIN))
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hora de autorización'), { chargeId: 'ch1', venueId: 'v1' })

    // Con la hora de Stripe no hay aviso; «Mi equipo» nunca la usa, así que tampoco avisa.
    ;(logger.warn as jest.Mock).mockClear()
    getAuthorization.mockResolvedValue(autorizada(new Date(NOW.getTime() - MIN)))
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('CREATED')
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(borrador(false) as any)
    getAuthorization.mockResolvedValue(autorizada())
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('CREATED')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('D661 (Ruling 10): un borrador de «Nadie» sin el cierre guardado (anterior al campo) lo deriva del horario a la hora en que empezó', async () => {
    const dia = { enabled: true, ranges: [{ open: '09:00', close: '21:35' }] }
    const HORARIO = { monday: dia, tuesday: dia, wednesday: dia, thursday: dia, friday: dia, saturday: dia, sunday: dia }
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ hours: HORARIO } as any)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
    const sinCampo = borrador(true)
    delete (sinCampo.request as Record<string, unknown>).cierreDeFranja
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(sinCampo as any)
    getAuthorization.mockResolvedValue(autorizada(new Date(NOW.getTime() - MIN)))
    // Empezó a las 21:10 (NOW − 20 min, en CDMX): su franja cierra a las 21:35 = 03:35 UTC, antes de Stripe + 10 min (03:39).
    expect(await confirmCardAuthorization('ch1', NOW)).toBe('CREATED')
    expect(escrito().acceptDeadlineAt).toEqual(new Date('2026-11-20T03:35:00.000Z'))
  })
})

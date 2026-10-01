/**
 * 🔴 Auditoría 2026-09-30: `POST /sdk/charge` no miraba el estado de la sesión. Repetir la llamada volvía
 * a autorizar con el banco, y el `catch` podía escribir FAILED encima de una sesión ya cobrada. Mismo
 * candado que el cobro de ligas (`paymentLink.service.ts`): sólo quien gana PROCESSING → CHARGING habla
 * con el banco, y la tarjeta se lee DESPUÉS de ganarlo. La tokenización no puede regresar a PROCESSING
 * una sesión que se está cobrando, y lo que no se debe reintentar lo dice con `canRetry: false`.
 */
const mockAuthorizePayment = jest.fn()
const mockBlumonTokenize = jest.fn()
jest.mock('@/services/sdk/blumon-ecommerce.service', () => ({
  getBlumonEcommerceService: () => ({
    authorizePayment: (...args: unknown[]) => mockAuthorizePayment(...args),
    tokenizeCard: (...args: unknown[]) => mockBlumonTokenize(...args),
  }),
}))
jest.mock('@/services/blumon/blumonAuth.service', () => ({
  blumonAuthService: { isTokenExpired: () => false, refreshToken: jest.fn(), authenticate: jest.fn() },
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { chargeWithToken, tokenizeCard } from '@/controllers/sdk/tokenize.sdk.controller'
import { BadRequestError, PaymentOutcomeUnknownError } from '@/errors/AppError'

const CLAIM_WHERE = {
  id: 'cs-1',
  status: 'PROCESSING',
  expiresAt: { gt: expect.any(Date) },
  metadata: { path: ['cardToken'], equals: 'tok_1' },
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000)
const READ_AT = new Date('2026-09-30T20:00:00.000Z') // `updatedAt` de la fila tal como se leyó

function session(over: Record<string, unknown> = {}) {
  return {
    id: 'cs-1',
    sessionId: 'cs_test_1',
    status: 'PROCESSING',
    amount: 100,
    expiresAt: FUTURE,
    updatedAt: READ_AT,
    paymentLinkId: null,
    customerEmail: null,
    customerPhone: null,
    metadata: { cardToken: 'tok_1' },
    ecommerceMerchant: {
      id: 'm-1',
      sandboxMode: true,
      providerCredentials: { accessToken: 'at', expiresAt: FUTURE.toISOString() },
      provider: { code: 'BLUMON' },
    },
    ...over,
  } as any
}

function fakeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any
}

/** Ninguna escritura, por ningún camino, deja la sesión en FAILED. */
function wroteFailed() {
  const writes = [...prismaMock.checkoutSession.update.mock.calls, ...prismaMock.checkoutSession.updateMany.mock.calls]
  return writes.some(([arg]: any[]) => arg?.data?.status === 'FAILED')
}

function saidNoRetry(res: any, httpStatus: number) {
  expect(res.status).toHaveBeenCalledWith(httpStatus)
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, canRetry: false }))
}

/** Por default la página manda el token que le devolvió `/tokenize`, como hace `payment.js` desde este cambio. */
async function charge(body: Record<string, unknown> = { sessionId: 'cs_test_1', cvv: '123', cardToken: 'tok_1' }) {
  const res = fakeRes()
  await chargeWithToken({ body } as any, res)
  return res
}

async function tokenize() {
  const res = fakeRes()
  const req = {
    body: {
      sessionId: 'cs_test_1',
      cardData: { pan: '4111111111111111', cvv: '123', expMonth: '12', expYear: '2030', cardholderName: 'Ana' },
    },
    ip: '127.0.0.1',
    get: () => 'jest',
  } as any
  await tokenizeCard(req, res)
  return res
}

beforeEach(() => {
  jest.clearAllMocks()
  // r5 #4: `clearAllMocks` borra llamadas pero NO implementaciones; sin reset, una prueba hereda el retorno de la anterior y
  // puede pasar sola por la razón equivocada.
  mockAuthorizePayment.mockReset()
  mockBlumonTokenize.mockReset().mockResolvedValue({ token: 'tok_2', maskedPan: '411111******1111', cardBrand: 'VISA' })
  prismaMock.checkoutSession.findUnique.mockReset()
  prismaMock.checkoutSession.update.mockReset().mockResolvedValue({} as any)
  prismaMock.checkoutSession.updateMany.mockReset().mockResolvedValue({ count: 1 } as any)
  prismaMock.ecommerceMerchant.update.mockReset().mockResolvedValue({} as any)
})

describe('chargeWithToken', () => {
  it('cobra una vez: reclama PROCESSING→CHARGING sobre SU tarjeta antes de hablar con el banco y termina COMPLETED', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session())
    mockAuthorizePayment.mockResolvedValue({ authorizationId: 'a1', transactionId: 't1' })

    const res = await charge()

    expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledWith({ where: CLAIM_WHERE, data: { status: 'CHARGING' } })
    expect(mockAuthorizePayment).toHaveBeenCalledWith(expect.objectContaining({ cardToken: 'tok_1', cvv: '123' }))
    expect(prismaMock.checkoutSession.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mockAuthorizePayment.mock.invocationCallOrder[0])
    expect(prismaMock.checkoutSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cs-1' }, data: expect.objectContaining({ status: 'COMPLETED' }) }),
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('🔴 si la tarjeta cambió antes del reclamo, NO cobra nada y deja reintentar', async () => {
    // Otra tokenización guardó tok_2: el candado atado a tok_1 no toca ninguna fila.
    prismaMock.checkoutSession.findUnique
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce({ status: 'PROCESSING', expiresAt: FUTURE } as any) // relectura tras perder el reclamo
    prismaMock.checkoutSession.updateMany.mockResolvedValueOnce({ count: 0 } as any)

    const res = await charge()

    expect(mockAuthorizePayment).not.toHaveBeenCalled()
    expect(wroteFailed()).toBe(false)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ canRetry: false }))
  })

  it.each([
    ['una página vieja que no manda el token', { sessionId: 'cs_test_1', cvv: '123' }],
    ['un token que no es texto', { sessionId: 'cs_test_1', cvv: '123', cardToken: { not: null } }],
  ])('🔴 %s: no reclama ni cobra; pide recargar', async (_label, body) => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session())

    const res = await charge(body)

    expect(prismaMock.checkoutSession.updateMany).not.toHaveBeenCalled()
    expect(mockAuthorizePayment).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    // r5 #1: el texto tiene que llegar tal cual; si pasara por parseBlumonError la página diría «Error desconocido».
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Recarga la página e intenta de nuevo.' }))
  })

  it('🔴 si vence entre la revisión y el reclamo, no cobra: la marca EXPIRED y no invita a reintentar', async () => {
    prismaMock.checkoutSession.findUnique
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce({ status: 'PROCESSING', expiresAt: new Date(Date.now() - 1000) } as any)
    prismaMock.checkoutSession.updateMany
      .mockResolvedValueOnce({ count: 0 } as any) // el reclamo: ya venció
      .mockResolvedValueOnce({ count: 1 } as any) // PROCESSING → EXPIRED

    const res = await charge()

    expect(mockAuthorizePayment).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'cs-1', status: 'PROCESSING' },
      data: { status: 'EXPIRED' },
    })
    saidNoRetry(res, 409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'cs_test_1' }))
  })

  it('🔴 si otra llamada ya ganó el reclamo (sigue CHARGING), NO habla con el banco y dice que no se reintente', async () => {
    prismaMock.checkoutSession.findUnique
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce({ status: 'CHARGING', expiresAt: FUTURE } as any) // relectura tras perder el reclamo
    prismaMock.checkoutSession.updateMany.mockResolvedValueOnce({ count: 0 } as any)

    const res = await charge()

    expect(mockAuthorizePayment).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledTimes(1)
    expect(wroteFailed()).toBe(false)
    saidNoRetry(res, 409)
  })

  it('perdió el reclamo pero la sesión ya volvió a FAILED (el otro intento fue rechazado): deja reintentar', async () => {
    prismaMock.checkoutSession.findUnique
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce({ status: 'FAILED', expiresAt: FUTURE } as any)
    prismaMock.checkoutSession.updateMany.mockResolvedValueOnce({ count: 0 } as any)

    const res = await charge()

    expect(mockAuthorizePayment).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ canRetry: false }))
  })

  it.each(['COMPLETED', 'CHARGING', 'CANCELLED', 'EXPIRED'])(
    '🔴 una sesión %s no se cobra, no se reescribe y no invita a reintentar',
    async status => {
      prismaMock.checkoutSession.findUnique.mockResolvedValue(session({ status }))

      const res = await charge()

      expect(mockAuthorizePayment).not.toHaveBeenCalled()
      expect(prismaMock.checkoutSession.update).not.toHaveBeenCalled()
      expect(prismaMock.checkoutSession.updateMany).not.toHaveBeenCalled()
      saidNoRetry(res, 409)
    },
  )

  it.each(['PENDING', 'FAILED'])('una sesión %s no se cobra: primero hay que poner la tarjeta (400)', async status => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session({ status }))

    const res = await charge()

    expect(mockAuthorizePayment).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.updateMany).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('🔴 una sesión vencida se marca EXPIRED y no se cobra', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session({ expiresAt: new Date(Date.now() - 1000) }))

    const res = await charge()

    expect(mockAuthorizePayment).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'cs-1', status: 'PROCESSING' },
      data: { status: 'EXPIRED' },
    })
    saidNoRetry(res, 409)
  })

  it('🔴 una sesión de liga de pago se cobra por su propio flujo, no aquí', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session({ paymentLinkId: 'pl-1' }))

    const res = await charge()

    expect(mockAuthorizePayment).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.updateMany).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('rechazo definitivo del banco: FAILED, y sólo desde CHARGING', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session())
    mockAuthorizePayment.mockRejectedValue(new BadRequestError('Tarjeta declinada'))

    await charge()

    expect(prismaMock.checkoutSession.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { sessionId: 'cs_test_1', status: 'CHARGING' },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    )
    expect(prismaMock.checkoutSession.update).not.toHaveBeenCalled()
  })

  it.each([
    ['la liberación truena', () => prismaMock.checkoutSession.updateMany.mockRejectedValueOnce(new Error('se cayó la base'))],
    ['la liberación no toca ninguna fila', () => prismaMock.checkoutSession.updateMany.mockResolvedValueOnce({ count: 0 } as any)],
  ])('🔴 rechazo del banco pero %s: la sesión sigue CHARGING y NO se invita a reintentar', async (_label, armRelease) => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session())
    mockAuthorizePayment.mockRejectedValue(new BadRequestError('Tarjeta declinada'))
    prismaMock.checkoutSession.updateMany.mockResolvedValueOnce({ count: 1 } as any) // el reclamo
    armRelease()

    const res = await charge()

    saidNoRetry(res, 502)
  })

  it('🔴 resultado DESCONOCIDO (corte tras mandar el cargo): la sesión se queda CHARGING y no invita a reintentar', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session())
    mockAuthorizePayment.mockRejectedValue(new PaymentOutcomeUnknownError())

    const res = await charge()

    expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledTimes(1) // sólo el reclamo
    expect(wroteFailed()).toBe(false)
    saidNoRetry(res, 502)
  })

  it('🔴 el banco aprobó pero falló guardar COMPLETED: NO se marca FAILED por ningún camino', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session())
    mockAuthorizePayment.mockResolvedValue({ authorizationId: 'a1', transactionId: 't1' })
    prismaMock.checkoutSession.update.mockRejectedValueOnce(new Error('se cayó la base'))

    const res = await charge()

    expect(wroteFailed()).toBe(false)
    saidNoRetry(res, 502)
  })
})

describe('tokenizeCard', () => {
  it.each(['CHARGING', 'COMPLETED', 'CANCELLED', 'EXPIRED'])('🔴 no tokeniza una sesión %s y dice que no se reintente', async status => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session({ status }))

    const res = await tokenize()

    expect(mockBlumonTokenize).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.update).not.toHaveBeenCalled()
    expect(prismaMock.checkoutSession.updateMany).not.toHaveBeenCalled()
    saidNoRetry(res, 409)
  })

  it('🔴 una sesión de liga de pago no se tokeniza por el SDK', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session({ paymentLinkId: 'pl-1' }))

    const res = await tokenize()

    expect(mockBlumonTokenize).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('🔴 si la sesión pasó a CHARGING mientras tokenizaba, NO la regresa a PROCESSING y dice que no se reintente', async () => {
    prismaMock.checkoutSession.findUnique
      .mockResolvedValueOnce(session({ status: 'PROCESSING' }))
      .mockResolvedValueOnce({ status: 'CHARGING' } as any) // relectura tras perder el candado
    mockBlumonTokenize.mockResolvedValue({ token: 'tok_2', maskedPan: '411111******1111', cardBrand: 'VISA' })
    prismaMock.checkoutSession.updateMany.mockResolvedValueOnce({ count: 0 } as any)

    const res = await tokenize()

    expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cs-1', status: 'PROCESSING', updatedAt: READ_AT } }),
    )
    expect(prismaMock.checkoutSession.update).not.toHaveBeenCalled()
    saidNoRetry(res, 409)
  })

  it('si otra tokenización ganó (sigue PROCESSING), responde 400 reintentable', async () => {
    prismaMock.checkoutSession.findUnique
      .mockResolvedValueOnce(session({ status: 'PROCESSING' }))
      .mockResolvedValueOnce({ status: 'PROCESSING' } as any)
    mockBlumonTokenize.mockResolvedValue({ token: 'tok_2', maskedPan: '411111******1111', cardBrand: 'VISA' })
    prismaMock.checkoutSession.updateMany.mockResolvedValueOnce({ count: 0 } as any)

    const res = await tokenize()

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ canRetry: false }))
  })

  it('regresión: una sesión FAILED se reintenta con otra tarjeta en UN paso, sin restos del fallo anterior', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(session({ status: 'FAILED', metadata: {} }))
    mockBlumonTokenize.mockResolvedValue({ token: 'tok_2', maskedPan: '411111******1111', cardBrand: 'VISA' })

    const res = await tokenize()

    expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'cs-1', status: 'FAILED', updatedAt: READ_AT },
      data: expect.objectContaining({
        status: 'PROCESSING',
        failedAt: null,
        errorMessage: null,
        metadata: expect.objectContaining({ cardToken: 'tok_2' }),
      }),
    })
    expect(res.status).toHaveBeenCalledWith(200)
  })
})

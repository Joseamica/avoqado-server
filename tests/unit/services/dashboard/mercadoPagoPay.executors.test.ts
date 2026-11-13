import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import * as paymentService from '@/services/mercado-pago/payment.service'
import * as connectionService from '@/services/mercado-pago/connection.service'
import { executeMercadoPagoPaymentForPaymentLink } from '@/services/dashboard/paymentLink.service'
import { executeMercadoPagoPaymentForVenue } from '@/services/dashboard/venueCheckout.service'
import { handleIpn, procesarPagoDeMercadoPago } from '@/services/mercado-pago/payment-flow.service'
import { MercadoPagoCierrePerdidoJob, MAX_INTENTOS } from '@/jobs/mercadopago-cierre-perdido.job'

jest.mock('nanoid', () => ({ nanoid: jest.fn(() => 'test-id') }))
jest.mock('@/services/mercado-pago/payment.service', () => ({
  ...jest.requireActual('@/services/mercado-pago/payment.service'),
  createPayment: jest.fn(),
  getPayment: jest.fn(),
}))
jest.mock('@/services/mercado-pago/connection.service')
// Financial finalization is real; only its external side effects are stubbed.
const mockCreatePosting = jest.fn()
const mockApplyPosting = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: (...args: unknown[]) => mockCreatePosting(...args),
  applySalePosting: (...args: unknown[]) => mockApplyPosting(...args),
}))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn() }))

const input = { token: 'card-token', paymentMethodId: 'visa', installments: 1, payer: { email: 'buyer@example.com' } }
const payload = {
  id: 1,
  live_mode: false,
  type: 'payment',
  date_created: new Date().toISOString(),
  user_id: 123,
  api_version: 'v1',
  action: 'payment.updated',
  data: { id: '777' },
}
let session: any
let providerStatus: string
let paymentTypeId: string | undefined
let requestNumber: number
const paths = ['liga', 'venue', 'IPN'] as const
async function execute(path: (typeof paths)[number]) {
  if (path === 'liga') return executeMercadoPagoPaymentForPaymentLink('link1', session.sessionId, input)
  if (path === 'venue') return executeMercadoPagoPaymentForVenue('venue1', session.sessionId, input)
  return handleIpn({ payload, requestId: `request-${++requestNumber}` })
}

beforeEach(() => {
  jest.clearAllMocks()
  providerStatus = 'authorized'
  paymentTypeId = undefined
  requestNumber = 0
  session = {
    id: 'cs-db-1',
    sessionId: 'cs-1',
    status: 'PENDING',
    completedAt: null,
    paymentId: null,
    amount: new Prisma.Decimal(275),
    applicationFeeCents: 500,
    description: 'Pago',
    customerEmail: null,
    ecommerceMerchantId: 'em-1',
    ecommerceMerchant: { id: 'em-1', venueId: 'v-1', provider: { code: 'MERCADO_PAGO' } },
    paymentLink: { id: 'pl-1', shortCode: 'link1', venueId: 'v-1', createdById: 'staff-1', purpose: 'ITEM' },
    metadata: { tipAmount: 25, items: [{ productId: 'p-1', productName: 'Producto', quantity: 1, unitPrice: 250, modifiers: [] }] },
  }
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'v-1', name: 'Venue', salesEnabled: true })
  prismaMock.ecommerceMerchant.findFirst.mockResolvedValue({ id: 'em-1', venueId: 'v-1', providerMerchantId: '123' })
  prismaMock.checkoutSession.findUnique.mockImplementation(async () => ({ ...session }))
  prismaMock.checkoutSession.findFirst.mockImplementation(async (args: any) =>
    args.where.ecommerceMerchantId === session.ecommerceMerchantId ? { ...session } : null,
  )
  prismaMock.checkoutSession.update.mockImplementation(async ({ data }: any) => {
    Object.assign(session, data)
    return { ...session }
  })
  // updateMany honra el WHERE (CAS) como Postgres: igualdad, `not` y `notIn` sobre la sesión en memoria.
  prismaMock.checkoutSession.updateMany.mockImplementation(async ({ where, data }: any) => {
    const ids = typeof where.id === 'string' ? [where.id] : (where.id?.in ?? [])
    if (!ids.includes(session.id)) return { count: 0 }
    for (const [campo, cond] of Object.entries(where)) {
      if (campo === 'id') continue
      const valor = session[campo]
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as any
        if ('not' in c && valor === c.not) return { count: 0 }
        if ('notIn' in c && c.notIn.includes(valor)) return { count: 0 }
      } else if (valor !== cond) return { count: 0 }
    }
    Object.assign(session, data)
    return { count: 1 }
  })
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.order.create.mockResolvedValue({ id: 'order-1', items: [{ id: 'oi-1', productId: 'p-1', quantity: 1, modifiers: [] }] })
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-1' })
  prismaMock.paymentLink.update.mockResolvedValue({})
  prismaMock.mercadoPagoWebhookEvent.create.mockResolvedValue({ id: 'event-1' })
  prismaMock.mercadoPagoWebhookEvent.updateMany.mockResolvedValue({ count: 1 })
  mockCreatePosting.mockResolvedValue({ id: 'posting-1' })
  mockApplyPosting.mockResolvedValue(undefined)
  jest
    .mocked(connectionService.loadCredentials)
    .mockResolvedValue({ accessToken: 'test-seller', publicKey: 'test-pk', mpUserId: '123' } as any)
  const payment = () => ({
    id: 777,
    status: providerStatus,
    status_detail: 'test',
    external_reference: session.sessionId,
    order: null,
    payment_type_id: paymentTypeId,
  })
  jest.mocked(paymentService.createPayment).mockImplementation(async () => payment() as any)
  jest.mocked(paymentService.getPayment).mockImplementation(async () => payment() as any)
})

for (const path of paths) {
  describe(`MP ${path} con finalizador real`, () => {
    it.each([
      ['authorized', 'PENDING'],
      ['pending', 'PENDING'],
      ['in_process', 'PENDING'],
      ['in_mediation', 'PENDING'],
      ['rejected', 'CANCELLED'],
      ['cancelled', 'CANCELLED'],
      ['refunded', 'FAILED'],
      ['charged_back', 'FAILED'],
      ['unknown', 'PENDING'],
    ])('%s guarda %s sin entrar al finalizador ni registrar venta/stock', async (status, expected) => {
      providerStatus = status
      await execute(path)
      expect(session.status).toBe(expected)
      expect(session.completedAt).toBeNull()
      expect(session.mpPaymentId).toBe('777')
      // The first operation of the real finalizer is findUnique; no extra read means no entry.
      expect(prismaMock.checkoutSession.findUnique).toHaveBeenCalledTimes(path === 'IPN' ? 0 : 1)
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(mockCreatePosting).not.toHaveBeenCalled()
      expect(mockApplyPosting).not.toHaveBeenCalled()
    })
    it('authorized seguido de approved registra una sola venta, incluso con IPN repetido', async () => {
      if (path === 'venue') {
        session.paymentLink = null
        session.metadata = { type: 'venue_checkout' }
      }
      await execute(path)
      expect(session.status).toBe('PENDING')
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      providerStatus = 'approved'
      await execute(path)
      expect(session.status).toBe('COMPLETED')
      expect(session.completedAt).toBeInstanceOf(Date)
      expect(session.paymentId).toBe('payment-1')
      const completedAt = session.completedAt
      await execute('IPN')
      await execute('IPN') // new delivery ids, so this exercises finalizer idempotency, not webhook dedupe
      expect(session.completedAt).toBe(completedAt)
      expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
      expect(mockCreatePosting).toHaveBeenCalledTimes(1)
      expect(mockApplyPosting).toHaveBeenCalledTimes(1)
      expect(prismaMock.payment.create.mock.calls[0][0].data.idempotencyKey).toBe('777')
    })
    // 16-oct (producción): un SPEI quedó como CREDIT_CARD. Cada camino debe pasar el `payment_type_id` que manda MP.
    it('la venta guarda el tipo de pago que manda Mercado Pago', async () => {
      if (path === 'venue') {
        session.paymentLink = null
        session.metadata = { type: 'venue_checkout' }
      }
      paymentTypeId = path === 'IPN' ? 'bank_transfer' : 'debit_card'
      providerStatus = 'approved'
      await execute(path)
      expect(prismaMock.payment.create.mock.calls[0][0].data.method).toBe(path === 'IPN' ? 'BANK_TRANSFER' : 'DEBIT_CARD')
      expect(prismaMock.payment.create.mock.calls[0][0].data.fundsFlow).toBe('AVOQADO_PROCESSED')
    })
  })
}

it('liga ajena y venue ajeno no crean pago en MP', async () => {
  await expect(executeMercadoPagoPaymentForPaymentLink('other-link', session.sessionId, input)).rejects.toThrow('La sesión no pertenece')
  session.ecommerceMerchant.venueId = 'other-venue'
  await expect(execute('venue')).rejects.toThrow('La sesión no pertenece')
  expect(paymentService.createPayment).not.toHaveBeenCalled()
})
it('IPN sólo encuentra sesión del merchant propietario', async () => {
  session.ecommerceMerchantId = 'other-merchant'
  expect(await execute('IPN')).toEqual({ status: 'ignored', reason: 'session_not_found' })
  expect(prismaMock.checkoutSession.findFirst).toHaveBeenCalledWith({ where: { sessionId: 'cs-1', ecommerceMerchantId: 'em-1' } })
  expect(prismaMock.checkoutSession.update).not.toHaveBeenCalled()
  expect(prismaMock.checkoutSession.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.order.create).not.toHaveBeenCalled()
})

// ─── Cierre perdido de Mercado Pago (tarjeta D1, 12-nov) ────────────────────────────────────────────────────────────────
// Recorrido con el finalizador real: MP aprobó y algo falló en medio. El barrido debe dejar UNA venta, sin revivir un
// reembolso. Promesa: Avoqado/docs/audit/2026-11-12-mp-cierre-perdido/promesa.md.
describe('cierre perdido de MP: un cobro aprobado nunca se queda sin venta', () => {
  let eventos: any[]
  let auditoria: any[]
  const logAction = jest.fn()
  const recuperadas = () => auditoria.filter(a => a.action === 'MERCADOPAGO_CHARGE_RECOVERED')
  let barrido: MercadoPagoCierrePerdidoJob
  const aprobado = () => ({ id: 777, status: 'approved', status_detail: 'test', external_reference: session.sessionId, order: null })
  const conEstado = (status: string) => ({ ...aprobado(), status })
  const delPago = () => eventos.filter(e => e.dataId === '777')

  beforeEach(() => {
    eventos = []
    auditoria = []
    // La bitácora de recuperación se escribe con el `tx` del cierre (en estas pruebas el tx es el mismo mock).
    prismaMock.activityLog.create.mockImplementation(async ({ data }: any) => {
      auditoria.push(data)
      return data
    })
    prismaMock.ecommerceMerchant.findMany.mockImplementation(async ({ where }: any) =>
      where.providerMerchantId.in.includes('123') ? [{ id: 'em-1', venueId: 'v-1', providerMerchantId: '123' }] : [],
    )
    const mismo = (e: any, k: any) => e.mpUserId === k.mpUserId && e.dataId === k.dataId && e.requestId === k.requestId
    prismaMock.mercadoPagoWebhookEvent.create.mockImplementation(async ({ data }: any) => {
      if (eventos.some(e => mismo(e, data))) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      const e = { id: `ev-${eventos.length + 1}`, createdAt: new Date(), errorMessage: null, ...data }
      eventos.push(e)
      return e
    })
    prismaMock.mercadoPagoWebhookEvent.updateMany.mockImplementation(async ({ where, data }: any) => {
      const hits = eventos.filter(e => (where.id?.in ? where.id.in.includes(e.id) : mismo(e, where)))
      hits.forEach(e => Object.assign(e, data))
      return { count: hits.length }
    })
    prismaMock.mercadoPagoWebhookEvent.upsert.mockImplementation(async ({ where, create, update }: any) => {
      const e = eventos.find(x => mismo(x, where.mpUserId_dataId_requestId))
      if (e) return Object.assign(e, update)
      const nuevo = { id: `ev-${eventos.length + 1}`, createdAt: new Date(), ...create }
      eventos.push(nuevo)
      return nuevo
    })
    prismaMock.mercadoPagoWebhookEvent.findMany.mockImplementation(async () =>
      eventos.filter(e => e.eventType === 'payment' && ['error', 'pending'].includes(e.processingStatus)).slice(0, 25),
    )
    // El SQL crudo de «sesiones sin venta», evaluado sobre la sesión en memoria con las mismas condiciones.
    prismaMock.$queryRaw.mockImplementation(async () => {
      const abierto = eventos.some(
        e => e.dataId === session.mpPaymentId && ['error', 'pending', 'abandonado', 'ignored'].includes(e.processingStatus),
      )
      const elegible = session.mpPaymentId && !session.paymentId && session.status !== 'FAILED' && !abierto
      return elegible
        ? [{ id: session.id, sessionId: session.sessionId, mpPaymentId: session.mpPaymentId, mpUserId: '123', status: session.status }]
        : []
    })
    barrido = new MercadoPagoCierrePerdidoJob({
      cron: { start: jest.fn(), stop: jest.fn() },
      retryEntry: ((fn: () => unknown) => fn()) as any,
      logAction,
    })
  })

  it('(1) el cierre truena después de aprobar: el aviso queda en error y el barrido crea la venta UNA vez, con bitácora', async () => {
    providerStatus = 'approved'
    prismaMock.payment.create.mockRejectedValueOnce(new Error('se cayó la base a media transacción'))
    expect(await execute('IPN')).toMatchObject({ status: 'processed' })
    expect(delPago()[0].processingStatus).toBe('error')
    expect(session.status).toBe('COMPLETED')
    expect(session.paymentId).toBeNull()

    // Un aviso repetido con el mismo request-id sale como duplicado: antes era el final del camino.
    expect(await handleIpn({ payload, requestId: 'request-1' })).toEqual({ status: 'duplicate' })

    const r = await barrido.runNow()
    expect(r).toMatchObject({ pagos: 1, recuperados: 1, errores: 0 })
    expect(session.paymentId).toBe('payment-1')
    expect(delPago().every(e => e.processingStatus === 'processed')).toBe(true)
    expect(recuperadas()).toEqual([
      expect.objectContaining({
        venueId: 'v-1',
        entity: 'CheckoutSession',
        entityId: 'cs-db-1',
        data: expect.objectContaining({ mpPaymentId: '777' }),
      }),
    ])

    // (4) Idempotencia: otra vuelta y otro aviso no crean otra venta.
    expect(await barrido.runNow()).toMatchObject({ pagos: 0, recuperados: 0 })
    await execute('IPN')
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(2) // el que tronó + el del barrido
    expect(prismaMock.checkoutSession.update).toHaveBeenCalledWith({ where: { id: 'cs-db-1' }, data: { paymentId: 'payment-1' } })
    expect(prismaMock.paymentLink.update).toHaveBeenCalledTimes(1)
    expect(recuperadas()).toHaveLength(1)
  })

  for (const camino of ['liga', 'venue'] as const) {
    it(`(2) ${camino}: la respuesta optimista «pendiente» que llega tras la aprobación no baja el COMPLETED`, async () => {
      if (camino === 'venue') {
        session.paymentLink = null
        session.metadata = { type: 'venue_checkout' }
      }
      jest.mocked(paymentService.createPayment).mockImplementationOnce(async () => {
        // Mientras MP contesta, llega su aviso con la aprobación y cierra la venta.
        providerStatus = 'approved'
        await handleIpn({ payload, requestId: 'aviso-rapido' })
        return conEstado('in_process') as any
      })
      await execute(camino)
      expect(session.status).toBe('COMPLETED')
      expect(session.completedAt).toBeInstanceOf(Date)
      expect(session.paymentId).toBe('payment-1')
      expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    })
  }

  it('(2c) dos avisos a la vez: el «pendiente» lento no pisa la aprobación', async () => {
    jest.mocked(paymentService.getPayment).mockImplementationOnce(async () => {
      providerStatus = 'approved'
      await handleIpn({ payload, requestId: 'aviso-rapido' })
      return conEstado('pending') as any
    })
    await handleIpn({ payload, requestId: 'aviso-lento' })
    expect(session.status).toBe('COMPLETED')
    expect(session.paymentId).toBe('payment-1')
  })

  it('(3) falla la consulta a MP dentro del aviso: la sesión no se toca y el barrido la recupera', async () => {
    providerStatus = 'approved'
    jest.mocked(paymentService.getPayment).mockRejectedValueOnce(new Error('MP getPayment failed: 503'))
    expect(await execute('IPN')).toEqual({ status: 'error', reason: 'fetch_failed' })
    expect(session.status).toBe('PENDING')
    expect(prismaMock.order.create).not.toHaveBeenCalled()

    expect(await barrido.runNow()).toMatchObject({ recuperados: 1 })
    expect(session.status).toBe('COMPLETED')
    expect(session.paymentId).toBe('payment-1')
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
  })

  it('(3b) el proceso murió con el aviso a medias (evento «pending»): el barrido lo retoma', async () => {
    providerStatus = 'approved'
    jest.mocked(connectionService.loadCredentials).mockRejectedValueOnce(new Error('proceso muerto'))
    await expect(execute('IPN')).rejects.toThrow('proceso muerto')
    expect(delPago()[0].processingStatus).toBe('pending')
    expect(await barrido.runNow()).toMatchObject({ recuperados: 1 })
    expect(session.paymentId).toBe('payment-1')
  })

  it('(4b) el aviso de la aprobación ni siquiera se pudo guardar y la sesión quedó PENDING: el barrido la encuentra (Codex r1 #1)', async () => {
    await execute('liga') // MP contestó «authorized»: la sesión guarda el número de pago
    expect(session).toMatchObject({ status: 'PENDING', mpPaymentId: '777' })
    providerStatus = 'approved'
    prismaMock.mercadoPagoWebhookEvent.create.mockRejectedValueOnce(Object.assign(new Error('Connection lost'), { code: 'P1001' }))
    await expect(execute('IPN')).rejects.toThrow('Connection lost')
    expect(eventos).toHaveLength(0)

    expect(await barrido.runNow()).toMatchObject({ encoladas: 1, recuperados: 1 })
    expect(session.paymentId).toBe('payment-1')
    expect(eventos[0]).toMatchObject({ requestId: 'barrido:cs-1', processingStatus: 'processed' })
    expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['cs-db-1'] } },
      data: { updatedAt: expect.any(Date) },
    })
  })

  it('(4c) una sesión que MP sigue reportando pendiente se revisa sin venta y su evento queda procesado', async () => {
    await execute('liga')
    expect(await barrido.runNow()).toMatchObject({ encoladas: 1, recuperados: 0, errores: 0 })
    expect(session.status).toBe('PENDING')
    expect(eventos[0].processingStatus).toBe('processed')
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('(4d) una cancelación sólo local (SDK) no esconde el pago que MP aprobó después (Codex r2 #1)', async () => {
    await execute('liga') // MP: «authorized», la sesión guarda el número de pago
    session.status = 'CANCELLED' // el comercio la canceló en Avoqado; MP no se enteró
    providerStatus = 'approved'
    prismaMock.mercadoPagoWebhookEvent.create.mockRejectedValueOnce(Object.assign(new Error('Connection lost'), { code: 'P1001' }))
    await expect(execute('IPN')).rejects.toThrow('Connection lost')

    expect(await barrido.runNow()).toMatchObject({ encoladas: 1, recuperados: 1 })
    expect(session).toMatchObject({ status: 'COMPLETED', paymentId: 'payment-1' })
  })

  it('(4e) un pago que MP rechazó deja su evento «ignored» y la sesión ya no se vuelve a revisar', async () => {
    providerStatus = 'rejected'
    await execute('liga')
    expect(await barrido.runNow()).toMatchObject({ encoladas: 1, recuperados: 0 })
    expect(eventos[0]).toMatchObject({ processingStatus: 'ignored', errorMessage: 'MP rejected: desenlace final, sin venta' })
    jest.mocked(paymentService.getPayment).mockClear()
    expect(await barrido.runNow()).toMatchObject({ encoladas: 0, pagos: 0 })
    expect(paymentService.getPayment).not.toHaveBeenCalled()
  })

  it('(1b) si marcar el evento falla después de recuperar, la bitácora ya quedó y la próxima vuelta lo cierra sin duplicar', async () => {
    providerStatus = 'approved'
    prismaMock.payment.create.mockRejectedValueOnce(new Error('se cayó la base a media transacción'))
    await execute('IPN')
    prismaMock.mercadoPagoWebhookEvent.updateMany.mockRejectedValueOnce(new Error('se cayó la base al marcar'))
    await barrido.runNow()
    expect(session.paymentId).toBe('payment-1')
    expect(recuperadas()).toHaveLength(1)
    expect(delPago()[0].processingStatus).toBe('error')

    await barrido.runNow()
    expect(delPago()[0].processingStatus).toBe('processed')
    expect(recuperadas()).toHaveLength(1)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(2)
  })

  it('(1c) venta y bitácora son todo o nada: si la bitácora falla no queda venta, y un reembolso posterior no deja una venta sin auditar (Codex código r2)', async () => {
    providerStatus = 'approved'
    prismaMock.payment.create.mockRejectedValueOnce(new Error('se cayó la base a media transacción'))
    await execute('IPN')
    // El INSERT de la bitácora truena DENTRO de la transacción del cierre: la venta no llega a sellarse.
    prismaMock.activityLog.create.mockRejectedValueOnce(new Error('se cayó la base en la bitácora'))
    expect(await barrido.runNow()).toMatchObject({ recuperados: 0, errores: 1 })
    expect(session.paymentId).toBeNull()
    expect(recuperadas()).toHaveLength(0)
    expect(delPago()[0].processingStatus).toBe('error')

    // MP reporta el reembolso antes del siguiente intento: no hay venta que auditar y el evento se cierra limpio.
    providerStatus = 'refunded'
    await barrido.runNow()
    expect(session.status).toBe('FAILED')
    expect(session.paymentId).toBeNull()
    expect(recuperadas()).toHaveLength(0)
    expect(delPago()[0].processingStatus).toBe('ignored')
  })

  it('(1d) la bitácora de recuperación nace en la transacción del cierre del barrido, y sólo ahí', async () => {
    providerStatus = 'approved'
    prismaMock.payment.create.mockRejectedValueOnce(new Error('se cayó la base a media transacción'))
    await execute('IPN')
    expect(recuperadas()).toHaveLength(0) // el aviso normal no escribe bitácora de recuperación
    await barrido.runNow()
    // Escrita antes de sellar la venta en la sesión: misma transacción.
    const bitacora = prismaMock.activityLog.create.mock.invocationCallOrder[0]
    const sello = prismaMock.checkoutSession.update.mock.invocationCallOrder.at(-1)!
    expect(bitacora).toBeLessThan(sello)
    expect(recuperadas()).toEqual([
      expect.objectContaining({
        venueId: 'v-1',
        entity: 'CheckoutSession',
        entityId: 'cs-db-1',
        data: expect.objectContaining({ mpPaymentId: '777' }),
      }),
    ])
  })

  it('(7) varios pagos del mismo vendedor: comercio y credenciales se cargan UNA vez por vuelta (Codex código r1 #2)', async () => {
    providerStatus = 'approved'
    for (const dataId of ['777', '778', '779']) {
      eventos.push({
        id: `ev-${dataId}`,
        mpUserId: '123',
        dataId,
        requestId: `r-${dataId}`,
        eventType: 'payment',
        processingStatus: 'error',
        errorMessage: null,
      })
    }
    jest.mocked(connectionService.loadCredentials).mockClear()
    await barrido.runNow()
    expect(prismaMock.ecommerceMerchant.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.ecommerceMerchant.findFirst).not.toHaveBeenCalled()
    expect(connectionService.loadCredentials).toHaveBeenCalledTimes(1)
    expect(paymentService.getPayment).toHaveBeenCalledTimes(3)
    expect(recuperadas()).toHaveLength(1) // los tres apuntan a la misma sesión: un solo renglón
  })

  it('(5) una aprobación vieja no revive un reembolso ya escrito ni crea venta (Codex r1 #2)', async () => {
    Object.assign(session, { status: 'FAILED', mpPaymentId: '777' })
    providerStatus = 'approved'
    expect(await procesarPagoDeMercadoPago({ id: 'em-1' }, '777')).toMatchObject({ estado: 'processed', ventaCreada: false })
    expect(session.status).toBe('FAILED')
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('(5b) el reembolso se escribe entre la aprobación y el cierre: el cierre no crea venta', async () => {
    providerStatus = 'approved'
    prismaMock.checkoutSession.findUnique.mockImplementationOnce(async () => {
      const foto = { ...session } // el cierre leyó COMPLETED…
      session.status = 'FAILED' // …y el aviso del reembolso llegó antes de su transacción
      return foto
    })
    expect(await procesarPagoDeMercadoPago({ id: 'em-1' }, '777')).toMatchObject({ ventaCreada: false })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('(6) tope visible: tras MAX_INTENTOS fallos el evento queda «abandonado», con bitácora, y ya no se reintenta', async () => {
    providerStatus = 'approved'
    jest.mocked(paymentService.getPayment).mockRejectedValue(new Error('MP getPayment failed: 503'))
    await execute('IPN')
    await handleIpn({ payload, requestId: 'otra-entrega' }) // dos eventos del mismo pago = una consulta por vuelta
    jest.mocked(paymentService.getPayment).mockClear()

    await barrido.runNow()
    expect(paymentService.getPayment).toHaveBeenCalledTimes(1)
    expect(delPago().map(e => e.errorMessage)).toEqual([
      `[barrido 1/${MAX_INTENTOS}] MP getPayment failed: 503`,
      `[barrido 1/${MAX_INTENTOS}] MP getPayment failed: 503`,
    ])
    for (let i = 2; i <= MAX_INTENTOS; i++) await barrido.runNow()
    expect(delPago().every(e => e.processingStatus === 'abandonado')).toBe(true)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'v-1',
        action: 'MERCADOPAGO_RECOVERY_ABANDONED',
        data: expect.objectContaining({ intentos: MAX_INTENTOS }),
      }),
    )
    jest.mocked(paymentService.getPayment).mockClear()
    expect(await barrido.runNow()).toMatchObject({ pagos: 0, encoladas: 0 })
    expect(paymentService.getPayment).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })
})

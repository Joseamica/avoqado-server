import cuid from 'cuid'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { NextFunction, Request, Response } from 'express'
import { StaffRole } from '@prisma/client'

jest.mock('@/communication/sockets/managers/socketManager', () => ({ socketManager: { broadcastToVenue: jest.fn() } }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
  broadcastTpvStatusUpdate: jest.fn(),
}))
jest.mock('@/communication/rabbitmq/commandListener', () => ({ deliverPosCommand: jest.fn() }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn() }))
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    req.authContext = {
      userId: req.get('x-test-actor')!,
      venueId: req.params.venueId,
      orgId: req.params.venueId,
      role: StaffRole.OWNER,
      terminalSerialNumber: req.get('x-test-terminal'),
    }
    next()
  },
}))
jest.mock('@/middlewares/registerDevice.middleware', () => ({
  registerDeviceMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  capturarVenueDeLaRuta: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

import prisma from '@/utils/prismaClient'
import { initiateCryptoPayment, getCryptoOperationForVenue, cancelCryptoPayment, processWebhook } from '@/services/b4bit/b4bit.service'
import { sembrarVentaDeTarjetasSinPagar } from '../giftCards/sembrarTarjetasDeRegalo'
import tpvRouter from '@/routes/tpv.routes'
const express = require('express') as typeof import('express')
const request = require('supertest') as typeof import('supertest')
const app = express()
app.use(express.json())
app.use('/tpv', tpvRouter)
app.use((error: any, _req: Request, res: Response, _next: NextFunction) =>
  res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code }),
)
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname))
  throw Error('S3 requires an isolated disposable avq-verify database, never av-db-25')

async function fixture() {
  const key = cuid()
  const org = await prisma.organization.create({ data: { name: `S3 ${key}`, email: `${key}@org.test`, phone: '5555555555' } })
  const venue = await prisma.venue.create({ data: { organizationId: org.id, name: `S3 ${key}`, slug: `s3-${key}`, seatCapExempt: true } })
  const staff = await prisma.staff.create({ data: { email: `${key}@staff.test`, firstName: 'Actual', lastName: 'Actor', active: true } })
  await prisma.staffVenue.create({ data: { venueId: venue.id, staffId: staff.id, role: StaffRole.OWNER } })
  const serial = `AVQD-${key}`
  await prisma.terminal.create({
    data: { venueId: venue.id, serialNumber: serial, name: 'S3 terminal', type: 'TPV_ANDROID', status: 'ACTIVE' },
  })
  await prisma.venueSettings.create({ data: { venueId: venue.id, enableShifts: true, requirePinLogin: false } })
  await prisma.venueCryptoConfig.create({
    data: { venueId: venue.id, status: 'ACTIVE', b4bitDeviceId: 'controlled-provider-stub', b4bitDeviceName: 'Never real provider' },
  })
  return { venueId: venue.id, staffId: staff.id, orgId: org.id, serial, key: cuid() }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const orderFor = async (n: Fixture) =>
  (
    await prisma.order.create({
      data: { venueId: n.venueId, orderNumber: cuid(), type: 'TAKEOUT', source: 'TPV', subtotal: 50, taxAmount: 0, total: 50 },
    })
  ).id
const params = (n: Fixture, extra: Record<string, unknown> = {}) => ({
  venueId: n.venueId,
  orgId: n.orgId,
  staffId: n.staffId,
  actorStaffId: n.staffId,
  terminalSerialNumber: n.serial,
  idempotencyKey: n.key,
  amount: 5000,
  ...extra,
})
const body = (n: Fixture, extra: Record<string, unknown> = {}) => ({ staffId: n.staffId, idempotencyKey: n.key, amount: 5000, ...extra })
const post = (n: Fixture, input = body(n), serial = n.serial, actor = n.staffId) =>
  request(app).post(`/tpv/venues/${n.venueId}/crypto/initiate`).set('x-test-actor', actor).set('x-test-terminal', serial).send(input)
const row = (n: Fixture) => prisma.payment.findFirstOrThrow({ where: { id: n.key, venueId: n.venueId } })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}
const provider = jest.fn()
let providerStatus = 'PE'
const originalFetch = global.fetch
beforeEach(() => {
  jest.clearAllMocks()
  providerStatus = 'PE'
  provider.mockImplementation(async (_url: string, opts: any) => {
    if (opts.method === 'POST') {
      const reference = opts.body.get('reference')
      const durable = await prisma.payment.findFirstOrThrow({ where: { id: reference } })
      expect((durable.processorData as any)?.cryptoOperation?.phase ?? 'SENDING').toBe('SENDING')
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ identifier: `request-${reference}`, web_url: `https://controlled.invalid/${reference}` }),
      }
    }
    return { json: async () => ({ status: providerStatus }) }
  })
  global.fetch = provider as any
})
afterEach(() => jest.restoreAllMocks())
afterAll(() => {
  global.fetch = originalFetch
})
const creates = () => provider.mock.calls.filter(c => c[1].method === 'POST')

// Only transport authentication and external effects are doubled. Permissions, validators, routes, transactions and money rows are real.
describe('S3 recoverable crypto with real PostgreSQL', () => {
  it('real route strips forged context, persists same PK/key and lost-response replay after another PIN does not reattribute', async () => {
    const n = await fixture()
    const other = await prisma.staff.create({ data: { email: `${cuid()}@staff.test`, firstName: 'Other', lastName: 'PIN' } })
    await prisma.staffVenue.create({ data: { staffId: other.id, venueId: n.venueId, role: StaffRole.OWNER } })
    const first = await post(
      n,
      body(n, { staffId: other.id, actorStaffId: other.id, terminalSerialNumber: 'forged', deviceSerialNumber: 'forged' }),
    )
    expect(first.status).toBe(200)
    const replay = await post(n, body(n, { staffId: n.staffId }), n.serial, other.id)
    expect(replay.status).toBe(200)
    expect(replay.body.data.paymentId).toBe(n.key)
    expect(await row(n)).toMatchObject({ idempotencyKey: n.key, processedById: n.staffId })
    expect(await prisma.order.count({ where: { venueId: n.venueId } })).toBe(1)
    expect(creates()).toHaveLength(1)
    const recovered = await request(app)
      .get(`/tpv/venues/${n.venueId}/crypto/operations/${n.key}`)
      .set('x-test-actor', other.id)
      .set('x-test-terminal', n.serial)
    expect(recovered.status).toBe(200)
    expect(recovered.body.data.paymentId).toBe(n.key)
    expect(JSON.stringify(recovered.body)).not.toMatch(/controlled-provider-stub|fingerprint|declaredStaffId|processorData/)
  })
  it('concurrent identical calls create one order/payment and only one provider emission', async () => {
    const n = await fixture()
    const responses = await Promise.all(Array.from({ length: 4 }, () => post(n)))
    expect(responses.map(r => r.status)).toEqual([200, 200, 200, 200])
    expect(creates()).toHaveLength(1)
    expect(await prisma.order.count({ where: { venueId: n.venueId } })).toBe(1)
    expect(await prisma.payment.count({ where: { venueId: n.venueId } })).toBe(1)
  })
  it.each(['cross-venue', 'legacy-id'] as const)('PK %s collision fails on SECOND write and rolls back its actual Order', async kind => {
    const own = await fixture(),
      foreign = await fixture()
    if (kind === 'cross-venue') await post(own)
    else
      await prisma.payment.create({
        data: {
          id: own.key,
          orderId: await orderFor(own),
          venueId: own.venueId,
          amount: 50,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: 50,
          method: 'CASH',
          status: 'COMPLETED',
        },
      })
    const target = { ...foreign, key: own.key }
    let sawInsertedOrder = false
    const transact = prisma.$transaction.bind(prisma) as any
    jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, opts: any) =>
      transact(
        (tx: any) =>
          fn(
            new Proxy(tx, {
              get(t, k) {
                if (k !== 'payment') return t[k]
                return new Proxy(t.payment, {
                  get(p, m) {
                    if (m !== 'create') return p[m]
                    return async (args: any) => {
                      sawInsertedOrder = (await tx.order.count({ where: { id: args.data.orderId, venueId: target.venueId } })) === 1
                      return p.create(args)
                    }
                  },
                })
              },
            }),
          ),
        opts,
      )) as any)
    const result = await post(target)
    expect(result.status).toBe(409)
    expect(sawInsertedOrder).toBe(true)
    expect(await prisma.order.count({ where: { venueId: target.venueId } })).toBe(0)
    expect(await prisma.payment.count({ where: { venueId: target.venueId } })).toBe(0)
    expect(creates()).toHaveLength(kind === 'cross-venue' ? 1 : 0)
  })
  it('contradictory body/order/terminal and own non-crypto collision never emit again', async () => {
    const n = await fixture()
    await post(n)
    expect((await post(n, body(n, { amount: 6000 }))).status).toBe(409)
    expect((await post(n, body(n, { orderId: cuid() }))).status).toBe(409)
    const serial = `AVQD-${cuid()}`
    await prisma.terminal.create({
      data: { venueId: n.venueId, serialNumber: serial, name: 'Other', type: 'TPV_ANDROID', status: 'ACTIVE' },
    })
    expect((await post(n, body(n), serial)).status).toBe(409)
    await expect(getCryptoOperationForVenue(n.venueId, n.key, serial, n.staffId)).rejects.toMatchObject({ statusCode: 409 })
    expect(creates()).toHaveLength(1)
    const k = cuid()
    await prisma.payment.create({
      data: {
        id: k,
        idempotencyKey: k,
        orderId: await orderFor(n),
        venueId: n.venueId,
        amount: 50,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 50,
        method: 'CASH',
      },
    })
    expect((await post({ ...n, key: k })).status).toBe(409)
    expect(creates()).toHaveLength(1)
  })
  it('process death before phase claim keeps PREPARED; restart emits once, never loses its key', async () => {
    const n = await fixture(),
      transact = prisma.$transaction.bind(prisma) as any
    let count = 0
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((...args: any[]) => {
      if (++count === 2) throw Error('process died before phase claim')
      return transact(...args)
    }) as any)
    await expect(initiateCryptoPayment(params(n))).rejects.toThrow('process died')
    expect((await row(n)).processorData).toMatchObject({ cryptoOperation: { phase: 'PREPARED' } })
    expect(creates()).toHaveLength(0)
    spy.mockRestore()
    await initiateCryptoPayment(params(n))
    expect(creates()).toHaveLength(1)
  })
  it.each(['lost-response', 'lost-persistence'] as const)(
    '%s leaves SENDING obligation and restart never issues another POST',
    async mode => {
      const n = await fixture()
      let spy: jest.SpyInstance | undefined
      if (mode === 'lost-response')
        provider.mockImplementation(async () => {
          throw Error('response lost')
        })
      else {
        const transact = prisma.$transaction.bind(prisma) as any
        let count = 0
        spy = jest.spyOn(prisma, '$transaction').mockImplementation(((...args: any[]) => {
          if (++count === 3) throw Error('worker died after response')
          return transact(...args)
        }) as any)
      }
      const first = await post(n)
      expect(first.status).toBe(200)
      expect(first.body.data).toMatchObject({
        requestId: null,
        paymentUrl: null,
        operation: { emissionStatus: 'SENDING', requiresReview: true, financialRecorded: false },
      })
      spy?.mockRestore()
      const restart = await post(n)
      expect(restart.status).toBe(200)
      expect(creates()).toHaveLength(1)
      expect((await row(n)).status).toBe('PENDING')
    },
  )
  it('provider response and AC callback merge current metadata without erasing contract/phase or evidence', async () => {
    const n = await fixture(),
      entered = deferred(),
      release = deferred()
    const normal = provider.getMockImplementation()!
    provider.mockImplementation(async (url: any, options: any) => {
      if (options.method === 'POST') {
        entered.resolve()
        await release.promise
      }
      return normal(url, options)
    })
    const sending = initiateCryptoPayment(params(n))
    await entered.promise
    await processWebhook({
      identifier: `request-${n.key}`,
      reference: n.key,
      fiat_amount: 50,
      fiat_currency: 'MXN',
      crypto_amount: '0.1',
      currency: 'BTC',
      status: 'AC',
    })
    release.resolve()
    await sending
    expect((await row(n)).processorData).toMatchObject({ lastStatus: 'AC', cryptoOperation: { phase: 'READY', terminalSerial: n.serial } })
  })
  it.each(['PENDING', 'FAILED'] as const)(
    'provider positive with DB %s is review, never financial settlement or shift money',
    async status => {
      const n = await fixture()
      await post(n)
      if (status === 'FAILED') await cancelCryptoPayment({ venueId: n.venueId, staffId: n.staffId, paymentId: n.key })
      providerStatus = 'CO'
      const result = await getCryptoOperationForVenue(n.venueId, n.key, n.serial, n.staffId)
      expect(result.operation).toMatchObject({
        financialStatus: status,
        financialRecorded: false,
        providerStatus: 'CO',
        requiresReview: true,
        reviewOwner: 'VENUE_MANAGER',
      })
      expect((await row(n)).status).toBe(status)
    },
  )
  it('org OWNER and platform SUPERADMIN without StaffVenue at venue recover; revoked/excluded/foreign actors cannot', async () => {
    const n = await fixture()
    await post(n)
    const owner = await prisma.staff.create({ data: { email: `${cuid()}@owner.test`, firstName: 'Org', lastName: 'Owner' } })
    await prisma.staffOrganization.create({ data: { staffId: owner.id, organizationId: n.orgId, role: 'OWNER', isActive: true } })
    await expect(getCryptoOperationForVenue(n.venueId, n.key, n.serial, owner.id)).resolves.toMatchObject({ paymentId: n.key })
    const otherVenue = await fixture()
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: otherVenue.staffId, venueId: otherVenue.venueId } },
      data: { role: 'SUPERADMIN' },
    })
    await expect(getCryptoOperationForVenue(n.venueId, n.key, n.serial, otherVenue.staffId)).resolves.toMatchObject({ paymentId: n.key })
    await prisma.staff.update({ where: { id: owner.id }, data: { active: false } })
    await expect(getCryptoOperationForVenue(n.venueId, n.key, n.serial, owner.id)).rejects.toMatchObject({ statusCode: 403 })
    const set = await prisma.permissionSet.create({ data: { venueId: n.venueId, name: 'No crypto', permissions: [] } })
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: n.staffId, venueId: n.venueId } },
      data: { role: StaffRole.CASHIER, permissionSetId: set.id },
    })
    await expect(getCryptoOperationForVenue(n.venueId, n.key, n.serial, n.staffId)).rejects.toMatchObject({ statusCode: 403 })
    await expect(initiateCryptoPayment(params(n))).rejects.toMatchObject({ statusCode: 403 })
    const foreign = await fixture()
    await expect(getCryptoOperationForVenue(n.venueId, n.key, n.serial, foreign.staffId)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('cancel is tenant/method/id scoped, preserves metadata, is once-only and never overwrites confirmation winning its lock', async () => {
    const n = await fixture(),
      foreign = await fixture()
    await post(n)
    await expect(cancelCryptoPayment({ venueId: foreign.venueId, staffId: foreign.staffId, paymentId: n.key })).rejects.toThrow()
    await expect(
      cancelCryptoPayment({ venueId: n.venueId, staffId: n.staffId, paymentId: n.key, requestId: 'contradiction' }),
    ).rejects.toThrow()
    const cash = await prisma.payment.create({
      data: {
        venueId: n.venueId,
        orderId: await orderFor(n),
        amount: 50,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 50,
        method: 'CASH',
        status: 'PENDING',
      },
    })
    await expect(cancelCryptoPayment({ venueId: n.venueId, staffId: n.staffId, paymentId: cash.id })).rejects.toThrow()
    await cancelCryptoPayment({ venueId: n.venueId, staffId: n.staffId, requestId: `request-${n.key}` })
    await cancelCryptoPayment({ venueId: n.venueId, staffId: n.staffId, paymentId: n.key })
    expect(
      await prisma.activityLog.count({
        where: { venueId: n.venueId, entityId: n.key, action: 'CRYPTO_PAYMENT_CANCELLED', staffId: n.staffId },
      }),
    ).toBe(1)
    expect((await row(n)).processorData).toMatchObject({ cryptoOperation: { phase: 'READY' } })
    const m = await fixture()
    await post(m)
    const transact = prisma.$transaction.bind(prisma) as any,
      locked = deferred(),
      release = deferred(),
      readPending = deferred()
    const confirmer = transact(async (tx: any) => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id=${m.key} AND "venueId"=${m.venueId} FOR UPDATE`
      locked.resolve()
      await release.promise
      await tx.payment.update({ where: { id: m.key, venueId: m.venueId }, data: { status: 'COMPLETED' } })
    })
    await locked.promise
    jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, opts: any) =>
      transact(
        (tx: any) =>
          fn(
            new Proxy(tx, {
              get(t, k) {
                if (k !== 'payment') return t[k]
                return new Proxy(t.payment, {
                  get(p, m) {
                    if (m !== 'findFirst') return p[m]
                    return async (args: any) => {
                      const value = await p.findFirst(args)
                      readPending.resolve()
                      return value
                    }
                  },
                })
              },
            }),
          ),
        opts,
      )) as any)
    const cancellation = cancelCryptoPayment({ venueId: m.venueId, staffId: m.staffId, paymentId: m.key })
    const outcome = cancellation.catch(error => error)
    await readPending.promise
    release.resolve()
    await confirmer
    expect(await outcome).toMatchObject({ statusCode: 400 })
    expect((await row(m)).status).toBe('COMPLETED')
  })
  it('legacy initiate without key keeps generated id and response shape', async () => {
    const n = await fixture(),
      input = body(n)
    delete (input as any).idempotencyKey
    const result = await post(n, input)
    expect(result.status).toBe(200)
    expect(result.body.data.operation).toBeUndefined()
    const payment = await prisma.payment.findFirstOrThrow({ where: { venueId: n.venueId } })
    expect(payment.id).not.toBe(n.key)
    expect(payment.idempotencyKey).toBeNull()
    expect(result.body.data).toMatchObject({ paymentId: payment.id, requestId: `request-${payment.id}`, expiresInSeconds: 900 })
  })
  it('PAY_CASH A closed / B open + lost ACK records one D4 payment, never B; no new required client field', async () => {
    const n = await fixture()
    const a = await prisma.shift.create({
      data: {
        venueId: n.venueId,
        staffId: n.staffId,
        status: 'CLOSED',
        startTime: new Date(Date.now() - 10000),
        endTime: new Date(Date.now() - 5000),
      },
    })
    const b = await prisma.shift.create({ data: { venueId: n.venueId, staffId: n.staffId, status: 'OPEN', startTime: new Date() } })
    const order = await prisma.order.create({
      data: {
        venueId: n.venueId,
        orderNumber: cuid(),
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'PENDING',
        subtotal: 50,
        taxAmount: 0,
        total: 50,
        remainingBalance: 50,
        paymentStatus: 'PENDING',
      },
    })
    const intent = { id: cuid(), seq: 1, type: 'PAY_CASH', payload: { orderId: order.id, amountCents: 5000, shiftIdDeLaVenta: a.id } }
    const sync = () =>
      request(app)
        .post(`/tpv/venues/${n.venueId}/sync/intents`)
        .set('x-test-actor', n.staffId)
        .set('x-test-terminal', n.serial)
        .send({ deviceId: 'untrusted-device', intents: [intent] })
    const first = await sync()
    expect(first.status).toBe(200)
    expect(first.body.data[0].status).toBe('ACKED')
    const replay = await sync()
    expect(replay.body.data[0].result.paymentId).toBe(first.body.data[0].result.paymentId)
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { venueId_idempotencyKey: { venueId: n.venueId, idempotencyKey: intent.id } },
    })
    expect(payment.shiftId).toBeNull()
    expect(payment.posRawData).toMatchObject({ ventaDeTurnoCerrado: a.id })
    expect(await prisma.payment.count({ where: { venueId: n.venueId } })).toBe(1)
    expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: b.id } })).totalSales)).toBe(0)
    const audits = await prisma.activityLog.findMany({ where: { venueId: n.venueId, action: 'PAYMENT_WITHOUT_SHIFT' }, take: 10 })
    expect(audits).toHaveLength(1)
    expect(audits[0].data).toMatchObject({ reason: 'SALE_SHIFT_CLOSED', saleShiftId: a.id, candidateShiftId: b.id })
  })
})

describe('B4Bit payment-only leaves against the real confirmation lock hierarchy', () => {
  const within = async <T>(work: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error(`No se acreditó la barrera real: ${label}`)), 10_000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const outcome = <T>(work: Promise<T>) =>
    work.then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    )
  const waitForBlocker = async (waiter: number, holder: number) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const [witness] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT ${holder}::int = ANY(pg_blocking_pids(${waiter}::int)) AS blocked`
      if (witness?.blocked) return
      // Yield only to permit the next DB observation, never as evidence of contention.
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    throw Error(`Postgres no acreditó que PID ${waiter} esperara al PID ${holder}`)
  }

  it.each(['claim-replay', 'ready-write', 'AC', 'cancel-first', 'CO-first'] as const)(
    '%s: identified PostgreSQL locks cross without a cycle and preserve the winning financial outcome',
    async mode => {
      const n = await fixture()
      const sale = await sembrarVentaDeTarjetasSinPagar({
        venueId: n.venueId,
        organizationId: n.orgId,
        staffId: n.staffId,
        montos: [50],
      })
      const input = params(n, { orderId: sale.orderId })
      const older = new Date().toISOString()
      const newer = new Date(Date.parse(older) + 1_000).toISOString()
      const webhook = (status: 'AC' | 'CO') => ({
        identifier: `request-${n.key}`,
        reference: n.key,
        fiat_amount: 50,
        fiat_currency: 'MXN',
        crypto_amount: '0.1',
        currency: 'BTC',
        status,
        edited_at: status === 'CO' ? newer : older,
      })

      const providerEntered = deferred(),
        providerRelease = deferred()
      if (mode === 'ready-write') {
        const normalProvider = provider.getMockImplementation()!
        provider.mockImplementation(async (url: any, options: any) => {
          if (options.method === 'POST') {
            providerEntered.resolve()
            await providerRelease.promise
          }
          return normalProvider(url, options)
        })
      } else await initiateCryptoPayment(input)

      const lanes = new AsyncLocalStorage<'leaf' | 'confirm'>()
      const orderOwned = deferred(),
        releaseOrder = deferred()
      const leafOwned = deferred(),
        releaseLeaf = deferred(),
        leafAttempted = deferred()
      const confirmationOwned = deferred(),
        releaseConfirmation = deferred()
      let confirmPid = 0,
        leafPid = 0,
        leafLocks = 0,
        heldOrder = false,
        heldConfirmation = false
      const transact = prisma.$transaction.bind(prisma) as any
      const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, options: any) => {
        const lane = lanes.getStore()
        if (!lane || typeof fn !== 'function') return transact(fn, options)
        return transact(async (tx: any) => {
          const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`
          return fn(
            new Proxy(tx, {
              get(target, key) {
                if (key !== '$queryRaw') return target[key]
                return async (...args: any[]) => {
                  const sql = Array.isArray(args[0]) ? args[0].join(' ') : (args[0]?.sql ?? '')
                  const paymentLock = /SELECT id FROM "Payment"[\s\S]*FOR UPDATE/.test(sql)
                  const targetLeaf = lane === 'leaf' && paymentLock && ++leafLocks === (mode === 'ready-write' ? 2 : 1)
                  if (targetLeaf) {
                    leafPid = pid
                    leafAttempted.resolve()
                  }
                  // The database really acquires the row before any barrier is exposed.
                  const rows = await target.$queryRaw(...args)
                  if (lane === 'confirm' && /FOR UPDATE OF o\b/.test(sql) && !heldOrder && mode !== 'CO-first') {
                    expect(rows.some((r: any) => r.id === sale.orderId)).toBe(true)
                    heldOrder = true
                    confirmPid = pid
                    orderOwned.resolve()
                    await releaseOrder.promise
                  }
                  if (lane === 'confirm' && paymentLock && !heldConfirmation && mode === 'CO-first') {
                    heldConfirmation = true
                    confirmPid = pid
                    confirmationOwned.resolve()
                    await releaseConfirmation.promise
                  }
                  if (targetLeaf && mode !== 'CO-first') {
                    expect(rows).toEqual([{ id: n.key }])
                    leafOwned.resolve()
                    await releaseLeaf.promise
                  }
                  return rows
                }
              },
            }),
          )
        }, options)
      }) as any)

      const runLeaf = (): Promise<unknown> =>
        lanes.run('leaf', () =>
          mode === 'AC'
            ? processWebhook(webhook('AC'))
            : mode === 'cancel-first' || mode === 'CO-first'
              ? cancelCryptoPayment({ venueId: n.venueId, staffId: n.staffId, paymentId: n.key })
              : initiateCryptoPayment(input),
        )
      let leaf: ReturnType<typeof outcome<unknown>> | undefined
      let confirmation: ReturnType<typeof outcome<unknown>> | undefined
      try {
        if (mode === 'ready-write') {
          leaf = outcome(runLeaf())
          await within(
            Promise.race([
              providerEntered.promise,
              leaf.then(result => {
                if (!result.ok) throw result.error
                throw Error('Initiation ended before provider barrier')
              }),
            ]),
            'provider before READY',
          )
        }
        confirmation = outcome(lanes.run('confirm', () => processWebhook(webhook('CO'))))
        if (mode === 'CO-first') {
          await within(
            Promise.race([
              confirmationOwned.promise,
              confirmation.then(result => {
                if (!result.ok) throw result.error
                throw Error('CO ended before its Payment lock')
              }),
            ]),
            'CO owns Order and Payment',
          )
          leaf = outcome(runLeaf())
          await within(
            Promise.race([
              leafAttempted.promise,
              leaf.then(result => {
                if (!result.ok) throw result.error
                throw Error('Cancel ended before attempting Payment')
              }),
            ]),
            'cancel attempts Payment',
          )
          expect(leafPid).not.toBe(confirmPid)
          await waitForBlocker(leafPid, confirmPid)
          releaseConfirmation.resolve()
        } else {
          await within(
            Promise.race([
              orderOwned.promise,
              confirmation.then(result => {
                if (!result.ok) throw result.error
                throw Error('CO ended before its canonical Order lock')
              }),
            ]),
            'CO owns canonical Order scope',
          )
          if (mode === 'ready-write') providerRelease.resolve()
          else leaf = outcome(runLeaf())
          await within(
            Promise.race([
              leafOwned.promise,
              leaf!.then(result => {
                if (!result.ok) throw result.error
                throw Error('Leaf ended before owning Payment')
              }),
            ]),
            'leaf owns Payment while CO holds Order',
          )
          expect(leafPid).not.toBe(confirmPid)
          releaseOrder.resolve()
          await waitForBlocker(confirmPid, leafPid)
          releaseLeaf.resolve()
        }

        const results = await within(Promise.all([leaf!, confirmation]), 'both public operations finish after real contention')
        expect(results.map(r => (r.ok ? 'fulfilled' : String(r.error))).join(' ')).not.toMatch(/40P01|deadlock/i)
        expect(results[1]).toMatchObject({ ok: true, value: { action: mode === 'cancel-first' ? 'IGNORED' : 'CONFIRMED' } })
        if (mode === 'CO-first') expect(results[0]).toMatchObject({ ok: false, error: { statusCode: 400 } })
        else expect(results[0].ok).toBe(true)
        expect(leafLocks).toBe(mode === 'ready-write' ? 2 : 1)
        expect(creates()).toHaveLength(1)
        expect(await prisma.payment.count({ where: { venueId: n.venueId } })).toBe(1)
        expect(await row(n)).toMatchObject({ status: mode === 'cancel-first' ? 'FAILED' : 'COMPLETED', idempotencyKey: n.key })
        expect((await row(n)).processorData).toMatchObject({ cryptoOperation: { phase: 'READY', terminalSerial: n.serial } })
        expect(await prisma.order.findUniqueOrThrow({ where: { id: sale.orderId } })).toMatchObject({
          paymentStatus: mode === 'cancel-first' ? 'PENDING' : 'PAID',
        })
        const cards = await prisma.giftCard.findMany({ where: { id: { in: sale.giftCardIds }, venueId: n.venueId }, take: 2 })
        expect(cards.map(c => [c.status, c.balance.toFixed(2)])).toEqual([
          [mode === 'cancel-first' ? 'PENDING' : 'ACTIVE', mode === 'cancel-first' ? '0.00' : '50.00'],
        ])
        expect(
          await prisma.giftCardActivity.count({ where: { venueId: n.venueId, giftCardId: { in: sale.giftCardIds }, type: 'ACTIVATE' } }),
        ).toBe(mode === 'cancel-first' ? 0 : 1)
        expect(await prisma.activityLog.count({ where: { venueId: n.venueId, entityId: n.key, action: 'CRYPTO_PAYMENT_CANCELLED' } })).toBe(
          mode === 'cancel-first' ? 1 : 0,
        )
        if (mode === 'AC') expect((await row(n)).processorData).toMatchObject({ lastStatus: 'CO', lastEditedAt: newer })
        if (mode === 'cancel-first') {
          providerStatus = 'CO'
          expect(await getCryptoOperationForVenue(n.venueId, n.key, n.serial, n.staffId)).toMatchObject({
            operation: { financialStatus: 'FAILED', providerStatus: 'CO', financialRecorded: false, requiresReview: true },
          })
        }
      } finally {
        providerRelease.resolve()
        releaseOrder.resolve()
        releaseLeaf.resolve()
        releaseConfirmation.resolve()
        try {
          await within(Promise.allSettled([...(leaf ? [leaf] : []), ...(confirmation ? [confirmation] : [])]), 'drain owned operations')
        } finally {
          spy.mockRestore()
        }
      }
    },
    60_000,
  )
})

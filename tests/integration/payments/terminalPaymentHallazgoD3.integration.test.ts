import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { llaveDeIntento } from '@/services/tpv/candadoDeIntento'
import { Prisma } from '@prisma/client'
import { terminalIdentityKey } from '@/utils/terminalSerial'
import { utcTs } from '@/utils/sqlDates'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import * as angelpay from '@/services/tpv/angelpay-webhook.service'
import { TerminalPaymentWatchdogJob } from '@/jobs/terminal-payment-watchdog.job'
import { sendOpsAlert } from '@/services/alerts/opsAlert.service'

jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn(() => null), getBroadcastingService: jest.fn(() => null) },
  socketManager: { getServer: jest.fn(() => null), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (s: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(s),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))

const APPROVAL = 'TERMINAL_PAYMENT_WINDOW_BANK_APPROVED_AWAITING_PAYMENT'
const ALERT = 'ANGELPAY_APPROVED_WITHOUT_REFERENCES'
let orgId: string
let venueId: string
let otherVenueId: string
let merchant: { id: string; externalMerchantId: string }
let terminal: { id: string; serialNumber: string | null }
let loginId: string
let providerId: string
const eventIds: string[] = []
const eventKeys: string[] = []
const watchdog = new TerminalPaymentWatchdogJob()

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: 'D3 aislado', email: `${cuid()}@example.test`, phone: '5500000000' } })
  orgId = org.id
  const v = await prisma.venue.create({ data: { organizationId: orgId, name: 'D3 tienda', slug: cuid(), currency: 'MXN' } })
  venueId = v.id
  otherVenueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'D3 otro', slug: cuid() } })).id
  terminal = await prisma.terminal.create({ data: { venueId, name: 'D3 terminal', serialNumber: `AVQD-${cuid()}`, type: 'TPV_ANDROID' } })
  providerId = (
    await prisma.paymentProvider.create({ data: { code: cuid(), name: 'D3 proveedor', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] } })
  ).id
  loginId = (
    await prisma.angelPayUserAccount.create({ data: { venueId, email: `${cuid()}@example.test`, environment: 'QA', status: 'ACTIVE' } })
  ).id
  merchant = await prisma.merchantAccount.create({
    data: { providerId, externalMerchantId: cuid(), alias: 'D3 afiliación', credentialsEncrypted: {}, angelpayUserAccountId: loginId },
  })
})

beforeEach(() => jest.clearAllMocks())
afterEach(async () => {
  jest.restoreAllMocks()
  if (!venueId) return
  await prisma.activityLog.deleteMany({ where: { OR: [{ venueId: { in: [venueId, otherVenueId] } }, { entityId: { in: eventIds } }] } })
  await prisma.providerEventLog.deleteMany({ where: { eventId: { in: eventKeys } } })
  await prisma.payment.deleteMany({ where: { venueId: { in: [venueId, otherVenueId] } } })
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId: { in: [venueId, otherVenueId] } } })
  await prisma.order.deleteMany({ where: { venueId: { in: [venueId, otherVenueId] } } })
  eventIds.length = 0
  eventKeys.length = 0
  ;(terminalPaymentService as any).positivasCursor = null
})
afterAll(async () => {
  watchdog.stop()
  if (!venueId) return
  await prisma.merchantAccount.delete({ where: { id: merchant.id } })
  await prisma.angelPayUserAccount.delete({ where: { id: loginId } })
  await prisma.terminal.delete({ where: { id: terminal.id } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, otherVenueId] } } })
  await prisma.organization.delete({ where: { id: orgId } })
  await prisma.paymentProvider.delete({ where: { id: providerId } })
})

const logs = (id: string, action = ALERT) => prisma.activityLog.findMany({ where: { entityId: id, action } })
const payload = (inner: Record<string, unknown> = {}): angelpay.AngelPayWebhookPayload => ({
  event_type: 'send_transaction',
  payload: { amount: '000000010025', status: 'approved', terminalSerial: terminal.serialNumber!, ...inner },
})
const deliver = async (body: unknown) => {
  const eventId = cuid()
  eventKeys.push(`angelpay-${eventId}`)
  const result = await angelpay.processAngelPayWebhook({
    payload: body as angelpay.AngelPayWebhookPayload,
    eventId,
    merchantAccount: merchant,
    retryDelaysMs: [0],
  })
  if (result.eventLogId) eventIds.push(result.eventLogId)
  return { ...result, eventId }
}

/** El INSERT real confirma; la continuación nunca recibe el resultado, como una caída entre ambas operaciones. */
async function crashAfterInsert(body = payload()) {
  const original = prisma.providerEventLog.create.bind(prisma.providerEventLog)
  const eventId = cuid()
  eventKeys.push(`angelpay-${eventId}`)
  const originalTransaction = prisma.$transaction.bind(prisma)
  const die = () => {
    throw new Error('D3 simulated process death after durable INSERT')
  }
  const crash = llaveDeIntento(body.payload.integratorReference)
    ? jest.spyOn(prisma, '$transaction').mockImplementation((async (fn: any, options: any) => {
        const result = await originalTransaction(fn, options)
        const durable = await prisma.providerEventLog.findUnique({
          where: { provider_eventId: { provider: 'PAYMENT_PROCESSOR', eventId: `angelpay-${eventId}` } },
        })
        if (durable) {
          expect(durable.id).toMatch(/^c[a-z0-9]{24}$/)
          return die()
        }
        return result
      }) as any)
    : jest.spyOn(prisma.providerEventLog, 'create').mockImplementationOnce((async (args: any) => {
        await original(args)
        return die()
      }) as any)
  await expect(angelpay.processAngelPayWebhook({ payload: body, eventId, merchantAccount: merchant, retryDelaysMs: [0] })).rejects.toThrow(
    'simulated process death',
  )
  crash.mockRestore()
  const inserted = await prisma.providerEventLog.findUniqueOrThrow({
    where: { provider_eventId: { provider: 'PAYMENT_PROCESSOR', eventId: `angelpay-${eventId}` } },
  })
  eventIds.push(inserted.id)
  return inserted
}

async function released() {
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: cuid(),
      source: 'TPV',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      subtotal: 100.25,
      taxAmount: 0,
      total: 100.25,
    },
  })
  const old = new Date(Date.now() - 3 * 60 * 60_000)
  const request = await prisma.terminalPaymentRequest.create({
    data: {
      requestId: cuid(),
      venueId,
      terminalId: terminalIdentityKey(terminal.serialNumber!),
      orderId: order.id,
      amountCents: 10025,
      tipCents: 0,
      status: 'FAILED',
      failureCode: 'NO_EVIDENCE_AFTER_WINDOW',
      expiresAt: old,
      createdAt: old,
      resultJson: { releasedAfterWindow: { releasedAt: old.toISOString() }, outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW' },
    },
  })
  await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = ${utcTs(old)} WHERE "id" = ${request.id}`
  const attemptId = cuid()
  await prisma.terminalPaymentAttemptLink.create({
    data: { attemptId, requestId: request.requestId, venueId, terminalId: request.terminalId },
  })
  return { request: await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: request.id } }), order, attemptId }
}

async function financialSnapshot() {
  return {
    requests: await prisma.terminalPaymentRequest.findMany({ where: { venueId: { in: [venueId, otherVenueId] } }, orderBy: { id: 'asc' } }),
    payments: await prisma.payment.findMany({ where: { venueId: { in: [venueId, otherVenueId] } }, orderBy: { id: 'asc' } }),
    orders: await prisma.order.findMany({ where: { venueId: { in: [venueId, otherVenueId] } }, orderBy: { id: 'asc' } }),
  }
}

describe('Hallazgo D3 · aprobado exacto, recuperación financiera real', () => {
  it('el CAS relee la evidencia: si el vínculo cambia después del selector no retiene la venta anterior', async () => {
    const { request, attemptId } = await released()
    await crashAfterInsert(payload({ integratorReference: attemptId }))
    const original = terminalPaymentService.retenerSolicitudLiberadaPorAprobacion.bind(terminalPaymentService)
    jest.spyOn(terminalPaymentService, 'retenerSolicitudLiberadaPorAprobacion').mockImplementationOnce(async input => {
      await prisma.terminalPaymentAttemptLink.delete({ where: { attemptId } })
      return original(input)
    })
    await (terminalPaymentService as any).retenerLiberadasConSenalPositiva()
    expect(await prisma.terminalPaymentRequest.findUnique({ where: { id: request.id } })).toEqual(request)
    expect(await logs(request.id, APPROVAL)).toHaveLength(0)
  })

  it('un Payment que llega antes del CAS tiene prioridad; la siguiente pasada concilia sin inventar aprobación', async () => {
    const { request, order, attemptId } = await released()
    await crashAfterInsert(payload({ integratorReference: attemptId }))
    const original = terminalPaymentService.retenerSolicitudLiberadaPorAprobacion.bind(terminalPaymentService)
    let paymentId: string | undefined
    jest.spyOn(terminalPaymentService, 'retenerSolicitudLiberadaPorAprobacion').mockImplementationOnce(async input => {
      paymentId = (
        await prisma.payment.create({
          data: {
            venueId,
            orderId: order.id,
            terminalId: terminal.id,
            amount: 100.25,
            tipAmount: 0,
            source: 'TPV',
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 100.25,
            idempotencyKey: attemptId,
          },
        })
      ).id
      return original(input)
    })
    expect(await (terminalPaymentService as any).retenerLiberadasConSenalPositiva()).toMatchObject({ sinPago: 0 })
    expect(await logs(request.id, APPROVAL)).toHaveLength(0)
    await (terminalPaymentService as any).retenerLiberadasConSenalPositiva()
    expect(await prisma.terminalPaymentRequest.findUnique({ where: { id: request.id } })).toMatchObject({ status: 'COMPLETED', paymentId })
    expect(await prisma.payment.count({ where: { venueId } })).toBe(1)
  })

  it('EXPLAIN de los dos selectores reales conserva acceso acotado por índices', async () => {
    const { attemptId } = await released()
    await crashAfterInsert(payload({ integratorReference: attemptId }))
    await crashAfterInsert()
    const original = prisma.$queryRaw.bind(prisma)
    const selectors: Prisma.Sql[] = []
    const spy = jest.spyOn(prisma, '$queryRaw').mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values)
      if (sql.text.includes('liberadas-con-senal') || sql.text.includes('a."action"')) selectors.push(sql)
      return original(sql)
    }) as any)
    // Captura la consulta antes de consumir sus candidatas; las decisiones financieras reales se prueban por separado.
    const skip = jest.spyOn(prisma.terminalPaymentRequest, 'findFirst').mockResolvedValueOnce(null)
    await (terminalPaymentService as any).retenerLiberadasConSenalPositiva()
    skip.mockRestore()
    // El barrido real consume el aviso; ninguna venta cambia por esa recuperación.
    await angelpay.recuperarAvisosAprobadosSinReferencias()
    spy.mockRestore()
    expect(selectors).toHaveLength(2)
    for (const selector of selectors) {
      const plan = await prisma.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${selector}`)
      console.log('[D3 selector default EXPLAIN]', JSON.stringify(plan))
      const indexed = await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
        return tx.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON) ${selector}`)
      })
      const nodes = (value: any): any[] => (value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(nodes)] : [])
      expect(nodes(indexed).filter(n => n['Relation Name'] === 'ProviderEventLog')).toEqual(
        expect.arrayContaining([expect.objectContaining({ 'Node Type': expect.stringContaining('Index') })]),
      )
    }
  })

  it('rescata fuera de 30 minutos el aprobado agotado sin Payment, por el núcleo y una sola auditoría', async () => {
    const { request, attemptId, order } = await released()
    const event = await crashAfterInsert(payload({ integratorReference: attemptId }))
    await prisma.providerEventLog.update({ where: { id: event.id }, data: { status: 'ERROR', errorReason: 'RETRIES_EXHAUSTED' } })
    expect(await prisma.payment.count({ where: { venueId } })).toBe(0)
    expect(await (terminalPaymentService as any).retenerLiberadasConSenalPositiva()).toMatchObject({ sinPago: 1 })
    expect(await prisma.terminalPaymentRequest.findUnique({ where: { id: request.id } })).toMatchObject({
      status: 'TIMED_OUT',
      failureCode: 'BANK_APPROVED_AWAITING_PAYMENT',
      paymentId: null,
    })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, order.id)).toBe(true)
    await (terminalPaymentService as any).retenerLiberadasConSenalPositiva()
    expect(await logs(request.id, APPROVAL)).toHaveLength(1)
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    expect(await prisma.payment.count({ where: { venueId } })).toBe(0)
  })

  it.each(['other-key', 'other-venue', 'declined', 'invalid', 'removed-link'])('control exacto: %s no re-retiene', async control => {
    const { request, attemptId } = await released()
    const event = await crashAfterInsert(
      payload({
        integratorReference: control === 'other-key' ? cuid() : attemptId,
        status: control === 'declined' ? 'declined' : control === 'invalid' ? {} : 'approved',
      }),
    )
    if (control === 'other-venue') await prisma.providerEventLog.update({ where: { id: event.id }, data: { venueId: otherVenueId } })
    if (control === 'removed-link') await prisma.terminalPaymentAttemptLink.delete({ where: { attemptId } })
    await (terminalPaymentService as any).retenerLiberadasConSenalPositiva()
    expect(await prisma.terminalPaymentRequest.findUnique({ where: { id: request.id } })).toEqual(request)
    expect(await logs(request.id, APPROVAL)).toHaveLength(0)
  })
})

describe('Hallazgo D3 · sólo avisar aprobados sin referencias útiles', () => {
  it('fix1 · el correo diferido no retiene al watchdog ni el siguiente rescate', async () => {
    await released()
    const before = await financialSnapshot()
    const event = await crashAfterInsert()
    let releaseMail!: (sent: boolean) => void
    let markWaited!: (state: 'WAITED_FOR_MAIL') => void
    const waited = new Promise<'WAITED_FOR_MAIL'>(resolve => {
      markWaited = resolve
    })
    // Una Promise válida con constructor distinto hace observable su espera, sin sleeps ni plazos de scheduler.
    const mail = new (class extends Promise<boolean> {})(resolve => {
      releaseMail = resolve
    })
    const originalThen = mail.then.bind(mail)
    jest.spyOn(mail, 'then').mockImplementation(((...args: any[]) => {
      markWaited('WAITED_FOR_MAIL')
      return (originalThen as any)(...args)
    }) as any)
    ;(sendOpsAlert as jest.Mock).mockReturnValueOnce(mail)
    const rescue = jest.spyOn(terminalPaymentService, 'resolvePendingFromDurableState')
    const firstRun = watchdog.run()
    try {
      expect(await Promise.race([firstRun.then(() => 'RECOVERY_FINISHED'), waited])).toBe('RECOVERY_FINISHED')
      expect(await logs(event.id)).toHaveLength(1)
      expect(sendOpsAlert).toHaveBeenCalledTimes(1)
      expect(rescue).toHaveBeenCalledTimes(1)
      // El correo sigue sin resolver: el mismo job debe volver a ejecutar sus rescates y no sólo saltar isRunning.
      await watchdog.run()
      expect(rescue).toHaveBeenCalledTimes(2)
      expect(await logs(event.id)).toHaveLength(1)
      expect(sendOpsAlert).toHaveBeenCalledTimes(1)
      expect(await financialSnapshot()).toEqual(before)
    } finally {
      releaseMail(false)
      markWaited('WAITED_FOR_MAIL')
      await firstRun
    }
  })

  it('receptor y barrido concurrentes producen un asiento y un intento de correo por evento', async () => {
    await released()
    const before = await financialSnapshot()
    const original = prisma.providerEventLog.updateMany.bind(prisma.providerEventLog)
    let sweep: Promise<number> | undefined
    jest.spyOn(prisma.providerEventLog, 'updateMany').mockImplementationOnce((async (args: any) => {
      const result = await original(args)
      sweep = angelpay.recuperarAvisosAprobadosSinReferencias()
      return result
    }) as any)
    const result = await deliver(payload())
    await sweep
    expect(await logs(result.eventLogId!)).toHaveLength(1)
    expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    expect(await financialSnapshot()).toEqual(before)
  })

  it.each([undefined, '', ' \t\u00a0', {}, 123])(
    'receptor válido sin referencia útil %p: aviso y bitácora, dinero intacto',
    async reference => {
      await released()
      const before = await financialSnapshot()
      const result = await deliver(payload({ integratorReference: reference, transactionId: reference }))
      expect(result.action).toBe('ORPHANED')
      expect(await logs(result.eventLogId!)).toHaveLength(1)
      expect(sendOpsAlert).toHaveBeenCalledTimes(1)
      expect(JSON.stringify((sendOpsAlert as jest.Mock).mock.calls[0])).toContain('$100.25')
      expect(await financialSnapshot()).toEqual(before)
      const again = await angelpay.processAngelPayWebhook({
        payload: payload(),
        eventId: result.eventId,
        merchantAccount: merchant,
        retryDelaysMs: [0],
      })
      expect(again.action).toBe('DUPLICATE')
      await watchdog.run()
      expect(await logs(result.eventLogId!)).toHaveLength(1)
      expect(sendOpsAlert).toHaveBeenCalledTimes(1)
      expect(await financialSnapshot()).toEqual(before)
    },
  )

  it.each(['INSERT', 'AWAITING_PAYMENT', 'RETRIES_EXHAUSTED'])(
    'tras caída en %s el barrido/reinicio recupera una sola vez',
    async phase => {
      await released()
      const before = await financialSnapshot()
      const event = await crashAfterInsert(payload({ integratorReference: '\t\u00a0', transactionId: ' ' }))
      if (phase !== 'INSERT')
        await prisma.providerEventLog.update({
          where: { id: event.id },
          data: { status: phase === 'RETRIES_EXHAUSTED' ? 'ERROR' : 'PENDING', errorReason: phase },
        })
      expect(await logs(event.id)).toHaveLength(0)
      await Promise.all([watchdog.run(), new TerminalPaymentWatchdogJob().run()])
      await watchdog.run()
      expect(await logs(event.id)).toHaveLength(1)
      expect(sendOpsAlert).toHaveBeenCalledTimes(1)
      expect(await financialSnapshot()).toEqual(before)
    },
  )

  it('fallo del correo conserva la bitácora; terminal de otro venue nunca se adopta', async () => {
    const alien = await prisma.terminal.create({
      data: { venueId: otherVenueId, name: 'Otra', serialNumber: `AVQD-${cuid()}`, type: 'TPV_ANDROID' },
    })
    try {
      ;(sendOpsAlert as jest.Mock).mockResolvedValueOnce(false)
      const result = await deliver(payload({ terminalSerial: alien.serialNumber }))
      const [log] = await logs(result.eventLogId!)
      expect(log).toMatchObject({ venueId, data: { terminalId: null } })
      expect(JSON.stringify(log.data)).not.toContain(otherVenueId)
      await watchdog.run()
      expect(await logs(result.eventLogId!)).toHaveLength(1)
      expect(sendOpsAlert).toHaveBeenCalledTimes(1)
    } finally {
      await prisma.terminal.delete({ where: { id: alien.id } })
    }
  })

  it.each(['declined', undefined, {}, ''])('sin aprobación explícita %p no inventa aviso', async status => {
    const result = await deliver(payload({ status }))
    await watchdog.run()
    expect(await logs(result.eventLogId!)).toHaveLength(0)
    expect(sendOpsAlert).not.toHaveBeenCalled()
  })

  it('payload inválido con sello _avoqado falsificado no acredita comercio', async () => {
    const result = await deliver({
      event_type: 'send_transaction',
      payload: { status: 'approved' },
      _avoqado: { receivedByMerchantAccountId: merchant.id },
    })
    await watchdog.run()
    expect(result.errorReason).toBe('INVALID_PAYLOAD')
    expect(await logs(result.eventLogId!)).toHaveLength(0)
    expect(sendOpsAlert).not.toHaveBeenCalled()
  })

  it('referencia útil conserva su ruta y los ingresos de hace más de 24h no generan correo histórico', async () => {
    const result = await deliver(payload({ transactionId: cuid() }))
    const old = await crashAfterInsert()
    await prisma.$executeRaw`UPDATE "ProviderEventLog" SET "createdAt" = ${utcTs(new Date(Date.now() - 25 * 60 * 60_000))} WHERE "id" = ${old.id}`
    await watchdog.run()
    expect(await logs(result.eventLogId!)).toHaveLength(0)
    expect(await logs(old.id)).toHaveLength(0)
    expect(sendOpsAlert).not.toHaveBeenCalled()
  })
})

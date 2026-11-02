import cuid from 'cuid'
import type { Request, Response } from 'express'
import { getTerminalConfig } from '@/controllers/tpv/terminal.tpv.controller'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import {
  reserveAngelPaySlot,
  upsertDiscoveredAngelPayMerchants,
  updateMerchantAccount,
  deleteMerchantAccount,
  getMerchantAccountBlockers,
} from '@/services/superadmin/merchantAccount.service'
import {
  setAngelPayUserAccountPin,
  updateAngelPayUserAccountCredentials,
  hardDeleteAngelPayUserAccount,
  markAngelPayUserAccountValidated,
} from '@/services/superadmin/angelpayUserAccount.service'
import { fullSetupAngelPayMerchant } from '@/services/superadmin/angelpayFullSetup.service'
import { runClaimedAngelPayEvent } from '@/services/tpv/angelpayEventWorker.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn(() => null), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/access/basePlan.service', () => ({ getVenuePlanInfo: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/access/cashReconciliationAccess.service', () => ({ isCashReconciliationEnabled: jest.fn().mockResolvedValue(false) }))
jest.mock('@/services/modules/module.service', () => ({
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }))

let orgId: string
let venueId: string
let otherVenueId: string
let providerId: string
let ownProvider = false
const merchantIds: string[] = []
const eventIds: string[] = []
const immutable = { statusCode: 409, code: 'ANGELPAY_IDENTITY_IMMUTABLE' }

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
    const target = new URL(process.env[key] ?? '')
    expect(['localhost', '127.0.0.1']).toContain(target.hostname)
    expect(target.pathname).toBe('/avoqado_ningunaduda_test_20261020')
    expect(target.searchParams.getAll('host')).toEqual([])
    expect(target.searchParams.getAll('hostaddr')).toEqual([])
  }
  expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL)
  expect(await prisma.$queryRaw`SELECT current_database() AS db`).toEqual([{ db: 'avoqado_ningunaduda_test_20261020' }])
  orgId = (await prisma.organization.create({ data: { name: 'D4 aislado', email: `${cuid()}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'D4 tienda', slug: cuid() } })).id
  otherVenueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'D4 otro negocio', slug: cuid() } })).id
  const provider = await prisma.paymentProvider.findUnique({ where: { code: 'ANGELPAY' } })
  ownProvider = !provider
  providerId =
    provider?.id ??
    (await prisma.paymentProvider.create({ data: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] } }))
      .id
})
beforeEach(() => jest.clearAllMocks())
afterEach(async () => {
  jest.restoreAllMocks()
  if (!venueId) return
  await prisma.providerEventLog.deleteMany({ where: { id: { in: eventIds } } })
  await prisma.venuePaymentConfig.deleteMany({ where: { venueId: { in: [venueId, otherVenueId] } } })
  await prisma.terminal.deleteMany({ where: { venueId: { in: [venueId, otherVenueId] } } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: merchantIds } } })
  await prisma.angelPayUserAccount.deleteMany({ where: { venueId: { in: [venueId, otherVenueId] } } })
  merchantIds.length = 0
  eventIds.length = 0
})
afterAll(async () => {
  if (!venueId) return
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, otherVenueId] } } })
  await prisma.organization.delete({ where: { id: orgId } })
  if (ownProvider) await prisma.paymentProvider.delete({ where: { id: providerId } })
})

async function makeLogin() {
  return prisma.angelPayUserAccount.create({ data: { venueId, email: `${cuid()}@example.test`, environment: 'QA', status: 'PENDING_PIN' } })
}
async function reserve(loginId: string) {
  const slot = await reserveAngelPaySlot({ venueId, angelpayUserAccountId: loginId })
  merchantIds.push(slot.merchantAccountId)
  return slot.merchantAccountId
}
async function discover(loginId: string, angelpayId = 198700001, skipAutoOnboarding = false) {
  try {
    return await upsertDiscoveredAngelPayMerchants({
      venueId,
      angelpayUserAccountId: loginId,
      merchants: [{ angelpayId, name: 'D4 comercio', affiliationNumber: 'D4-AF', isActive: false }],
      skipAutoOnboarding,
    })
  } finally {
    // This login is unique to this test. Include preview/new rows in scoped cleanup.
    const rows = await prisma.merchantAccount.findMany({ where: { angelpayUserAccountId: loginId }, select: { id: true }, take: 20 })
    for (const row of rows) if (!merchantIds.includes(row.id)) merchantIds.push(row.id)
  }
}

async function configMerchantIds(serialNumber: string) {
  const response = { status: jest.fn(), json: jest.fn() }
  response.status.mockReturnValue(response)
  const next = jest.fn()
  await getTerminalConfig({ params: { serialNumber } } as unknown as Request, response as unknown as Response, next)
  expect(next).not.toHaveBeenCalled()
  expect(response.status).toHaveBeenCalledWith(200)
  return response.json.mock.calls[0][0].data.merchantAccounts.map((m: { id: string }) => m.id) as string[]
}
async function existingMerchant(loginId: string, externalMerchantId = '198700011') {
  const merchant = await prisma.merchantAccount.create({
    data: { providerId, externalMerchantId, angelpayUserAccountId: loginId, credentialsEncrypted: {}, active: true },
  })
  merchantIds.push(merchant.id)
  await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: merchant.id } })
  return merchant.id
}

// Delay ONLY the first acquired PostgreSQL lock; the competing service really waits in Postgres.
function pauseFirstLock() {
  let acquired!: () => void
  let attempted!: () => void
  let release!: () => void
  const firstLocked = new Promise<void>(resolve => (acquired = resolve))
  const secondAttempted = new Promise<void>(resolve => (attempted = resolve))
  const gate = new Promise<void>(resolve => (release = resolve))
  const original = prisma.$transaction.bind(prisma)
  let locks = 0
  jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options: any) =>
    original(
      async tx => {
        const proxy = new Proxy(tx, {
          get(target, prop) {
            if (prop !== '$queryRaw') return Reflect.get(target, prop)
            return async (...args: any[]) => {
              const isLock = String(args[0]?.[0] ?? '').includes('pg_advisory_xact_lock')
              const position = isLock ? ++locks : 0
              if (position === 2) attempted()
              const result = await (target.$queryRaw as any)(...args)
              if (position === 1) {
                acquired()
                await gate
              }
              return result
            }
          },
        })
        return callback(proxy)
      },
      { ...options, timeout: 15000 },
    )) as any)
  return { firstLocked, secondAttempted, release }
}

describe('D4 identidad, reservas y carreras reales', () => {
  it('alta nueva transfiere slot y terminales de su negocio sin cambiar reserva ni salud; replay no se reapropia', async () => {
    const login = await makeLogin()
    const placeholderId = await reserve(login.id)
    const health = new Date()
    await prisma.merchantAccount.update({
      where: { id: placeholderId },
      data: {
        angelpayWebhookSecret: 'fixture-secret',
        angelpayWebhookEndpointId: 'fixture-endpoint',
        angelpayWebhookLastReceivedAt: health,
      },
    })
    const local = await prisma.terminal.create({
      data: {
        venueId,
        name: 'D4 terminal',
        serialNumber: `AVQD-${cuid()}`,
        type: 'TPV_ANDROID',
        brand: 'NEXGO',
        assignedMerchantIds: [placeholderId],
      },
    })
    const foreign = await prisma.terminal.create({
      data: {
        venueId: otherVenueId,
        name: 'D4 otra terminal',
        serialNumber: `AVQD-${cuid()}`,
        type: 'TPV_ANDROID',
        assignedMerchantIds: [placeholderId],
      },
    })
    await discover(login.id)
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ANGELPAY_RESERVATION_REPLACED', venueId }))
    const config = await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId } })
    const real = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: config.primaryAccountId } })
    expect(real.id).not.toBe(placeholderId)
    expect(real).toMatchObject({
      externalMerchantId: '198700001',
      angelpayUserAccountId: login.id,
      active: true,
      angelpayWebhookSecret: null,
      angelpayWebhookEndpointId: null,
      angelpayWebhookLastReceivedAt: null,
    })
    expect(await prisma.merchantAccount.findUniqueOrThrow({ where: { id: placeholderId } })).toMatchObject({
      active: false,
      angelpayUserAccountId: login.id,
      externalMerchantId: expect.stringMatching(/^AWAITING_/),
      angelpayWebhookSecret: 'fixture-secret',
      angelpayWebhookLastReceivedAt: health,
    })
    expect((await prisma.terminal.findUniqueOrThrow({ where: { id: local.id } })).assignedMerchantIds).toEqual([real.id])
    expect((await prisma.terminal.findUniqueOrThrow({ where: { id: foreign.id } })).assignedMerchantIds).toEqual([placeholderId])
    await discover(login.id, 198700002)
    const second = await prisma.merchantAccount.findFirstOrThrow({
      where: { angelpayUserAccountId: login.id, externalMerchantId: '198700002' },
    })
    await discover(login.id, 198700001)
    expect(logAction).toHaveBeenCalledTimes(1)
    expect((await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId } })).primaryAccountId).toBe(real.id)
    expect((await prisma.terminal.findUniqueOrThrow({ where: { id: local.id } })).assignedMerchantIds).toEqual([real.id, second.id])
  })

  it('fix1: NEXGO[A] recibe B reservado sólo en slot; consumidor real mantiene A primero y aísla otras terminales', async () => {
    const firstLogin = await makeLogin()
    const first = await existingMerchant(firstLogin.id)
    const secondLogin = await makeLogin()
    const placeholderId = await reserve(secondLogin.id)
    const local = await prisma.terminal.create({
      data: {
        venueId,
        name: 'D4 NEXGO',
        serialNumber: `AVQD-${cuid()}`,
        type: 'TPV_ANDROID',
        brand: 'NEXGO',
        assignedMerchantIds: [first],
      },
    })
    const foreign = await prisma.terminal.create({
      data: {
        venueId: otherVenueId,
        name: 'D4 ajena',
        serialNumber: `AVQD-${cuid()}`,
        type: 'TPV_ANDROID',
        brand: 'NEXGO',
        assignedMerchantIds: [first],
      },
    })
    const pax = await prisma.terminal.create({
      data: { venueId, name: 'D4 PAX', serialNumber: `AVQD-${cuid()}`, type: 'TPV_ANDROID', brand: 'PAX', assignedMerchantIds: [first] },
    })
    await discover(secondLogin.id)
    const config = await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId } })
    const second = config.secondaryAccountId!
    expect(second).not.toBe(placeholderId)
    expect(await configMerchantIds(local.serialNumber!)).toEqual([first, second])
    expect((await prisma.terminal.findUniqueOrThrow({ where: { id: foreign.id } })).assignedMerchantIds).toEqual([first])
    expect((await prisma.terminal.findUniqueOrThrow({ where: { id: pax.id } })).assignedMerchantIds).toEqual([first])
    await discover(secondLogin.id)
    expect(await configMerchantIds(local.serialNumber!)).toEqual([first, second])
    expect((await prisma.terminal.findUniqueOrThrow({ where: { id: local.id } })).assignedMerchantIds).toEqual([first, second])
    expect(await prisma.merchantAccount.findUniqueOrThrow({ where: { id: placeholderId } })).toMatchObject({
      active: false,
      externalMerchantId: expect.stringMatching(/^AWAITING_/),
    })
    expect(logAction).toHaveBeenCalledTimes(1)
  })

  it('fix1: alta sin reserva y replay existing reparan NEXGO[A] sin duplicar ni alterar orden', async () => {
    const first = await existingMerchant((await makeLogin()).id)
    const secondLogin = await makeLogin()
    const terminal = await prisma.terminal.create({
      data: {
        venueId,
        name: 'D4 NEXGO',
        serialNumber: `AVQD-${cuid()}`,
        type: 'TPV_ANDROID',
        brand: 'NEXGO',
        assignedMerchantIds: [first],
      },
    })
    await discover(secondLogin.id)
    const second = (await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId } })).secondaryAccountId!
    expect(await configMerchantIds(terminal.serialNumber!)).toEqual([first, second])
    await prisma.terminal.update({ where: { id: terminal.id }, data: { assignedMerchantIds: [first] } })
    await Promise.all([discover(secondLogin.id), discover(secondLogin.id)])
    expect(await configMerchantIds(terminal.serialNumber!)).toEqual([first, second])
    expect((await prisma.terminal.findUniqueOrThrow({ where: { id: terminal.id } })).assignedMerchantIds).toEqual([first, second])
    expect(logAction).not.toHaveBeenCalled()
  })

  it('fix1: elegibilidad conserva legacy en slot y login local sin slot; excluye login ajeno e inactivo', async () => {
    const firstLogin = await makeLogin()
    const first = await existingMerchant(firstLogin.id)
    const terminal = await prisma.terminal.create({
      data: {
        venueId,
        name: 'D4 NEXGO',
        serialNumber: `AVQD-${cuid()}`,
        type: 'TPV_ANDROID',
        brand: 'NEXGO',
        assignedMerchantIds: [first],
      },
    })
    const legacy = await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: '198700012', credentialsEncrypted: {}, active: true },
    })
    merchantIds.push(legacy.id)
    await prisma.venuePaymentConfig.update({ where: { venueId }, data: { secondaryAccountId: legacy.id } })
    const local = await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: '198700013', angelpayUserAccountId: firstLogin.id, credentialsEncrypted: {}, active: true },
    })
    merchantIds.push(local.id)
    const foreignLogin = await prisma.angelPayUserAccount.create({
      data: { venueId: otherVenueId, email: `${cuid()}@example.test`, environment: 'QA', status: 'ACTIVE' },
    })
    const foreign = await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: '198700014', angelpayUserAccountId: foreignLogin.id, credentialsEncrypted: {}, active: true },
    })
    const inactive = await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: '198700015', angelpayUserAccountId: firstLogin.id, credentialsEncrypted: {}, active: false },
    })
    merchantIds.push(foreign.id, inactive.id)
    await discover(firstLogin.id, 198700011)
    expect(await configMerchantIds(terminal.serialNumber!)).toEqual([first, legacy.id, local.id])
    expect((await prisma.terminal.findUniqueOrThrow({ where: { id: terminal.id } })).assignedMerchantIds).toEqual([
      first,
      legacy.id,
      local.id,
    ])
    expect(logAction).not.toHaveBeenCalled()
  })

  it('fix1: preview inactiva sin reserva permanece fuera del array y del consumidor real', async () => {
    const first = await existingMerchant((await makeLogin()).id)
    const previewLogin = await makeLogin()
    const terminal = await prisma.terminal.create({
      data: {
        venueId,
        name: 'D4 NEXGO',
        serialNumber: `AVQD-${cuid()}`,
        type: 'TPV_ANDROID',
        brand: 'NEXGO',
        assignedMerchantIds: [first],
      },
    })
    await discover(previewLogin.id, 198700001, true)
    const preview = await prisma.merchantAccount.findFirstOrThrow({
      where: { angelpayUserAccountId: previewLogin.id, externalMerchantId: '198700001' },
    })
    expect(preview.active).toBe(false)
    expect(await configMerchantIds(terminal.serialNumber!)).toEqual([first])
    expect((await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId } })).secondaryAccountId).toBeNull()
    expect((await prisma.terminal.findUniqueOrThrow({ where: { id: terminal.id } })).assignedMerchantIds).toEqual([first])
  })

  it('fallo en SEGUNDA escritura revierte nueva fila + slot + terminal; reserva queda intacta', async () => {
    const login = await makeLogin()
    const placeholderId = await reserve(login.id)
    const terminal = await prisma.terminal.create({
      data: { venueId, name: 'D4 terminal', serialNumber: `AVQD-${cuid()}`, type: 'TPV_ANDROID', assignedMerchantIds: [placeholderId] },
    })
    const original = prisma.$transaction.bind(prisma)
    let createdInTransaction = false
    jest.spyOn(prisma, '$transaction').mockImplementationOnce(((callback: any) =>
      original(async tx => {
        const proxy = new Proxy(tx, {
          get(target, prop) {
            if (prop !== 'venuePaymentConfig') return Reflect.get(target, prop)
            return {
              ...target.venuePaymentConfig,
              update: async () => {
                createdInTransaction =
                  (await tx.merchantAccount.count({ where: { angelpayUserAccountId: login.id, externalMerchantId: '198700001' } })) === 1
                throw new Error('D4 simulated SECOND write failure')
              },
            }
          },
        })
        return callback(proxy)
      })) as any)
    await expect(discover(login.id)).rejects.toThrow('D4 simulated SECOND write failure')
    expect(createdInTransaction).toBe(true)
    expect(logAction).not.toHaveBeenCalled()
    expect(await prisma.merchantAccount.count({ where: { angelpayUserAccountId: login.id, externalMerchantId: '198700001' } })).toBe(0)
    expect((await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId } })).primaryAccountId).toBe(placeholderId)
    expect((await prisma.terminal.findUniqueOrThrow({ where: { id: terminal.id } })).assignedMerchantIds).toEqual([placeholderId])
  })

  it('vínculo gana la carrera: borrador ya enlazado rechaza edición sin cambiar correo', async () => {
    const login = await makeLogin()
    const gate = pauseFirstLock()
    const linking = reserve(login.id)
    let editing: Promise<unknown> | undefined
    try {
      await gate.firstLocked
      editing = updateAngelPayUserAccountCredentials(login.id, { email: 'cambio@example.test' }).catch(error => error)
      await gate.secondAttempted
    } finally {
      gate.release()
    }
    await linking
    expect(await editing).toMatchObject(immutable)
    expect((await prisma.angelPayUserAccount.findUniqueOrThrow({ where: { id: login.id } })).email).toBe(login.email)
  })

  it('vínculo gana la carrera: DELETE cascade no despega cuenta recién enlazada', async () => {
    const login = await makeLogin()
    const gate = pauseFirstLock()
    const linking = reserve(login.id)
    let deleting: Promise<unknown> | undefined
    try {
      await gate.firstLocked
      deleting = hardDeleteAngelPayUserAccount(login.id, 'fixture-admin', { cascadeMerchants: true }).catch(error => error)
      await gate.secondAttempted
    } finally {
      gate.release()
    }
    const id = await linking
    expect(await deleting).toMatchObject(immutable)
    expect((await prisma.merchantAccount.findUniqueOrThrow({ where: { id } })).angelpayUserAccountId).toBe(login.id)
  })

  it('DELETE gana la carrera: un vínculo tardío no revive ni deja huérfano el login borrado', async () => {
    const login = await makeLogin()
    const gate = pauseFirstLock()
    const deleting = hardDeleteAngelPayUserAccount(login.id, 'fixture-admin', { cascadeMerchants: true })
    let linking: Promise<unknown> | undefined
    try {
      await gate.firstLocked
      linking = reserve(login.id).catch(error => error)
      await gate.secondAttempted
    } finally {
      gate.release()
    }
    await expect(deleting).resolves.toMatchObject({ deletedAccountId: login.id, detachedMerchantIds: [] })
    expect(await linking).toMatchObject({ statusCode: 422 })
    expect(await prisma.angelPayUserAccount.findUnique({ where: { id: login.id } })).toBeNull()
    expect(await prisma.merchantAccount.count({ where: { angelpayUserAccountId: login.id } })).toBe(0)
  })

  it('alta inline reactiva MISMA identidad, renueva PIN y crea otra fila sin mover la anterior', async () => {
    const login = await makeLogin()
    await prisma.angelPayUserAccount.update({ where: { id: login.id }, data: { status: 'DELETED', externalUserId: 79 } })
    const old = await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: '198700007', angelpayUserAccountId: login.id, credentialsEncrypted: {}, active: false },
    })
    merchantIds.push(old.id)
    const result = await fullSetupAngelPayMerchant({
      venueId,
      login: { mode: 'new', email: login.email, environment: 'QA', pin: '654321' },
      merchant: { mode: 'create', externalMerchantId: '198700008', name: 'Nueva', affiliation: 'D4-AF', displayName: 'Nueva' },
      slot: { accountType: 'PRIMARY', mode: 'fill' },
    })
    merchantIds.push(result.merchantAccountId)
    expect(result.angelpayUserAccountId).toBe(login.id)
    expect(result.merchantAccountId).not.toBe(old.id)
    expect(await prisma.angelPayUserAccount.findUniqueOrThrow({ where: { id: login.id } })).toMatchObject({
      email: login.email,
      environment: 'QA',
      externalUserId: 79,
      pin: '654321',
    })
    expect(await prisma.merchantAccount.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      externalMerchantId: '198700007',
      angelpayUserAccountId: login.id,
      active: false,
    })
  })

  it('dos validaciones concurrentes fijan un único externalUserId y no lo pisan', async () => {
    const login = await makeLogin()
    const results = await Promise.allSettled([
      markAngelPayUserAccountValidated(login.id, 71),
      markAngelPayUserAccountValidated(login.id, 72),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const loser = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect(loser.reason).toMatchObject(immutable)
    const learned = await prisma.angelPayUserAccount.findUniqueOrThrow({ where: { id: login.id } })
    expect([71, 72]).toContain(learned.externalUserId)
    await expect(markAngelPayUserAccountValidated(login.id, learned.externalUserId!)).resolves.toMatchObject({
      externalUserId: learned.externalUserId,
    })
  })

  it('evento PENDING sin Payment conserva receptor desactivado; worker resuelve la cuenta anterior', async () => {
    const login = await makeLogin()
    const merchant = await prisma.merchantAccount.create({
      data: { providerId, externalMerchantId: '198700009', angelpayUserAccountId: login.id, credentialsEncrypted: {}, active: true },
    })
    merchantIds.push(merchant.id)
    const claimToken = cuid()
    const event = await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        type: 'send_transaction',
        eventId: `angelpay-${cuid()}`,
        venueId,
        status: 'PENDING',
        claimToken,
        attempts: 1,
        payload: {
          event_type: 'send_transaction',
          payload: { status: null },
          _avoqado: { receivedByMerchantAccountId: merchant.id },
        },
      },
    })
    eventIds.push(event.id)
    expect(await prisma.payment.count({ where: { merchantAccountId: merchant.id } })).toBe(0)
    await updateMerchantAccount(merchant.id, { active: false })
    expect((await getMerchantAccountBlockers(merchant.id)).canDelete).toBe(false)
    await expect(deleteMerchantAccount(merchant.id)).rejects.toMatchObject({ code: 'ANGELPAY_ACCOUNT_PRESERVED' })
    await setAngelPayUserAccountPin(login.id, '123456')
    const next = await fullSetupAngelPayMerchant({
      venueId,
      login: { mode: 'existing', angelpayUserAccountId: login.id },
      merchant: { mode: 'create', externalMerchantId: '198700010', name: 'Nueva', affiliation: 'D4-AF', displayName: 'Nueva' },
      slot: { accountType: 'PRIMARY', mode: 'fill' },
    })
    merchantIds.push(next.merchantAccountId)
    expect(next.merchantAccountId).not.toBe(merchant.id)
    expect(
      await runClaimedAngelPayEvent({
        id: event.id,
        eventId: event.eventId!,
        payload: event.payload,
        venueId,
        claimToken,
        attempts: 1,
        leaseUntil: new Date(Date.now() + 10000),
      }),
    ).toBe('PENDING')
    expect(await prisma.providerEventLog.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      errorReason: 'INVALID_STATUS',
      payload: { _avoqado: { receivedByMerchantAccountId: merchant.id } },
    })
    expect(await prisma.merchantAccount.findUniqueOrThrow({ where: { id: merchant.id } })).toMatchObject({
      active: false,
      externalMerchantId: '198700009',
      angelpayUserAccountId: login.id,
    })
  })
})

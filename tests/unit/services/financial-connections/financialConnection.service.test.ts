const clientMock = {
  connect: jest.fn(), validateDevice: jest.fn(), refresh: jest.fn(),
  revoke: jest.fn(), listAccounts: jest.fn(), getBalance: jest.fn(),
}
jest.mock('@/services/financial-connections/registry', () => ({
  getFinancialProviderClient: () => clientMock,
}))
// prisma mock mínimo (financialConnection/financialAccount/$transaction/$executeRaw)
const db: any = {}
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: db }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import * as svc from '@/services/financial-connections/financialConnection.service'

beforeAll(() => {
  process.env.FINANCIAL_CONNECTION_KEY = 'a'.repeat(64)
})

beforeEach(() => {
  jest.clearAllMocks()
  db.financialProvider = { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'prov-1', code: 'EXTERNAL_BANK' }) }
  db.financialConnection = { create: jest.fn(), update: jest.fn(), findUniqueOrThrow: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() }
  db.financialAccount = { createMany: jest.fn(), findUniqueOrThrow: jest.fn(), findFirst: jest.fn(), update: jest.fn() }
  db.$transaction = jest.fn(async (fn: any) => fn(db))
  db.$executeRaw = jest.fn()
})

const encFixture = () => {
  // Lazy import so FINANCIAL_CONNECTION_KEY (set in beforeAll) is present when
  // the crypto module's lazy cipher is first constructed.
  const { encryptGrant } = require('@/services/financial-connections/crypto')
  return encryptGrant({ refreshToken: 'r1' })
}

it('startConnection: single negocio → auto-selects, CONNECTED', async () => {
  db.financialConnection.create.mockResolvedValue({ id: 'c1', deviceIdentifier: 'dev-c1' })
  clientMock.connect.mockResolvedValue({ kind: 'connected', grant: { refreshToken: 'r1' },
    accounts: [{ externalId: 'neg-1', label: 'Centro', clabe: '01', active: true, balance: 100 }] })
  const r = await svc.startConnection({ venueId: 'v1', providerId: 'prov-1', email: 'a@b.co', password: 'p' })
  expect(r.status).toBe('CONNECTED')
  expect(db.financialAccount.createMany).toHaveBeenCalled()
})

it('startConnection: several negocios → PENDING_ACCOUNT_SELECTION with options', async () => {
  db.financialConnection.create.mockResolvedValue({ id: 'c2', deviceIdentifier: 'dev-c2' })
  clientMock.connect.mockResolvedValue({ kind: 'connected', grant: { refreshToken: 'r' },
    accounts: [{ externalId: 'neg-1' }, { externalId: 'neg-2' }] })
  const r = await svc.startConnection({ venueId: 'v1', providerId: 'prov-1', email: 'a@b.co', password: 'p' })
  expect(r.status).toBe('PENDING_ACCOUNT_SELECTION')
  expect(r.accountOptions?.length).toBe(2)
})

it('startConnection: needDeviceValidation → stores challenge, PENDING_DEVICE_VALIDATION', async () => {
  db.financialConnection.create.mockResolvedValue({ id: 'c3', deviceIdentifier: 'dev-c3' })
  clientMock.connect.mockResolvedValue({ kind: 'need_device_validation', challenge: { accessToken: 't', processId: 'p9' } })
  const r = await svc.startConnection({ venueId: 'v1', providerId: 'prov-1', email: 'a@b.co', password: 'p' })
  expect(r.status).toBe('PENDING_DEVICE_VALIDATION')
  const upd = db.financialConnection.update.mock.calls.at(-1)[0].data
  expect(upd.challengeEnc).toBeTruthy()
  expect(JSON.stringify(upd)).not.toContain('p9') // el processId va cifrado, no en claro
})

it('selectAccount: rejects an externalId not in the stored options', async () => {
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({
    id: 'c2', status: 'PENDING_ACCOUNT_SELECTION',
    accounts: [{ id: 'fa1', externalId: 'neg-1' }, { id: 'fa2', externalId: 'neg-2' }],
  })
  await expect(svc.selectAccount('c2', 'neg-999')).rejects.toThrow()
})

it('getBalanceForConnectionAccount: provider null saldo → state ERROR, not OK', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa1', externalId: 'neg-1',
    connection: { id: 'c1', mode: 'SELF_CONNECT', grantEnc: encFixture(), tokenVersion: 0, deviceIdentifier: 'dev', provider: { code: 'EXTERNAL_BANK' } },
  })
  // accessTokenFor() re-reads the connection under the advisory lock (protects against a
  // concurrent refresh that landed while we waited for the lock) — the mock must reflect
  // the same row (grantEnc/tokenVersion) the fast-path check already saw.
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'c1', grantEnc: encFixture(), tokenVersion: 0 })
  db.financialConnection.update.mockResolvedValue({})
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.getBalance.mockResolvedValue({ amount: null, currency: 'MXN', active: true, providerAccountLabel: 'X' })
  const r = await svc.getBalanceForConnectionAccount('fa1')
  expect(r.state).toBe('ERROR')
  expect(r.amount).toBeNull()
})

it('refresh path takes the advisory lock (pg_advisory_xact_lock) inside a tx', async () => {
  // Distinct connection/account ids from the previous test — the service keeps an
  // in-memory tokenCache keyed by connectionId that outlives a single it() block
  // (it's a module-level singleton, by design, for the real fast-path). Reusing
  // 'c1' here would let this test silently hit that cache instead of the lock path.
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa2', externalId: 'neg-1',
    connection: { id: 'c4', mode: 'SELF_CONNECT', grantEnc: encFixture(), tokenVersion: 0, deviceIdentifier: 'dev', provider: { code: 'EXTERNAL_BANK' } },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'c4', grantEnc: encFixture(), tokenVersion: 0 })
  db.financialConnection.update.mockResolvedValue({})
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.getBalance.mockResolvedValue({ amount: 10, currency: 'MXN', active: true, providerAccountLabel: 'X' })
  await svc.getBalanceForConnectionAccount('fa2')
  expect(db.$transaction).toHaveBeenCalled()
  expect(db.$executeRaw).toHaveBeenCalled() // pg_advisory_xact_lock(...)
})

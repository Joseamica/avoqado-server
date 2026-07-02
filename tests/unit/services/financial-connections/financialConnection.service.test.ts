const clientMock = {
  connect: jest.fn(),
  validateDevice: jest.fn(),
  validateTwoFactorCode: jest.fn(),
  refresh: jest.fn(),
  revoke: jest.fn(),
  listAccounts: jest.fn(),
  getBalance: jest.fn(),
  listMovements: jest.fn(),
  getMovementStats: jest.fn(),
}
jest.mock('@/services/financial-connections/registry', () => ({
  getFinancialProviderClient: () => clientMock,
}))
// prisma mock mínimo (financialConnection/financialAccount/$transaction/$executeRaw)
const db: any = {}
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: db }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import * as svc from '@/services/financial-connections/financialConnection.service'
import { logAction } from '@/services/dashboard/activity-log.service'

beforeAll(() => {
  process.env.FINANCIAL_CONNECTION_KEY = 'a'.repeat(64)
})

beforeEach(() => {
  jest.clearAllMocks()
  db.financialProvider = { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'prov-1', code: 'EXTERNAL_BANK' }) }
  db.financialConnection = {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
  }
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
const enc2faFixture = () => {
  const { encryptGrant } = require('@/services/financial-connections/crypto')
  // El blob 2FA deliberadamente NO incluye password (retención mínima).
  return encryptGrant({ accessToken: 'tmp-2fa', email: 'a@b.co' })
}

it('startConnection: single negocio → auto-selects, CONNECTED', async () => {
  db.financialConnection.create.mockResolvedValue({ id: 'c1', deviceIdentifier: 'dev-c1' })
  clientMock.connect.mockResolvedValue({
    kind: 'connected',
    grant: { refreshToken: 'r1' },
    accounts: [{ externalId: 'neg-1', cuentaId: 'cta-1', label: 'Centro', clabe: '01', active: true, balance: 100 }],
  })
  const r = await svc.startConnection({ venueId: 'v1', providerId: 'prov-1', email: 'a@b.co', password: 'p' })
  expect(r.status).toBe('CONNECTED')
  expect(db.financialAccount.createMany).toHaveBeenCalled()
  const args = db.financialAccount.createMany.mock.calls.at(-1)[0]
  expect(args.data[0].externalCuentaId).toBe('cta-1')
  expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'FINANCIAL_CONNECTION_STARTED', entityId: 'c1' }))
})

it('startConnection: connect() throws → marks the row ERROR with lastError instead of orphaning it, still rejects', async () => {
  db.financialConnection.create.mockResolvedValue({ id: 'c-bad', deviceIdentifier: 'dev-c-bad' })
  clientMock.connect.mockRejectedValue(new Error('Este usuario no tiene una cuenta.'))
  await expect(svc.startConnection({ venueId: 'v1', providerId: 'prov-1', email: 'bad@b.co', password: 'wrong' })).rejects.toThrow(
    'Este usuario no tiene una cuenta.',
  )
  expect(db.financialConnection.update).toHaveBeenCalledWith({
    where: { id: 'c-bad' },
    data: { status: 'ERROR', lastError: 'Este usuario no tiene una cuenta.' },
  })
  expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'FINANCIAL_CONNECTION_FAILED', entityId: 'c-bad' }))
})

it('startConnection: several negocios → PENDING_ACCOUNT_SELECTION with options', async () => {
  db.financialConnection.create.mockResolvedValue({ id: 'c2', deviceIdentifier: 'dev-c2' })
  clientMock.connect.mockResolvedValue({
    kind: 'connected',
    grant: { refreshToken: 'r' },
    accounts: [{ externalId: 'neg-1' }, { externalId: 'neg-2' }],
  })
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

it('startConnection: needTwoFactorAuth → stores challenge WITHOUT the password, PENDING_TWO_FACTOR_AUTH', async () => {
  db.financialConnection.create.mockResolvedValue({ id: 'c4', deviceIdentifier: 'dev-c4' })
  clientMock.connect.mockResolvedValue({ kind: 'need_two_factor_auth', challenge: { accessToken: 'tmp-2fa' } })
  const r = await svc.startConnection({ venueId: 'v1', providerId: 'prov-1', email: 'a@b.co', password: 'super-secret' })
  expect(r.status).toBe('PENDING_TWO_FACTOR_AUTH')
  const { decryptGrant } = require('@/services/financial-connections/crypto')
  const upd = db.financialConnection.update.mock.calls.at(-1)[0].data
  const blob = decryptGrant(upd.challengeEnc)
  expect(blob).toEqual({ accessToken: 'tmp-2fa', email: 'a@b.co' }) // sin password: validate-2fa no lo necesita
})

it('validateDevice/2FA: expired challenge is wiped from the row, not left encrypted forever', async () => {
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({
    id: 'c5',
    deviceIdentifier: 'dev-c5',
    venueId: 'v1',
    provider: { code: 'EXTERNAL_BANK' },
    challengeEnc: enc2faFixture(),
    challengeExpiresAt: new Date(Date.now() - 1_000),
  })
  await expect(svc.validateTwoFactorAuth('c5', '123456')).rejects.toThrow('expiró')
  expect(db.financialConnection.update).toHaveBeenCalledWith({
    where: { id: 'c5' },
    data: { challengeEnc: null, challengeExpiresAt: null },
  })
})

it('validateTwoFactorAuth: valid code → CONNECTED', async () => {
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({
    id: 'c4',
    deviceIdentifier: 'dev-c4',
    provider: { code: 'EXTERNAL_BANK' },
    challengeEnc: enc2faFixture(),
    challengeExpiresAt: new Date(Date.now() + 60_000),
  })
  clientMock.validateTwoFactorCode.mockResolvedValue({
    kind: 'connected',
    grant: { refreshToken: 'ref-x' },
    accounts: [{ externalId: 'neg-1' }],
  })
  const r = await svc.validateTwoFactorAuth('c4', '123456', 'staff-1')
  expect(r.status).toBe('CONNECTED')
  expect(logAction).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'FINANCIAL_CONNECTION_TWO_FACTOR_VALIDATED', staffId: 'staff-1', entityId: 'c4' }),
  )
})

it('selectAccount: rejects an externalId not in the stored options, logs FINANCIAL_CONNECTION_FAILED', async () => {
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({
    id: 'c2',
    status: 'PENDING_ACCOUNT_SELECTION',
    venueId: 'v1',
    accounts: [
      { id: 'fa1', externalId: 'neg-1' },
      { id: 'fa2', externalId: 'neg-2' },
    ],
  })
  await expect(svc.selectAccount('c2', 'neg-999')).rejects.toThrow()
  expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'FINANCIAL_CONNECTION_FAILED', entityId: 'c2' }))
})

it('getBalanceForConnectionAccount: provider null saldo → state ERROR, not OK', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa1',
    externalId: 'neg-1',
    connection: {
      id: 'c1',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      provider: { code: 'EXTERNAL_BANK' },
    },
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

it('selectAccount: rejects on a revoked connection (no resurrection to CONNECTED)', async () => {
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({
    id: 'c7',
    status: 'REVOKED',
    venueId: 'v1',
    accounts: [{ id: 'fa1', externalId: 'neg-1' }],
  })
  await expect(svc.selectAccount('c7', 'neg-1')).rejects.toThrow('no está activa')
  expect(db.financialConnection.update).not.toHaveBeenCalled()
})

it('refresh guard: a connection revoked before the lock re-read is never refreshed nor resurrected', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa9',
    externalId: 'neg-1',
    currency: 'MXN',
    lastSyncedAt: null,
    connection: {
      id: 'c9',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 3,
      deviceIdentifier: 'dev',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  // La re-lectura BAJO el lock ve el disconnect que ganó la carrera:
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'c9', status: 'REVOKED', grantEnc: null, tokenVersion: 4 })
  const r = await svc.getBalanceForConnectionAccount('fa9')
  expect(r.state).toBe('ERROR')
  expect(clientMock.refresh).not.toHaveBeenCalled() // jamás rotó el token de una fila revocada
  expect(db.financialConnection.update).not.toHaveBeenCalled() // jamás re-persistió CONNECTED
  // El downgrade del catch va filtrado por status — no pisa REVOKED:
  expect(db.financialConnection.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ status: { in: ['CONNECTED', 'NEEDS_REAUTH'] } }) }),
  )
})

it('getMovementsForAccount: usa externalCuentaId y delega al client', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa1', externalId: 'neg-1', externalCuentaId: 'cta-1',
    connection: { id: 'cm-1', mode: 'SELF_CONNECT', grantEnc: encFixture(), tokenVersion: 0, deviceIdentifier: 'dev', status: 'CONNECTED', provider: { code: 'EXTERNAL_BANK' } },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-1', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listMovements.mockResolvedValue({ movements: [], total: 0 })
  const r = await svc.getMovementsForAccount('fa1', { page: 0, size: 10 })
  expect(clientMock.listMovements).toHaveBeenCalledWith(expect.objectContaining({ accessToken: expect.any(String) }), 'cta-1', { page: 0, size: 10 })
  expect(r.total).toBe(0)
})

it('getMovementsForAccount: backfillea externalCuentaId perezosamente cuando es null (fila pre-columna)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa2', externalId: 'neg-1', externalCuentaId: null,
    connection: { id: 'cm-2', mode: 'SELF_CONNECT', grantEnc: encFixture(), tokenVersion: 0, deviceIdentifier: 'dev', status: 'CONNECTED', provider: { code: 'EXTERNAL_BANK' } },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-2', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listAccounts.mockResolvedValue([{ externalId: 'neg-1', cuentaId: 'cta-9', label: null, clabe: null, active: null, balance: null }])
  clientMock.listMovements.mockResolvedValue({ movements: [], total: 0 })
  await svc.getMovementsForAccount('fa2', { page: 0, size: 10 })
  expect(db.financialAccount.update).toHaveBeenCalledWith({ where: { id: 'fa2' }, data: { externalCuentaId: 'cta-9' } })
  expect(clientMock.listMovements).toHaveBeenCalledWith(expect.anything(), 'cta-9', expect.anything())
})

it('getMovementsForAccount: si el provider no reporta cuentaId → BadRequest, no 500', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa3', externalId: 'neg-x', externalCuentaId: null,
    connection: { id: 'cm-3', mode: 'SELF_CONNECT', grantEnc: encFixture(), tokenVersion: 0, deviceIdentifier: 'dev', status: 'CONNECTED', provider: { code: 'EXTERNAL_BANK' } },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-3', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listAccounts.mockResolvedValue([])
  await expect(svc.getMovementsForAccount('fa3', { page: 0, size: 10 })).rejects.toThrow()
})

it('getMovementsForAccount: token/provider muere → degrada la conexión a NEEDS_REAUTH y lanza 400 honesto (no 500 crudo)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-mov-err', externalId: 'neg-1', externalCuentaId: 'cta-1',
    connection: { id: 'cm-moverr', mode: 'SELF_CONNECT', grantEnc: encFixture(), tokenVersion: 0, deviceIdentifier: 'dev', status: 'CONNECTED', provider: { code: 'EXTERNAL_BANK' } },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-moverr', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  // El refresh silencioso truena (bug de QPay con 2FA cuando el token cacheado murió).
  clientMock.refresh.mockRejectedValue(new Error('Request failed with status code 400'))
  const { BadRequestError } = require('@/errors/AppError')
  await expect(svc.getMovementsForAccount('fa-mov-err', { page: 0, size: 10 })).rejects.toBeInstanceOf(BadRequestError)
  // Degradó la conexión operante a NEEDS_REAUTH (filtrado por status) → la UI muestra "Reconectar".
  expect(db.financialConnection.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ status: { in: ['CONNECTED', 'NEEDS_REAUTH'] } }), data: expect.objectContaining({ status: 'NEEDS_REAUTH' }) }),
  )
  expect(clientMock.listMovements).not.toHaveBeenCalled()
})

it('refresh path takes the advisory lock (pg_advisory_xact_lock) inside a tx', async () => {
  // Distinct connection/account ids from the previous test — the service keeps an
  // in-memory tokenCache keyed by connectionId that outlives a single it() block
  // (it's a module-level singleton, by design, for the real fast-path). Reusing
  // 'c1' here would let this test silently hit that cache instead of the lock path.
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa2',
    externalId: 'neg-1',
    connection: {
      id: 'c4',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'c4', grantEnc: encFixture(), tokenVersion: 0 })
  db.financialConnection.update.mockResolvedValue({})
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.getBalance.mockResolvedValue({ amount: 10, currency: 'MXN', active: true, providerAccountLabel: 'X' })
  await svc.getBalanceForConnectionAccount('fa2')
  expect(db.$transaction).toHaveBeenCalled()
  expect(db.$executeRaw).toHaveBeenCalled() // pg_advisory_xact_lock(...)
})

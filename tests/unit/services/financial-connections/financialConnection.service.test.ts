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
  resolveAltAccount: jest.fn(),
  internalTransfer: jest.fn(),
  getExternalUserId: jest.fn(),
  listSpeiBanks: jest.fn(),
  sendSpeiOut: jest.fn(),
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
  // count: usado por el guard de SPEI (conexiones de UNA cuenta) — default 1 (caso normal).
  db.financialAccount = {
    createMany: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    count: jest.fn().mockResolvedValue(1),
  }
  // Dedup de traspasos internos lee ActivityLog: por defecto vacío (sin traspaso previo).
  db.activityLog = { findMany: jest.fn().mockResolvedValue([]) }
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

it('startConnection: accountKind CLIENT se persiste en la fila y externalClientId/externalDeviceId del provider llegan al update de conectado', async () => {
  db.financialConnection.create.mockResolvedValue({ id: 'c-cl', deviceIdentifier: 'dev-c-cl' })
  clientMock.connect.mockResolvedValue({
    kind: 'connected',
    grant: { refreshToken: 'r1' },
    accounts: [],
    accessToken: 't',
    externalClientId: 'mg-1',
    externalDeviceId: 'disp-1',
  })
  const r = await svc.startConnection({ venueId: 'v1', providerId: 'prov-1', email: 'a@b.co', password: 'p', accountKind: 'CLIENT' })
  expect(r.status).toBe('CONNECTED')
  // La fila nace con el kind elegido — única fuente de verdad (decisión 3A).
  expect(db.financialConnection.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ accountKind: 'CLIENT' }) }),
  )
  // El client recibe el kind para branchear sign-in/cuentas.
  expect(clientMock.connect).toHaveBeenCalledWith(expect.objectContaining({ accountKind: 'CLIENT' }))
  // finishConnected persiste el id de usuario del proveedor Y el idDispositivo devueltos por el provider —
  // el segundo es la llave para descifrar el envelope del cliente en lecturas post-connect.
  const upd = db.financialConnection.update.mock.calls.at(-1)[0].data
  expect(upd.externalClientId).toBe('mg-1')
  expect(upd.externalDeviceId).toBe('disp-1')
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
  // sin password: validate-2fa no lo necesita. externalClientId/externalDeviceId viajan null en MERCHANT (cosmético).
  expect(blob).toEqual({ accessToken: 'tmp-2fa', email: 'a@b.co', externalClientId: null, externalDeviceId: null })
  expect(blob.password).toBeUndefined()
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
    id: 'fa1',
    externalId: 'neg-1',
    externalCuentaId: 'cta-1',
    connection: {
      id: 'cm-1',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-1', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listMovements.mockResolvedValue({ movements: [], total: 0 })
  const r = await svc.getMovementsForAccount('fa1', { page: 0, size: 10 })
  // (ctx, idNegocio='neg-1', cuentaId='cta-1', query)
  expect(clientMock.listMovements).toHaveBeenCalledWith(expect.objectContaining({ accessToken: expect.any(String) }), 'neg-1', 'cta-1', {
    page: 0,
    size: 10,
  })
  expect(r.total).toBe(0)
})

it('getMovementsForAccount: backfillea externalCuentaId perezosamente cuando es null (fila pre-columna)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa2',
    externalId: 'neg-1',
    externalCuentaId: null,
    connection: {
      id: 'cm-2',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-2', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listAccounts.mockResolvedValue([
    { externalId: 'neg-1', cuentaId: 'cta-9', label: null, clabe: null, active: null, balance: null },
  ])
  clientMock.listMovements.mockResolvedValue({ movements: [], total: 0 })
  await svc.getMovementsForAccount('fa2', { page: 0, size: 10 })
  expect(db.financialAccount.update).toHaveBeenCalledWith({ where: { id: 'fa2' }, data: { externalCuentaId: 'cta-9' } })
  expect(clientMock.listMovements).toHaveBeenCalledWith(expect.anything(), 'neg-1', 'cta-9', expect.anything())
})

it('getMovementsForAccount: si el provider no reporta cuentaId → BadRequest, no 500', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa3',
    externalId: 'neg-x',
    externalCuentaId: null,
    connection: {
      id: 'cm-3',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-3', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listAccounts.mockResolvedValue([])
  await expect(svc.getMovementsForAccount('fa3', { page: 0, size: 10 })).rejects.toThrow()
})

it('getMovementsForAccount: token/provider muere → degrada la conexión a NEEDS_REAUTH y lanza 400 honesto (no 500 crudo)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-mov-err',
    externalId: 'neg-1',
    externalCuentaId: 'cta-1',
    connection: {
      id: 'cm-moverr',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({
    id: 'cm-moverr',
    grantEnc: encFixture(),
    tokenVersion: 0,
    status: 'CONNECTED',
  })
  // El refresh silencioso truena (bug del proveedor con 2FA cuando el token cacheado murió).
  clientMock.refresh.mockRejectedValue(new Error('Request failed with status code 400'))
  const { BadRequestError } = require('@/errors/AppError')
  await expect(svc.getMovementsForAccount('fa-mov-err', { page: 0, size: 10 })).rejects.toBeInstanceOf(BadRequestError)
  // Degradó la conexión operante a NEEDS_REAUTH (filtrado por status) → la UI muestra "Reconectar".
  expect(db.financialConnection.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['CONNECTED', 'NEEDS_REAUTH'] } }),
      data: expect.objectContaining({ status: 'NEEDS_REAUTH' }),
    }),
  )
  expect(clientMock.listMovements).not.toHaveBeenCalled()
})

it('sendInternalTransfer: resuelve origen (altId) + destino y ejecuta el traspaso, auditando', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-tr',
    externalId: 'neg-1',
    connection: {
      id: 'cm-tr',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      venueId: 'v1',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-tr', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listAccounts.mockResolvedValue([
    { externalId: 'neg-1', altId: 10, cuentaId: 'c', label: null, clabe: null, active: null, balance: null },
  ])
  clientMock.resolveAltAccount.mockResolvedValue({ altId: 20, name: 'Destino', accountType: 'wallet' })
  clientMock.internalTransfer.mockResolvedValue({ ok: true, movementId: 'mov-9', message: 'OK' })
  const r = await svc.sendInternalTransfer('fa-tr', { destAccountNumber: '155525', amount: 1, concept: 'Prueba', staffId: 'staff-1' })
  expect(clientMock.internalTransfer).toHaveBeenCalledWith(expect.anything(), {
    sourceAltId: 10,
    destAltId: 20,
    amount: 1,
    concept: 'Prueba',
  })
  expect(r.ok).toBe(true)
  expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'FINANCIAL_INTERNAL_TRANSFER', entityId: 'fa-tr' }))
})

it('sendInternalTransfer: origen sin altId → BadRequest y NO intenta enviar', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-tr2',
    externalId: 'neg-1',
    connection: {
      id: 'cm-tr2',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      venueId: 'v1',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-tr2', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listAccounts.mockResolvedValue([
    { externalId: 'neg-1', altId: null, cuentaId: 'c', label: null, clabe: null, active: null, balance: null },
  ])
  await expect(svc.sendInternalTransfer('fa-tr2', { destAccountNumber: '155525', amount: 1, concept: '' })).rejects.toThrow()
  expect(clientMock.internalTransfer).not.toHaveBeenCalled()
})

it('sendInternalTransfer: monto <= 0 → BadRequest (ni siquiera toca al proveedor)', async () => {
  await expect(svc.sendInternalTransfer('fa-x', { destAccountNumber: '155525', amount: 0, concept: '' })).rejects.toThrow('mayor a 0')
})

it('sendInternalTransfer: dedup — un traspaso idéntico reciente NO se reenvía (no toca al proveedor, devuelve el previo)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-dup',
    externalId: 'neg-1',
    connection: {
      id: 'cm-dup',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      venueId: 'v1',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  // Auditoría previa: mismo destino (155525) + mismo monto (1) hace instantes.
  db.activityLog.findMany.mockResolvedValue([
    { data: { destAccount: '155525', amount: 1, ok: true, movementId: 'mov-prev', message: 'OK' } },
  ])
  const r = await svc.sendInternalTransfer('fa-dup', { destAccountNumber: '155525', amount: 1, concept: 'Prueba' })
  expect(clientMock.internalTransfer).not.toHaveBeenCalled() // jamás reenvió al proveedor
  expect(clientMock.listAccounts).not.toHaveBeenCalled() // corta antes de resolver origen/destino
  expect(r.ok).toBe(true)
  expect(r.movementId).toBe('mov-prev') // devuelve el resultado del traspaso original
  // No re-audita un envío que no ocurrió.
  expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'FINANCIAL_INTERNAL_TRANSFER' }))
})

it('sendInternalTransfer: destino/monto DISTINTO a lo reciente NO se deduplica (sí envía)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-nd',
    externalId: 'neg-1',
    connection: {
      id: 'cm-nd',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      venueId: 'v1',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-nd', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  // Reciente fue a 155525 monto 1; este va a la MISMA cuenta pero monto 2 → no es el mismo traspaso.
  db.activityLog.findMany.mockResolvedValue([
    { data: { destAccount: '155525', amount: 1, ok: true, movementId: 'mov-prev', message: 'OK' } },
  ])
  clientMock.listAccounts.mockResolvedValue([
    { externalId: 'neg-1', altId: 10, cuentaId: 'c', label: null, clabe: null, active: null, balance: null },
  ])
  clientMock.resolveAltAccount.mockResolvedValue({ altId: 20, name: 'Destino', accountType: 'wallet' })
  clientMock.internalTransfer.mockResolvedValue({ ok: true, movementId: 'mov-new', message: 'OK' })
  const r = await svc.sendInternalTransfer('fa-nd', { destAccountNumber: '155525', amount: 2, concept: '' })
  expect(clientMock.internalTransfer).toHaveBeenCalled()
  expect(r.movementId).toBe('mov-new')
})

it('sendInternalTransfer: conexión CLIENT (cuenta personal) → rechaza ANTES de tocar al proveedor', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-cl-tr',
    externalId: 'cta-1',
    connection: {
      id: 'cm-cl-tr',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      venueId: 'v1',
      accountKind: 'CLIENT',
      externalClientId: 'mg-1',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  await expect(svc.sendInternalTransfer('fa-cl-tr', { destAccountNumber: '155525', amount: 1, concept: '' })).rejects.toThrow(
    'Las transferencias no están disponibles para cuentas personales.',
  )
  // El backend es la fuente de verdad: jamás llegó a resolver origen/destino ni a mover dinero.
  expect(clientMock.refresh).not.toHaveBeenCalled()
  expect(clientMock.listAccounts).not.toHaveBeenCalled()
  expect(clientMock.resolveAltAccount).not.toHaveBeenCalled()
  expect(clientMock.internalTransfer).not.toHaveBeenCalled()
})

it('resolveTransferDestination: conexión CLIENT (cuenta personal) → rechaza ANTES de tocar al proveedor', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-cl-rd',
    externalId: 'cta-1',
    connection: {
      id: 'cm-cl-rd',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      venueId: 'v1',
      accountKind: 'CLIENT',
      externalClientId: 'mg-1',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  await expect(svc.resolveTransferDestination('fa-cl-rd', '155525')).rejects.toThrow(
    'Las transferencias no están disponibles para cuentas personales.',
  )
  expect(clientMock.refresh).not.toHaveBeenCalled()
  expect(clientMock.resolveAltAccount).not.toHaveBeenCalled()
  // El guard corre ANTES del try de lectura: no degrada la conexión a NEEDS_REAUTH.
  expect(db.financialConnection.updateMany).not.toHaveBeenCalled()
})

it('resolveTransferDestination: devuelve nombre del beneficiario y NO expone el altId (PK interno)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-rd',
    externalId: 'neg-1',
    connection: {
      id: 'cm-rd',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      venueId: 'v1',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-rd', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.resolveAltAccount.mockResolvedValue({ altId: 999, name: 'Mardonio Calvo', accountType: 'wallet' })
  const r = await svc.resolveTransferDestination('fa-rd', '155525')
  expect(r).toEqual({ name: 'Mardonio Calvo', accountType: 'wallet' }) // exactamente esto: sin altId
  expect((r as Record<string, unknown>)?.altId).toBeUndefined()
})

it('resolveTransferDestination: cuenta inexistente → null (el controller lo traduce a 404)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-rd2',
    externalId: 'neg-1',
    connection: {
      id: 'cm-rd2',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      venueId: 'v1',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-rd2', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.resolveAltAccount.mockResolvedValue(null)
  const r = await svc.resolveTransferDestination('fa-rd2', '999999')
  expect(r).toBeNull()
  expect(clientMock.internalTransfer).not.toHaveBeenCalled() // jamás mueve dinero: es solo lectura
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

// ─── SPEI externo (envío real a cualquier banco) ─────────────────────────────

const speiConn = (over: Record<string, unknown> = {}) => ({
  id: 'cm-spei',
  mode: 'SELF_CONNECT',
  grantEnc: encFixture(),
  tokenVersion: 0,
  deviceIdentifier: 'dev',
  status: 'CONNECTED',
  venueId: 'v1',
  accountKind: 'MERCHANT',
  externalClientId: 'mg-uuid-1',
  externalDeviceId: null,
  provider: { code: 'EXTERNAL_BANK' },
  ...over,
})
const VALID_CLABE = '032180000118359719'
const IDEM_KEY = 'a1b2c3d4-0000-4000-8000-000000000001'
const speiInput = (over: Record<string, unknown> = {}) => ({
  destinationClabe: VALID_CLABE,
  beneficiaryName: 'X',
  idBanco: 1,
  amount: 1,
  concept: '',
  idempotencyKey: IDEM_KEY,
  ...over,
})

it('sendSpeiOut: CLABE con dígito verificador inválido → BadRequest ANTES de tocar al proveedor', async () => {
  await expect(svc.sendSpeiOut('fa-sp0', speiInput({ destinationClabe: '032180000118359710' }))).rejects.toThrow('CLABE')
  // Falla en la validación pura — ni siquiera cargó la cuenta de la DB.
  expect(db.financialAccount.findUniqueOrThrow).not.toHaveBeenCalled()
  expect(clientMock.sendSpeiOut).not.toHaveBeenCalled()
})

it('sendSpeiOut: idempotencyKey que no es UUID → BadRequest antes de tocar nada', async () => {
  await expect(svc.sendSpeiOut('fa-sp0b', speiInput({ idempotencyKey: 'no-un-uuid' }))).rejects.toThrow('UUID')
  expect(db.financialAccount.findUniqueOrThrow).not.toHaveBeenCalled()
})

it('sendSpeiOut: conexión CLIENT (cuenta personal) → rechaza ANTES de tocar al proveedor', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-sp-cl',
    externalId: 'cta-1',
    connection: speiConn({ id: 'cm-sp-cl', accountKind: 'CLIENT' }),
  })
  await expect(svc.sendSpeiOut('fa-sp-cl', speiInput())).rejects.toThrow('cuentas personales')
  expect(clientMock.refresh).not.toHaveBeenCalled()
  expect(clientMock.sendSpeiOut).not.toHaveBeenCalled()
})

it('sendSpeiOut: conexión con VARIAS cuentas → rechaza (el proveedor debita por usuario, no por la cuenta elegida)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({ id: 'fa-multi', externalId: 'neg-2', connection: speiConn({ id: 'cm-multi' }) })
  db.financialAccount.count.mockResolvedValue(2)
  await expect(svc.sendSpeiOut('fa-multi', speiInput())).rejects.toThrow('una sola cuenta')
  // Jamás llegó a token/proveedor: el dinero podría salir de la cuenta equivocada.
  expect(clientMock.refresh).not.toHaveBeenCalled()
  expect(clientMock.sendSpeiOut).not.toHaveBeenCalled()
})

it('sendSpeiOut: éxito — usa el id de usuario del proveedor de la fila y la idempotencyKey PROVISTA (no genera una nueva); audita con monto normalizado', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({ id: 'fa-sp1', externalId: 'neg-1', connection: speiConn() })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({
    id: 'cm-spei',
    grantEnc: encFixture(),
    tokenVersion: 0,
    status: 'CONNECTED',
  })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.sendSpeiOut.mockResolvedValue({ ok: true, operationId: 'op-1', transferId: 'uuid-t1', message: 'OK' })

  const r = await svc.sendSpeiOut(
    'fa-sp1',
    speiInput({ beneficiaryName: '  Juan Pérez  ', idBanco: 40012, amount: 150.505, concept: 'Prueba', staffId: 'staff-1' }),
  )
  expect(r.ok).toBe(true)
  const sent = clientMock.sendSpeiOut.mock.calls.at(-1)[1]
  expect(sent.externalUserId).toBe('mg-uuid-1') // de la fila, sin backfill
  expect(sent.beneficiaryName).toBe('Juan Pérez') // normalizado (trim)
  expect(sent.idempotencyKey).toBe(IDEM_KEY) // la del frontend, intacta — los retries HTTP reenvían la misma
  expect(sent.amount).toBe(150.51) // normalizado a centavos UNA vez
  expect(clientMock.getExternalUserId).not.toHaveBeenCalled()
  expect(logAction).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'FINANCIAL_SPEI_OUT',
      entityId: 'fa-sp1',
      // El monto auditado ES el monto enviado (150.51), no el crudo del request (150.505).
      data: expect.objectContaining({
        destClabe: VALID_CLABE,
        idBanco: 40012,
        amount: 150.51,
        idempotencyKey: IDEM_KEY,
        ok: true,
        operationId: 'op-1',
      }),
    }),
  )
})

it('sendSpeiOut: backfill perezoso — externalClientId null → getExternalUserId + update de la conexión', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-sp2',
    externalId: 'neg-1',
    connection: speiConn({ id: 'cm-sp2', externalClientId: null }),
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-sp2', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.getExternalUserId.mockResolvedValue('mg-backfilled')
  clientMock.sendSpeiOut.mockResolvedValue({ ok: true, operationId: 'op-2', transferId: null, message: null })

  await svc.sendSpeiOut('fa-sp2', speiInput({ amount: 2 }))
  expect(db.financialConnection.update).toHaveBeenCalledWith({
    where: { id: 'cm-sp2' },
    data: { externalClientId: 'mg-backfilled' },
  })
  expect(clientMock.sendSpeiOut.mock.calls.at(-1)[1].externalUserId).toBe('mg-backfilled')
})

it('sendSpeiOut: dedup — un envío idéntico reciente (misma CLABE + monto) NO se reenvía; misma key → "ya se procesó"', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({ id: 'fa-sp3', externalId: 'neg-1', connection: speiConn({ id: 'cm-sp3' }) })
  db.activityLog.findMany.mockResolvedValue([
    { data: { destClabe: VALID_CLABE, amount: 3, ok: true, operationId: 'op-prev', idempotencyKey: IDEM_KEY } },
  ])

  // Mismo intento re-entregado (retry HTTP): misma key → resultado original, mensaje "ya se procesó".
  const same = await svc.sendSpeiOut('fa-sp3', speiInput({ amount: 3 }))
  expect(same.ok).toBe(true)
  expect(same.operationId).toBe('op-prev')
  expect(same.message).toContain('ya se procesó')

  // Intento NUEVO (otra key) con mismo contenido: bloqueado con aviso de verificación.
  const blocked = await svc.sendSpeiOut('fa-sp3', speiInput({ amount: 3, idempotencyKey: 'b2b2c3d4-0000-4000-8000-000000000002' }))
  expect(blocked.message).toContain('Verifica tus movimientos')

  expect(clientMock.sendSpeiOut).not.toHaveBeenCalled()
  expect(clientMock.refresh).not.toHaveBeenCalled()
  expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'FINANCIAL_SPEI_OUT' }))
})

it('sendSpeiOut: proveedor no reporta el id de usuario en el backfill → BadRequest, no 500 y NO envía', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa-sp4',
    externalId: 'neg-1',
    connection: speiConn({ id: 'cm-sp4', externalClientId: null }),
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-sp4', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.getExternalUserId.mockResolvedValue(null)
  await expect(svc.sendSpeiOut('fa-sp4', speiInput())).rejects.toThrow('identificador de la cuenta origen')
  expect(clientMock.sendSpeiOut).not.toHaveBeenCalled()
})

it('getSpeiBanks: delega al client con el token de la conexión de la cuenta', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({ id: 'fa-bk', externalId: 'neg-1', connection: speiConn({ id: 'cm-bk' }) })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-bk', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listSpeiBanks.mockResolvedValue([{ idBanco: 40012, name: 'BBVA', clabePrefix: 12 }])
  const banks = await svc.getSpeiBanks('fa-bk')
  expect(banks).toEqual([{ idBanco: 40012, name: 'BBVA', clabePrefix: 12 }])
})

it('getSpeiBanks: fallo del ENDPOINT del catálogo → 400 honesto SIN degradar la conexión (regresión del incidente 2026-07-03)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({ id: 'fa-bk2', externalId: 'neg-1', connection: speiConn({ id: 'cm-bk2' }) })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-bk2', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listSpeiBanks.mockRejectedValue(new Error('Request failed with status code 401'))
  await expect(svc.getSpeiBanks('fa-bk2')).rejects.toThrow('catálogo de bancos')
  // El token sigue sirviendo para saldo/movimientos — un 401 del catálogo NO tumba la conexión.
  expect(db.financialConnection.updateMany).not.toHaveBeenCalled()
})

it('getSpeiBanks: refresh de token MUERTO → sí degrada a NEEDS_REAUTH (la mitad legítima del split)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({ id: 'fa-bk3', externalId: 'neg-1', connection: speiConn({ id: 'cm-bk3' }) })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'cm-bk3', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockRejectedValue(new Error('invalid refresh token'))
  await expect(svc.getSpeiBanks('fa-bk3')).rejects.toThrow()
  expect(db.financialConnection.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: 'NEEDS_REAUTH' }) }),
  )
  expect(clientMock.listSpeiBanks).not.toHaveBeenCalled()
})

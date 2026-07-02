import nock from 'nock'

const BASE = 'https://external-bank-test.example.com'
const DEVICE = 'avoqado-conn-test-1'

function setEnv() {
  process.env.EXTERNAL_BANK_API_BASE = BASE
  process.env.EXTERNAL_BANK_MG_PLATFORM = 'MERCHANT'
}
async function loadClient() {
  jest.resetModules()
  setEnv()
  return (await import('@/services/financial-connections/externalBank.client')).externalBankClient
}

beforeAll(() => nock.disableNetConnect())
afterAll(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})
afterEach(() => nock.cleanAll())

const NEGOCIOS = {
  negocios: [
    { idNegocio: 'neg-1', nombre: 'Sucursal Centro', cuentaDispersion: { cuentaClabe: '0123', saldo: 1500.5, activo: true } },
    { idNegocio: 'neg-2', nombre: 'Sucursal Norte', cuentaDispersion: { cuentaClabe: '0987', saldo: 0, activo: false } },
  ],
}

it('connect: device already trusted → returns grant + accounts', async () => {
  nock(BASE)
    .post('/api/auth/sign-in/merchant')
    .reply(200, {
      signedIn: true,
      token: 'acc-1',
      refreshToken: 'ref-1',
      expiresIn: new Date(Date.now() + 3600e3).toISOString(),
    })
  nock(BASE).get('/api/auth').reply(200, NEGOCIOS)
  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') {
    expect(r.grant.refreshToken).toBe('ref-1')
    expect(r.accounts.map(a => a.externalId)).toEqual(['neg-1', 'neg-2'])
    expect(r.accounts[0]).toMatchObject({ label: 'Sucursal Centro', balance: 1500.5, active: true, clabe: '0123' })
  }
})

it('connect: needTwoFactorAuth (no device validation needed) → returns 2FA challenge', async () => {
  nock(BASE)
    .post('/api/auth/sign-in/merchant')
    .reply(200, {
      signedIn: true,
      token: 'tmp-tok-2fa',
      refreshToken: null,
      needTwoFactorAuth: true,
      needDeviceValidation: false,
      expiresIn: new Date(Date.now() + 3600e3).toISOString(),
    })
  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE })
  expect(r.kind).toBe('need_two_factor_auth')
  if (r.kind === 'need_two_factor_auth') expect(r.challenge).toEqual({ accessToken: 'tmp-tok-2fa' })
})

it('validateTwoFactorCode: valid code → returns full grant + accounts', async () => {
  nock(BASE)
    .post('/api/auth/validate-two-factor-code')
    .reply(200, {
      isLoggedIn: true,
      success: true,
      token: 'acc-2fa',
      refreshToken: 'ref-2fa',
      expiresIn: new Date(Date.now() + 3600e3).toISOString(),
      needTwoFactorAuth: false,
    })
  nock(BASE).get('/api/auth').reply(200, NEGOCIOS)
  const client = await loadClient()
  const r = await client.validateTwoFactorCode({
    email: 'a@b.co',
    deviceIdentifier: DEVICE,
    challenge: { accessToken: 'tmp-tok-2fa' },
    code: '123456',
  })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') expect(r.grant.refreshToken).toBe('ref-2fa')
})

it('validateTwoFactorCode: invalid code → throws', async () => {
  nock(BASE).post('/api/auth/validate-two-factor-code').reply(400, {
    Success: false,
    Message: 'Código inválido',
    HttpStatusCode: 400,
    IdOperacion: null,
  })
  const client = await loadClient()
  await expect(
    client.validateTwoFactorCode({
      email: 'a@b.co',
      deviceIdentifier: DEVICE,
      challenge: { accessToken: 'tmp-tok-2fa' },
      code: '000000',
    }),
  ).rejects.toThrow(/inválid|inv[aá]lido/i)
})

it('connect: needDeviceValidation → starts identity + returns challenge', async () => {
  nock(BASE).post('/api/auth/sign-in/merchant').reply(200, { needDeviceValidation: true, token: 'tmp-tok' })
  nock(BASE).post('/api/identity/start/web').reply(200, { proccessId: 'proc-9', needValidateOtp: true })
  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE })
  expect(r.kind).toBe('need_device_validation')
  if (r.kind === 'need_device_validation') {
    expect(r.challenge).toEqual({ accessToken: 'tmp-tok', processId: 'proc-9' })
  }
})

it('validateDevice: valid OTP → re-signs in and returns grant', async () => {
  nock(BASE).post('/api/identity/validate-otp-code/web').reply(200, { isValid: true })
  nock(BASE)
    .post('/api/auth/sign-in/merchant')
    .reply(200, {
      signedIn: true,
      token: 'acc-2',
      refreshToken: 'ref-2',
      expiresIn: new Date(Date.now() + 3600e3).toISOString(),
    })
  nock(BASE).get('/api/auth').reply(200, NEGOCIOS)
  const client = await loadClient()
  const r = await client.validateDevice({
    email: 'a@b.co',
    password: 'p',
    deviceIdentifier: DEVICE,
    challenge: { accessToken: 'tmp-tok', processId: 'proc-9' },
    code: '123456',
  })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') expect(r.grant.refreshToken).toBe('ref-2')
})

it('validateDevice: invalid OTP → throws', async () => {
  nock(BASE).post('/api/identity/validate-otp-code/web').reply(200, { isValid: false })
  const client = await loadClient()
  await expect(
    client.validateDevice({
      email: 'a@b.co',
      password: 'p',
      deviceIdentifier: DEVICE,
      challenge: { accessToken: 'tmp-tok', processId: 'proc-9' },
      code: '000000',
    }),
  ).rejects.toThrow(/OTP|código|inválid/i)
})

it('refresh: usa /api/auth/refresh-token (NO sign-in/token) y devuelve el grant rotado', async () => {
  // sign-in/token truena con 400 para tokens de 2FA (bug .NET del proveedor, confirmado en
  // vivo); refresh-token renueva sin validar dispositivo/2FA. El body lleva token/refreshToken/expiresIn.
  nock(BASE)
    .post('/api/auth/refresh-token', body => body.refreshToken === 'ref-2')
    .reply(200, {
      success: true,
      token: 'acc-3',
      refreshToken: 'ref-3-rotated',
      expiresIn: new Date(Date.now() + 3600e3).toISOString(),
    })
  const client = await loadClient()
  const { grant, ctx } = await client.refresh({ refreshToken: 'ref-2' }, DEVICE)
  expect(grant.refreshToken).toBe('ref-3-rotated')
  expect(ctx.accessToken).toBe('acc-3')
})

it('getBalance: maps saldo/activo, and a null saldo stays null (state decided upstream)', async () => {
  nock(BASE).get('/api/auth').reply(200, NEGOCIOS)
  const client = await loadClient()
  const b = await client.getBalance({ accessToken: 'acc-x' }, 'neg-2')
  expect(b).toMatchObject({ amount: 0, currency: 'MXN', active: false })
})

it('getBalance: unknown negocio → throws NotFound', async () => {
  nock(BASE).get('/api/auth').reply(200, NEGOCIOS)
  const client = await loadClient()
  await expect(client.getBalance({ accessToken: 'acc-x' }, 'nope')).rejects.toThrow()
})

it('listMovements: pagina con notación punteada y normaliza el movimiento', async () => {
  nock(BASE)
    .get('/api/clients/movimientos/cta-1')
    .query({ 'Pagination.Page': '0', 'Pagination.Size': '10', FechaInicio: '2026-07-01T00:00:00.000Z' })
    .reply(200, {
      total: 1,
      data: [
        {
          idOperacion: 'op1',
          tipoMovimiento: 'SPEI IN',
          tipoOperacion: 'Abono',
          concepto: 'Pago',
          fechaCreacion: '2026-07-01T10:00:00Z',
          monto: 150.5,
          estatus: 'Liquidado',
          idEstatus: 3,
          nombreOrdenante: 'ACME',
          referencia: '777',
        },
      ],
    })
  const client = await loadClient()
  const r = await client.listMovements({ accessToken: 't' }, 'cta-1', { page: 0, size: 10, from: '2026-07-01T00:00:00.000Z' })
  expect(r.total).toBe(1)
  expect(r.movements[0]).toMatchObject({ id: 'op1', type: 'SPEI IN', amount: 150.5, originator: 'ACME', beneficiary: null })
})

it('getMovementStats: parsea los montos-string a número y preserva null en no-parseables', async () => {
  nock(BASE)
    .get('/api/clients/movimientos/Estadisticas/cta-1')
    .query(true)
    .reply(200, {
      nombre: 'AV-X',
      cuentaClabe: '7381',
      montoTransaccionadoSpeiIn: '1500.75',
      numeroOperacionesSpeiIn: '3',
      comisionCobradaSpeiIn: '12.5',
      montoTransaccionadoSpeiOut: 'garbage',
      numeroOperacionesSpeiOut: '1',
      comisionCobradaSpeiOut: '0',
      montoTransaccionadoTransferenciaInterna: '0',
      numeroOperacionesTransferenciaInterna: '0',
      comisionCobradaTransferenciaInterna: '0',
      montoTransaccionadoDispersion: '200',
      numeroOperacionesDispersion: '2',
      comisionCobradaDispersion: '1',
    })
  const client = await loadClient()
  const s = await client.getMovementStats({ accessToken: 't' }, 'cta-1', { from: '2026-07-01T00:00:00.000Z' })
  expect(s.speiIn).toEqual({ amount: 1500.75, count: 3, fee: 12.5 })
  expect(s.speiOut.amount).toBeNull() // 'garbage' NO se convierte en 0
  expect(s.dispersions.amount).toBe(200)
})

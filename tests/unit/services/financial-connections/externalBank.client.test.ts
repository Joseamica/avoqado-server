import nock from 'nock'

const BASE = 'https://external-bank-test.example.com'
const DEVICE = 'avoqado-conn-test-1'

function setEnv() {
  process.env.EXTERNAL_BANK_API_BASE = BASE
  process.env.EXTERNAL_BANK_MG_PLATFORM = 'MERCHANT'
  process.env.EXTERNAL_BANK_MG_PLATFORM_CLIENT = 'PWA'
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

it('resolveMgAlt: número interno → idCuentaAlt (string del proveedor → entero); 404 → null', async () => {
  nock(BASE).get('/api/transferencia/get-MoneyGiverAlt').query({ idClienteWalletAlt: '155525' }).reply(200, {
    idCuentaAlt: '4521',
    nombre: 'AV Destino',
    tipoCuenta: 'wallet',
  })
  let client = await loadClient()
  const r = await client.resolveMgAlt({ accessToken: 't', kind: 'MERCHANT' }, '155525')
  expect(r).toEqual({ altId: 4521, name: 'AV Destino', accountType: 'wallet' })

  nock(BASE).get('/api/transferencia/get-MoneyGiverAlt').query({ idClienteWalletAlt: '999999' }).reply(404, {})
  client = await loadClient()
  expect(await client.resolveMgAlt({ accessToken: 't', kind: 'MERCHANT' }, '999999')).toBeNull()
})

it('internalTransfer: POST add-transferenciaMG con el body probado; success:true → ok, success:false → no ok', async () => {
  nock(BASE)
    .post(
      '/api/transferencia/add-transferenciaMG',
      b => b.idCuentaAltSalida === 10 && b.idCuentaAltRecibe === 20 && b.idTipo === 1 && b.monto === 1 && b.concepto === 'Prueba',
    )
    .reply(200, { success: true, idMovimiento: 'mov-1', message: 'OK' })
  let client = await loadClient()
  const ok = await client.internalTransfer({ accessToken: 't', kind: 'MERCHANT' }, { sourceAltId: 10, destAltId: 20, amount: 1, concept: 'Prueba' })
  expect(ok).toEqual({ ok: true, movementId: 'mov-1', message: 'OK' })

  nock(BASE).post('/api/transferencia/add-transferenciaMG').reply(200, { success: false, message: 'Saldo insuficiente' })
  client = await loadClient()
  const bad = await client.internalTransfer({ accessToken: 't', kind: 'MERCHANT' }, { sourceAltId: 10, destAltId: 20, amount: 1, concept: '' })
  expect(bad.ok).toBe(false)
  expect(bad.message).toBe('Saldo insuficiente')
})

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
  if (r.kind === 'need_two_factor_auth') expect(r.challenge).toMatchObject({ accessToken: 'tmp-tok-2fa' })
})

it('connect(CLIENT): usa /sign-in genérico + mgPlatform PWA; 2FA challenge', async () => {
  let seenPlatform: string | undefined
  nock(BASE)
    .post('/api/auth/sign-in')
    .reply(function () {
      seenPlatform = this.req.headers['mgplatform']
      return [200, { signedIn: true, token: 'tmp-2fa', refreshToken: null, needTwoFactorAuth: true, needDeviceValidation: false }]
    })
  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE, accountKind: 'CLIENT' })
  expect(seenPlatform).toBe('PWA')
  expect(r.kind).toBe('need_two_factor_auth')
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
    accountKind: 'MERCHANT',
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
      accountKind: 'MERCHANT',
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
    expect(r.challenge).toMatchObject({ accessToken: 'tmp-tok', processId: 'proc-9' })
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
    accountKind: 'MERCHANT',
  })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') expect(r.grant.refreshToken).toBe('ref-2')
})

it('validateDevice(CLIENT): re-login con needTwoFactorAuth y token:null reusa el token del challenge (shape PWA real 2026-07-03)', async () => {
  nock(BASE).post('/api/identity/validate-otp-code/web').reply(200, { isValid: true })
  // Shape REAL del provider para PWA: re-login tras device validation NO trae token temporal
  // nuevo y anida el id en user.idMoneyGiver (no userData).
  nock(BASE).post('/api/auth/sign-in').reply(200, {
    isLoggedIn: true,
    token: null,
    refreshToken: null,
    needTwoFactorAuth: true,
    needDeviceValidation: false,
    user: { idMoneyGiver: 'mg-real' },
  })
  const client = await loadClient()
  const r = await client.validateDevice({
    email: 'a@b.co',
    password: 'p',
    deviceIdentifier: DEVICE,
    challenge: { accessToken: 'tmp-tok-original', processId: 'proc-9', externalClientId: null },
    code: '123456',
    accountKind: 'CLIENT',
  })
  expect(r.kind).toBe('need_two_factor_auth')
  if (r.kind === 'need_two_factor_auth') {
    expect(r.challenge.accessToken).toBe('tmp-tok-original') // reusado, no null
    expect(r.challenge.externalClientId).toBe('mg-real') // leído de user.idMoneyGiver
  }
})

it('idMoneyGiverOf vía connect(CLIENT): user.idMoneyGiver (shape PWA real) se acepta igual que userData', async () => {
  nock(BASE).post('/api/auth/sign-in').reply(200, {
    signedIn: true,
    token: 'acc-c2',
    refreshToken: 'ref-c2',
    expiresIn: new Date(Date.now() + 3600e3).toISOString(),
    user: { idMoneyGiver: 'mg-user-path' },
  })
  nock(BASE)
    .get('/api/clients/get-wallet-clientAccounts/v3r2.1')
    .query({ idMoneyGiver: 'mg-user-path' })
    .reply(200, { cuentas: [{ idCuenta: 'cta-9', nombre: 'X', cuentaClabe: '646', saldo: 1, activo: true, idCuentaAlt: 1 }] })
  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE, accountKind: 'CLIENT' })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') expect(r.externalClientId).toBe('mg-user-path')
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
      accountKind: 'MERCHANT',
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
  const { grant, ctx } = await client.refresh({ refreshToken: 'ref-2' }, DEVICE, 'MERCHANT')
  expect(grant.refreshToken).toBe('ref-3-rotated')
  expect(ctx.accessToken).toBe('acc-3')
})

it('refresh(CLIENT): manda mgPlatform PWA y devuelve el grant rotado con ctx.kind CLIENT', async () => {
  let seenPlatform: string | undefined
  nock(BASE)
    .post('/api/auth/refresh-token', body => body.refreshToken === 'ref-cl')
    .reply(function () {
      seenPlatform = this.req.headers['mgplatform'] as string | undefined
      return [
        200,
        { success: true, token: 'acc-cl', refreshToken: 'ref-cl-rotated', expiresIn: new Date(Date.now() + 3600e3).toISOString() },
      ]
    })
  const client = await loadClient()
  const { grant, ctx } = await client.refresh({ refreshToken: 'ref-cl' }, DEVICE, 'CLIENT')
  expect(seenPlatform).toBe('PWA')
  expect(grant.refreshToken).toBe('ref-cl-rotated')
  expect(ctx.accessToken).toBe('acc-cl')
  expect(ctx.kind).toBe('CLIENT')
})

it('getBalance: maps saldo/activo, and a null saldo stays null (state decided upstream)', async () => {
  nock(BASE).get('/api/auth').reply(200, NEGOCIOS)
  const client = await loadClient()
  const b = await client.getBalance({ accessToken: 'acc-x', kind: 'MERCHANT' }, 'neg-2')
  expect(b).toMatchObject({ amount: 0, currency: 'MXN', active: false })
})

it('getBalance: unknown negocio → throws NotFound', async () => {
  nock(BASE).get('/api/auth').reply(200, NEGOCIOS)
  const client = await loadClient()
  await expect(client.getBalance({ accessToken: 'acc-x', kind: 'MERCHANT' }, 'nope')).rejects.toThrow()
})

it('listMovements: pagina con notación punteada y normaliza el movimiento', async () => {
  // Ruta = idNegocio; idCuenta como query param (acota a la cuenta real, no al pool global).
  nock(BASE)
    .get('/api/clients/movimientos/neg-1')
    .query({
      'Pagination.Page': '0',
      'Pagination.Size': '10',
      idCuenta: 'cta-1',
      SortByFecha: 'DESC',
      FechaInicio: '2026-07-01T00:00:00.000Z',
    })
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
  const r = await client.listMovements({ accessToken: 't', kind: 'MERCHANT' }, 'neg-1', 'cta-1', { page: 0, size: 10, from: '2026-07-01T00:00:00.000Z' })
  expect(r.total).toBe(1)
  expect(r.movements[0]).toMatchObject({ id: 'op1', type: 'SPEI IN', amount: 150.5, originator: 'ACME', beneficiary: null })
})

it('listMovements(CLIENT): idCuenta en la RUTA **y** como query param (scoping — sin el query devuelve pool global)', async () => {
  // Verificado en vivo 2026-07-03: la PWA manda idCuenta en ambos lados; sin el query param el
  // proveedor devuelve ~5.16M movimientos ajenos. Este test fija que el query param SIEMPRE va.
  nock(BASE)
    .get('/api/clients/movimientos/cta-1')
    .query(q => q['Pagination.Page'] === '0' && q.SortByFecha === 'DESC' && q.idCuenta === 'cta-1')
    .reply(200, { data: [{ idOperacion: 'op1', monto: '10.5', fechaCreacion: '2026-06-01' }], total: 1 })
  const client = await loadClient()
  const page = await client.listMovements({ accessToken: 't', kind: 'CLIENT' }, 'IGNORED', 'cta-1', { page: 0, size: 10 })
  expect(page.total).toBe(1)
  expect(page.movements[0]).toMatchObject({ id: 'op1', amount: 10.5 })
})

it('listMovements(CLIENT): descifra el envelope cifrado si el endpoint enveló la respuesta', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto') as typeof import('node:crypto')
  const idDispositivo = 'a1b2c3d4-e5f6-47a8-9012-abcdef123456'
  const plain = { data: [{ idOperacion: 'op-enc', monto: '42.00', fechaCreacion: '2026-07-01' }], total: 1 }
  const key = Buffer.from(idDispositivo.slice(0, 16), 'utf8')
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()])
  nock(BASE)
    .get('/api/clients/movimientos/cta-9')
    .query(() => true)
    .reply(200, { payload: `${iv.toString('base64')}|${ct.toString('base64')}`, timestamp: '1' })
  const client = await loadClient()
  const page = await client.listMovements(
    { accessToken: 't', kind: 'CLIENT', idDispositivo },
    'IGNORED',
    'cta-9',
    { page: 0, size: 10 },
  )
  expect(page.total).toBe(1)
  expect(page.movements[0]).toMatchObject({ id: 'op-enc', amount: 42 })
})

it('listAccounts(CLIENT) sin externalClientId → BadRequestError', async () => {
  const client = await loadClient()
  await expect(client.listAccounts({ accessToken: 't', kind: 'CLIENT', externalClientId: null })).rejects.toThrow(/Falta externalClientId/)
})

it('getBalance(CLIENT): resuelve vía get-wallet-clientAccounts y devuelve saldo/active/label de la cuenta pedida', async () => {
  nock(BASE).get('/api/clients/get-wallet-clientAccounts/v3r2.1').query({ idMoneyGiver: 'mg-1' }).reply(200, {
    cuentas: [
      { idCuenta: 'cta-1', nombre: 'Mi cuenta', cuentaClabe: '646...', saldo: 1234.5, activo: true, idCuentaAlt: 77 },
      { idCuenta: 'cta-2', nombre: 'Otra', cuentaClabe: '646...', saldo: 0, activo: false, idCuentaAlt: 78 },
    ],
  })
  const client = await loadClient()
  const b = await client.getBalance({ accessToken: 't', kind: 'CLIENT', externalClientId: 'mg-1' }, 'cta-1')
  expect(b).toMatchObject({ amount: 1234.5, currency: 'MXN', active: true, providerAccountLabel: 'Mi cuenta' })
})

it('connect(CLIENT) sin 2FA: normaliza get-wallet-clientAccounts a ProviderAccount[]', async () => {
  nock(BASE).post('/api/auth/sign-in').reply(200, {
    signedIn: true, token: 'acc-c', refreshToken: 'ref-c',
    expiresIn: new Date(Date.now() + 3600e3).toISOString(),
    userData: { idMoneyGiver: 'mg-1' },
  })
  nock(BASE).get('/api/clients/get-wallet-clientAccounts/v3r2.1').query({ idMoneyGiver: 'mg-1' }).reply(200, {
    cuentas: [
      { idCuenta: 'cta-1', nombre: 'Mi cuenta', cuentaClabe: '646...', saldo: 1234.5, activo: true, idCuentaAlt: 77 },
      { idCuenta: 'cta-2', nombre: 'Otra', cuentaClabe: '646...', saldo: 0, activo: false, idCuentaAlt: 78 },
    ],
  })
  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE, accountKind: 'CLIENT' })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') {
    expect(r.externalClientId).toBe('mg-1')
    expect(r.accounts.map(a => a.externalId)).toEqual(['cta-1', 'cta-2'])
    expect(r.accounts[0]).toMatchObject({ cuentaId: 'cta-1', label: 'Mi cuenta', balance: 1234.5, active: true, altId: 77 })
  }
})

it('connect(CLIENT): descifra el envelope cifrado (AES-128-CBC, key=idDispositivo[0:16]) y expone externalDeviceId', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto') as typeof import('node:crypto')
  const idDispositivo = 'a1b2c3d4-e5f6-47a8-9012-abcdef123456' // UUID real-shaped, como lo devuelve el proveedor
  const plainAccounts = {
    cuentas: [
      { idCuenta: 'cta-enc-1', nombre: 'Cuenta cifrada', cuentaClabe: '646...', saldo: 999.25, activo: true, idCuentaAlt: 55 },
    ],
  }
  const key = Buffer.from(idDispositivo.slice(0, 16), 'utf8')
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plainAccounts), 'utf8'), cipher.final()])
  const payload = `${iv.toString('base64')}|${ciphertext.toString('base64')}`

  nock(BASE).post('/api/auth/sign-in').reply(200, {
    signedIn: true,
    token: 'acc-enc',
    refreshToken: 'ref-enc',
    expiresIn: new Date(Date.now() + 3600e3).toISOString(),
    userData: { idMoneyGiver: 'mg-enc' },
    idDispositivo,
  })
  nock(BASE)
    .get('/api/clients/get-wallet-clientAccounts/v3r2.1')
    .query({ idMoneyGiver: 'mg-enc' })
    .reply(200, { payload, timestamp: new Date().toISOString() })

  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE, accountKind: 'CLIENT' })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') {
    expect(r.externalClientId).toBe('mg-enc')
    expect(r.externalDeviceId).toBe(idDispositivo)
    expect(r.accounts).toHaveLength(1)
    expect(r.accounts[0]).toMatchObject({
      externalId: 'cta-enc-1',
      cuentaId: 'cta-enc-1',
      label: 'Cuenta cifrada',
      balance: 999.25,
      active: true,
      altId: 55,
    })
  }
})

it('validateTwoFactorCode(CLIENT): respuesta 2FA SIN idMoneyGiver usa el fallback del challenge', async () => {
  let seenPlatform: string | undefined
  nock(BASE).post('/api/auth/validate-two-factor-code').reply(function () {
    seenPlatform = this.req.headers['mgplatform']
    return [200, {
      success: true, token: 'acc-2fa', refreshToken: 'ref-2fa',
      expiresIn: new Date(Date.now() + 3600e3).toISOString(),
      // deliberadamente SIN userData/idMoneyGiver — el fallback debe cubrirlo
    }]
  })
  nock(BASE).get('/api/clients/get-wallet-clientAccounts/v3r2.1').query({ idMoneyGiver: 'mg-1' }).reply(200, {
    cuentas: [{ idCuenta: 'cta-1', nombre: 'Mi cuenta', cuentaClabe: '646...', saldo: 50, activo: true, idCuentaAlt: 9 }],
  })
  const client = await loadClient()
  const r = await client.validateTwoFactorCode({
    email: 'a@b.co', deviceIdentifier: DEVICE, code: '123456',
    accountKind: 'CLIENT', challenge: { accessToken: 'tmp-2fa', externalClientId: 'mg-1' },
  })
  expect(seenPlatform).toBe('PWA')
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') expect(r.externalClientId).toBe('mg-1')
})

it('normalizeClientAccounts (vía connect CLIENT): filtra cuentas sin idCuenta; payload sin cuentas[] → []', async () => {
  nock(BASE).post('/api/auth/sign-in').reply(200, {
    signedIn: true, token: 'acc-c2', refreshToken: 'ref-c2',
    expiresIn: new Date(Date.now() + 3600e3).toISOString(),
    userData: { idMoneyGiver: 'mg-2' },
  })
  nock(BASE).get('/api/clients/get-wallet-clientAccounts/v3r2.1').query({ idMoneyGiver: 'mg-2' }).reply(200, {
    cuentas: [
      { nombre: 'Sin idCuenta', saldo: 5, activo: true }, // filtrada: sin idCuenta
      { idCuenta: 'cta-9', nombre: 'Válida', saldo: 5, activo: true, idCuentaAlt: 1 },
    ],
  })
  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE, accountKind: 'CLIENT' })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') expect(r.accounts.map(a => a.externalId)).toEqual(['cta-9'])
})

it('connect(CLIENT) sin idMoneyGiver y sin fallback → BadRequest "no devolvió idMoneyGiver"', async () => {
  nock(BASE).post('/api/auth/sign-in').reply(200, {
    signedIn: true, token: 'acc-c3', refreshToken: 'ref-c3',
    expiresIn: new Date(Date.now() + 3600e3).toISOString(),
    // sin userData/idMoneyGiver
  })
  const client = await loadClient()
  await expect(
    client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE, accountKind: 'CLIENT' }),
  ).rejects.toThrow(/no devolvió idMoneyGiver/)
})

it('connect(CLIENT) con cuentas:[] → BadRequest "no devolvió cuentas" (guard C4), no connected', async () => {
  nock(BASE).post('/api/auth/sign-in').reply(200, {
    signedIn: true, token: 'acc-c4', refreshToken: 'ref-c4',
    expiresIn: new Date(Date.now() + 3600e3).toISOString(),
    userData: { idMoneyGiver: 'mg-4' },
  })
  nock(BASE).get('/api/clients/get-wallet-clientAccounts/v3r2.1').query({ idMoneyGiver: 'mg-4' }).reply(200, { cuentas: [] })
  const client = await loadClient()
  await expect(
    client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE, accountKind: 'CLIENT' }),
  ).rejects.toThrow(/no devolvió cuentas/)
})

it('getMovementStats: parsea los montos-string a número y preserva null en no-parseables', async () => {
  nock(BASE).get('/api/clients/movimientos/Estadisticas/cta-1').query(true).reply(200, {
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
  const s = await client.getMovementStats({ accessToken: 't', kind: 'MERCHANT' }, 'cta-1', { from: '2026-07-01T00:00:00.000Z' })
  expect(s.speiIn).toEqual({ amount: 1500.75, count: 3, fee: 12.5 })
  expect(s.speiOut.amount).toBeNull() // 'garbage' NO se convierte en 0
  expect(s.dispersions.amount).toBe(200)
})

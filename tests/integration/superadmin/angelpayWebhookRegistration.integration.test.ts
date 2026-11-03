/**
 * D11 (versión mínima): el recorrido del aviso del banco por HTTP real, contra Postgres. Sólo AngelPay es falso.
 *
 * Lo que un mock no puede probar: el guardia real del router (anónimo 401, un dueño 403), la escritura condicional contra la fila
 * (dos entradas a la vez: un solo secreto, un solo asiento), que el receptor del webhook pase de 503 a aceptar la firma nada más
 * registrar, y que la llave y el secreto no salgan en ninguna respuesta.
 */
import { createHmac, randomUUID } from 'crypto'
import cuid from 'cuid'
import jwt from 'jsonwebtoken'
import request, { type Response } from 'supertest'
import type { Express } from 'express'
import { motivoParaRechazarBaseDePruebas } from '../../__helpers__/baseDePruebasPermitida'

jest.mock('connect-pg-simple', () => (session: typeof import('express-session')) => session.MemoryStore)
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: () => null, getBroadcastingService: () => null },
}))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmail: jest.fn().mockResolvedValue(true) } }))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }))
// El asiento se escribe de verdad: la configuración de integración deja `logAction` en `jest.fn()`.
jest.mock('@/services/dashboard/activity-log.service', () => jest.requireActual('@/services/dashboard/activity-log.service'))
jest.mock('@/services/integrations/angelpay-integrations-api.client', () => ({
  ...jest.requireActual('@/services/integrations/angelpay-integrations-api.client'),
  angelPayIntegrationsApiClient: { auth: jest.fn(), registerWebhook: jest.fn() },
}))

const declaredDatabase = process.env.TEST_DATABASE_URL
if (!declaredDatabase || motivoParaRechazarBaseDePruebas(declaredDatabase) || process.env.DATABASE_URL !== declaredDatabase) {
  throw new Error('D11 requires equal, caller-supplied local integration database URLs; URL withheld')
}

const LLAVE = 'llave-de-prueba-no-real'
const SECRETO = 'whsec_secreto_de_prueba'
const ACCION = 'MERCHANT_ACCOUNT_ANGELPAY_WEBHOOK_REGISTERED'

let prisma: typeof import('@/utils/prismaClient').default
let appModule: typeof import('@/app')
let app: Express
let mockAuth: jest.Mock
let mockRegister: jest.Mock
let ApiError: typeof import('@/services/integrations/angelpay-integrations-api.client').AngelPayIntegrationsApiError
let orgId: string
let venueId: string
let superadminId: string
let duenoId: string
let loginId: string
let angelpayProviderId: string
let propioProveedor = false
let tokenSuperadmin: string
let tokenDueno: string
const cuentasCreadas: string[] = []

beforeAll(async () => {
  prisma = require('@/utils/prismaClient').default
  appModule = require('@/app')
  app = appModule.default
  const cliente = require('@/services/integrations/angelpay-integrations-api.client')
  mockAuth = cliente.angelPayIntegrationsApiClient.auth
  mockRegister = cliente.angelPayIntegrationsApiClient.registerWebhook
  ApiError = cliente.AngelPayIntegrationsApiError

  orgId = (await prisma.organization.create({ data: { name: 'D11 aviso', email: `${cuid()}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'D11 aviso', slug: cuid() } })).id
  const existente = await prisma.paymentProvider.findUnique({ where: { code: 'ANGELPAY' } })
  propioProveedor = !existente
  angelpayProviderId =
    existente?.id ??
    (await prisma.paymentProvider.create({ data: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] } }))
      .id
  superadminId = (await prisma.staff.create({ data: { email: `${cuid()}@example.test`, firstName: 'D11', lastName: 'Soporte' } })).id
  duenoId = (await prisma.staff.create({ data: { email: `${cuid()}@example.test`, firstName: 'D11', lastName: 'Dueña' } })).id
  const firmar = async (staffId: string, role: 'SUPERADMIN' | 'OWNER') => {
    await prisma.staffVenue.create({ data: { venueId, staffId, role } })
    const sesion = await prisma.session.create({ data: { venueId, staffId, authMethod: 'PASSWORD' } })
    return jwt.sign({ sub: staffId, orgId, venueId, role, sid: sesion.id }, process.env.ACCESS_TOKEN_SECRET!, {
      expiresIn: '15m',
      algorithm: 'HS256',
    })
  }
  tokenSuperadmin = await firmar(superadminId, 'SUPERADMIN')
  tokenDueno = await firmar(duenoId, 'OWNER')
  loginId = (
    await prisma.angelPayUserAccount.create({
      data: { venueId, email: `${cuid()}@angelpay.test`, environment: 'QA', status: 'ACTIVE' },
    })
  ).id
})

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockReset()
  mockRegister.mockReset()
  mockAuth.mockImplementation(async () => ({ accessToken: 'token-de-prueba', merchantId: '990' }))
  mockRegister.mockImplementation(async () => ({ endpointId: `ep_${randomUUID()}`, secret: SECRETO }))
})

afterEach(async () => {
  if (cuentasCreadas.length === 0) return
  await prisma.activityLog.deleteMany({ where: { entityId: { in: cuentasCreadas } } })
  await prisma.providerEventLog.deleteMany({ where: { eventId: { startsWith: `angelpay-d11-${venueId}` } } })
  await prisma.venuePaymentConfig.deleteMany({ where: { venueId } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: cuentasCreadas } } })
  cuentasCreadas.length = 0
})

afterAll(async () => {
  appModule?.detenerMonitorDeEventLoop()
  appModule?.getAppEventLoopHistogram().disable()
  if (!venueId) return
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.angelPayUserAccount.deleteMany({ where: { venueId } })
  await prisma.session.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: { in: [superadminId, duenoId].filter(Boolean) } } })
  await prisma.venue.deleteMany({ where: { id: venueId, organizationId: orgId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  if (propioProveedor) await prisma.paymentProvider.deleteMany({ where: { id: angelpayProviderId } })
})

const cuenta = async (over: Record<string, unknown> = {}) => {
  const fila = await prisma.merchantAccount.create({
    data: {
      providerId: angelpayProviderId,
      externalMerchantId: '990',
      displayName: 'Boutique Centro',
      credentialsEncrypted: {},
      angelpayUserAccountId: loginId,
      active: true,
      ...over,
    },
  })
  cuentasCreadas.push(fila.id)
  return fila
}
const fila = (id: string) => prisma.merchantAccount.findUniqueOrThrow({ where: { id } })
const asientos = (id: string) => prisma.activityLog.findMany({ where: { entityId: id, action: ACCION }, take: 10 })

const registrar = (id: string, body: Record<string, unknown> = { apiKey: LLAVE }, token: string | null = tokenSuperadmin) => {
  const peticion = request(app).post(`/api/v1/superadmin/merchant-accounts/${id}/angelpay/webhook`)
  return (token ? peticion.set('Authorization', `Bearer ${token}`) : peticion).send(body)
}

const sinFugas = (respuesta: Response) => {
  expect(respuesta.text).not.toContain(LLAVE)
  expect(respuesta.text).not.toContain(SECRETO)
  expect(respuesta.text).not.toContain('angelpayWebhookSecret')
}

describe('quién puede registrar', () => {
  it('sin sesión: 401, y ni la base ni AngelPay se enteran', async () => {
    const { id } = await cuenta()
    expect((await registrar(id, { apiKey: LLAVE }, null)).status).toBe(401)
    expect(mockAuth).not.toHaveBeenCalled()
    expect((await fila(id)).angelpayWebhookSecret).toBeNull()
  })

  it.each([['/api/v1/superadmin/merchant-accounts'], ['/api/v1/dashboard/superadmin/merchant-accounts']])(
    'una dueña en %s: 403, y ni la base ni AngelPay se enteran',
    async base => {
      const { id } = await cuenta()
      const respuesta = await request(app)
        .post(`${base}/${id}/angelpay/webhook`)
        .set('Authorization', `Bearer ${tokenDueno}`)
        .send({ apiKey: LLAVE })
      expect(respuesta.status).toBe(403)
      expect(mockAuth).not.toHaveBeenCalled()
      expect((await fila(id)).angelpayWebhookSecret).toBeNull()
    },
  )
})

describe('el recorrido', () => {
  const avisoFirmado = (id: string, secreto: string) => {
    const cuerpo = JSON.stringify({ event_type: 'evento_que_no_se_procesa', payload: {} })
    return request(app)
      .post(`/api/v1/webhooks/angelpay/${id}`)
      .set('Content-Type', 'application/json')
      .set('x-webhook-event-id', `d11-${venueId}-${randomUUID()}`)
      .set('x-webhook-signature', createHmac('sha256', secreto).update(cuerpo).digest('hex'))
      .send(cuerpo)
  }

  it('sin registrar el banco recibe 503; registrado se acepta su firma, y la de otro secreto no: registrar no finge que ya llegó nada', async () => {
    const { id } = await cuenta()
    expect((await avisoFirmado(id, SECRETO)).status).toBe(503)

    const respuesta = await registrar(id)

    expect(respuesta.status).toBe(200)
    expect(respuesta.body).toEqual({ success: true, data: { merchantAccountId: id, webhookRegistered: true, alreadyRegistered: false } })
    sinFugas(respuesta)
    const guardada = await fila(id)
    expect(guardada.angelpayWebhookSecret).toBe(SECRETO)
    expect(guardada.angelpayWebhookEndpointId).toMatch(/^ep_/)
    expect(guardada.angelpayWebhookLastReceivedAt).toBeNull()
    expect(mockAuth).toHaveBeenCalledWith(LLAVE, 'QA')

    expect((await avisoFirmado(id, 'whsec_de_un_endpoint_de_mas')).status).toBe(401)
    expect((await avisoFirmado(id, SECRETO)).status).toBe(200)
  })

  it('deja un asiento con quién y en qué negocio, sin la llave ni el secreto', async () => {
    const { id } = await cuenta()
    await registrar(id)

    const [asiento, ...otros] = await asientos(id)
    expect(otros).toEqual([])
    expect(asiento).toMatchObject({ staffId: superadminId, venueId, entity: 'MerchantAccount', entityId: id })
    expect(JSON.stringify(asiento)).not.toContain(LLAVE)
    expect(JSON.stringify(asiento)).not.toContain(SECRETO)
  })

  it.each([
    ['con secreto y endpoint', { angelpayWebhookSecret: 'whsec_viejo', angelpayWebhookEndpointId: 'ep_viejo' }],
    ['con secreto y sin endpoint', { angelpayWebhookSecret: 'whsec_viejo', angelpayWebhookEndpointId: null }],
  ])('una cuenta %s no se toca: cero llamadas, la fila idéntica y sin asiento', async (_caso, over) => {
    const { id } = await cuenta(over)
    const antes = await fila(id)

    const respuesta = await registrar(id)

    expect(respuesta.status).toBe(200)
    expect(respuesta.body.data).toEqual({ merchantAccountId: id, webhookRegistered: true, alreadyRegistered: true })
    expect(mockAuth).not.toHaveBeenCalled()
    expect(mockRegister).not.toHaveBeenCalled()
    expect(await fila(id)).toEqual(antes)
    expect(await asientos(id)).toEqual([])
  })

  it('una llave de otro comercio: 422, sin crear nada y la fila intacta', async () => {
    const { id } = await cuenta({ externalMerchantId: '123' })
    const antes = await fila(id)

    const respuesta = await registrar(id)

    expect(respuesta.status).toBe(422)
    expect(respuesta.body.message).toContain('990')
    expect(mockRegister).not.toHaveBeenCalled()
    expect(await fila(id)).toEqual(antes)
    sinFugas(respuesta)
  })

  it('un ambiente distinto al de la cuenta: 422 antes de llamar a AngelPay', async () => {
    const { id } = await cuenta()

    const respuesta = await registrar(id, { apiKey: LLAVE, environment: 'PROD' })

    expect(respuesta.status).toBe(422)
    expect(mockAuth).not.toHaveBeenCalled()
  })

  it('AngelPay rechaza la llave: 422 y nunca 401, que sacaría al operador de su sesión', async () => {
    const { id } = await cuenta()
    mockAuth.mockRejectedValue(new ApiError(`AngelPay: ${LLAVE}`, 401, { eco: LLAVE }))

    const respuesta = await registrar(id)

    expect(respuesta.status).toBe(422)
    sinFugas(respuesta)
  })

  it('AngelPay no contesta al crear: 503 con su código, no se guarda nada, y reintentar funciona', async () => {
    const { id } = await cuenta()
    mockRegister.mockRejectedValueOnce(new ApiError('AngelPay: timeout', undefined, undefined))

    const incierto = await registrar(id)

    expect(incierto.status).toBe(503)
    expect(incierto.body).toMatchObject({ code: 'ANGELPAY_WEBHOOK_RESULTADO_INCIERTO', message: expect.stringContaining('No sabemos') })
    expect((await fila(id)).angelpayWebhookSecret).toBeNull()
    expect(await asientos(id)).toEqual([])

    expect((await registrar(id)).body.data.alreadyRegistered).toBe(false)
    expect((await fila(id)).angelpayWebhookSecret).toBe(SECRETO)
  })

  it('dos entradas a la vez sobre la misma cuenta: un solo secreto guardado, un solo asiento y la perdedora no lo pisa', async () => {
    const { id } = await cuenta()
    // Las dos llegan al alta en AngelPay antes de que cualquiera guarde: es la carrera, sin depender del reloj.
    const llegadas: (() => void)[] = []
    let turno = 0
    mockRegister.mockImplementation(async () => {
      const propio = ++turno
      await new Promise<void>(resolve => {
        llegadas.push(resolve)
        if (llegadas.length === 2) llegadas.forEach(soltar => soltar())
      })
      return { endpointId: `ep_${propio}`, secret: `whsec_de_la_entrada_${propio}` }
    })

    const [una, otra] = await Promise.all([registrar(id), registrar(id)])

    expect([una.status, otra.status]).toEqual([200, 200])
    expect([una.body.data.alreadyRegistered, otra.body.data.alreadyRegistered].sort()).toEqual([false, true])
    expect(mockRegister).toHaveBeenCalledTimes(2)
    const guardada = await fila(id)
    const ganadora = guardada.angelpayWebhookEndpointId!.slice('ep_'.length)
    expect(guardada.angelpayWebhookSecret).toBe(`whsec_de_la_entrada_${ganadora}`)
    expect(await asientos(id)).toHaveLength(1)
  })

  it('la identidad cambió mientras se llamaba a AngelPay: 409 y ese secreto no se guarda', async () => {
    const { id } = await cuenta()
    mockRegister.mockImplementation(async () => {
      await prisma.merchantAccount.update({ where: { id }, data: { externalMerchantId: '991' } })
      return { endpointId: 'ep_1', secret: SECRETO }
    })

    const respuesta = await registrar(id)

    expect(respuesta.status).toBe(409)
    expect((await fila(id)).angelpayWebhookSecret).toBeNull()
  })

  it('una cuenta inactiva no se registra', async () => {
    const inactiva = await cuenta({ active: false })
    expect((await registrar(inactiva.id)).status).toBe(422)
    expect(mockAuth).not.toHaveBeenCalled()
  })

  it('una cuenta que no existe es 404', async () => {
    expect((await registrar(cuid())).status).toBe(404)
    expect(mockAuth).not.toHaveBeenCalled()
  })

  it('un cuerpo inválido es 400 en español', async () => {
    const { id } = await cuenta()
    const respuesta = await registrar(id, {})
    expect(respuesta.status).toBe(400)
    expect(respuesta.body.message).toBe('La llave de API es requerida')
  })
})

describe('lo que lee el SUPERADMIN', () => {
  const leer = (ruta: string) =>
    request(app).get(`/api/v1/superadmin/merchant-accounts${ruta}`).set('Authorization', `Bearer ${tokenSuperadmin}`)

  it('detalle y lista dicen si está registrado y cuándo llegó el último aviso, sin el secreto', async () => {
    const recibido = new Date('2026-11-01T18:00:00.000Z')
    const sinAviso = await cuenta()
    const conAviso = await cuenta({
      externalMerchantId: '991',
      angelpayWebhookSecret: SECRETO,
      angelpayWebhookEndpointId: 'ep_1',
      angelpayWebhookLastReceivedAt: recibido,
    })
    // El criterio del ruling: con secreto ya hay canal, tenga o no su endpoint.
    const sinEndpoint = await cuenta({ externalMerchantId: '992', angelpayWebhookSecret: SECRETO })

    for (const [id, registrado] of [
      [sinAviso.id, false],
      [conAviso.id, true],
      [sinEndpoint.id, true],
    ] as const) {
      const detalle = await leer(`/${id}`)
      expect(detalle.body.data.angelpayWebhookRegistered).toBe(registrado)
      sinFugas(detalle)
    }
    expect((await leer(`/${conAviso.id}`)).body.data.angelpayWebhookLastReceivedAt).toBe(recibido.toISOString())

    const lista = await leer(`?providerId=${angelpayProviderId}`)
    const enLista = (id: string) => lista.body.data.find((c: { id: string }) => c.id === id)
    expect(enLista(sinAviso.id).angelpayWebhookRegistered).toBe(false)
    expect(enLista(conAviso.id).angelpayWebhookRegistered).toBe(true)
    sinFugas(lista)
  })
})

describe('el alta completa', () => {
  const alta = (over: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/v1/superadmin/merchant-accounts/full-setup-angelpay')
      .set('Authorization', `Bearer ${tokenSuperadmin}`)
      .send({
        venueId,
        login: { mode: 'existing', angelpayUserAccountId: loginId },
        merchant: { mode: 'create', externalMerchantId: '990', name: 'Boutique', affiliation: '123', displayName: 'Boutique Centro' },
        slot: { accountType: 'PRIMARY', mode: 'fill' },
        ...over,
      })

  const anotar = (respuesta: Response) => {
    if (respuesta.body?.data?.merchantAccountId) cuentasCreadas.push(respuesta.body.data.merchantAccountId)
    return respuesta
  }

  it('con la llave correcta: 201 y aviso registrado, una sola vez', async () => {
    const respuesta = anotar(await alta({ apiKey: LLAVE }))

    expect(respuesta.status).toBe(201)
    expect(respuesta.body.data.webhookRegistered).toBe(true)
    expect(respuesta.body.data.webhookRegistrationError).toBeUndefined()
    const { angelpayWebhookSecret } = await fila(respuesta.body.data.merchantAccountId)
    expect(angelpayWebhookSecret).toBe(SECRETO)
    expect(await asientos(respuesta.body.data.merchantAccountId)).toHaveLength(1)
    sinFugas(respuesta)
  })

  it('con la llave de otro comercio: la cuenta se crea igual, 201, sin aviso y con el motivo', async () => {
    mockAuth.mockImplementation(async () => ({ accessToken: 'token-de-prueba', merchantId: '991' }))

    const respuesta = anotar(await alta({ apiKey: LLAVE }))

    expect(respuesta.status).toBe(201)
    expect(respuesta.body.data.webhookRegistered).toBe(false)
    expect(respuesta.body.data.webhookRegistrationError).toContain('991')
    expect((await fila(respuesta.body.data.merchantAccountId)).active).toBe(true)
    expect((await fila(respuesta.body.data.merchantAccountId)).angelpayWebhookSecret).toBeNull()
    expect(mockRegister).not.toHaveBeenCalled()
    sinFugas(respuesta)
  })

  it('sin llave: la cuenta se crea, sin aviso, y el botón del detalle lo arregla después sin volver a dar de alta', async () => {
    const respuesta = anotar(await alta())

    expect(respuesta.status).toBe(201)
    expect(respuesta.body.data.webhookRegistered).toBe(false)
    expect(mockAuth).not.toHaveBeenCalled()

    expect((await registrar(respuesta.body.data.merchantAccountId)).body.data.webhookRegistered).toBe(true)
  })
})

/**
 * El apagador del SDK propio llega a la terminal por `GET /api/v1/tpv/terminals/:serial/config` (fase 3, bloque 2a, C1).
 * La puerta es PÚBLICA y la leen ~85 aparatos en ~35 versiones: `inHouseSdkEnabled: true` va en la RAÍZ de `data` sólo con la
 * columna `Terminal.inHouseSdkEnabled` en true Y el freno general `BLUMON_SDK_PROPIO_ENABLED` exactamente `'true'`. En cualquier
 * otro caso la respuesta es la de develop, llave por llave; y lo que el propio aparato haya guardado en su JSON nunca lo prende
 * (ni aparece dentro de `tpvSettings`). Postgres real; series ficticias AVQD-99000004xx (otros archivos usan otros rangos).
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   npx jest --selectProjects=integration --runTestsByPath tests/integration/tpv/configSdkPropio.integration.test.ts --ci
 */
import { randomUUID } from 'crypto'
import request from 'supertest'
import type { Express } from 'express'
import { Prisma, TerminalType } from '@prisma/client'

jest.mock('connect-pg-simple', () => (session: typeof import('express-session')) => session.MemoryStore)
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: () => null, getBroadcastingService: () => null },
}))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmail: jest.fn().mockResolvedValue(true) } }))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }))

const FRENO = 'BLUMON_SDK_PROPIO_ENABLED'
const FRENO_ORIGINAL = process.env[FRENO]
/** El JSON que el aparato ya trae guardado hoy (lo de siempre): un ajuste suyo cualquiera. */
const JSON_DE_SIEMPRE = { settings: { showTipScreen: false, tipSuggestions: [10, 15] } }
/**
 * Las llaves de `data` que devuelve develop para una PAX (no NEXGO) con el plan resuelto, copiadas del `res.json({ data: … })`
 * de `getTerminalConfig` en la base de esta rama (merge-base 7b6bf7bee = origin/develop 2241f19ac en ese archivo):
 * terminal, merchantAccounts, tpvSettings, cashReconciliationEnabled, angelpayAuth (null fuera de NEXGO, viaja),
 * angelpayAccounts (undefined fuera de NEXGO: el JSON la omite) y `...(plan ? { plan } : {})`. EN ESE ORDEN: la prueba compara
 * el orden real, no las llaves ordenadas (Codex b2a r1 (a)).
 */
const LLAVES_DE_DEVELOP = ['terminal', 'merchantAccounts', 'tpvSettings', 'cashReconciliationEnabled', 'angelpayAuth', 'plan']

let prisma: typeof import('@/utils/prismaClient').default
let appModule: typeof import('@/app')
let app: Express
const sufijo = randomUUID().slice(0, 8)
let orgId: string | undefined
let venueId: string | undefined
let proveedorPropio: string | undefined
let merchantId: string | undefined
let terminalId: string | undefined
const SERIE = 'AVQD-9900000400'

beforeAll(async () => {
  prisma = require('@/utils/prismaClient').default
  appModule = require('@/app')
  app = appModule.default

  orgId = (
    await prisma.organization.create({
      data: { name: `Negocio de prueba ${sufijo}`, email: `sdk-config-${sufijo}@example.test`, phone: '5500000000' },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Negocio de prueba', slug: `sdk-config-${sufijo}` } })).id
  const existente = await prisma.paymentProvider.findUnique({ where: { code: 'BLUMON' } })
  const blumonId =
    existente?.id ??
    (proveedorPropio = (
      await prisma.paymentProvider.create({ data: { code: 'BLUMON', name: 'Blumon', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] } })
    ).id)
  merchantId = (
    await prisma.merchantAccount.create({
      data: { providerId: blumonId, externalMerchantId: `sdk-config-${sufijo}`, credentialsEncrypted: {}, active: true },
    })
  ).id
  terminalId = (
    await prisma.terminal.create({
      data: {
        venueId,
        name: 'Caja 1',
        type: TerminalType.TPV_ANDROID,
        brand: 'PAX',
        serialNumber: SERIE,
        assignedMerchantIds: [merchantId],
        config: JSON_DE_SIEMPRE,
      },
    })
  ).id
})

afterEach(async () => {
  // El freno se restaura tal como estaba: ningún otro archivo del mismo proceso lo ve prendido.
  if (FRENO_ORIGINAL === undefined) delete process.env[FRENO]
  else process.env[FRENO] = FRENO_ORIGINAL
  // La terminal vuelve a lo de siempre: columna apagada y su JSON de siempre.
  if (terminalId) await prisma.terminal.update({ where: { id: terminalId }, data: { inHouseSdkEnabled: false, config: JSON_DE_SIEMPRE } })
})

afterAll(async () => {
  appModule?.detenerMonitorDeEventLoop()
  appModule?.getAppEventLoopHistogram().disable()
  if (terminalId) await prisma.terminal.deleteMany({ where: { id: terminalId } })
  if (merchantId) await prisma.merchantAccount.deleteMany({ where: { id: merchantId } })
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  if (proveedorPropio) await prisma.paymentProvider.deleteMany({ where: { id: proveedorPropio } })
})

type Respuesta = { success: boolean; data: Record<string, any> }

/** `GET /config` de la terminal de la prueba. Quita la única hora de la respuesta (`plan.accessObservedAt`). */
async function config(): Promise<Respuesta> {
  const res = await request(app).get(`/api/v1/tpv/terminals/${SERIE}/config`)
  expect(res.status).toBe(200)
  const body = res.body as Respuesta
  if (body.data?.plan) delete body.data.plan.accessObservedAt
  return body
}

function freno(valor: string | undefined) {
  if (valor === undefined) delete process.env[FRENO]
  else process.env[FRENO] = valor
}
const columna = (valor: boolean) => prisma.terminal.update({ where: { id: terminalId! }, data: { inHouseSdkEnabled: valor } })

/** La respuesta de referencia: columna en false, freno sin definir y el JSON de siempre. */
async function base() {
  freno(undefined)
  await columna(false)
  return config()
}

describe('GET /tpv/terminals/:serial/config — inHouseSdkEnabled (apagador + freno)', () => {
  it('columna false + freno abajo ⇒ data sin inHouseSdkEnabled ni en la raíz ni en tpvSettings', async () => {
    const b = await base()
    expect(b.success).toBe(true)
    expect(b.data).not.toHaveProperty('inHouseSdkEnabled')
    expect(b.data.tpvSettings).not.toHaveProperty('inHouseSdkEnabled')
    // La terminal la sirve normal: su afiliación de Blumon y su ajuste guardado llegan.
    expect(b.data.merchantAccounts.map((m: { id: string }) => m.id)).toEqual([merchantId])
    expect(b.data.tpvSettings).toMatchObject({ showTipScreen: false, tipSuggestions: [10, 15] })
  })

  it('columna true + freno abajo ⇒ la MISMA respuesta que base (toEqual)', async () => {
    const b = await base()
    await columna(true)
    expect(await config()).toEqual(b)
  })

  it('columna false + freno "true" ⇒ la misma que base', async () => {
    const b = await base()
    freno('true')
    expect(await config()).toEqual(b)
  })

  it.each(['TRUE', '1', 'True', ' true', ''])('freno %j + columna true ⇒ la misma que base', async valor => {
    const b = await base()
    await columna(true)
    freno(valor)
    expect(await config()).toEqual(b)
  })

  it('columna true + freno "true" ⇒ { ...base.data, inHouseSdkEnabled: true } y nada más cambia', async () => {
    const b = await base()
    await columna(true)
    freno('true')
    const prendida = await config()
    expect(prendida).toEqual({ ...b, data: { ...b.data, inHouseSdkEnabled: true } })
    expect(prendida.data.tpvSettings).not.toHaveProperty('inHouseSdkEnabled')
  })

  it.each([
    ['freno abajo', undefined],
    ['freno "true"', 'true'],
  ])(
    'el aparato guardó inHouseSdkEnabled:true en su JSON (PUT /tpv/terminals/:serial/settings), %s ⇒ ni tpvSettings ni la raíz lo traen; lo demás igual a base',
    async (_caso, valor) => {
      const b = await base()
      // Lo que dejaría el eco del aparato en `config.settings`: se siembra directo, sin pasar por su PUT.
      await prisma.terminal.update({
        where: { id: terminalId! },
        data: { config: { settings: { ...JSON_DE_SIEMPRE.settings, inHouseSdkEnabled: true } } as Prisma.InputJsonValue },
      })
      freno(valor)
      const conEco = await config()
      expect(conEco.data).not.toHaveProperty('inHouseSdkEnabled')
      expect(conEco.data.tpvSettings).not.toHaveProperty('inHouseSdkEnabled')
      expect(conEco).toEqual(b)
    },
  )

  it('las llaves de data con todo apagado son exactamente las de develop, en su orden', async () => {
    const b = await base()
    expect(Object.keys(b.data)).toEqual(LLAVES_DE_DEVELOP)
  })
})

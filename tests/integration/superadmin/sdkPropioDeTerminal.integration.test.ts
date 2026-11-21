/**
 * El único escritor del apagador del SDK propio (fase 3, bloque 2a): `cambiarSdkPropioDeTerminal`.
 * Prender pide la serie que vio quien prende (literal, bajo el candado) y la elegibilidad de /config; apagar siempre se puede y,
 * si ya está apagada, contesta sin candado. Cada cambio deja UNA bitácora; repetir el valor no deja ninguna. El candado es
 * `FOR NO KEY UPDATE`: ordena a dos escritores, pero no frena el alta de una orden o un pago de esa terminal.
 * Postgres real; series ficticias AVQD-99000001xx (el archivo del disparador usa …0001–…0009).
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   npx jest --selectProjects=integration --runTestsByPath tests/integration/superadmin/sdkPropioDeTerminal.integration.test.ts --ci
 */
import { randomUUID } from 'crypto'
import type { Request, Response } from 'express'
import { Prisma, TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getTerminalConfig } from '@/controllers/tpv/terminal.tpv.controller'
import {
  afiliacionesQueEntregaConfig,
  cambiarSdkPropioDeTerminal,
  elegibilidadDelSdkPropio,
} from '@/services/superadmin/sdkPropioDeTerminal.service'

// Lo mismo que simula la prueba vecina de /config (angelpayIdentity): fuera de la base, nada que ver con las afiliaciones.
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

const SERIAL_MISMATCH = 'TERMINAL_SERIAL_MISMATCH'
const NOT_ELIGIBLE = 'TERMINAL_NOT_ELIGIBLE_FOR_IN_HOUSE_SDK'
const SIN_BLUMON = 'No tiene una afiliación de Blumon activa que le llegue a la terminal'
const FORMATO = 'La serie no tiene el formato de una PAX'

const sufijo = randomUUID().slice(0, 8)
let orgId: string | undefined
let venueId: string
let venueHerenciaId: string
let venueDeLaOrgId: string
let staffId: string | undefined
let blumonId: string
let angelpayId: string
const proveedoresPropios: string[] = []
const terminalIds: string[] = []
const merchantIds: string[] = []
const orderIds: string[] = []
let consecutivo = 100
const nuevaSerie = () => `AVQD-99000${String(consecutivo++).padStart(5, '0')}` // AVQD-9900000100 … 199

async function proveedor(code: 'BLUMON' | 'ANGELPAY', name: string) {
  const existente = await prisma.paymentProvider.findUnique({ where: { code } })
  if (existente) return existente.id
  const creado = await prisma.paymentProvider.create({ data: { code, name, type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] } })
  proveedoresPropios.push(creado.id)
  return creado.id
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Negocio de prueba ${sufijo}`, email: `sdk-propio-${sufijo}@example.test`, phone: '5500000000' },
    })
  ).id
  const venue = (nombre: string, slug: string) => prisma.venue.create({ data: { organizationId: orgId!, name: nombre, slug } })
  venueId = (await venue('Negocio de prueba', `sdk-propio-${sufijo}`)).id
  venueHerenciaId = (await venue('Negocio de prueba 2', `sdk-propio-2-${sufijo}`)).id
  venueDeLaOrgId = (await venue('Negocio de prueba 3', `sdk-propio-3-${sufijo}`)).id
  staffId = (await prisma.staff.create({ data: { email: `sdk-propio-${sufijo}@example.test`, firstName: 'Prueba', lastName: 'Apagador' } }))
    .id
  blumonId = await proveedor('BLUMON', 'Blumon')
  angelpayId = await proveedor('ANGELPAY', 'AngelPay')
})

afterEach(async () => {
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
  await prisma.activityLog.deleteMany({ where: { entity: 'Terminal', entityId: { in: terminalIds } } })
  await prisma.venuePaymentConfig.deleteMany({ where: { venueId: { in: [venueId, venueHerenciaId, venueDeLaOrgId].filter(Boolean) } } })
  if (orgId) await prisma.organizationPaymentConfig.deleteMany({ where: { organizationId: orgId } })
  await prisma.terminal.deleteMany({ where: { id: { in: terminalIds } } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: merchantIds } } })
  orderIds.length = 0
  terminalIds.length = 0
  merchantIds.length = 0
})

afterAll(async () => {
  const venues = [venueId, venueHerenciaId, venueDeLaOrgId].filter(Boolean)
  if (venues.length) await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (proveedoresPropios.length) await prisma.paymentProvider.deleteMany({ where: { id: { in: proveedoresPropios } } })
})

async function afiliacion(cual: 'BLUMON' | 'ANGELPAY', active = true) {
  const m = await prisma.merchantAccount.create({
    data: {
      providerId: cual === 'BLUMON' ? blumonId : angelpayId,
      externalMerchantId: `sdk-propio-${sufijo}-${merchantIds.length}`,
      credentialsEncrypted: {},
      active,
    },
  })
  merchantIds.push(m.id)
  return m.id
}

type DatosTerminal = {
  serialNumber?: string | null
  type?: TerminalType
  brand?: string | null
  assignedMerchantIds?: string[]
  venueId?: string
}
async function terminal(datos: DatosTerminal = {}) {
  const t = await prisma.terminal.create({
    data: { venueId, name: 'Caja 1', type: TerminalType.TPV_ANDROID, brand: 'PAX', serialNumber: nuevaSerie(), ...datos },
  })
  terminalIds.push(t.id)
  return t
}
const paxElegible = async () => terminal({ assignedMerchantIds: [await afiliacion('BLUMON')] })

type Terminal = Awaited<ReturnType<typeof terminal>>
/** Sin segundo argumento, la serie guardada; con él, ESE valor tal cual (también `undefined`: un parámetro con valor por
 *  omisión lo tragaría y la prueba de «serie ausente» mandaría la buena). */
const prender = (t: Terminal, ...vista: [string | undefined] | []) =>
  cambiarSdkPropioDeTerminal({
    terminalId: t.id,
    enabled: true,
    serieEsperada: vista.length ? vista[0] : (t.serialNumber ?? undefined),
    staffId: staffId!,
    procedencia: 'superadmin-rest',
  })
const apagar = (terminalId: string) => cambiarSdkPropioDeTerminal({ terminalId, enabled: false, staffId: staffId!, procedencia: 'mcp' })
const estado = async (id: string) =>
  (await prisma.terminal.findUniqueOrThrow({ where: { id }, select: { inHouseSdkEnabled: true } })).inHouseSdkEnabled
const bitacoras = (id: string) =>
  prisma.activityLog.findMany({ where: { entity: 'Terminal', entityId: id }, orderBy: { createdAt: 'asc' } })
const prendidaAMano = (id: string) => prisma.terminal.update({ where: { id }, data: { inHouseSdkEnabled: true } })

/** Otra conexión abre una transacción, corre `pasos` y la deja abierta hasta que se llame a la función que devuelve. */
async function otraConexionSostiene(pasos: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let soltar!: () => void
  const suelta = new Promise<void>(r => (soltar = r))
  let listo!: () => void
  let fallo!: (e: unknown) => void
  const tomado = new Promise<void>((r, j) => ((listo = r), (fallo = j)))
  const fin = prisma.$transaction(
    async tx => {
      await pasos(tx)
      listo()
      await suelta
    },
    { timeout: 15_000, maxWait: 5_000 },
  )
  fin.catch(fallo)
  await tomado
  return async () => {
    soltar()
    await fin
  }
}

const sinEsperarMasDe = <T>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, j) => setTimeout(() => j(new Error(`esperó más de ${ms} ms`)), ms))])

async function configCuentas(serialNumber: string) {
  const response = { status: jest.fn(), json: jest.fn() }
  response.status.mockReturnValue(response)
  const next = jest.fn()
  await getTerminalConfig({ params: { serialNumber } } as unknown as Request, response as unknown as Response, next)
  expect(next).not.toHaveBeenCalled()
  return response.json.mock.calls[0][0].data.merchantAccounts as { id: string; providerCode: string }[]
}
async function configBlumon(serialNumber: string) {
  return (await configCuentas(serialNumber))
    .filter(m => m.providerCode === 'BLUMON')
    .map(m => m.id)
    .sort()
}

describe('cambiarSdkPropioDeTerminal — prender', () => {
  it('PAX TPV_ANDROID con afiliación Blumon asignada + serie correcta ⇒ changed:true, columna true, bitácora ENABLED', async () => {
    const t = await paxElegible()
    await expect(
      cambiarSdkPropioDeTerminal({
        terminalId: t.id,
        enabled: true,
        serieEsperada: t.serialNumber!,
        staffId: staffId!,
        reason: 'Piloto',
        procedencia: 'superadmin-rest',
        extra: { vistaPrevia: 'v1' },
      }),
    ).resolves.toEqual({ changed: true, enabled: true })

    // D6: el UPDATE sólo toca el apagador; la identidad queda igual (si no, el disparador lo apagaría en el mismo UPDATE).
    const guardada = await prisma.terminal.findUniqueOrThrow({ where: { id: t.id } })
    expect(guardada).toMatchObject({ inHouseSdkEnabled: true, serialNumber: t.serialNumber, type: t.type, brand: t.brand })

    const logs = await bitacoras(t.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      action: 'TERMINAL_IN_HOUSE_SDK_ENABLED',
      staffId,
      venueId,
      data: { reason: 'Piloto', procedencia: 'superadmin-rest', serialNumber: t.serialNumber, vistaPrevia: 'v1' },
    })
  })

  it('sin asignadas, hereda una afiliación Blumon del negocio ⇒ elegible y se prende', async () => {
    await prisma.venuePaymentConfig.create({ data: { venueId: venueHerenciaId, primaryAccountId: await afiliacion('BLUMON') } })
    const t = await terminal({ venueId: venueHerenciaId })
    await expect(elegibilidadDelSdkPropio(prisma, t.id)).resolves.toEqual({ elegible: true })
    await expect(prender(t)).resolves.toEqual({ changed: true, enabled: true })
    expect(await estado(t.id)).toBe(true)
  })

  it.each([
    ['ausente', () => undefined],
    ['distinta', () => 'AVQD-9900000199'],
    ['sólo difiere en mayúsculas', (s: string) => s.toLowerCase()],
    ['sin el prefijo AVQD-', (s: string) => s.slice('AVQD-'.length)],
  ])('serieEsperada %s ⇒ 409 TERMINAL_SERIAL_MISMATCH, sin cambios', async (_caso, serieVista) => {
    const t = await paxElegible()
    await expect(prender(t, serieVista(t.serialNumber!))).rejects.toMatchObject({ statusCode: 409, code: SERIAL_MISMATCH })
    expect(await estado(t.id)).toBe(false)
    expect(await bitacoras(t.id)).toHaveLength(0)
  })

  it('la serie se corrigió en la ficha entre la vista y el prender ⇒ 409 TERMINAL_SERIAL_MISMATCH', async () => {
    const t = await paxElegible()
    const vista = t.serialNumber!
    await prisma.terminal.update({ where: { id: t.id }, data: { serialNumber: nuevaSerie() } })
    await expect(prender(t, vista)).rejects.toMatchObject({ statusCode: 409, code: SERIAL_MISMATCH })
    expect(await estado(t.id)).toBe(false)
    expect(await bitacoras(t.id)).toHaveLength(0)
  })

  it.each([
    ['con una serie vista', 'AVQD-9900000198'],
    ['sin serie vista', undefined],
  ])('ficha con serie nula (%s) ⇒ 409 TERMINAL_SERIAL_MISMATCH antes de la elegibilidad, sin cambios', async (_caso, vista) => {
    // Nexgo y sin afiliaciones: si la elegibilidad corriera primero, el código sería NOT_ELIGIBLE.
    const t = await terminal({ serialNumber: null, brand: 'NEXGO' })
    await expect(prender(t, vista)).rejects.toMatchObject({
      statusCode: 409,
      code: SERIAL_MISMATCH,
      message: 'La terminal no tiene serie guardada; corrígela en la ficha.',
    })
    expect(await estado(t.id)).toBe(false)
    expect(await bitacoras(t.id)).toHaveLength(0)
  })

  it.each<[string, DatosTerminal, 'BLUMON' | 'ANGELPAY' | 'BLUMON_INACTIVA', string]>([
    ['Nexgo', { brand: 'NEXGO' }, 'BLUMON', 'No es una PAX (marca guardada: NEXGO)'],
    ['TPV_IOS', { type: TerminalType.TPV_IOS }, 'BLUMON', 'No es una terminal Android'],
    ['marca «pax» en minúsculas', { brand: 'pax' }, 'BLUMON', 'No es una PAX (marca guardada: pax)'],
    ['serie AVQD-UNKNOWN', { serialNumber: 'AVQD-UNKNOWN' }, 'BLUMON', FORMATO],
    ['serie de respaldo de Android', { serialNumber: 'AVQD-0000ABCD1234EF56' }, 'BLUMON', FORMATO],
    ['serie sin prefijo', { serialNumber: '9900000101' }, 'BLUMON', FORMATO],
    ['sólo afiliaciones AngelPay', {}, 'ANGELPAY', SIN_BLUMON],
    ['afiliación Blumon inactiva', {}, 'BLUMON_INACTIVA', SIN_BLUMON],
  ])('no elegible: %s ⇒ 409 TERMINAL_NOT_ELIGIBLE_FOR_IN_HOUSE_SDK, sin cambios ni bitácora', async (_caso, datos, cuenta, razon) => {
    const merchant = cuenta === 'BLUMON_INACTIVA' ? await afiliacion('BLUMON', false) : await afiliacion(cuenta)
    const t = await terminal({ ...datos, assignedMerchantIds: [merchant] })
    await expect(prender(t)).rejects.toMatchObject({ statusCode: 409, code: NOT_ELIGIBLE, message: razon })
    expect(await estado(t.id)).toBe(false)
    expect(await bitacoras(t.id)).toHaveLength(0)
  })

  it('el mismo valor dos veces ⇒ una sola bitácora (prender y apagar)', async () => {
    const t = await paxElegible()
    expect(await prender(t)).toEqual({ changed: true, enabled: true })
    expect(await prender(t)).toEqual({ changed: false, enabled: true })
    expect(await bitacoras(t.id)).toHaveLength(1)
    expect(await apagar(t.id)).toEqual({ changed: true, enabled: false })
    expect(await apagar(t.id)).toEqual({ changed: false, enabled: false })
    expect((await bitacoras(t.id)).map(l => l.action)).toEqual(['TERMINAL_IN_HOUSE_SDK_ENABLED', 'TERMINAL_IN_HOUSE_SDK_DISABLED'])
  })

  it('dos prender a la vez ⇒ uno changed:true y otro changed:false, una bitácora', async () => {
    const t = await paxElegible()
    const resultados = await Promise.all([prender(t), prender(t)])
    expect(resultados.map(r => r.changed).sort()).toEqual([false, true])
    expect(await estado(t.id)).toBe(true)
    expect(await bitacoras(t.id)).toHaveLength(1)
  })
})

describe('cambiarSdkPropioDeTerminal — apagar', () => {
  it('apagar sin serieEsperada ⇒ permitido, bitácora DISABLED con su procedencia', async () => {
    const t = await paxElegible()
    await prender(t)
    await expect(apagar(t.id)).resolves.toEqual({ changed: true, enabled: false })
    expect(await estado(t.id)).toBe(false)
    const logs = await bitacoras(t.id)
    expect(logs.map(l => l.action)).toEqual(['TERMINAL_IN_HOUSE_SDK_ENABLED', 'TERMINAL_IN_HOUSE_SDK_DISABLED'])
    expect(logs[1]).toMatchObject({ staffId, venueId, data: { procedencia: 'mcp', serialNumber: t.serialNumber, reason: null } })
  })

  it('apagar una YA apagada mientras otra conexión sostiene un UPDATE abierto (el latido) ⇒ changed:false sin esperar', async () => {
    const t = await paxElegible()
    const soltar = await otraConexionSostiene(tx => tx.$executeRaw`UPDATE "Terminal" SET "lastHeartbeat" = now() WHERE id = ${t.id}`)
    try {
      await expect(sinEsperarMasDe(2_000, apagar(t.id))).resolves.toEqual({ changed: false, enabled: false })
    } finally {
      await soltar()
    }
    expect(await bitacoras(t.id)).toHaveLength(0)
  })

  it('apagar una prendida mientras otra conexión la apaga ⇒ se turnan y la segunda ve el estado nuevo', async () => {
    const t = await paxElegible()
    await prendidaAMano(t.id)
    const soltar = await otraConexionSostiene(async tx => {
      await tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${t.id} FOR NO KEY UPDATE`
      await tx.$executeRaw`UPDATE "Terminal" SET "inHouseSdkEnabled" = false WHERE id = ${t.id}`
    })
    let terminado = false
    const segunda = apagar(t.id).finally(() => (terminado = true))
    try {
      await new Promise(r => setTimeout(r, 500))
      expect(terminado).toBe(false) // espera el candado de la otra
    } finally {
      await soltar()
    }
    await expect(segunda).resolves.toEqual({ changed: false, enabled: false })
    expect(await estado(t.id)).toBe(false)
    expect(await bitacoras(t.id)).toHaveLength(0)
  })

  it.each([true, false])('actor (staffId) inexistente (enabled=%s) ⇒ NotFoundError y nada cambia', async enabled => {
    const t = await paxElegible()
    if (!enabled) await prendidaAMano(t.id)
    await expect(
      cambiarSdkPropioDeTerminal({
        terminalId: t.id,
        enabled,
        serieEsperada: t.serialNumber!,
        staffId: 'cnoexistestaff00000000000',
        procedencia: 'mcp',
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(await estado(t.id)).toBe(!enabled)
    expect(await bitacoras(t.id)).toHaveLength(0)
  })

  it('si falla el alta de la bitácora, el interruptor se revierte con ella', async () => {
    const t = await paxElegible()
    const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>
    const espia = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: any) => unknown, opciones?: unknown) =>
      original(
        (tx: any) =>
          fn(
            new Proxy(tx, {
              get(objetivo, prop) {
                if (prop === 'activityLog') return { create: () => Promise.reject(new Error('falló la bitácora')) }
                return Reflect.get(objetivo, prop)
              },
            }),
          ),
        opciones,
      )) as never)
    try {
      await expect(prender(t)).rejects.toThrow('falló la bitácora')
    } finally {
      espia.mockRestore()
    }
    expect(await estado(t.id)).toBe(false)
    expect(await bitacoras(t.id)).toHaveLength(0)
  })

  it.each([true, false])('terminal inexistente (enabled=%s) ⇒ NotFoundError', async enabled => {
    await expect(
      cambiarSdkPropioDeTerminal({
        terminalId: 'cnoexiste0000000000000000',
        enabled,
        serieEsperada: 'AVQD-9900000197',
        staffId: staffId!,
        procedencia: 'mcp',
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('el candado: FOR NO KEY UPDATE (Codex r1 #2)', () => {
  it('el escritor toma la fila con FOR NO KEY UPDATE (nunca FOR UPDATE) y su UPDATE sólo toca el apagador', async () => {
    const t = await paxElegible()
    const consultas: string[] = []
    const actualizaciones: unknown[] = []
    const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>
    const espia = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: any) => unknown, opciones?: unknown) =>
      original(
        (tx: any) =>
          fn(
            new Proxy(tx, {
              get(objetivo, prop) {
                if (prop === '$queryRaw')
                  return (q: any, ...valores: unknown[]) => {
                    consultas.push(Array.isArray(q) ? q.join('?') : String(q?.sql ?? q))
                    return objetivo.$queryRaw(q, ...valores)
                  }
                if (prop === 'terminal')
                  return new Proxy(objetivo.terminal, {
                    get(modelo, metodo) {
                      if (metodo === 'update')
                        return (args: unknown) => {
                          actualizaciones.push(args)
                          return modelo.update(args)
                        }
                      return Reflect.get(modelo, metodo)
                    },
                  })
                return Reflect.get(objetivo, prop)
              },
            }),
          ),
        opciones,
      )) as never)
    try {
      await expect(prender(t)).resolves.toEqual({ changed: true, enabled: true })
    } finally {
      espia.mockRestore()
    }
    const candado = consultas.filter(c => /"Terminal"/.test(c))
    expect(candado).toHaveLength(1)
    expect(candado[0]).toMatch(/\bFOR\s+NO\s+KEY\s+UPDATE\b/)
    expect(consultas.some(c => /\bFOR\s+UPDATE\b/.test(c))).toBe(false)
    // Codex b2a r1 #4: primero el actor (`Staff … FOR KEY SHARE`) y después la terminal, el mismo orden que la limpieza de una
    // demo (Staff y luego Terminal); al revés, las dos podrían abrazarse.
    const actor = consultas.findIndex(c => /"Staff"/.test(c))
    expect(actor).toBeGreaterThanOrEqual(0)
    expect(consultas[actor]).toMatch(/\bFOR\s+KEY\s+SHARE\b/)
    expect(actor).toBeLessThan(consultas.findIndex(c => /"Terminal"/.test(c)))
    expect(actualizaciones).toEqual([{ where: { id: t.id }, data: { inHouseSdkEnabled: true } }])
  })

  const insertarOrdenSinEsperar = (terminalId: string) =>
    prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '1000ms'`)
      const orden = await tx.order.create({
        data: { venueId, terminalId, orderNumber: randomUUID(), subtotal: 100, taxAmount: 0, total: 100 },
      })
      orderIds.push(orden.id)
      return orden
    })

  it('con la fila en FOR NO KEY UPDATE, el alta de una orden de esa terminal NO espera', async () => {
    const t = await paxElegible()
    const soltar = await otraConexionSostiene(tx => tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${t.id} FOR NO KEY UPDATE`)
    try {
      await expect(insertarOrdenSinEsperar(t.id)).resolves.toMatchObject({ terminalId: t.id })
    } finally {
      await soltar()
    }
  })

  it('control: con FOR UPDATE, la misma alta SÍ espera (se corta por el tope de la sentencia)', async () => {
    const t = await paxElegible()
    const soltar = await otraConexionSostiene(tx => tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${t.id} FOR UPDATE`)
    try {
      await expect(insertarOrdenSinEsperar(t.id)).rejects.toThrow(/statement timeout/)
    } finally {
      await soltar()
    }
  })
})

describe('paridad con /config', () => {
  it('el filtro marca/proveedor: una PAX con AngelPay (sólo Nexgo) y otro proveedor sin restricción de marca, sin Blumon ⇒ no elegible, y el conjunto completo es el de /config', async () => {
    // En la tabla de compatibilidad sólo están BLUMON (PAX) y ANGELPAY (NEXGO): no hay OTRO proveedor atado a PAX. Lo más cercano
    // y honesto es uno fuera de la tabla, que es compatible con cualquier marca (`isProviderCompatibleWithBrand` ⇒ true).
    const otroProveedor = (
      await prisma.paymentProvider.create({
        data: { code: `PRUEBA${sufijo.toUpperCase()}`, name: 'Proveedor de prueba', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
      })
    ).id
    proveedoresPropios.push(otroProveedor)
    const angelpay = await afiliacion('ANGELPAY')
    const otra = (
      await prisma.merchantAccount.create({
        data: { providerId: otroProveedor, externalMerchantId: `sdk-propio-${sufijo}-otro`, credentialsEncrypted: {}, active: true },
      })
    ).id
    merchantIds.push(otra)
    const t = await terminal({ assignedMerchantIds: [angelpay, otra] })

    await expect(elegibilidadDelSdkPropio(prisma, t.id)).resolves.toEqual({ elegible: false, razon: SIN_BLUMON })
    const fila = await prisma.terminal.findUniqueOrThrow({ where: { id: t.id } })
    const deElegibilidad = (await afiliacionesQueEntregaConfig(prisma, fila)).map(m => m.id).sort()
    // Sin el filtro, AngelPay se colaría aquí y no en /config.
    expect(deElegibilidad).toEqual([otra])
    expect(deElegibilidad).toEqual((await configCuentas(t.serialNumber!)).map(m => m.id).sort())
  })

  it('Blumon SÓLO en el tercer espacio de la configuración heredada ⇒ elegible', async () => {
    await prisma.venuePaymentConfig.create({
      data: {
        venueId: venueHerenciaId,
        primaryAccountId: await afiliacion('ANGELPAY'),
        secondaryAccountId: await afiliacion('ANGELPAY'),
        tertiaryAccountId: await afiliacion('BLUMON'),
      },
    })
    const t = await terminal({ venueId: venueHerenciaId })
    await expect(elegibilidadDelSdkPropio(prisma, t.id)).resolves.toEqual({ elegible: true })
  })

  it('las afiliaciones de Blumon que acepta la elegibilidad son las que GET /tpv/terminals/:serial/config le entrega', async () => {
    const blumon = await afiliacion('BLUMON')
    const blumonInactiva = await afiliacion('BLUMON', false)
    const angelpay = await afiliacion('ANGELPAY')
    const blumonDelNegocio = await afiliacion('BLUMON')
    const blumonDeLaOrg = await afiliacion('BLUMON')
    await prisma.venuePaymentConfig.create({
      data: { venueId: venueHerenciaId, primaryAccountId: angelpay, secondaryAccountId: blumonDelNegocio },
    })
    await prisma.organizationPaymentConfig.create({ data: { organizationId: orgId!, primaryAccountId: blumonDeLaOrg } })

    const casos: [Terminal, string[]][] = [
      [await terminal({ assignedMerchantIds: [blumon, blumonInactiva, angelpay] }), [blumon]],
      [await terminal({ venueId: venueHerenciaId }), [blumonDelNegocio]],
      [await terminal({ venueId: venueDeLaOrgId }), [blumonDeLaOrg]],
      [await terminal({ assignedMerchantIds: [angelpay] }), []],
      [await terminal({ assignedMerchantIds: [blumonInactiva] }), []],
    ]
    for (const [t, esperadas] of casos) {
      const deConfig = await configBlumon(t.serialNumber!)
      expect(deConfig).toEqual(esperadas.sort())
      const fila = await prisma.terminal.findUniqueOrThrow({ where: { id: t.id } })
      const deElegibilidad = (await afiliacionesQueEntregaConfig(prisma, fila))
        .filter(m => m.provider.code === 'BLUMON')
        .map(m => m.id)
        .sort()
      expect(deElegibilidad).toEqual(deConfig)
      expect((await elegibilidadDelSdkPropio(prisma, t.id)).elegible).toBe(deConfig.length > 0)
    }
  })
})

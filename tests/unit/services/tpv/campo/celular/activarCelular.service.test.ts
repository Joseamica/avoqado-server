/**
 * Activar el celular (App de campo, bloque 1, Tarea 3): código + PIN → credencial, sesión y tokens propios del celular.
 * Prisma, las sesiones, los grants y la bitácora van mockeados; la base es una memoria chica que entiende los `where`.
 */
import { createHash, pbkdf2 } from 'crypto'
import { promisify } from 'util'
import jwt from 'jsonwebtoken'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createSession, revokeSession } from '@/services/auth/session.service'
import { invalidateSession } from '@/services/auth/sessionCache'
import socketManager from '@/communication/sockets/managers/socketManager'
import { issueGrant } from '@/services/auth/refreshGrant.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { sucursalesDeCampoDeLaPersona, sucursalesDeLaPersona } from '@/services/tpv/campo/celular/personasDeCampo'
import { esTokenDeLaApi } from '@/utils/tokenDeLaApi'
import { activarCelular, AparatoDelCelular } from '@/services/tpv/campo/celular/activarCelular.service'
import { autenticarCelular, CABECERA_CREDENCIAL, deviceIdDelCelular, hashDeCredencial } from '@/services/tpv/campo/celular/credencial'
import {
  crearSesionDeCelular,
  revocarSesionesDelCelular,
  sucursalesParaElCelular,
  verificadorDelPin,
} from '@/services/tpv/campo/celular/sesionDeCelular'
import { firmarAccesoDeCampo, nuevoRefreshDeCampo, verificarAccesoDeCampo } from '@/services/tpv/campo/celular/tokenDeCampo'
import { activarCelularSchema } from '@/schemas/tpv/campo.schema'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    codigoDeCelular: { findUnique: jest.fn(), updateMany: jest.fn() },
    celularDeCampo: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    staff: { findUnique: jest.fn() },
    session: { findMany: jest.fn(), updateMany: jest.fn() },
    venueSettings: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/services/auth/session.service', () => ({ createSession: jest.fn(), revokeSession: jest.fn() }))
jest.mock('@/services/auth/sessionCache', () => ({ invalidateSession: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({ __esModule: true, default: { disconnectBySession: jest.fn() } }))
jest.mock('@/services/auth/refreshGrant.service', () => ({ issueGrant: jest.fn() }))
jest.mock('@/services/mobile/auth.mobile.service', () => ({ refreshGrantExpiry: () => new Date('2026-11-16T12:00:00.000Z') }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/personasDeCampo', () => ({
  sucursalesDeLaPersona: jest.fn(),
  sucursalesDeCampoDeLaPersona: jest.fn(),
}))

const db = prisma as any
const AHORA = new Date('2026-11-09T12:00:00.000Z')
const MIN = 60 * 1000
const pbkdf2Async = promisify(pbkdf2)

/** ¿La fila cumple el `where` de Prisma? Sólo lo que usan estos servicios: igualdad, null, not, in, gt, lt. */
function coincide(fila: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v === null) return fila[k] == null
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return v.not === null ? fila[k] != null : fila[k] !== v.not
      if ('in' in v) return v.in.includes(fila[k])
      if ('gt' in v) return fila[k] > v.gt
      if ('lt' in v) return fila[k] < v.lt
      return true
    }
    return fila[k] === v
  })
}
function aplicar(fila: any, data: any) {
  for (const [k, v] of Object.entries(data) as [string, any][]) {
    if (v && typeof v === 'object' && 'increment' in v) fila[k] += v.increment
    else fila[k] = v
  }
}

let codigos: any[]
let celulares: any[]
let sesiones: any[]
let nSesion: number
let nCelular: number
let sucursales: any[]
let ajustes: any[]

const codigoVivo = (extra: Record<string, unknown> = {}) => ({
  id: 'cod1',
  organizationId: 'org1',
  staffId: 'staff1',
  codigo: 'ABC234',
  expiraAt: new Date(AHORA.getTime() + 7 * 24 * 60 * MIN),
  intentos: 0,
  usadoAt: null,
  usadoPorAparatoId: null,
  anuladoAt: null,
  ...extra,
})
const APARATO = { aparatoId: 'aparato-0001', marca: 'Samsung', modelo: 'A15', versionAndroid: '14', versionApp: '1.0.0' }
const activar = (pin = '4321', aparato: AparatoDelCelular = APARATO, codigo = 'ABC234') => activarCelular({ codigo, pin, aparato })
const falla = (p: Promise<unknown>) =>
  p.then(
    () => Promise.reject(new Error('debió fallar')),
    (e: any) => e,
  )

beforeEach(() => {
  jest.resetAllMocks()
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(AHORA)
  codigos = [codigoVivo()]
  celulares = []
  sesiones = []
  nSesion = 0
  nCelular = 0
  sucursales = [
    { staffVenueId: 'sv1', venueId: 'v1', nombre: 'Tienda Uno', role: 'WAITER', pin: '1111' },
    { staffVenueId: 'sv2', venueId: 'v2', nombre: 'Tienda Dos', role: 'CASHIER', pin: '4321' },
  ]
  ;(sucursalesDeLaPersona as jest.Mock).mockImplementation(() => Promise.resolve(sucursales.map(s => ({ ...s }))))
  // Lo que hace la real (A8): sólo rol de promotor; el módulo lo prueba personasDeCampo.test.ts.
  ;(sucursalesDeCampoDeLaPersona as jest.Mock).mockImplementation(() =>
    Promise.resolve(sucursales.filter(s => ['WAITER', 'CASHIER'].includes(s.role)).map(s => ({ ...s }))),
  )
  ;(logAction as jest.Mock).mockResolvedValue(undefined)
  ;(issueGrant as jest.Mock).mockResolvedValue({})
  ;(createSession as jest.Mock).mockImplementation((d: any) => {
    const s = { id: `ses${++nSesion}`, revokedAt: null, ...d }
    sesiones.push(s)
    return Promise.resolve(s)
  })
  ;(revokeSession as jest.Mock).mockImplementation((id: string) => {
    const s = sesiones.find(x => x.id === id && !x.revokedAt)
    if (s) s.revokedAt = new Date()
    return Promise.resolve(s ? 1 : 0)
  })
  db.$transaction.mockImplementation((fn: any) => fn(db))
  db.staff.findUnique.mockResolvedValue({ id: 'staff1', firstName: 'Ana', lastName: 'López' })
  db.codigoDeCelular.findUnique.mockImplementation(({ where }: any) => Promise.resolve(codigos.find(c => coincide(c, where)) ?? null))
  db.codigoDeCelular.updateMany.mockImplementation(({ where, data }: any) => {
    const filas = codigos.filter(c => coincide(c, where))
    filas.forEach(f => aplicar(f, data))
    return Promise.resolve({ count: filas.length })
  })
  db.celularDeCampo.findFirst.mockImplementation(({ where }: any) => Promise.resolve(celulares.find(c => coincide(c, where)) ?? null))
  db.celularDeCampo.findMany.mockImplementation(({ where }: any) => Promise.resolve(celulares.filter(c => coincide(c, where))))
  db.celularDeCampo.findUnique.mockImplementation(({ where }: any) => Promise.resolve(celulares.find(c => coincide(c, where)) ?? null))
  db.celularDeCampo.updateMany.mockImplementation(({ where, data }: any) => {
    const filas = celulares.filter(c => coincide(c, where))
    filas.forEach(f => aplicar(f, data))
    return Promise.resolve({ count: filas.length })
  })
  db.celularDeCampo.create.mockImplementation(({ data }: any) => {
    const c = { id: `cel${++nCelular}`, desvinculadoAt: null, motivoDesvinculo: null, ...data }
    celulares.push(c)
    return Promise.resolve({ ...c })
  })
  db.session.findMany.mockImplementation(({ where }: any) => Promise.resolve(sesiones.filter(s => coincide(s, where))))
  ajustes = []
  db.venueSettings.findMany.mockImplementation(({ where }: any) => Promise.resolve(ajustes.filter(a => coincide(a, where))))
  db.session.updateMany.mockImplementation(({ where, data }: any) => {
    const filas = sesiones.filter(s => coincide(s, where))
    filas.forEach(f => aplicar(f, data))
    return Promise.resolve({ count: filas.length })
  })
})
afterEach(() => jest.useRealTimers())

describe('tokenDeCampo', () => {
  const datos = { staffId: 'staff1', organizationId: 'org1', venueId: 'v1', role: 'WAITER' as const, sid: 'ses1' }

  it('firma con la llave y la audiencia propias del celular, 24 h, y se verifica', () => {
    const token = firmarAccesoDeCampo(datos)
    const llave = require('crypto').createHmac('sha256', process.env.ACCESS_TOKEN_SECRET!).update('avoqado-campo-v1').digest('hex')
    const crudo = jwt.verify(token, llave, { algorithms: ['HS256'], issuer: 'avoqado-api', audience: 'avoqado-campo' }) as any
    expect(crudo).toMatchObject({ sub: 'staff1', orgId: 'org1', venueId: 'v1', role: 'WAITER', sid: 'ses1' })
    expect(crudo.exp - crudo.iat).toBe(86400)
    expect(verificarAccesoDeCampo(token)).toMatchObject({ sub: 'staff1', orgId: 'org1', venueId: 'v1', role: 'WAITER', sid: 'ses1' })
  })

  it('NO es un token de la API: falla la llave común y `esTokenDeLaApi`', () => {
    const token = firmarAccesoDeCampo(datos)
    expect(() => jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!, { algorithms: ['HS256'] })).toThrow()
    expect(esTokenDeLaApi(jwt.decode(token))).toBe(false)
  })

  it('token de la API, otra audiencia, vencido o basura → 401 SESION_INVALIDA', () => {
    const llave = require('crypto').createHmac('sha256', process.env.ACCESS_TOKEN_SECRET!).update('avoqado-campo-v1').digest('hex')
    const malos = [
      jwt.sign({ sub: 'staff1', sid: 'ses1' }, process.env.ACCESS_TOKEN_SECRET!, { expiresIn: '1h' }),
      jwt.sign({ sub: 'staff1' }, llave, { issuer: 'avoqado-api', audience: 'avoqado-clients', expiresIn: '1h' }),
      jwt.sign({ sub: 'staff1' }, llave, { issuer: 'otro', audience: 'avoqado-campo', expiresIn: '1h' }),
      jwt.sign({ sub: 'staff1', exp: Math.floor(AHORA.getTime() / 1000) - 1 }, llave, { issuer: 'avoqado-api', audience: 'avoqado-campo' }),
      'no.es.jwt',
      // Firma y audiencia buenas, pero claims de otro tipo: sin orgId, o con un rol que no existe.
      jwt.sign({ sub: 'staff1', sid: 'ses1', venueId: 'v1', role: 'WAITER' }, llave, {
        issuer: 'avoqado-api',
        audience: 'avoqado-campo',
        expiresIn: '1h',
      }),
      jwt.sign({ sub: 'staff1', sid: 'ses1', venueId: 'v1', orgId: 'org1', role: 'REY' }, llave, {
        issuer: 'avoqado-api',
        audience: 'avoqado-campo',
        expiresIn: '1h',
      }),
    ]
    for (const t of malos) {
      let error: any
      try {
        verificarAccesoDeCampo(t)
      } catch (e) {
        error = e
      }
      expect(error).toMatchObject({ statusCode: 401, code: 'SESION_INVALIDA' })
    }
  })

  it('el refresh es opaco: 64 hex aleatorios', () => {
    const a = nuevoRefreshDeCampo()
    expect(a).toMatch(/^[a-f0-9]{64}$/)
    expect(nuevoRefreshDeCampo()).not.toBe(a)
  })
})

describe('credencial', () => {
  it('deviceId y hash', () => {
    expect(CABECERA_CREDENCIAL).toBe('x-celular-credencial')
    expect(deviceIdDelCelular('cel9')).toBe('celular:cel9')
    expect(hashDeCredencial('abc')).toBe(createHash('sha256').update('abc').digest('hex'))
  })

  const correr = async (cabecera: unknown) => {
    const req: any = { headers: cabecera === undefined ? {} : { [CABECERA_CREDENCIAL]: cabecera } }
    const res: any = { locals: {} }
    const next = jest.fn()
    await autenticarCelular(req, res, next)
    return { res, error: next.mock.calls[0][0] }
  }

  it('cabecera mal formada o hash desconocido → 401 CELULAR_DESCONOCIDO', async () => {
    for (const c of [undefined, '', 'XYZ', 'A'.repeat(64), 'a'.repeat(63), ['a'.repeat(64)]]) {
      expect((await correr(c)).error).toMatchObject({ statusCode: 401, code: 'CELULAR_DESCONOCIDO' })
    }
    expect((await correr('a'.repeat(64))).error).toMatchObject({ statusCode: 401, code: 'CELULAR_DESCONOCIDO' })
  })

  it('credencial conocida → res.locals.celular (aunque esté desvinculado)', async () => {
    const credencial = 'b'.repeat(64)
    celulares.push({ id: 'cel7', credencialHash: hashDeCredencial(credencial), staffIdVinculado: null })
    const { res, error } = await correr(credencial)
    expect(error).toBeUndefined()
    expect(res.locals.celular).toMatchObject({ id: 'cel7' })
  })
})

describe('verificadorDelPin y sucursalesParaElCelular', () => {
  it('PBKDF2-SHA256, 100 000 iteraciones, 32 bytes, en base64', async () => {
    const sal = Buffer.from('0123456789abcdef').toString('base64')
    const esperado = (await pbkdf2Async('1234', Buffer.from(sal, 'base64'), 100000, 32, 'sha256')).toString('base64')
    expect(await verificadorDelPin('1234', sal)).toEqual({ algoritmo: 'PBKDF2-SHA256', iteraciones: 100000, sal, hash: esperado })
  })

  it('cada sucursal lleva su verificador; sin PIN → null', async () => {
    sucursales[0].pin = null
    const sal = Buffer.alloc(16, 7).toString('base64')
    sucursales.push({ staffVenueId: 'sv3', venueId: 'v3', nombre: 'Donde es gerente', role: 'MANAGER', pin: '7777' })
    const r = await sucursalesParaElCelular({ staffId: 'staff1', organizationId: 'org1', pinSal: sal } as any)
    // S13: sólo las sucursales de campo (la de gerente no viaja al celular).
    expect(sucursalesDeCampoDeLaPersona).toHaveBeenCalledWith('staff1', 'org1')
    expect(r).toEqual([
      { venueId: 'v1', nombre: 'Tienda Uno', verificadorPin: null, seguimientoDeUbicacion: false },
      { venueId: 'v2', nombre: 'Tienda Dos', verificadorPin: await verificadorDelPin('4321', sal), seguimientoDeUbicacion: false },
    ])
  })

  it('seguimientoDeUbicacion = trackPromoterLocation de cada sucursal, en UNA consulta; sin fila de ajustes → false', async () => {
    ajustes = [
      { venueId: 'v1', trackPromoterLocation: true },
      { venueId: 'otra', trackPromoterLocation: true },
    ]
    const r = await sucursalesParaElCelular({ staffId: 'staff1', organizationId: 'org1', pinSal: 'c2Fs' } as any)
    expect(r.map(s => [s.venueId, s.seguimientoDeUbicacion])).toEqual([
      ['v1', true],
      ['v2', false],
    ])
    expect(db.venueSettings.findMany).toHaveBeenCalledTimes(1)
    expect(db.venueSettings.findMany.mock.calls[0][0].where.venueId).toEqual({ in: ['v1', 'v2'] })
  })

  it('apagado en la sucursal → false', async () => {
    ajustes = [{ venueId: 'v2', trackPromoterLocation: false }]
    const r = await sucursalesParaElCelular({ staffId: 'staff1', organizationId: 'org1', pinSal: 'c2Fs' } as any)
    expect(r.map(s => s.seguimientoDeUbicacion)).toEqual([false, false])
  })
})

describe('verificadorDelPin: memo (S11)', () => {
  it('el mismo PIN con la misma sal no vuelve a correr PBKDF2; otro PIN u otra sal sí', async () => {
    const real = jest.requireActual('crypto')
    const pbkdf2Espia = jest.fn(real.pbkdf2)
    let verificar!: typeof verificadorDelPin
    jest.isolateModules(() => {
      jest.doMock('crypto', () => ({ ...real, pbkdf2: pbkdf2Espia }))
      verificar = require('@/services/tpv/campo/celular/sesionDeCelular').verificadorDelPin
    })
    jest.dontMock('crypto')
    const sal = Buffer.alloc(16, 3).toString('base64')
    const primero = await verificar('2468', sal)
    expect(await verificar('2468', sal)).toEqual(primero)
    expect(pbkdf2Espia).toHaveBeenCalledTimes(1)
    await verificar('1357', sal)
    await verificar('2468', Buffer.alloc(16, 4).toString('base64'))
    expect(pbkdf2Espia).toHaveBeenCalledTimes(3)
  })
})

describe('crearSesionDeCelular', () => {
  const celular = (extra: Record<string, unknown> = {}) => {
    const c = {
      id: 'cel1',
      organizationId: 'org1',
      staffId: 'staff1',
      staffIdVinculado: 'staff1',
      sesionId: null,
      credencialHash: 'h0',
      ...extra,
    }
    celulares.push(c)
    return { ...c } as any
  }

  it('crea la Session del celular, la deja en sesionId (CAS desde null), emite el grant y tokens de campo', async () => {
    const c = celular()
    const s = await crearSesionDeCelular(c, { venueId: 'v2', role: 'CASHIER' as any })
    expect(createSession).toHaveBeenCalledWith({ staffId: 'staff1', venueId: 'v2', deviceId: 'celular:cel1', authMethod: 'PIN' })
    expect(db.celularDeCampo.updateMany).toHaveBeenCalledWith({
      where: { id: 'cel1', staffIdVinculado: { not: null }, sesionId: null },
      data: { sesionId: 'ses1' },
    })
    expect(celulares[0].sesionId).toBe('ses1')
    expect(issueGrant).toHaveBeenCalledWith('ses1', expect.any(String), s.refreshToken, new Date('2026-11-16T12:00:00.000Z'))
    expect(s).toMatchObject({ venueId: 'v2', expiraEn: 86400 })
    expect(s.refreshToken).toMatch(/^[a-f0-9]{64}$/)
    expect(verificarAccesoDeCampo(s.accessToken)).toMatchObject({
      sub: 'staff1',
      orgId: 'org1',
      venueId: 'v2',
      role: 'CASHIER',
      sid: 'ses1',
    })
  })

  it('si gana, revoca SÓLO la sesión anterior (y la saca de caché y socket)', async () => {
    sesiones.push({ id: 'vieja', deviceId: 'celular:cel1', revokedAt: null })
    const c = celular({ sesionId: 'vieja' })
    await crearSesionDeCelular(c, { venueId: 'v1', role: 'WAITER' as any })
    expect(celulares[0].sesionId).toBe('ses1')
    expect(revokeSession).toHaveBeenCalledWith('vieja', expect.any(String))
    expect(revokeSession).not.toHaveBeenCalledWith('ses1', expect.anything())
    expect(invalidateSession).toHaveBeenCalledWith('vieja')
    expect(socketManager.disconnectBySession).toHaveBeenCalledWith('vieja')
  })

  it('nuevaCredencialHash va en el MISMO CAS que la sesión', async () => {
    const c = celular()
    await crearSesionDeCelular(c, { venueId: 'v1', role: 'WAITER' as any }, { nuevaCredencialHash: 'h1' })
    expect(db.celularDeCampo.updateMany).toHaveBeenCalledTimes(1)
    expect(db.celularDeCampo.updateMany.mock.calls[0][0].data).toEqual({ sesionId: 'ses1', credencialHash: 'h1' })
    expect(celulares[0].credencialHash).toBe('h1')
  })

  it('pierde el CAS (otra entrada ya cambió sesionId) → revoca la suya, no toca nada y 409 ENTRADA_EN_PROCESO', async () => {
    const leido = celular() // leyó sesionId null
    celulares[0].sesionId = 'otra'
    const e = await falla(crearSesionDeCelular(leido, { venueId: 'v1', role: 'WAITER' as any }, { nuevaCredencialHash: 'h1' }))
    expect(e).toMatchObject({ statusCode: 409, code: 'ENTRADA_EN_PROCESO' })
    expect(celulares[0]).toMatchObject({ sesionId: 'otra', credencialHash: 'h0' })
    expect(revokeSession).toHaveBeenCalledWith('ses1', expect.any(String))
    expect(revokeSession).not.toHaveBeenCalledWith('otra', expect.anything())
    expect(invalidateSession).toHaveBeenCalledWith('ses1')
  })

  it('pierde porque lo desvincularon → revoca la suya y 401 CELULAR_DESVINCULADO', async () => {
    const leido = celular()
    celulares[0].staffIdVinculado = null
    const e = await falla(crearSesionDeCelular(leido, { venueId: 'v1', role: 'WAITER' as any }))
    expect(e).toMatchObject({ statusCode: 401, code: 'CELULAR_DESVINCULADO' })
    expect(revokeSession).toHaveBeenCalledWith('ses1', expect.any(String))
  })
})

describe('revocarSesionesDelCelular', () => {
  it('sólo las sesiones vivas de `celular:<id>`, salvo la indicada; caché y socket por cada una', async () => {
    sesiones.push(
      { id: 'a', deviceId: 'celular:cel1', revokedAt: null },
      { id: 'b', deviceId: 'celular:cel1', revokedAt: null },
      { id: 'pax', deviceId: 'PAX-123', revokedAt: null },
      { id: 'otro', deviceId: 'celular:cel2', revokedAt: null },
    )
    expect(await revocarSesionesDelCelular('cel1', 'campo_prueba', 'b')).toBe(1)
    expect(sesiones.find(s => s.id === 'a')).toMatchObject({ revokedReason: 'campo_prueba' })
    expect(sesiones.filter(s => s.revokedAt).map(s => s.id)).toEqual(['a'])
    expect(invalidateSession).toHaveBeenCalledWith('a')
    expect(socketManager.disconnectBySession).toHaveBeenCalledWith('a')
    expect(invalidateSession).toHaveBeenCalledTimes(1)
  })
})

describe('activarCelular', () => {
  it('1 · código que no existe → 404 CODIGO_INVALIDO', async () => {
    expect(await falla(activar('4321', APARATO, 'ZZZZZZ'))).toMatchObject({ statusCode: 404, code: 'CODIGO_INVALIDO' })
  })

  it('3 · anulado → 410 CODIGO_ANULADO; vencido → 410 CODIGO_VENCIDO', async () => {
    codigos = [codigoVivo({ anuladoAt: AHORA })]
    expect(await falla(activar())).toMatchObject({ statusCode: 410, code: 'CODIGO_ANULADO' })
    codigos = [codigoVivo({ expiraAt: AHORA })]
    expect(await falla(activar())).toMatchObject({ statusCode: 410, code: 'CODIGO_VENCIDO' })
  })

  it('4 · sin sucursales → 403 SIN_SUCURSAL; ninguna con PIN → 409 SIN_PIN', async () => {
    sucursales = []
    expect(await falla(activar())).toMatchObject({ statusCode: 403, code: 'SIN_SUCURSAL' })
    sucursales = [{ staffVenueId: 'sv1', venueId: 'v1', nombre: 'T', role: 'WAITER', pin: null }]
    expect(await falla(activar())).toMatchObject({ statusCode: 409, code: 'SIN_PIN' })
    expect(db.codigoDeCelular.updateMany).not.toHaveBeenCalled()
  })

  it('S13 · el PIN de una sucursal donde NO es promotora (gerente) no activa: 401 PIN_INCORRECTO', async () => {
    sucursales.push({ staffVenueId: 'sv3', venueId: 'v3', nombre: 'Donde es gerente', role: 'MANAGER', pin: '7777' })
    expect(await falla(activar('7777'))).toMatchObject({ statusCode: 401, code: 'PIN_INCORRECTO' })
    expect(celulares).toHaveLength(0)
    // Sólo con sucursales de gerente es como no tener sucursal de campo.
    sucursales = [{ staffVenueId: 'sv3', venueId: 'v3', nombre: 'Donde es gerente', role: 'MANAGER', pin: '7777' }]
    expect(await falla(activar('7777'))).toMatchObject({ statusCode: 403, code: 'SIN_SUCURSAL' })
  })

  it('5 · 4 PINes malos: 4, 3, 2, 1; el 5.º anula; luego el bueno → 410 CODIGO_ANULADO', async () => {
    for (const restantes of [4, 3, 2, 1]) {
      expect(await falla(activar('9999'))).toMatchObject({
        statusCode: 401,
        code: 'PIN_INCORRECTO',
        details: { intentosRestantes: restantes },
      })
    }
    expect(await falla(activar('9999'))).toMatchObject({ statusCode: 401, code: 'CODIGO_ANULADO', details: { intentosRestantes: 0 } })
    expect(codigos[0].anuladoAt).toEqual(AHORA)
    // El intento se reserva ANTES de comparar el PIN, en un solo UPDATE con su tope.
    expect(db.codigoDeCelular.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'cod1', codigo: 'ABC234', usadoAt: null, anuladoAt: null, expiraAt: { gt: AHORA }, intentos: { lt: 5 } },
      data: { intentos: { increment: 1 } },
    })
    expect(await falla(activar('4321'))).toMatchObject({ statusCode: 410, code: 'CODIGO_ANULADO' })
    expect(celulares).toEqual([])
  })

  it('6-7 · PIN bueno → 201: consume el código, crea el celular vinculado, sesión en la sucursal cuyo PIN coincidió', async () => {
    const r = await activar('4321')
    expect(r.status).toBe(201)
    expect(codigos[0]).toMatchObject({ usadoAt: AHORA, usadoPorAparatoId: 'aparato-0001', intentos: 0 })
    // [0] reserva el intento; [1] consume: ya sin mirar `intentos`, y lo vuelve a 0.
    expect(db.codigoDeCelular.updateMany.mock.calls[1][0]).toEqual({
      where: { id: 'cod1', codigo: 'ABC234', usadoAt: null, anuladoAt: null, expiraAt: { gt: AHORA } },
      data: { usadoAt: AHORA, usadoPorAparatoId: 'aparato-0001', intentos: 0 },
    })
    const cel = celulares[0]
    expect(cel).toMatchObject({
      organizationId: 'org1',
      staffId: 'staff1',
      staffIdVinculado: 'staff1',
      codigoId: 'cod1',
      aparatoId: 'aparato-0001',
      marca: 'Samsung',
      modelo: 'A15',
      versionAndroid: '14',
      versionApp: '1.0.0',
      sesionId: 'ses1',
    })
    expect(Buffer.from(cel.pinSal, 'base64')).toHaveLength(16)
    expect(r.body.credencial).toMatch(/^[a-f0-9]{64}$/)
    expect(cel.credencialHash).toBe(hashDeCredencial(r.body.credencial))
    expect(createSession).toHaveBeenCalledWith({ staffId: 'staff1', venueId: 'v2', deviceId: `celular:${cel.id}`, authMethod: 'PIN' })
    expect(r.body).toMatchObject({
      celularId: cel.id,
      persona: { staffId: 'staff1', nombre: 'Ana López' },
      repetida: false,
      horaDelServidor: AHORA.toISOString(),
      sesion: { venueId: 'v2', expiraEn: 86400 },
    })
    expect(r.body.sucursales.map((s: any) => s.venueId)).toEqual(['v1', 'v2'])
    expect(r.body.sucursales[1].verificadorPin).toEqual(await verificadorDelPin('4321', cel.pinSal))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CAMPO_CELULAR_ACTIVADO',
        entityId: cel.id,
        staffId: 'staff1',
        venueId: 'v2',
        organizationId: 'org1',
      }),
    )
    // La bitácora nunca guarda secretos.
    const textoDeBitacora = JSON.stringify((logAction as jest.Mock).mock.calls)
    expect(textoDeBitacora).not.toContain(r.body.credencial)
    expect(textoDeBitacora).not.toContain('4321')
    expect(textoDeBitacora).not.toContain('ABC234')
  })

  it('6-7 · activar otro celular desvincula el anterior (CELULAR_NUEVO) y revoca SÓLO sus sesiones', async () => {
    celulares.push({
      id: 'viejo',
      organizationId: 'org1',
      staffId: 'staff1',
      staffIdVinculado: 'staff1',
      sesionId: 'sv',
      credencialHash: 'hv',
    })
    sesiones.push({ id: 'sv', deviceId: 'celular:viejo', revokedAt: null }, { id: 'pax', deviceId: 'PAX-1', revokedAt: null })
    const r = await activar('1111')
    expect(r.status).toBe(201)
    expect(celulares[0]).toMatchObject({ staffIdVinculado: null, desvinculadoAt: AHORA, motivoDesvinculo: 'CELULAR_NUEVO', sesionId: null })
    expect(sesiones.find(s => s.id === 'sv').revokedAt).not.toBeNull()
    expect(sesiones.find(s => s.id === 'pax').revokedAt).toBeNull()
    expect(r.body.sesion.venueId).toBe('v1')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CAMPO_CELULAR_DESVINCULADO',
        entityId: 'viejo',
        data: expect.objectContaining({ motivo: 'CELULAR_NUEVO' }),
      }),
    )
  })

  describe('6 · el PIN bueno pierde el CAS del consumo → se contesta lo que dice la base', () => {
    /** Justo antes del consumo, el código cambia (otra activación lo usó, se anuló o venció). */
    const alConsumir = (cambio: (c: any) => void) => {
      const real = db.codigoDeCelular.updateMany.getMockImplementation()
      db.codigoDeCelular.updateMany.mockImplementation((args: any) => {
        if (args.data.usadoAt) cambio(codigos[0])
        return real(args)
      })
    }

    it.each([
      ['otra activación lo usó', (c: any) => (c.usadoAt = AHORA), { statusCode: 409, code: 'CODIGO_USADO' }],
      ['se anuló', (c: any) => (c.anuladoAt = AHORA), { statusCode: 401, code: 'CODIGO_ANULADO', details: { intentosRestantes: 0 } }],
      ['venció', (c: any) => (c.expiraAt = AHORA), { statusCode: 410, code: 'CODIGO_VENCIDO' }],
    ])('%s', async (_, cambio, esperado) => {
      alConsumir(cambio)
      expect(await falla(activar('4321'))).toMatchObject(esperado)
      expect(celulares).toEqual([])
      expect(createSession).not.toHaveBeenCalled()
    })
  })

  it('6 · otra activación de la persona creó su celular a la vez (P2002) → 409 ENTRADA_EN_PROCESO', async () => {
    db.celularDeCampo.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['staffIdVinculado'] },
      }),
    )
    expect(await falla(activar('4321'))).toMatchObject({ statusCode: 409, code: 'ENTRADA_EN_PROCESO' })
    expect(createSession).not.toHaveBeenCalled()
  })

  it('ráfaga de 10 PINes distintos en paralelo (uno bueno): máximo 5 comparaciones y el bueno no se delata', async () => {
    sucursales = [{ staffVenueId: 'sv2', venueId: 'v2', nombre: 'Tienda Dos', role: 'CASHIER', pin: '4321' }]
    const espia = jest.spyOn(require('crypto'), 'timingSafeEqual')
    const pines = ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '4321', '0008', '0009']
    const resultados = await Promise.all(pines.map((pin, i) => falla(activar(pin, { aparatoId: `aparato-rafaga-${i}` }))))
    const comparaciones = espia.mock.calls.length
    espia.mockRestore() // antes de afirmar: un espía que queda vivo lo vacía el `resetAllMocks` de la siguiente prueba
    expect(comparaciones).toBeLessThanOrEqual(5)
    expect(codigos[0].intentos).toBe(5)
    expect(celulares).toEqual([])
    const bueno = resultados[pines.indexOf('4321')]
    const malos = resultados.filter((_, i) => pines[i] !== '4321')
    expect(malos.map(m => `${m.statusCode}:${m.code}`)).toContain(`${bueno.statusCode}:${bueno.code}`)
  })

  describe('2 · código ya usado', () => {
    const primera = async () => {
      const r = await activar('4321')
      jest.clearAllMocks()
      return r
    }

    it('mismo aparato a los 9 min con el PIN bueno → 200 repetida, credencial nueva y sesión nueva', async () => {
      const r1 = await primera()
      const hashAntes = celulares[0].credencialHash
      jest.setSystemTime(new Date(AHORA.getTime() + 9 * MIN))
      const r2 = await activar('4321')
      expect(r2.status).toBe(200)
      expect(r2.body.repetida).toBe(true)
      expect(r2.body.celularId).toBe(r1.body.celularId)
      expect(r2.body.credencial).not.toBe(r1.body.credencial)
      expect(celulares[0].credencialHash).not.toBe(hashAntes)
      expect(celulares[0].credencialHash).toBe(hashDeCredencial(r2.body.credencial))
      expect(celulares[0].sesionId).toBe('ses2')
      expect(sesiones.find(s => s.id === 'ses1').revokedAt).not.toBeNull()
      expect(celulares).toHaveLength(1)
    })

    it('a los 11 min, con otro aparato, con PIN malo o con el celular desvinculado → 409 CODIGO_USADO', async () => {
      await primera()
      jest.setSystemTime(new Date(AHORA.getTime() + 11 * MIN))
      expect(await falla(activar('4321'))).toMatchObject({ statusCode: 409, code: 'CODIGO_USADO' })
      jest.setSystemTime(new Date(AHORA.getTime() + 5 * MIN))
      expect(await falla(activar('4321', { aparatoId: 'aparato-otro' }))).toMatchObject({ statusCode: 409, code: 'CODIGO_USADO' })
      expect(await falla(activar('9999'))).toMatchObject({ statusCode: 409, code: 'CODIGO_USADO' })
      celulares[0].staffIdVinculado = null
      expect(await falla(activar('4321'))).toMatchObject({ statusCode: 409, code: 'CODIGO_USADO' })
      expect(createSession).not.toHaveBeenCalled()
    })

    it('el reintento que pierde el CAS no cambia la credencial', async () => {
      await primera()
      const hashAntes = celulares[0].credencialHash
      db.celularDeCampo.updateMany.mockResolvedValueOnce({ count: 0 })
      jest.setSystemTime(new Date(AHORA.getTime() + 2 * MIN))
      expect(await falla(activar('4321'))).toMatchObject({ statusCode: 409, code: 'ENTRADA_EN_PROCESO' })
      expect(celulares[0].credencialHash).toBe(hashAntes)
    })

    it('los PINes malos en el reintento también cuentan: con 5, ya no hay reintento', async () => {
      await primera()
      jest.setSystemTime(new Date(AHORA.getTime() + 1 * MIN))
      for (let i = 0; i < 5; i++) await falla(activar('9999'))
      expect(await falla(activar('4321'))).toMatchObject({ statusCode: 409, code: 'CODIGO_USADO' })
      expect(createSession).not.toHaveBeenCalled()
    })
  })

  it('el PIN se compara en tiempo constante', async () => {
    const espia = jest.spyOn(require('crypto'), 'timingSafeEqual')
    await falla(activar('9999'))
    const llamadas = espia.mock.calls.length
    espia.mockRestore()
    expect(llamadas).toBeGreaterThan(0)
  })
})

describe('activarCelularSchema', () => {
  const parse = (body: any) => activarCelularSchema.safeParse({ body })
  const bueno = { codigo: 'abc234', pin: '1234', aparato: { aparatoId: 'aparato-0001' } }

  it('pasa el código a mayúsculas y acepta lo mínimo', () => {
    const r = parse(bueno)
    expect(r.success && r.data.body.codigo).toBe('ABC234')
  })

  it('rechaza código, PIN o aparato fuera de forma', () => {
    for (const malo of [
      { ...bueno, codigo: 'ABC23' },
      { ...bueno, codigo: 'ABC-23' },
      { ...bueno, pin: '123' },
      { ...bueno, pin: '12345678901' },
      { ...bueno, pin: '12a4' },
      { ...bueno, aparato: { aparatoId: 'corto' } },
      { ...bueno, aparato: { aparatoId: 'x'.repeat(101) } },
      { ...bueno, aparato: { aparatoId: 'aparato-0001', marca: 'm'.repeat(61) } },
      { codigo: 'ABC234', pin: '1234' },
    ]) {
      expect(parse(malo).success).toBe(false)
    }
  })
})

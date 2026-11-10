/**
 * La gracia de 24 h y «por revisar» (App de campo, bloque 1, Tarea 7). `aplicarEnvio` va mockeado (lo prueba
 * envioDeCampo.test.ts); la huella es la real. Los retenidos viven en una tabla en memoria con el MISMO comportamiento que
 * importa de Postgres: el único `(celularId, huella)` (P2002), los `updateMany` condicionados por estado (el CAS) y el
 * `@updatedAt` que Prisma pone en cada escritura (salvo que la escritura lo dé), que es la marca de «en vuelo» (I2).
 */
import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import { ConflictError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { staffHasPermissionInVenue } from '@/middlewares/checkPermission.middleware'
import { sucursalesDeCampoDeLaPersona, sucursalesDeLaPersona } from '@/services/tpv/campo/celular/personasDeCampo'
import { aplicarEnvio, efectoYaHecho, huellaDelEnvio } from '@/services/tpv/campo/celular/envioDeCampo'
import {
  listarRetenidos,
  reconciliarConLaRutaNormal,
  recibirEnGracia,
  resolverRetenido,
  VENTANA_EN_VUELO_MS,
} from '@/services/tpv/campo/celular/graciaDelCelular.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    // I8: el candado por celular abre una transacción; el doble la corre con el mismo cliente (la fila la pone el código).
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    venue: { findUnique: jest.fn(), findMany: jest.fn() },
    staff: { findMany: jest.fn() },
    envioRetenidoDeCampo: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    serializedItemCustodyEvent: { findMany: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/middlewares/checkPermission.middleware', () => ({ staffHasPermissionInVenue: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/personasDeCampo', () => ({
  sucursalesDeLaPersona: jest.fn(),
  sucursalesDeCampoDeLaPersona: jest.fn(),
}))
jest.mock('@/services/tpv/campo/celular/envioDeCampo', () => ({
  ...jest.requireActual('@/services/tpv/campo/celular/envioDeCampo'),
  aplicarEnvio: jest.fn(),
  efectoYaHecho: jest.fn(),
}))

const db = prisma as any
const aplicar = aplicarEnvio as jest.Mock
const sucursales = sucursalesDeLaPersona as jest.Mock
const deCampo = sucursalesDeCampoDeLaPersona as jest.Mock
const efecto = efectoYaHecho as jest.Mock
const permiso = staffHasPermissionInVenue as jest.Mock
const AHORA = new Date('2026-11-09T12:00:00.000Z')
const HORA = 60 * 60 * 1000
const DESVINCULADO = new Date(AHORA.getTime() - 2 * HORA)

/** La tabla de retenidos en memoria. */
let filas: any[]
const igual = (a: any, b: any) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)
const coincide = (f: any, where: any): boolean =>
  Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'AND') return v.every((w: any) => coincide(f, w))
    if (k === 'OR') return v.some((w: any) => coincide(f, w))
    if (!v || typeof v !== 'object' || v instanceof Date) return igual(f[k], v)
    if ('in' in v) return v.in.includes(f[k])
    if ('lt' in v) return f[k] instanceof Date && f[k] < v.lt
    if ('gte' in v) return f[k] instanceof Date && f[k] >= v.gte
    return igual(f[k], v)
  })
const MIN = 60 * 1000
const tick = () => new Promise(r => setImmediate(r))

const cuerpoVenta = (extra: object = {}) => JSON.stringify({ llave: randomUUID(), serialNumber: '89520001', precioVisto: 0, ...extra })
const envio = (cuerpoJson = cuerpoVenta(), tipo: any = 'VENTA', venueId = 'v1') => ({ tipo, venueId, cuerpoJson })
const celular = (extra: object = {}): any => ({
  id: 'cel1',
  organizationId: 'org1',
  staffId: 's1',
  staffIdVinculado: null,
  desvinculadoAt: DESVINCULADO,
  huellasPorSubir: [] as string[],
  huellasReportadasAt: new Date(DESVINCULADO.getTime() - HORA),
  ...extra,
})
/** El celular con la huella de este envío en su último latido. */
const reportado = (e: ReturnType<typeof envio>, extra: object = {}) =>
  celular({ huellasPorSubir: [huellaDelEnvio(e.tipo, e.venueId, e.cuerpoJson)], ...extra })
const CAPTURA = { captureSeq: 1, captureDeviceId: 'cel1', idempotencyKey: 'k1', capturedAt: '2026-11-09T10:00:00.000Z' }
const aplicado = (status = 201, body: object = { orderId: 'o', paymentId: 'p', repetida: false }) => ({ tipo: 'APLICADO', status, body })
const rechazado = (code = 'SIM_YA_VENDIDA') => ({ tipo: 'RECHAZADO', rechazo: { code, message: 'Esta SIM ya se vendió.' } })

beforeEach(() => {
  jest.resetAllMocks()
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }).setSystemTime(AHORA)
  filas = []
  // Como Postgres: si la transacción lanza, las filas que escribió vuelven a como estaban (y las que creó desaparecen).
  db.$transaction.mockImplementation(async (fn: any) => {
    const antes = new Map<any, any>()
    const r = db.envioRetenidoDeCampo
    const tx = {
      ...db,
      envioRetenidoDeCampo: {
        ...r,
        updateMany: async (a: any) => {
          filas.filter(f => coincide(f, a.where) && !antes.has(f)).forEach(f => antes.set(f, { ...f }))
          return r.updateMany(a)
        },
        create: async (a: any) => {
          const f = await r.create(a)
          antes.set(
            filas.find(x => x.id === f.id),
            null,
          )
          return f
        },
      },
    }
    try {
      return await fn(tx)
    } catch (error) {
      for (const [f, copia] of antes) {
        if (copia === null) filas.splice(filas.indexOf(f), 1)
        else {
          for (const k of Object.keys(f)) if (!(k in copia)) delete f[k]
          Object.assign(f, copia)
        }
      }
      throw error
    }
  })
  db.$queryRaw.mockResolvedValue([{ pg_advisory_xact_lock: '' }])
  db.venue.findUnique.mockImplementation(async ({ where }: any) => ({ organizationId: where.id === 'vOtra' ? 'org2' : 'org1' }))
  db.venue.findMany.mockResolvedValue([{ id: 'v1', name: 'Sucursal Centro', timezone: 'America/Mexico_City' }])
  db.staff.findMany.mockResolvedValue([{ id: 's1', firstName: 'Ana', lastName: 'Campo' }])
  // Como Postgres, una lectura es una FOTO de la fila (no la fila viva que después cambia otra escritura).
  const foto = (f: any) => (f ? { ...f } : null)
  db.envioRetenidoDeCampo.findUnique.mockImplementation(async ({ where }: any) =>
    foto(
      where.id
        ? filas.find(f => f.id === where.id)
        : filas.find(f => f.celularId === where.celularId_huella.celularId && f.huella === where.celularId_huella.huella),
    ),
  )
  db.envioRetenidoDeCampo.findFirst.mockImplementation(async ({ where }: any) => {
    await tick()
    return foto(filas.find(f => coincide(f, where)))
  })
  db.envioRetenidoDeCampo.updateMany.mockImplementation(async ({ where, data }: any) => {
    await tick()
    const m = filas.filter(f => coincide(f, where))
    m.forEach(f => Object.assign(f, { updatedAt: new Date() }, data)) // @updatedAt, salvo que la escritura lo dé
    return { count: m.length }
  })
  db.envioRetenidoDeCampo.create.mockImplementation(async ({ data }: any) => {
    if (filas.some(f => f.celularId === data.celularId && f.huella === data.huella)) {
      throw new Prisma.PrismaClientKnownRequestError('único', { code: 'P2002', clientVersion: 'x' })
    }
    const f = {
      id: `r${filas.length + 1}`,
      estado: 'PENDIENTE',
      rechazo: null,
      resultado: null,
      nota: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }
    filas.push(f)
    return f
  })
  db.envioRetenidoDeCampo.count.mockImplementation(async ({ where }: any) => filas.filter(f => coincide(f, where)).length)
  db.serializedItemCustodyEvent.findMany.mockResolvedValue([])
  sucursales.mockResolvedValue([{ staffVenueId: 'sv1', venueId: 'v1', nombre: 'Sucursal Centro', role: 'CASHIER', pin: null }])
  // Las de campo son las mismas salvo que la prueba diga otra cosa (T7).
  deCampo.mockImplementation((...a: any[]) => sucursales(...a))
  efecto.mockResolvedValue({ hecho: false })
  permiso.mockResolvedValue(true)
})
afterEach(() => jest.useRealTimers())

describe('recibirEnGracia', () => {
  it('una huella reportada dentro de las 24 h se aplica a nombre de la persona, con su celular, y queda en la bitácora', async () => {
    const e = envio()
    aplicar.mockResolvedValue(aplicado())
    const r = await recibirEnGracia(reportado(e), e)

    expect(r).toEqual({ status: 201, body: { orderId: 'o', paymentId: 'p', repetida: false, aplicadoEnGracia: true } })
    expect(aplicar).toHaveBeenCalledWith(
      { venueId: 'v1', orgId: 'org1', staffId: 's1', celularId: 'cel1' },
      'VENTA',
      JSON.parse(e.cuerpoJson),
    )
    expect(permiso).toHaveBeenCalledWith({ staffId: 's1', venueId: 'v1', permission: 'serialized-inventory:sell' })
    expect(permiso).toHaveBeenCalledWith({ staffId: 's1', venueId: 'v1', permission: 'payments:create' })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CAMPO_GRACIA_APLICADA',
        organizationId: 'org1',
        staffId: 's1',
        venueId: 'v1',
        data: { tipo: 'VENTA', huella: huellaDelEnvio('VENTA', 'v1', e.cuerpoJson), celularId: 'cel1' },
      }),
    )
    // Su desenlace queda por huella (fuera de la lista por omisión, que sólo trae PENDIENTE y APLICANDO).
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      estado: 'APLICADO',
      motivo: 'APLICADO_EN_GRACIA',
      huella: huellaDelEnvio('VENTA', 'v1', e.cuerpoJson),
      resultado: { orderId: 'o', paymentId: 'p', repetida: false },
      resueltoAt: AHORA,
    })
  })

  it('lo aplicado en gracia, reintentado pasadas las 24 h o tras una baja, devuelve lo guardado y no se retiene', async () => {
    const e = envio()
    aplicar.mockResolvedValue(aplicado())
    await recibirEnGracia(reportado(e), e)
    const tarde = await recibirEnGracia(reportado(e, { desvinculadoAt: new Date(AHORA.getTime() - 25 * HORA) }), e)
    expect(tarde).toEqual({ status: 200, body: { resuelto: 'APLICADO', resultado: { orderId: 'o', paymentId: 'p', repetida: false } } })
    sucursales.mockResolvedValue([])
    expect((await recibirEnGracia(reportado(e), e)).body).toMatchObject({ resuelto: 'APLICADO' })
    expect(aplicar).toHaveBeenCalledTimes(1)
    expect(filas).toHaveLength(1)
  })

  it('dos subidas a la vez de la misma huella admitida: la que pierde el único (P2002) no la vuelve a ejecutar (409 o lo aplicado); UNA fila', async () => {
    const e = envio()
    db.envioRetenidoDeCampo.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    aplicar.mockResolvedValue(aplicado())
    const [a, b] = await Promise.all(
      [recibirEnGracia(reportado(e), e), recibirEnGracia(reportado(e), e)].map(x =>
        x.then(
          r => r,
          err => err,
        ),
      ),
    )
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ estado: 'APLICADO', motivo: 'APLICADO_EN_GRACIA' })
    expect(aplicar).toHaveBeenCalledTimes(1)
    const [gano, perdio] = a.status === 201 ? [a, b] : [b, a]
    expect(gano.status).toBe(201)
    // I2: mientras la otra la aplica es 409 reintentable; si ya terminó, contesta lo aplicado.
    if (perdio instanceof Error) expect(perdio).toMatchObject({ statusCode: 409, code: 'APLICACION_EN_CURSO' })
    else expect(perdio.body).toMatchObject({ resuelto: 'APLICADO' })
  })

  it('custodia aceptada en parte en la gracia → fila APLICADA con las fallidas en resultado y 200 { resuelto: APLICADO }', async () => {
    const e = envio(
      JSON.stringify({
        sims: [
          { serialNumber: 'A', custodyVersion: 1 },
          { serialNumber: 'B', custodyVersion: 1 },
        ],
      }),
      'CUSTODIA_ACEPTAR',
    )
    const detalle = { summary: { total: 2, succeeded: 1, failed: 1 }, fallidas: [{ serialNumber: 'B', status: 'error', code: 'X' }] }
    aplicar.mockResolvedValue({ tipo: 'RECHAZADO', rechazo: { code: 'CUSTODIA_INCOMPLETA', message: 'm', detalle } })
    expect(await recibirEnGracia(reportado(e), e)).toEqual({ status: 200, body: { resuelto: 'APLICADO', resultado: detalle } })
    expect(filas[0]).toMatchObject({
      estado: 'APLICADO',
      motivo: 'APLICADO_EN_GRACIA',
      resultado: detalle,
      rechazo: { code: 'CUSTODIA_INCOMPLETA' },
    })
    // Ninguna aceptada: se retiene como cualquier rechazo.
    const g = envio(JSON.stringify({ sims: [{ serialNumber: 'C', custodyVersion: 1 }] }), 'CUSTODIA_ACEPTAR')
    aplicar.mockResolvedValue({
      tipo: 'RECHAZADO',
      rechazo: { code: 'CUSTODIA_INCOMPLETA', message: 'm', detalle: { ...detalle, summary: { total: 1, succeeded: 0, failed: 1 } } },
    })
    expect((await recibirEnGracia(reportado(g), g)).body).toEqual({ retenido: true, motivo: 'RECHAZADO' })
  })

  it('la misma llave de venta con OTRA SIM es otra huella → NO_REPORTADA (202 y una fila), sin aplicar', async () => {
    const llave = randomUUID()
    const reportada = envio(cuerpoVenta({ llave }))
    const otraSim = envio(cuerpoVenta({ llave, serialNumber: '89529999' }))
    const r = await recibirEnGracia(reportado(reportada), otraSim)
    expect(r).toEqual({ status: 202, body: { retenido: true, motivo: 'NO_REPORTADA' } })
    expect(aplicar).not.toHaveBeenCalled()
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      organizationId: 'org1',
      celularId: 'cel1',
      staffId: 's1',
      venueId: 'v1',
      tipo: 'VENTA',
      huella: huellaDelEnvio('VENTA', 'v1', otraSim.cuerpoJson),
      cuerpoJson: otraSim.cuerpoJson,
      motivo: 'NO_REPORTADA',
    })
  })

  it('huellas reportadas DESPUÉS de desvincular no cuentan → NO_REPORTADA', async () => {
    const e = envio()
    const r = await recibirEnGracia(reportado(e, { huellasReportadasAt: new Date(DESVINCULADO.getTime() + 1000) }), e)
    expect(r.body).toEqual({ retenido: true, motivo: 'NO_REPORTADA' })
  })

  it('a las 24 h + 1 s de desvincular → FUERA_DE_PLAZO', async () => {
    const e = envio()
    const r = await recibirEnGracia(reportado(e, { desvinculadoAt: new Date(AHORA.getTime() - 24 * HORA - 1000) }), e)
    expect(r).toEqual({ status: 202, body: { retenido: true, motivo: 'FUERA_DE_PLAZO' } })
    expect(aplicar).not.toHaveBeenCalled()
  })

  it('la misma huella dos veces → UNA fila y la segunda sale repetida', async () => {
    const e = envio()
    await recibirEnGracia(celular(), e)
    const otra = await recibirEnGracia(celular(), e)
    expect(otra).toEqual({ status: 202, body: { retenido: true, motivo: 'NO_REPORTADA', repetida: true } })
    expect(filas).toHaveLength(1)
  })

  it('dos a la vez con la misma huella: el único de la base deja UNA fila y la que pierde contesta como repetida', async () => {
    const e = envio()
    db.envioRetenidoDeCampo.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    const [a, b] = await Promise.all([recibirEnGracia(celular(), e), recibirEnGracia(celular(), e)])
    expect(filas).toHaveLength(1)
    expect([a.body, b.body]).toEqual(
      expect.arrayContaining([
        { retenido: true, motivo: 'NO_REPORTADA' },
        { retenido: true, motivo: 'NO_REPORTADA', repetida: true },
      ]),
    )
  })

  it('ya retenido y APLICADO, con el celular vinculado otra vez → 200 { resuelto: APLICADO, resultado }, no USA_TU_SESION', async () => {
    const e = envio()
    filas.push({
      id: 'r1',
      celularId: 'cel1',
      huella: huellaDelEnvio('VENTA', 'v1', e.cuerpoJson),
      estado: 'APLICADO',
      resultado: { paymentId: 'p' },
    })
    const r = await recibirEnGracia(celular({ staffIdVinculado: 's1', desvinculadoAt: null }), e)
    expect(r).toEqual({ status: 200, body: { resuelto: 'APLICADO', resultado: { paymentId: 'p' } } })
    filas[0].estado = 'DESCARTADO'
    filas[0].nota = 'era de prueba'
    expect(await recibirEnGracia(celular(), e)).toEqual({ status: 200, body: { resuelto: 'DESCARTADO', nota: 'era de prueba' } })
  })

  it('una sucursal de otra organización → 403 OTRA_ORGANIZACION sin retener nada', async () => {
    await expect(recibirEnGracia(celular(), envio(cuerpoVenta(), 'VENTA', 'vOtra'))).rejects.toMatchObject({
      statusCode: 403,
      code: 'OTRA_ORGANIZACION',
    })
    expect(filas).toHaveLength(0)
    expect(db.envioRetenidoDeCampo.create).not.toHaveBeenCalled()
  })

  it('un cuerpo que no es JSON → 400', async () => {
    await expect(recibirEnGracia(celular(), envio('{no es json'))).rejects.toMatchObject({ statusCode: 400 })
    expect(filas).toHaveLength(0)
  })

  it('un rechazo definitivo (SIM_YA_VENDIDA) se retiene con motivo RECHAZADO y su rechazo', async () => {
    const e = envio()
    aplicar.mockResolvedValue(rechazado())
    const r = await recibirEnGracia(reportado(e), e)
    expect(r).toEqual({ status: 202, body: { retenido: true, motivo: 'RECHAZADO' } })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      estado: 'PENDIENTE',
      motivo: 'RECHAZADO',
      rechazo: { code: 'SIM_YA_VENDIDA', message: 'Esta SIM ya se vendió.' },
    })
  })

  it('VENTA_EN_PROCESO se propaga y no se retiene: la fila queda APLICANDO (no descartable) y el reintento la termina', async () => {
    const e = envio()
    const enProceso = new ConflictError('procesando', 'VENTA_EN_PROCESO')
    aplicar.mockRejectedValueOnce(enProceso)
    await expect(recibirEnGracia(reportado(e), e)).rejects.toBe(enProceso)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ estado: 'APLICANDO', motivo: 'APLICADO_EN_GRACIA' })
    aplicar.mockResolvedValueOnce(aplicado(200, { orderId: 'o', paymentId: 'p', repetida: true }))
    expect((await recibirEnGracia(reportado(e), e)).status).toBe(200)
    expect(filas[0]).toMatchObject({ estado: 'APLICADO' })
  })

  it('celular vinculado y persona activa → 409 USA_TU_SESION', async () => {
    const e = envio()
    await expect(recibirEnGracia(reportado(e, { staffIdVinculado: 's1' }), e)).rejects.toMatchObject({
      statusCode: 409,
      code: 'USA_TU_SESION',
    })
    expect(filas).toHaveLength(0)
  })

  it('persona dada de baja (vinculado o no) → retenido PERSONA_DADA_DE_BAJA', async () => {
    const e = envio()
    sucursales.mockResolvedValue([])
    expect((await recibirEnGracia(reportado(e, { staffIdVinculado: 's1' }), e)).body).toEqual({
      retenido: true,
      motivo: 'PERSONA_DADA_DE_BAJA',
    })
    expect(aplicar).not.toHaveBeenCalled()
  })

  it('sin StaffVenue activo en la sucursal o sin un permiso → SIN_PERMISO', async () => {
    const e = envio()
    permiso.mockImplementation(async ({ permission }: any) => permission !== 'payments:create')
    expect((await recibirEnGracia(reportado(e), e)).body).toEqual({ retenido: true, motivo: 'SIN_PERMISO' })
    const otra = envio()
    sucursales.mockResolvedValue([{ staffVenueId: 'sv2', venueId: 'v2', nombre: 'Otra', role: 'CASHIER', pin: null }])
    expect((await recibirEnGracia(reportado(otra), otra)).body).toEqual({ retenido: true, motivo: 'SIN_PERMISO' })
  })

  it('la evidencia no necesita huella: se aplica si está en plazo', async () => {
    const e = envio(
      JSON.stringify({ ventaLlave: randomUUID(), photoUrls: ['https://example.test/a.jpg'], photoLabel: 'Vinculacion', ...CAPTURA }),
      'EVIDENCIA',
    )
    aplicar.mockResolvedValue(aplicado(200, { success: true }))
    expect(await recibirEnGracia(celular(), e)).toEqual({ status: 200, body: { success: true, aplicadoEnGracia: true } })
    expect(permiso).toHaveBeenCalledWith({ staffId: 's1', venueId: 'v1', permission: 'payments:create' })
  })

  it('evidencia de una venta sin ficha completa (o del celular nuevo) → retenida RECHAZADO VENTA_PENDIENTE', async () => {
    const e = envio(
      JSON.stringify({ ventaLlave: randomUUID(), photoUrls: ['https://example.test/a.jpg'], photoLabel: 'Vinculacion', ...CAPTURA }),
      'EVIDENCIA',
    )
    aplicar.mockResolvedValue({ tipo: 'RECHAZADO', rechazo: { code: 'VENTA_PENDIENTE', message: 'La venta aún no está completa.' } })
    expect((await recibirEnGracia(celular(), e)).body).toEqual({ retenido: true, motivo: 'RECHAZADO' })
    expect(filas[0].rechazo).toMatchObject({ code: 'VENTA_PENDIENTE' })
  })
})

/** Cuándo nació un retenido ya guardado: hace una hora (más que la ventana de I6). */
const NACIO = new Date(AHORA.getTime() - HORA)
/** Un retenido ya guardado, como lo deja la gracia. */
function retenido(extra: object = {}) {
  const f = {
    id: 'r1',
    organizationId: 'org1',
    celularId: 'cel1',
    staffId: 's1',
    venueId: 'v1',
    tipo: 'VENTA',
    huella: 'h'.repeat(64),
    cuerpoJson: cuerpoVenta(),
    motivo: 'NO_REPORTADA',
    rechazo: null,
    estado: 'PENDIENTE',
    resultado: null,
    nota: null,
    createdAt: NACIO, // I6: llegó hace una hora (ya se puede descartar)
    updatedAt: new Date(AHORA.getTime() - HORA), // tocada hace una hora: nadie la está aplicando
    ...extra,
  }
  filas.push(f)
  return f
}
const resolver = (accion: 'APLICAR' | 'DESCARTAR', extra: object = {}) =>
  resolverRetenido({ retenidoId: 'r1', organizationId: 'org1', accion, porStaffId: 'sup1', ...extra })

describe('resolverRetenido', () => {
  it('APLICAR: PENDIENTE → APLICANDO → APLICADO con su resultado; aplica a nombre de la persona y del celular, sin revisar permisos', async () => {
    const f = retenido()
    aplicar.mockResolvedValue(aplicado())
    const r = await resolver('APLICAR', { nota: 'sí la vendió' })

    expect(r).toEqual({ estado: 'APLICADO', resultado: { orderId: 'o', paymentId: 'p', repetida: false }, repetida: false })
    expect(aplicar).toHaveBeenCalledWith(
      { venueId: 'v1', orgId: 'org1', staffId: 's1', celularId: 'cel1' },
      'VENTA',
      JSON.parse(f.cuerpoJson),
    )
    expect(permiso).not.toHaveBeenCalled()
    expect(f).toMatchObject({ estado: 'APLICADO', resueltoPor: 'sup1', resueltoAt: AHORA, nota: 'sí la vendió' })
    // I2: tomarla es un CAS: PENDIENTE, o APLICANDO que nadie toca hace más de la ventana; la marca es su updatedAt.
    // I5: y exacto (la fila tal como se leyó), así quien la toma sabe en qué estado la tomó.
    expect(db.envioRetenidoDeCampo.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'r1',
        organizationId: 'org1',
        estado: 'PENDIENTE',
        updatedAt: new Date(AHORA.getTime() - HORA),
        OR: [{ estado: 'PENDIENTE' }, { estado: 'APLICANDO', updatedAt: { lt: new Date(AHORA.getTime() - 5 * MIN) } }],
      },
      data: { estado: 'APLICANDO', updatedAt: AHORA },
    })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CAMPO_RETENIDO_APLICADO', staffId: 'sup1', entityId: 'r1' }))
  })

  it('APLICAR repetido → lo guardado con repetida, sin volver a aplicar', async () => {
    retenido({ estado: 'APLICADO', resultado: { paymentId: 'p' } })
    expect(await resolver('APLICAR')).toEqual({ estado: 'APLICADO', resultado: { paymentId: 'p' }, repetida: true })
    expect(aplicar).not.toHaveBeenCalled()
  })

  it('APLICAR con un 4xx → vuelve a PENDIENTE con el rechazo y 422 NO_SE_PUDO_APLICAR', async () => {
    const f = retenido()
    aplicar.mockResolvedValue(rechazado())
    await expect(resolver('APLICAR')).rejects.toMatchObject({
      statusCode: 422,
      code: 'NO_SE_PUDO_APLICAR',
      details: { rechazo: { code: 'SIM_YA_VENDIDA', message: 'Esta SIM ya se vendió.' } },
    })
    expect(f).toMatchObject({ estado: 'PENDIENTE', rechazo: { code: 'SIM_YA_VENDIDA' } })
  })

  it('DESCARTAR después de APLICADO → 409 YA_APLICADO; APLICAR después de DESCARTADO → 409 YA_RESUELTO', async () => {
    const f = retenido({ estado: 'APLICADO' })
    await expect(resolver('DESCARTAR')).rejects.toMatchObject({ statusCode: 409, code: 'YA_APLICADO' })
    f.estado = 'DESCARTADO'
    await expect(resolver('APLICAR')).rejects.toMatchObject({ statusCode: 409, code: 'YA_RESUELTO' })
  })

  it('DESCARTAR: PENDIENTE → DESCARTADO con nota y quién; repetido → lo guardado con repetida', async () => {
    const f = retenido()
    expect(await resolver('DESCARTAR', { nota: 'era de prueba' })).toEqual({ estado: 'DESCARTADO', repetida: false })
    expect(f).toMatchObject({ estado: 'DESCARTADO', nota: 'era de prueba', resueltoPor: 'sup1', resueltoAt: AHORA })
    expect(await resolver('DESCARTAR')).toEqual({ estado: 'DESCARTADO', repetida: true })
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CAMPO_RETENIDO_DESCARTADO', data: expect.objectContaining({ nota: 'era de prueba' }) }),
    )
  })

  it('«Aplicar» lanzó a medias (queda APLICANDO): DESCARTAR → 409 APLICACION_A_MEDIAS y «Aplicar» otra vez termina', async () => {
    const f = retenido()
    aplicar.mockRejectedValueOnce(new ConflictError('procesando', 'VENTA_EN_PROCESO'))
    await expect(resolver('APLICAR')).rejects.toMatchObject({ code: 'VENTA_EN_PROCESO' })
    expect(f.estado).toBe('APLICANDO')

    await expect(resolver('DESCARTAR')).rejects.toMatchObject({ statusCode: 409, code: 'APLICACION_A_MEDIAS' })
    expect(f.estado).toBe('APLICANDO')

    aplicar.mockResolvedValueOnce(aplicado(200, { orderId: 'o', paymentId: 'p', repetida: true }))
    expect(await resolver('APLICAR')).toMatchObject({ estado: 'APLICADO', repetida: false })
    expect(f.estado).toBe('APLICADO')
    // Las dos veces con el MISMO cuerpo: la venta es idempotente por su llave, así que queda UNA.
    expect(aplicar.mock.calls[0]).toEqual(aplicar.mock.calls[1])
  })

  it('«Aplicar» y «Descartar» a la vez: o APLICADO con su venta, o DESCARTADO sin venta; nunca descartado con venta', async () => {
    for (const descartaPrimero of [true, false]) {
      filas = []
      aplicar.mockReset()
      const f = retenido()
      let soltar!: () => void
      aplicar.mockImplementation(() => new Promise(listo => (soltar = () => listo(aplicado()))))

      if (descartaPrimero) {
        expect(await resolver('DESCARTAR')).toEqual({ estado: 'DESCARTADO', repetida: false })
        await expect(resolver('APLICAR')).rejects.toMatchObject({ code: 'YA_RESUELTO' })
        expect(aplicar).not.toHaveBeenCalled()
      } else {
        const aplicando = resolver('APLICAR')
        while (!aplicar.mock.calls.length) await tick() // «Aplicar» ya la tomó y está aplicando
        // I2: nadie le quita la fila a quien la está aplicando.
        await expect(resolver('DESCARTAR')).rejects.toMatchObject({ statusCode: 409, code: 'APLICACION_EN_CURSO' })
        soltar()
        expect(await aplicando).toMatchObject({ estado: 'APLICADO' })
        expect(aplicar).toHaveBeenCalledTimes(1)
      }
      expect(f.estado).toBe(descartaPrimero ? 'DESCARTADO' : 'APLICADO')
    }
  })

  it('persona dada de baja + «Aplicar» una ENTRADA → 422 PERSONA_SIN_ASIGNACION sin tocar el estado ni checar', async () => {
    const f = retenido({ tipo: 'ENTRADA', cuerpoJson: JSON.stringify({ llave: randomUUID() }) })
    sucursales.mockResolvedValue([])
    const rechazo = {
      code: 'PERSONA_SIN_ASIGNACION',
      message: 'La persona ya no tiene asignación activa en esa sucursal: reactívala en esa sucursal o descártalo.',
    }
    await expect(resolver('APLICAR')).rejects.toMatchObject({
      statusCode: 422,
      code: 'NO_SE_PUDO_APLICAR',
      details: { motivo: 'PERSONA_SIN_ASIGNACION', rechazo },
    })
    expect(aplicar).not.toHaveBeenCalled()
    expect(f.estado).toBe('PENDIENTE')
    // S10: el rechazo queda en la fila, así «Por revisar» dice por qué.
    expect(f.rechazo).toEqual(rechazo)
  })

  it('la sucursal ya no es de la organización → 422 NO_SE_PUDO_APLICAR OTRA_ORGANIZACION', async () => {
    retenido({ venueId: 'vOtra' })
    await expect(resolver('APLICAR')).rejects.toMatchObject({ statusCode: 422, details: { motivo: 'OTRA_ORGANIZACION' } })
    expect(aplicar).not.toHaveBeenCalled()
  })

  it('custodia aceptada en parte → APLICADO con las filas fallidas en resultado', async () => {
    const f = retenido({ tipo: 'CUSTODIA_ACEPTAR', cuerpoJson: JSON.stringify({ sims: [] }) })
    const detalle = { summary: { total: 2, succeeded: 1, failed: 1 }, fallidas: [{ serialNumber: 'B', status: 'error', code: 'X' }] }
    aplicar.mockResolvedValue({ tipo: 'RECHAZADO', rechazo: { code: 'CUSTODIA_INCOMPLETA', message: 'm', detalle } })
    expect(await resolver('APLICAR')).toEqual({ estado: 'APLICADO', resultado: detalle, repetida: false })
    expect(f).toMatchObject({ estado: 'APLICADO', resultado: detalle })
    // Sin ninguna aceptada es un rechazo como los demás.
    const g = retenido({ id: 'r2', tipo: 'CUSTODIA_ACEPTAR', cuerpoJson: JSON.stringify({ sims: [] }) })
    aplicar.mockResolvedValue({
      tipo: 'RECHAZADO',
      rechazo: { code: 'CUSTODIA_INCOMPLETA', message: 'm', detalle: { ...detalle, summary: { total: 1, succeeded: 0, failed: 1 } } },
    })
    await expect(
      resolverRetenido({ retenidoId: 'r2', organizationId: 'org1', accion: 'APLICAR', porStaffId: 'sup1' }),
    ).rejects.toMatchObject({
      code: 'NO_SE_PUDO_APLICAR',
    })
    expect(g.estado).toBe('PENDIENTE')
  })

  it('otra organización no lo encuentra → 404', async () => {
    retenido()
    await expect(resolverRetenido({ retenidoId: 'r1', organizationId: 'org2', accion: 'APLICAR', porStaffId: 'x' })).rejects.toMatchObject({
      statusCode: 404,
    })
    await expect(
      resolverRetenido({ retenidoId: 'r1', organizationId: 'org2', accion: 'DESCARTAR', porStaffId: 'x' }),
    ).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(filas[0].estado).toBe('PENDIENTE')
  })
})

describe('listarRetenidos', () => {
  it('filtra en el servidor (uno o varios estados), pagina y arma nombre, sucursal y resumen', async () => {
    const fila = retenido({ cuerpoJson: JSON.stringify({ llave: randomUUID(), serialNumber: '89520001', precioVisto: 150 }) })
    db.envioRetenidoDeCampo.findMany.mockResolvedValue([fila])
    db.envioRetenidoDeCampo.count.mockResolvedValue(51)

    const r = await listarRetenidos('org1', { estado: ['PENDIENTE', 'APLICANDO'], staffId: 's1', page: 2, pageSize: 50 })

    const where = { organizationId: 'org1', staffId: 's1', estado: { in: ['PENDIENTE', 'APLICANDO'] } }
    expect(db.envioRetenidoDeCampo.findMany).toHaveBeenCalledWith({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 50,
      take: 50,
    })
    expect(db.envioRetenidoDeCampo.count).toHaveBeenCalledWith({ where })
    expect(r).toEqual({
      total: 51,
      items: [
        {
          id: 'r1',
          staffId: 's1',
          nombre: 'Ana Campo',
          venueId: 'v1',
          sucursal: 'Sucursal Centro',
          tipo: 'VENTA',
          motivo: 'NO_REPORTADA',
          rechazo: null,
          resumen: 'SIM 89520001 · $150.00',
          createdAt: NACIO,
          estado: 'PENDIENTE',
        },
      ],
    })
  })

  it('el resumen de cada tipo: checada → hora local, custodia → series, evidencia → fotos; el rechazo con su detalle', async () => {
    const hora = '2026-11-09T15:05:00.000Z'
    const filasDeTipo = [
      retenido({ id: 'a', tipo: 'ENTRADA', cuerpoJson: JSON.stringify({ llave: 'x', ocurrioAt: hora }) }),
      retenido({ id: 'b', tipo: 'CUSTODIA_ACEPTAR', cuerpoJson: JSON.stringify({ sims: [{ serialNumber: 'A' }, { serialNumber: 'B' }] }) }),
      retenido({ id: 'c', tipo: 'CUSTODIA_RECHAZAR', cuerpoJson: JSON.stringify({ serialNumber: 'C' }) }),
      retenido({ id: 'd', tipo: 'EVIDENCIA', cuerpoJson: JSON.stringify({ photoUrls: ['u1', 'u2'] }) }),
      retenido({
        id: 'e',
        motivo: 'RECHAZADO',
        rechazo: { code: 'SIM_YA_VENDIDA', message: 'ya', detalle: { x: 1 } },
        cuerpoJson: 'no es json',
      }),
    ]
    db.envioRetenidoDeCampo.findMany.mockResolvedValue(filasDeTipo)
    db.envioRetenidoDeCampo.count.mockResolvedValue(5)
    const { items } = await listarRetenidos('org1', { page: 1, pageSize: 50 })
    expect(items.map(i => i.resumen)).toEqual(['Entrada a las 09:05 del 9-nov', 'SIMs A, B', 'SIM C', '2 fotos', ''])
    expect(items[4].rechazo).toEqual({ code: 'SIM_YA_VENDIDA', message: 'ya', detalle: { x: 1 } })
    expect(items[0].rechazo).toBeNull()
  })
})

describe('resolverRetenido: lo que se aplica nunca queda sin decirlo', () => {
  it('si el CAS no lo toma y sigue sin resolver → 409 RETENIDO_EN_PROCESO sin aplicar', async () => {
    retenido()
    db.envioRetenidoDeCampo.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(resolver('APLICAR')).rejects.toMatchObject({ statusCode: 409, code: 'RETENIDO_EN_PROCESO' })
    expect(aplicar).not.toHaveBeenCalled()
  })

  it('si otro «Aplicar» lo regresó a PENDIENTE mientras éste aplicaba, queda APLICADO (no descartable con efecto)', async () => {
    const f = retenido()
    aplicar.mockImplementation(async () => {
      f.estado = 'PENDIENTE' // el otro «Aplicar» recibió un rechazo y lo regresó
      return aplicado()
    })
    expect(await resolver('APLICAR')).toMatchObject({ estado: 'APLICADO' })
    expect(f.estado).toBe('APLICADO')
    await expect(resolver('DESCARTAR')).rejects.toMatchObject({ code: 'YA_APLICADO' })
  })
})

describe('resolverRetenido: carreras (ronda 1)', () => {
  it('DESCARTAR cuyo CAS no toca nada y la relectura sigue PENDIENTE → 409 RETENIDO_EN_PROCESO, nunca la fila cruda', async () => {
    retenido()
    db.envioRetenidoDeCampo.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(resolver('DESCARTAR')).rejects.toMatchObject({ statusCode: 409, code: 'RETENIDO_EN_PROCESO' })
    expect(filas[0].estado).toBe('PENDIENTE')
  })

  it('el rechazo de un «Aplicar» cuando otro ya lo dejó APLICADO → contesta lo aplicado con repetida, no un 422', async () => {
    const f = retenido()
    aplicar.mockImplementation(async () => {
      Object.assign(f, { estado: 'APLICADO', resultado: { paymentId: 'pB' } }) // el otro «Aplicar» terminó primero
      return rechazado()
    })
    expect(await resolver('APLICAR')).toEqual({ estado: 'APLICADO', resultado: { paymentId: 'pB' }, repetida: true })
    expect(f).toMatchObject({ estado: 'APLICADO', rechazo: null })
  })
})

describe('arreglo final: lo hecho nunca queda descartable (S1, S2)', () => {
  it('S1 · la fila APLICANDO / APLICADO_EN_GRACIA existe ANTES de aplicar', async () => {
    const e = envio()
    aplicar.mockImplementation(async () => {
      expect(filas).toHaveLength(1)
      expect(filas[0]).toMatchObject({
        estado: 'APLICANDO',
        motivo: 'APLICADO_EN_GRACIA',
        huella: huellaDelEnvio('VENTA', 'v1', e.cuerpoJson),
      })
      return aplicado()
    })
    await recibirEnGracia(reportado(e), e)
    expect(aplicar).toHaveBeenCalledTimes(1)
    expect(filas[0].estado).toBe('APLICADO')
  })

  it('T2 · la venta quedó hecha y el proceso cayó antes de guardar: el reintento PASADAS las 24 h ve el efecto y queda APLICADO sin volver a aplicar', async () => {
    const e = envio()
    aplicar.mockRejectedValueOnce(new Error('se cayó el proceso después de la venta'))
    await expect(recibirEnGracia(reportado(e), e)).rejects.toThrow('se cayó')
    // Mientras tanto el supervisor no la puede descartar.
    await expect(resolver('DESCARTAR')).rejects.toMatchObject({ code: 'APLICACION_A_MEDIAS' })

    const hecha = { orderId: 'o', paymentId: 'p', saleVerificationId: 'sv', recuperado: true }
    efecto.mockResolvedValueOnce({ hecho: true, resultado: hecha })
    const tarde = await recibirEnGracia(reportado(e, { desvinculadoAt: new Date(AHORA.getTime() - 30 * HORA) }), e)
    expect(tarde).toEqual({ status: 200, body: { resuelto: 'APLICADO', resultado: hecha } })
    expect(efecto).toHaveBeenCalledWith(
      'VENTA',
      { venueId: 'v1', orgId: 'org1', staffId: 's1', celularId: 'cel1' },
      JSON.parse(e.cuerpoJson),
      AHORA,
      expect.anything(), // I8: la transacción del candado
    )
    expect(aplicar).toHaveBeenCalledTimes(1)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ estado: 'APLICADO', motivo: 'APLICADO_EN_GRACIA', resultado: hecha })
  })

  it('T2 / R2-2 · una ENTRADA a medias SIN efecto + la persona dada de baja + reintento → no se checa; queda PENDIENTE PERSONA_DADA_DE_BAJA', async () => {
    const e = envio(JSON.stringify({ llave: randomUUID() }), 'ENTRADA')
    aplicar.mockRejectedValueOnce(new Error('se cayó antes de crear la checada'))
    await expect(recibirEnGracia(reportado(e), e)).rejects.toThrow('se cayó')
    expect(filas[0]).toMatchObject({ estado: 'APLICANDO', motivo: 'APLICADO_EN_GRACIA' })

    deCampo.mockResolvedValue([]) // la dieron de baja
    expect(await recibirEnGracia(reportado(e), e)).toEqual({ status: 202, body: { retenido: true, motivo: 'PERSONA_DADA_DE_BAJA' } })
    expect(aplicar).toHaveBeenCalledTimes(1) // el reintento no ejecutó nada
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ estado: 'PENDIENTE', motivo: 'PERSONA_DADA_DE_BAJA' })
    // Ya es descartable: no tiene efecto (pasada la ventana de I6 desde que nació).
    jest.setSystemTime(new Date(AHORA.getTime() + 6 * MIN))
    expect(await resolver('DESCARTAR')).toEqual({ estado: 'DESCARTADO', repetida: false })
  })

  it('T2 · a medias SIN efecto y pasadas las 24 h → PENDIENTE FUERA_DE_PLAZO, sin volver a aplicar', async () => {
    const e = envio()
    aplicar.mockRejectedValueOnce(new ConflictError('procesando', 'VENTA_EN_PROCESO'))
    await expect(recibirEnGracia(reportado(e), e)).rejects.toMatchObject({ code: 'VENTA_EN_PROCESO' })
    const tarde = await recibirEnGracia(reportado(e, { desvinculadoAt: new Date(AHORA.getTime() - 30 * HORA) }), e)
    expect(tarde).toEqual({ status: 202, body: { retenido: true, motivo: 'FUERA_DE_PLAZO' } })
    expect(aplicar).toHaveBeenCalledTimes(1)
    expect(filas[0]).toMatchObject({ estado: 'PENDIENTE', motivo: 'FUERA_DE_PLAZO' })
  })

  const custodia = () => envio(JSON.stringify({ sims: [{ serialNumber: 'SIM-A', custodyVersion: 2 }] }), 'CUSTODIA_ACEPTAR')
  const simVendida = {
    tipo: 'RECHAZADO',
    rechazo: { code: 'CUSTODIA_INCOMPLETA', message: 'm', detalle: { summary: { total: 1, succeeded: 0, failed: 1 } } },
  }

  const recuperada = { recuperadoDeLaBitacora: true, eventos: [{ serialNumber: 'SIM-A', at: AHORA.toISOString() }] }

  it('R2-1 · gracia, PRIMER intento: la ruta normal ya la aceptó (respuesta perdida) y la SIM se vendió; el rechazo consulta el efecto → APLICADO', async () => {
    const e = custodia()
    aplicar.mockResolvedValueOnce(simVendida)
    // Antes de ejecutar todavía no se ve (I1); la ruta normal la termina mientras tanto y el rechazo vuelve a preguntar.
    efecto.mockResolvedValueOnce({ hecho: false }).mockResolvedValueOnce({ hecho: true, resultado: recuperada })
    const r = await recibirEnGracia(reportado(e), e)
    expect(r).toEqual({ status: 200, body: { resuelto: 'APLICADO', resultado: recuperada } })
    expect(filas[0]).toMatchObject({ estado: 'APLICADO', resultado: recuperada })
    expect(efecto).toHaveBeenCalledWith(
      'CUSTODIA_ACEPTAR',
      { venueId: 'v1', orgId: 'org1', staffId: 's1', celularId: 'cel1' },
      JSON.parse(e.cuerpoJson),
      AHORA,
      expect.anything(), // I8: la transacción del candado
    )
    await expect(resolver('DESCARTAR')).rejects.toMatchObject({ code: 'YA_APLICADO' })
  })

  it('gracia: rechazo y sin efecto → PENDIENTE con su rechazo', async () => {
    const e = custodia()
    aplicar.mockResolvedValueOnce(simVendida)
    expect((await recibirEnGracia(reportado(e), e)).body).toEqual({ retenido: true, motivo: 'RECHAZADO' })
    expect(efecto).toHaveBeenCalledTimes(2) // antes de ejecutar (I1) y antes de regresarla
    expect(filas[0]).toMatchObject({ estado: 'PENDIENTE', motivo: 'RECHAZADO', rechazo: { code: 'CUSTODIA_INCOMPLETA' } })
  })

  it('T2 · «Aplicar» reanuda un APLICANDO: primero el efecto; ya hecho → APLICADO sin ejecutar ni pedir asignación', async () => {
    const f = retenido({ tipo: 'CUSTODIA_RECHAZAR', cuerpoJson: JSON.stringify({ serialNumber: 'SIM-C', custodyVersion: 1 }) })
    aplicar.mockRejectedValueOnce(new ConflictError('cambió', 'CUSTODIA_EN_PROCESO'))
    await expect(resolver('APLICAR')).rejects.toMatchObject({ code: 'CUSTODIA_EN_PROCESO' })
    expect(f.estado).toBe('APLICANDO')
    sucursales.mockResolvedValue([]) // ya no está asignada: recuperar no es ejecutar
    efecto.mockResolvedValueOnce({ hecho: true, resultado: { recuperadoDeLaBitacora: true } })
    expect(await resolver('APLICAR')).toEqual({ estado: 'APLICADO', resultado: { recuperadoDeLaBitacora: true }, repetida: false })
    expect(aplicar).toHaveBeenCalledTimes(1)
    expect(f).toMatchObject({ estado: 'APLICADO', resueltoPor: 'sup1' })
    expect(efecto).toHaveBeenLastCalledWith(
      'CUSTODIA_RECHAZAR',
      { venueId: 'v1', orgId: 'org1', staffId: 's1', celularId: 'cel1' },
      { serialNumber: 'SIM-C', custodyVersion: 1 },
      NACIO,
      expect.anything(), // I8: la transacción del candado
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CAMPO_RETENIDO_APLICADO', data: expect.objectContaining({ recuperado: true }) }),
    )
  })

  it('T2 · «Aplicar» reanuda un APLICANDO sin efecto y la persona sin asignación → 422 PERSONA_SIN_ASIGNACION sin ejecutar (A6)', async () => {
    const f = retenido({ estado: 'APLICANDO', tipo: 'ENTRADA', cuerpoJson: JSON.stringify({ llave: randomUUID() }) })
    sucursales.mockResolvedValue([])
    await expect(resolver('APLICAR')).rejects.toMatchObject({ details: { motivo: 'PERSONA_SIN_ASIGNACION' } })
    expect(aplicar).not.toHaveBeenCalled()
    expect(f.estado).toBe('APLICANDO')
  })

  it('«Aplicar»: una VENTA desde APLICANDO con rechazo y sin efecto vuelve a PENDIENTE', async () => {
    const f = retenido({ estado: 'APLICANDO' })
    aplicar.mockResolvedValueOnce(rechazado())
    await expect(resolver('APLICAR')).rejects.toMatchObject({ code: 'NO_SE_PUDO_APLICAR' })
    expect(f.estado).toBe('PENDIENTE')
    expect(efecto).toHaveBeenCalledTimes(2) // antes de reanudar y antes de regresarla
  })

  it('R2-1 · «Aplicar» desde PENDIENTE (primer intento): rechazo, pero la ruta normal ya la había aceptado → APLICADO, no PENDIENTE', async () => {
    const f = retenido({ tipo: 'CUSTODIA_RECHAZAR', cuerpoJson: JSON.stringify({ serialNumber: 'SIM-D', custodyVersion: 1 }) })
    aplicar.mockResolvedValueOnce({ tipo: 'RECHAZADO', rechazo: { code: 'NOT_IN_YOUR_CUSTODY', message: 'ya no' } })
    efecto.mockResolvedValueOnce({ hecho: false }).mockResolvedValueOnce({ hecho: true, resultado: { recuperadoDeLaBitacora: true } })
    expect(await resolver('APLICAR')).toMatchObject({ estado: 'APLICADO', resultado: { recuperadoDeLaBitacora: true } })
    expect(f.estado).toBe('APLICADO')
    expect(efecto).toHaveBeenCalledTimes(2) // antes de ejecutar (I1) y antes de regresarla
  })

  it('R2-1 · dos «Aplicar» a la vez: el segundo ve la fila en vuelo → 409 (I2); el primero cae tras aceptar y el tercero la recupera', async () => {
    const f = retenido({ tipo: 'CUSTODIA_ACEPTAR', cuerpoJson: JSON.stringify({ sims: [{ serialNumber: 'SIM-E', custodyVersion: 1 }] }) })
    let caer!: () => void
    aplicar.mockImplementationOnce(() => new Promise((_, rechazar) => (caer = () => rechazar(new Error('cayó tras aceptar')))))
    let aceptada = false
    efecto.mockImplementation(async () => (aceptada ? { hecho: true, resultado: { recuperadoDeLaBitacora: true } } : { hecho: false }))
    const a = resolver('APLICAR').then(
      r => r,
      e => e,
    )
    while (!aplicar.mock.calls.length) await tick()
    aceptada = true // el primero ya aceptó la SIM en la base
    await expect(resolver('APLICAR')).rejects.toMatchObject({ statusCode: 409, code: 'APLICACION_EN_CURSO' })
    expect(f.estado).toBe('APLICANDO')
    caer()
    expect(await a).toMatchObject({ message: 'cayó tras aceptar' })
    // Al caer la soltó: el siguiente «Aplicar» no espera la ventana, mira el efecto y la deja APLICADA sin ejecutar.
    expect(await resolver('APLICAR')).toMatchObject({ estado: 'APLICADO', resultado: { recuperadoDeLaBitacora: true } })
    expect(aplicar).toHaveBeenCalledTimes(1)
    expect(f.estado).toBe('APLICADO')
  })
})

describe('arreglo final 3: una VENTA con su ficha EN_CURSO está A MEDIAS (U2)', () => {
  const AMEDIAS = { hecho: false, aMedias: true }

  it('«Aplicar»: ficha EN_CURSO + rechazo definitivo → sigue APLICANDO (no PENDIENTE), «Descartar» → 409, «Aplicar» completa UNA venta', async () => {
    const f = retenido()
    efecto.mockResolvedValue(AMEDIAS)
    aplicar.mockResolvedValueOnce(rechazado('VENTAS_DESHABILITADAS'))
    await expect(resolver('APLICAR')).rejects.toMatchObject({
      statusCode: 422,
      code: 'NO_SE_PUDO_APLICAR',
      details: { aMedias: true, rechazo: { code: 'VENTAS_DESHABILITADAS' } },
    })
    expect(f).toMatchObject({ estado: 'APLICANDO', rechazo: { code: 'VENTAS_DESHABILITADAS' } })

    await expect(resolver('DESCARTAR')).rejects.toMatchObject({ statusCode: 409, code: 'APLICACION_A_MEDIAS' })
    expect(f.estado).toBe('APLICANDO')

    aplicar.mockResolvedValueOnce(aplicado(200, { orderId: 'o', paymentId: 'p', repetida: true }))
    expect(await resolver('APLICAR')).toMatchObject({ estado: 'APLICADO', resultado: { orderId: 'o' } })
    expect(f.estado).toBe('APLICADO')
    expect(aplicar).toHaveBeenCalledTimes(2)
    expect(aplicar.mock.calls[0]).toEqual(aplicar.mock.calls[1]) // la misma llave: el servicio retoma la ficha, UNA venta
  })

  it('gracia, intento en plazo: rechazo con la ficha EN_CURSO → la fila sigue APLICANDO (el reintento de gracia la termina)', async () => {
    const e = envio()
    efecto.mockResolvedValue(AMEDIAS)
    aplicar.mockResolvedValueOnce(rechazado('VENTAS_DESHABILITADAS'))
    expect(await recibirEnGracia(reportado(e), e)).toEqual({
      status: 202,
      body: { retenido: true, motivo: 'RECHAZADO', aMedias: true },
    })
    expect(filas[0]).toMatchObject({ estado: 'APLICANDO', motivo: 'APLICADO_EN_GRACIA', rechazo: { code: 'VENTAS_DESHABILITADAS' } })
    await expect(resolver('DESCARTAR')).rejects.toMatchObject({ code: 'APLICACION_A_MEDIAS' })

    aplicar.mockResolvedValueOnce(aplicado(200, { orderId: 'o', paymentId: 'p', repetida: true }))
    expect((await recibirEnGracia(reportado(e), e)).status).toBe(200)
    expect(filas[0].estado).toBe('APLICADO')
    expect(aplicar).toHaveBeenCalledTimes(2)
  })

  it('gracia, reintento pasadas las 24 h con la ficha EN_CURSO → no ejecuta y NO vuelve a PENDIENTE: APLICANDO con su motivo', async () => {
    const e = envio()
    aplicar.mockRejectedValueOnce(new ConflictError('procesando', 'VENTA_EN_PROCESO'))
    await expect(recibirEnGracia(reportado(e), e)).rejects.toMatchObject({ code: 'VENTA_EN_PROCESO' })
    efecto.mockResolvedValue(AMEDIAS)
    const tarde = await recibirEnGracia(reportado(e, { desvinculadoAt: new Date(AHORA.getTime() - 30 * HORA) }), e)
    expect(tarde).toEqual({ status: 202, body: { retenido: true, motivo: 'FUERA_DE_PLAZO' } })
    expect(aplicar).toHaveBeenCalledTimes(1)
    expect(filas[0]).toMatchObject({ estado: 'APLICANDO', motivo: 'FUERA_DE_PLAZO' })
    await expect(resolver('DESCARTAR')).rejects.toMatchObject({ code: 'APLICACION_A_MEDIAS' })
    // «Aplicar» la termina.
    aplicar.mockResolvedValueOnce(aplicado(200, { orderId: 'o', paymentId: 'p', repetida: true }))
    expect(await resolver('APLICAR')).toMatchObject({ estado: 'APLICADO' })
  })

  it('una VENTA nueva que se retiene con su ficha EN_CURSO (de antes de desvincular) nace APLICANDO: no se puede descartar', async () => {
    const e = envio() // sin huella reportada → NO_REPORTADA
    efecto.mockResolvedValue(AMEDIAS)
    expect(await recibirEnGracia(celular(), e)).toEqual({ status: 202, body: { retenido: true, motivo: 'NO_REPORTADA' } })
    expect(filas[0]).toMatchObject({ estado: 'APLICANDO', motivo: 'NO_REPORTADA' })
    expect(aplicar).not.toHaveBeenCalled()
    await expect(resolver('DESCARTAR')).rejects.toMatchObject({ code: 'APLICACION_A_MEDIAS' })
  })
})

describe('arreglo final 2: el tope y las sucursales de campo (T5, T7)', () => {
  it('T5 · con 500 por revisar, una evidencia que se aplicaría sola (y quedaría PENDIENTE por VENTA_PENDIENTE) → 409 sin fila nueva', async () => {
    for (let i = 0; i < 500; i++) filas.push({ id: `x${i}`, celularId: 'cel1', huella: `h${i}`, estado: 'PENDIENTE' })
    const e = envio(
      JSON.stringify({ ventaLlave: randomUUID(), photoUrls: ['https://example.test/a.jpg'], photoLabel: 'Vinculacion', ...CAPTURA }),
      'EVIDENCIA',
    )
    aplicar.mockResolvedValue({ tipo: 'RECHAZADO', rechazo: { code: 'VENTA_PENDIENTE', message: 'm' } })
    await expect(recibirEnGracia(celular(), e)).rejects.toMatchObject({ statusCode: 409, code: 'RETENIDOS_LLENOS' })
    expect(filas).toHaveLength(500)
    expect(aplicar).not.toHaveBeenCalled()
  })

  it('T7 · «dada de baja» se decide con las sucursales de CAMPO: alguien que ya sólo es gerente no aplica nada solo', async () => {
    const e = envio()
    sucursales.mockResolvedValue([{ staffVenueId: 'sv1', venueId: 'v1', nombre: 'Sucursal Centro', role: 'MANAGER', pin: null }])
    deCampo.mockResolvedValue([])
    expect((await recibirEnGracia(reportado(e), e)).body).toEqual({ retenido: true, motivo: 'PERSONA_DADA_DE_BAJA' })
    expect(deCampo).toHaveBeenCalledWith('s1', 'org1')
    expect(aplicar).not.toHaveBeenCalled()
  })
})

describe('arreglo final: lo que llega a la gracia (S7, S8, S9)', () => {
  it('S7 · un cuerpo que su esquema rechaza → 400 CUERPO_INVALIDO sin fila', async () => {
    const e = envio(JSON.stringify({ serialNumber: '1', precioVisto: 0 })) // venta sin llave
    await expect(recibirEnGracia(reportado(e), e)).rejects.toMatchObject({ statusCode: 400, code: 'CUERPO_INVALIDO' })
    expect(filas).toHaveLength(0)
    expect(aplicar).not.toHaveBeenCalled()
  })

  it('S9 · evidencia sin los campos de captura → 400 CUERPO_INVALIDO sin fila', async () => {
    const e = envio(JSON.stringify({ ventaLlave: randomUUID(), photoUrls: ['https://example.test/a.jpg'] }), 'EVIDENCIA')
    await expect(recibirEnGracia(celular(), e)).rejects.toMatchObject({ statusCode: 400, code: 'CUERPO_INVALIDO' })
    expect(filas).toHaveLength(0)
  })

  it('S7 · con 500 por revisar de ESTE celular, el siguiente → 409 RETENIDOS_LLENOS sin fila; los de otro celular no cuentan', async () => {
    for (let i = 0; i < 499; i++) filas.push({ id: `x${i}`, celularId: 'cel1', huella: `h${i}`, estado: i % 2 ? 'PENDIENTE' : 'APLICANDO' })
    for (let i = 0; i < 10; i++) filas.push({ id: `y${i}`, celularId: 'cel1', huella: `z${i}`, estado: 'DESCARTADO' })
    for (let i = 0; i < 10; i++) filas.push({ id: `o${i}`, celularId: 'celOtro', huella: `o${i}`, estado: 'PENDIENTE' })
    expect((await recibirEnGracia(celular(), envio())).body).toEqual({ retenido: true, motivo: 'NO_REPORTADA' }) // el 500
    const antes = filas.length
    await expect(recibirEnGracia(celular(), envio())).rejects.toMatchObject({ statusCode: 409, code: 'RETENIDOS_LLENOS' })
    expect(filas).toHaveLength(antes)
  })

  it('S8 · celular reportado perdido o robado: aun reportado y en plazo, todo queda por revisar con CELULAR_PERDIDO', async () => {
    const e = envio()
    const r = await recibirEnGracia(reportado(e, { sinGracia: true }), e)
    expect(r).toEqual({ status: 202, body: { retenido: true, motivo: 'CELULAR_PERDIDO' } })
    expect(aplicar).not.toHaveBeenCalled()
    expect(filas[0]).toMatchObject({ estado: 'PENDIENTE', motivo: 'CELULAR_PERDIDO' })
  })
})

describe('alcance del que pregunta (S3, MCP)', () => {
  it('listarRetenidos sólo de las sucursales del alcance', async () => {
    db.envioRetenidoDeCampo.findMany.mockResolvedValue([])
    db.envioRetenidoDeCampo.count.mockResolvedValue(0)
    await listarRetenidos('org1', { page: 1, pageSize: 25 }, ['vA'])
    expect(db.envioRetenidoDeCampo.findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org1',
      AND: [{ venueId: { in: ['vA'] } }],
    })
  })

  it('«Aplicar» y «Descartar» de un retenido de una sucursal fuera del alcance → 404 sin tocarlo', async () => {
    const f = retenido({ venueId: 'vB' })
    await expect(resolver('APLICAR', { venueIds: ['vA'] })).rejects.toMatchObject({ statusCode: 404 })
    await expect(resolver('DESCARTAR', { venueIds: ['vA'] })).rejects.toMatchObject({ statusCode: 404 })
    expect(f.estado).toBe('PENDIENTE')
    expect(aplicar).not.toHaveBeenCalled()
    // Dentro del alcance sigue igual.
    aplicar.mockResolvedValue(aplicado())
    db.venue.findUnique.mockResolvedValue({ organizationId: 'org1' })
    sucursales.mockResolvedValue([{ staffVenueId: 'sv', venueId: 'vB', nombre: 'B', role: 'CASHIER', pin: null }])
    expect(await resolver('APLICAR', { venueIds: ['vB'] })).toMatchObject({ estado: 'APLICADO' })
  })
})

describe('arreglo final 4: las cuatro invariantes del retenido', () => {
  const HECHA = { orderId: 'o', paymentId: 'p', saleVerificationId: 'sv', recuperado: true }
  const enVueloHace = (ms: number) => new Date(AHORA.getTime() - ms)
  const pendiente = <T>() => {
    let soltar!: (v: T) => void
    const promesa = new Promise<T>(r => (soltar = r))
    return { promesa, soltar }
  }

  describe('I1 · lo que pasó manda', () => {
    it('R3-1 · una VENTA COMPLETA por la ruta normal que llega retenida (NO_REPORTADA) nace APLICADO con su resultado', async () => {
      const e = envio() // sin huella reportada → se retendría
      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      expect(await recibirEnGracia(celular(), e)).toEqual({ status: 200, body: { resuelto: 'APLICADO', resultado: HECHA } })
      expect(filas).toHaveLength(1)
      expect(filas[0]).toMatchObject({ estado: 'APLICADO', resultado: HECHA, resueltoAt: AHORA })
      expect(aplicar).not.toHaveBeenCalled()
      expect(efecto).toHaveBeenCalledWith(
        'VENTA',
        { venueId: 'v1', orgId: 'org1', staffId: 's1', celularId: 'cel1' },
        JSON.parse(e.cuerpoJson),
        AHORA,
        expect.anything(), // I8: la transacción del candado
      )
      // «Descartar» ya no la puede dejar como «no se registra».
      await expect(
        resolverRetenido({ retenidoId: filas[0].id, organizationId: 'org1', accion: 'DESCARTAR', porStaffId: 'sup1' }),
      ).rejects.toMatchObject({
        code: 'YA_APLICADO',
      })
    })

    it('al nacer vale para todos los tipos: una SALIDA ya checada que llega fuera de plazo nace APLICADO', async () => {
      const e = envio(JSON.stringify({ llave: randomUUID(), llaveEntrada: randomUUID() }), 'SALIDA')
      efecto.mockResolvedValue({ hecho: true, resultado: { timeEntryId: 't1', recuperado: true } })
      const tarde = reportado(e, { desvinculadoAt: new Date(AHORA.getTime() - 30 * HORA) })
      expect(await recibirEnGracia(tarde, e)).toEqual({
        status: 200,
        body: { resuelto: 'APLICADO', resultado: { timeEntryId: 't1', recuperado: true } },
      })
      expect(filas[0]).toMatchObject({ estado: 'APLICADO', tipo: 'SALIDA' })
    })

    it('antes de la PRIMERA ejecución de la gracia: si ya está hecho no se ejecuta', async () => {
      const e = envio()
      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      expect(await recibirEnGracia(reportado(e), e)).toEqual({ status: 200, body: { resuelto: 'APLICADO', resultado: HECHA } })
      expect(aplicar).not.toHaveBeenCalled()
      expect(filas[0]).toMatchObject({ estado: 'APLICADO' })
    })

    it('«Descartar» de una PENDIENTE cuyo efecto ya ocurrió → queda APLICADO y contesta { estado: APLICADO, resultado, yaEstabaHecho }', async () => {
      const f = retenido()
      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      expect(await resolver('DESCARTAR', { nota: 'no la vendió' })).toEqual({
        estado: 'APLICADO',
        resultado: HECHA,
        repetida: false,
        yaEstabaHecho: true,
      })
      expect(f).toMatchObject({ estado: 'APLICADO', resultado: HECHA, resueltoPor: 'sup1' })
      expect(aplicar).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'CAMPO_RETENIDO_DESCARTADO' }))
    })

    it('«Descartar» de una PENDIENTE con la venta a medias → la fila pasa a APLICANDO (sin dueño) y 409 APLICACION_A_MEDIAS', async () => {
      const f = retenido()
      efecto.mockResolvedValue({ hecho: false, aMedias: true })
      await expect(resolver('DESCARTAR')).rejects.toMatchObject({ statusCode: 409, code: 'APLICACION_A_MEDIAS' })
      expect(f.estado).toBe('APLICANDO')
      // Sin dueño: «Aplicar» la toma enseguida, sin esperar la ventana.
      aplicar.mockResolvedValue(aplicado(200, { orderId: 'o', paymentId: 'p', repetida: true }))
      expect(await resolver('APLICAR')).toMatchObject({ estado: 'APLICADO' })
    })

    it('«Aplicar» de una PENDIENTE cuyo efecto ya ocurrió → APLICADO sin ejecutar ni pedir asignación', async () => {
      const f = retenido()
      sucursales.mockResolvedValue([])
      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      expect(await resolver('APLICAR')).toEqual({ estado: 'APLICADO', resultado: HECHA, repetida: false })
      expect(aplicar).not.toHaveBeenCalled()
      expect(f.estado).toBe('APLICADO')
    })

    it('la gracia no contesta «retenido» ni «descartado» de una fila cuyo efecto ya ocurrió: la deja APLICADO', async () => {
      const e = envio()
      const huella = huellaDelEnvio('VENTA', 'v1', e.cuerpoJson)
      for (const estado of ['PENDIENTE', 'DESCARTADO']) {
        filas = []
        const f = retenido({ huella, cuerpoJson: e.cuerpoJson, estado, resueltoPor: estado === 'DESCARTADO' ? 'sup9' : null })
        efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
        expect(await recibirEnGracia(celular(), e)).toEqual({ status: 200, body: { resuelto: 'APLICADO', resultado: HECHA } })
        expect(f.estado).toBe('APLICADO')
      }
      expect(aplicar).not.toHaveBeenCalled()
    })
  })

  describe('I2 · nadie le quita la fila a quien la está aplicando', () => {
    it('una APLICANDO tocada hace 1 min: «Aplicar» y «Descartar» → 409 APLICACION_EN_CURSO en español, sin tocarla ni ejecutar', async () => {
      const f = retenido({ estado: 'APLICANDO', updatedAt: enVueloHace(MIN) })
      for (const accion of ['APLICAR', 'DESCARTAR'] as const) {
        await expect(resolver(accion)).rejects.toMatchObject({
          statusCode: 409,
          code: 'APLICACION_EN_CURSO',
          message: 'Se está aplicando en este momento. Vuelve a intentar en unos minutos.',
        })
      }
      expect(f).toMatchObject({ estado: 'APLICANDO', updatedAt: enVueloHace(MIN) })
      expect(aplicar).not.toHaveBeenCalled()
      expect(efecto).not.toHaveBeenCalled()
    })

    it('R3-2 · la primera subida sigue aplicando; un reintento ya fuera de plazo → 409 (reintentable), NO la regresa a PENDIENTE', async () => {
      const e = envio()
      const venta = pendiente<any>()
      aplicar.mockReturnValueOnce(venta.promesa)
      const primera = recibirEnGracia(reportado(e), e)
      while (!aplicar.mock.calls.length) await tick()

      const tarde = reportado(e, { desvinculadoAt: new Date(AHORA.getTime() - 30 * HORA) })
      await expect(recibirEnGracia(tarde, e)).rejects.toMatchObject({ statusCode: 409, code: 'APLICACION_EN_CURSO' })
      await expect(recibirEnGracia(reportado(e, { sinGracia: true }), e)).rejects.toMatchObject({ code: 'APLICACION_EN_CURSO' })
      await expect(resolver('DESCARTAR')).rejects.toMatchObject({ code: 'APLICACION_EN_CURSO' })
      expect(filas[0].estado).toBe('APLICANDO')

      venta.soltar(aplicado())
      expect((await primera).status).toBe(201)
      expect(filas[0].estado).toBe('APLICADO')
      expect(aplicar).toHaveBeenCalledTimes(1)
    })

    it('vencida (nadie la toca hace 6 min, el proceso cayó): el reintento de la gracia la vuelve a tomar y la termina', async () => {
      const e = envio()
      retenido({
        huella: huellaDelEnvio('VENTA', 'v1', e.cuerpoJson),
        cuerpoJson: e.cuerpoJson,
        estado: 'APLICANDO',
        motivo: 'APLICADO_EN_GRACIA',
        updatedAt: enVueloHace(6 * MIN),
      })
      aplicar.mockResolvedValue(aplicado(200, { orderId: 'o', paymentId: 'p', repetida: true }))
      expect((await recibirEnGracia(reportado(e), e)).status).toBe(200)
      expect(filas[0].estado).toBe('APLICADO')
      expect(efecto).toHaveBeenCalledTimes(1) // I1 antes de volver a ejecutar
    })
  })

  describe('I3 · APLICANDO sólo vuelve a PENDIENTE por quien la tiene', () => {
    it('la gracia tarda más que la ventana y «Aplicar» la retoma: el rechazo de la gracia ya no la regresa; gana el que aplica', async () => {
      const e = envio()
      const deLaGracia = pendiente<any>()
      const delPanel = pendiente<any>()
      aplicar.mockReturnValueOnce(deLaGracia.promesa).mockReturnValueOnce(delPanel.promesa)
      const gracia = recibirEnGracia(reportado(e), e).then(
        r => r,
        err => err,
      )
      while (aplicar.mock.calls.length < 1) await tick()

      jest.setSystemTime(new Date(AHORA.getTime() + 6 * MIN)) // la gracia se colgó: ya no está en vuelo
      const panel = resolverRetenido({ retenidoId: filas[0].id, organizationId: 'org1', accion: 'APLICAR', porStaffId: 'sup1' })
      while (aplicar.mock.calls.length < 2) await tick()

      deLaGracia.soltar(rechazado()) // la gracia recibe un rechazo y no hay efecto: pero ya no es suya
      expect(await gracia).toMatchObject({ statusCode: 409, code: 'APLICACION_EN_CURSO' })
      expect(filas[0].estado).toBe('APLICANDO')

      delPanel.soltar(aplicado())
      expect(await panel).toMatchObject({ estado: 'APLICADO' })
      expect(filas[0].estado).toBe('APLICADO')
    })

    it('vencida y ya no procede (24 h) sin efecto ni a medias → PENDIENTE con su motivo (sólo la fila vencida)', async () => {
      const e = envio()
      retenido({
        huella: huellaDelEnvio('VENTA', 'v1', e.cuerpoJson),
        cuerpoJson: e.cuerpoJson,
        estado: 'APLICANDO',
        motivo: 'APLICADO_EN_GRACIA',
        updatedAt: enVueloHace(6 * MIN),
      })
      const tarde = reportado(e, { desvinculadoAt: new Date(AHORA.getTime() - 30 * HORA) })
      expect(await recibirEnGracia(tarde, e)).toEqual({ status: 202, body: { retenido: true, motivo: 'FUERA_DE_PLAZO' } })
      expect(filas[0]).toMatchObject({ estado: 'PENDIENTE', motivo: 'FUERA_DE_PLAZO' })
      expect(aplicar).not.toHaveBeenCalled()
    })
  })

  describe('I4 · el que aplicó gana', () => {
    it('la gracia aplica después de que la fila quedó DESCARTADO → APLICADO, contesta lo aplicado y deja CAMPO_RETENIDO_DESCARTE_REVERTIDO', async () => {
      const e = envio()
      aplicar.mockImplementationOnce(async () => {
        Object.assign(filas[0], { estado: 'DESCARTADO', resueltoPor: 'sup9', nota: 'no era' }) // tardó más que la ventana
        return aplicado()
      })
      expect(await recibirEnGracia(reportado(e), e)).toEqual({
        status: 201,
        body: { orderId: 'o', paymentId: 'p', repetida: false, aplicadoEnGracia: true },
      })
      expect(filas[0]).toMatchObject({ estado: 'APLICADO', resultado: { orderId: 'o', paymentId: 'p', repetida: false } })
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CAMPO_RETENIDO_DESCARTE_REVERTIDO',
          entityId: filas[0].id,
          data: expect.objectContaining({ descartadoPor: 'sup9', notaDelDescarte: 'no era' }),
        }),
      )
    })

    it('«Aplicar» que aplica sobre un DESCARTADO también lo revierte y lo deja en la bitácora', async () => {
      const f = retenido()
      aplicar.mockImplementationOnce(async () => {
        Object.assign(f, { estado: 'DESCARTADO', resueltoPor: 'sup9' })
        return aplicado()
      })
      expect(await resolver('APLICAR')).toMatchObject({ estado: 'APLICADO' })
      expect(f.estado).toBe('APLICADO')
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CAMPO_RETENIDO_DESCARTE_REVERTIDO', data: expect.objectContaining({ descartadoPor: 'sup9' }) }),
      )
    })
  })

  it('R3-3 · en la gracia, una evidencia con replaceIndex y sin photoLabel → 400 CUERPO_INVALIDO sin fila', async () => {
    const e = envio(
      JSON.stringify({ ventaLlave: randomUUID(), photoUrls: ['https://example.test/a.jpg'], replaceIndex: 1, ...CAPTURA }),
      'EVIDENCIA',
    )
    await expect(recibirEnGracia(celular(), e)).rejects.toMatchObject({ statusCode: 400, code: 'CUERPO_INVALIDO' })
    expect(filas).toHaveLength(0)
  })
})

describe('arreglo final 5: se decide con la fila en la mano (I5); lo que ya venía en camino termina antes de descartar (I6)', () => {
  const HECHA = { orderId: 'o', paymentId: 'p', saleVerificationId: 'sv', recuperado: true }
  const pendiente = <T>() => {
    let soltar!: (v: T) => void
    const promesa = new Promise<T>(r => (soltar = r))
    return { promesa, soltar }
  }
  const SUCURSAL = [{ staffVenueId: 'sv1', venueId: 'v1', nombre: 'Sucursal Centro', role: 'CASHIER', pin: null }]
  /** Lo que la gracia empezó a aplicar sola y cuyo proceso murió (APLICANDO vencida). */
  const vencidaDeLaGracia = (e: ReturnType<typeof envio>) =>
    retenido({
      tipo: e.tipo,
      huella: huellaDelEnvio(e.tipo, e.venueId, e.cuerpoJson),
      cuerpoJson: e.cuerpoJson,
      estado: 'APLICANDO',
      motivo: 'APLICADO_EN_GRACIA',
      updatedAt: new Date(AHORA.getTime() - 6 * MIN),
    })

  describe('I5 · la fila se toma ANTES de preguntar por el efecto', () => {
    it('R4-2 · el reintento de la gracia ya tiene la fila mientras evalúa: «Aplicar» no la ejecuta a medias por debajo y nada regresa a PENDIENTE con efecto', async () => {
      const e = envio(
        JSON.stringify({
          sims: [
            { serialNumber: 'SIM-A', custodyVersion: 1 },
            { serialNumber: 'SIM-B', custodyVersion: 1 },
          ],
        }),
        'CUSTODIA_ACEPTAR',
      )
      const f = vencidaDeLaGracia(e)
      let aceptada = false
      efecto.mockImplementation(async () => (aceptada ? { hecho: true, resultado: { recuperadoDeLaBitacora: true } } : { hecho: false }))
      // «Aplicar» aceptaría la primera SIM y una falla de infraestructura cortaría el lote (una transacción por SIM).
      aplicar.mockImplementation(async () => {
        aceptada = true
        throw new Error('se cayó la base en la segunda SIM')
      })
      // A: el reintento de la gracia de un celular perdido; ya tomó la fila y se queda en su consulta del efecto (I8: con el
      // candado; sus sucursales se piden ANTES, no dependen del efecto).
      const consultaDeA = pendiente<any>()
      efecto.mockImplementationOnce(async () => consultaDeA.promesa)
      const a = recibirEnGracia(reportado(e, { sinGracia: true }), e)
      while (!efecto.mock.calls.length) await tick()

      // B: «Aplicar» ve la fila en vuelo (A la tiene): 409, no ejecuta.
      await expect(resolver('APLICAR')).rejects.toMatchObject({ statusCode: 409, code: 'APLICACION_EN_CURSO' })
      expect(aplicar).not.toHaveBeenCalled()

      consultaDeA.soltar({ hecho: false })
      expect(await a).toEqual({ status: 202, body: { retenido: true, motivo: 'CELULAR_PERDIDO' } })
      expect(f).toMatchObject({ estado: 'PENDIENTE', motivo: 'CELULAR_PERDIDO' })
      expect(aceptada).toBe(false)
    })

    it('R4-2 · A todavía no la toma (espera sus sucursales) y «Aplicar» la deja a medias con efecto: A ya no gana la toma exacta y no la regresa a PENDIENTE', async () => {
      const e = envio(JSON.stringify({ sims: [{ serialNumber: 'SIM-A', custodyVersion: 1 }] }), 'CUSTODIA_ACEPTAR')
      const f = vencidaDeLaGracia(e)
      let aceptada = false
      efecto.mockImplementation(async () => (aceptada ? { hecho: true, resultado: { recuperadoDeLaBitacora: true } } : { hecho: false }))
      aplicar.mockImplementationOnce(async () => {
        aceptada = true
        throw new Error('se cayó la base en la segunda SIM')
      })
      const sucursalesDeA = pendiente<any[]>()
      deCampo.mockReturnValueOnce(sucursalesDeA.promesa)
      const a = recibirEnGracia(reportado(e, { sinGracia: true }), e)
      while (!deCampo.mock.calls.length) await tick()

      await expect(resolver('APLICAR')).rejects.toThrow('se cayó la base en la segunda SIM')
      expect(f.estado).toBe('APLICANDO') // a medias, soltada

      sucursalesDeA.soltar(SUCURSAL)
      expect(await a).toEqual({ status: 202, body: { retenido: true, motivo: 'APLICADO_EN_GRACIA', repetida: true } })
      expect(f.estado).toBe('APLICANDO') // nunca PENDIENTE con el efecto hecho; el siguiente «Aplicar» o reintento la termina
      expect(await resolver('APLICAR')).toMatchObject({ estado: 'APLICADO', resultado: { recuperadoDeLaBitacora: true } })
    })

    it('R4-2 · al revés: «Aplicar» la dejó a medias (soltada); el reintento de la gracia la toma, ve el efecto y la deja APLICADO', async () => {
      const e = envio(JSON.stringify({ sims: [{ serialNumber: 'SIM-A', custodyVersion: 1 }] }), 'CUSTODIA_ACEPTAR')
      const f = vencidaDeLaGracia(e)
      let aceptada = false
      efecto.mockImplementation(async () => (aceptada ? { hecho: true, resultado: { recuperadoDeLaBitacora: true } } : { hecho: false }))
      aplicar.mockImplementationOnce(async () => {
        aceptada = true
        throw new Error('se cayó la base en la segunda SIM')
      })
      await expect(resolver('APLICAR')).rejects.toThrow('se cayó la base')
      expect(f.estado).toBe('APLICANDO')

      expect(await recibirEnGracia(reportado(e, { sinGracia: true }), e)).toEqual({
        status: 200,
        body: { resuelto: 'APLICADO', resultado: { recuperadoDeLaBitacora: true } },
      })
      expect(f.estado).toBe('APLICADO')
      expect(aplicar).toHaveBeenCalledTimes(1)
    })

    it('la gracia pregunta por el efecto de una fila vencida cuando YA es suya (APLICANDO con su marca), no con la lectura vieja', async () => {
      const e = envio()
      const f = vencidaDeLaGracia(e)
      let visto: any
      efecto.mockImplementation(async () => {
        visto = { ...f }
        return { hecho: false }
      })
      aplicar.mockResolvedValue(aplicado(200, { orderId: 'o', paymentId: 'p', repetida: true }))
      expect((await recibirEnGracia(reportado(e), e)).status).toBe(200)
      expect(visto).toMatchObject({ estado: 'APLICANDO', updatedAt: AHORA })
    })

    it('si al reanudar la persona sigue vinculada (USA_TU_SESION), la gracia suelta la fila: sigue APLICANDO, ya vencida', async () => {
      const e = envio()
      const f = vencidaDeLaGracia(e)
      await expect(recibirEnGracia(reportado(e, { staffIdVinculado: 's1' }), e)).rejects.toMatchObject({ code: 'USA_TU_SESION' })
      expect(f.estado).toBe('APLICANDO')
      expect(f.updatedAt.getTime()).toBeLessThan(AHORA.getTime() - VENTANA_EN_VUELO_MS)
      expect(aplicar).not.toHaveBeenCalled()
    })

    it('«Descartar» toma la fila y luego pregunta: mientras pregunta, «Aplicar» → 409; sin efecto queda DESCARTADO por su marca', async () => {
      const f = retenido()
      const consulta = pendiente<any>()
      let visto: any
      efecto.mockImplementationOnce(async () => {
        visto = { ...f }
        return consulta.promesa
      })
      const d = resolver('DESCARTAR', { nota: 'no era' })
      while (!efecto.mock.calls.length) await tick()
      expect(visto).toMatchObject({ estado: 'APLICANDO', updatedAt: AHORA })

      await expect(resolver('APLICAR')).rejects.toMatchObject({ statusCode: 409, code: 'APLICACION_EN_CURSO' })
      expect(aplicar).not.toHaveBeenCalled()

      consulta.soltar({ hecho: false })
      expect(await d).toEqual({ estado: 'DESCARTADO', repetida: false })
      expect(f).toMatchObject({ estado: 'DESCARTADO', resueltoPor: 'sup1', nota: 'no era' })
    })

    it('«Descartar» cuya consulta del efecto falla → deshace la toma: la fila vuelve a PENDIENTE (descartable), sin quedar «a medias»', async () => {
      const f = retenido()
      efecto.mockRejectedValueOnce(new Error('se cayó la base'))
      await expect(resolver('DESCARTAR')).rejects.toThrow('se cayó la base')
      expect(f.estado).toBe('PENDIENTE')
      expect(await resolver('DESCARTAR')).toEqual({ estado: 'DESCARTADO', repetida: false })
    })

    it('«Aplicar» toma la fila ANTES de preguntar por el efecto (y la toma exacta: la que leyó)', async () => {
      const f = retenido()
      let visto: any
      efecto.mockImplementationOnce(async () => {
        visto = { ...f }
        return { hecho: false }
      })
      aplicar.mockResolvedValue(aplicado())
      expect(await resolver('APLICAR')).toMatchObject({ estado: 'APLICADO', repetida: false })
      expect(visto).toMatchObject({ estado: 'APLICANDO', updatedAt: AHORA })
    })

    it('«Aplicar» cuya consulta del efecto falla → deshace la toma (PENDIENTE sigue PENDIENTE; APLICANDO queda soltada)', async () => {
      const f = retenido()
      efecto.mockRejectedValueOnce(new Error('se cayó la base'))
      await expect(resolver('APLICAR')).rejects.toThrow('se cayó la base')
      expect(f.estado).toBe('PENDIENTE')
      expect(aplicar).not.toHaveBeenCalled()

      const g = retenido({ id: 'r2', estado: 'APLICANDO', updatedAt: new Date(AHORA.getTime() - 6 * MIN) })
      efecto.mockRejectedValueOnce(new Error('se cayó la base'))
      await expect(resolverRetenido({ retenidoId: 'r2', organizationId: 'org1', accion: 'APLICAR', porStaffId: 'sup1' })).rejects.toThrow(
        'se cayó la base',
      )
      expect(g.estado).toBe('APLICANDO')
      expect(g.updatedAt.getTime()).toBeLessThan(AHORA.getTime() - VENTANA_EN_VUELO_MS)
    })
  })

  describe('I6 · no se descarta antes de VENTANA_EN_VUELO_MS desde que nació', () => {
    it('R4-1 · nace PENDIENTE mientras la venta normal sigue en camino: «Descartar» → 409 DESCARTE_MUY_PRONTO; pasada la ventana ve la venta → APLICADO', async () => {
      const e = envio() // no reportada → nace PENDIENTE: todavía no hay ficha
      expect(await recibirEnGracia(celular(), e)).toEqual({ status: 202, body: { retenido: true, motivo: 'NO_REPORTADA' } })
      const id = filas[0].id
      const descartar = () => resolverRetenido({ retenidoId: id, organizationId: 'org1', accion: 'DESCARTAR', porStaffId: 'sup1' })
      efecto.mockClear()

      await expect(descartar()).rejects.toMatchObject({
        statusCode: 409,
        code: 'DESCARTE_MUY_PRONTO',
        message: 'Este envío acaba de llegar. Espera unos minutos antes de descartarlo: puede que todavía se esté registrando.',
      })
      expect(filas[0].estado).toBe('PENDIENTE')
      expect(efecto).not.toHaveBeenCalled()

      // La petición normal (admitida antes de desvincular) termina y registra la venta y su cobro.
      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      jest.setSystemTime(new Date(AHORA.getTime() + VENTANA_EN_VUELO_MS - 1000))
      await expect(descartar()).rejects.toMatchObject({ code: 'DESCARTE_MUY_PRONTO' })
      jest.setSystemTime(new Date(AHORA.getTime() + VENTANA_EN_VUELO_MS))
      expect(await descartar()).toEqual({ estado: 'APLICADO', resultado: HECHA, repetida: false, yaEstabaHecho: true })
      expect(filas[0]).toMatchObject({ estado: 'APLICADO', resultado: HECHA, resueltoPor: 'sup1' })
      expect(aplicar).not.toHaveBeenCalled()
    })

    it('«Aplicar» no espera la ventana: un retenido recién nacido se aplica (es idempotente por su llave)', async () => {
      const f = retenido({ createdAt: AHORA })
      aplicar.mockResolvedValue(aplicado())
      expect(await resolver('APLICAR')).toMatchObject({ estado: 'APLICADO', repetida: false })
      expect(f.estado).toBe('APLICADO')
    })
  })
})

describe('arreglo final 6: el que aplicó gana también por la ruta normal (I7, R5-1); reanudar toma exacto (R5-2)', () => {
  const HECHA = { orderId: 'o', paymentId: 'p', saleVerificationId: 'sv', recuperado: true }
  const SUCURSAL = [{ staffVenueId: 'sv1', venueId: 'v1', nombre: 'Sucursal Centro', role: 'CASHIER', pin: null }]
  const pendiente = <T>() => {
    let soltar!: (v: T) => void
    const promesa = new Promise<T>(r => (soltar = r))
    return { promesa, soltar }
  }

  describe('R5-2 · reanudar toma la fila tal como la leyó y, si falla antes de ejecutar, la deja como la tomó', () => {
    it('A lee la APLICANDO vencida; B la regresa a PENDIENTE (CELULAR_PERDIDO); A ya no la toma: sigue PENDIENTE y descartable', async () => {
      const e = envio()
      const f = retenido({
        huella: huellaDelEnvio(e.tipo, e.venueId, e.cuerpoJson),
        cuerpoJson: e.cuerpoJson,
        estado: 'APLICANDO',
        motivo: 'APLICADO_EN_GRACIA',
        updatedAt: new Date(AHORA.getTime() - 6 * MIN),
      })
      // A lee su foto de la fila y se queda esperando antes de tomarla.
      const lecturaDeA = pendiente<void>()
      const real = db.envioRetenidoDeCampo.findUnique.getMockImplementation()
      db.envioRetenidoDeCampo.findUnique.mockImplementationOnce(async (args: any) => {
        const foto = await real(args)
        await lecturaDeA.promesa
        return foto
      })
      const a = recibirEnGracia(reportado(e), e)
      while (!db.envioRetenidoDeCampo.findUnique.mock.calls.length) await tick()

      // B: el reintento de un celular perdido la toma, no ve efecto y la regresa a PENDIENTE (sin avanzar el reloj).
      deCampo.mockResolvedValueOnce(SUCURSAL).mockRejectedValueOnce(new Error('se cayó la consulta de sucursales'))
      expect(await recibirEnGracia(reportado(e, { sinGracia: true }), e)).toEqual({
        status: 202,
        body: { retenido: true, motivo: 'CELULAR_PERDIDO' },
      })
      expect(f).toMatchObject({ estado: 'PENDIENTE', motivo: 'CELULAR_PERDIDO' })

      lecturaDeA.soltar()
      // A no gana la toma exacta: contesta como quedó, sin consultar sus sucursales (que fallarían) ni ejecutar.
      expect(await a).toEqual({ status: 202, body: { retenido: true, motivo: 'CELULAR_PERDIDO', repetida: true } })
      expect(f).toMatchObject({ estado: 'PENDIENTE', motivo: 'CELULAR_PERDIDO' })
      expect(aplicar).not.toHaveBeenCalled()
      expect(await resolver('DESCARTAR')).toEqual({ estado: 'DESCARTADO', repetida: false })
    })

    it('la toma de reanudar es el CAS exacto: estado y updatedAt de la lectura', async () => {
      const e = envio()
      const leido = new Date(AHORA.getTime() - 6 * MIN)
      retenido({
        huella: huellaDelEnvio(e.tipo, e.venueId, e.cuerpoJson),
        cuerpoJson: e.cuerpoJson,
        estado: 'APLICANDO',
        motivo: 'APLICADO_EN_GRACIA',
        updatedAt: leido,
      })
      aplicar.mockResolvedValue(aplicado())
      await recibirEnGracia(reportado(e), e)
      expect(db.envioRetenidoDeCampo.updateMany.mock.calls[0][0].where).toMatchObject({
        id: 'r1',
        estado: 'APLICANDO',
        updatedAt: leido,
      })
    })
  })

  describe('I7 (R5-1) · lo que la ruta normal hizo deja APLICADO su retenido', () => {
    beforeEach(() => {
      db.envioRetenidoDeCampo.findMany.mockImplementation(async ({ where, take }: any) =>
        filas
          .filter(f => coincide(f, where))
          .slice(0, take)
          .map(f => ({ ...f })),
      )
    })

    it('el caso de Codex: un DESCARTADO cuya venta normal terminó después → APLICADO con CAMPO_RETENIDO_DESCARTE_REVERTIDO', async () => {
      const f = retenido({ estado: 'DESCARTADO', resueltoPor: 'sup1', resueltoAt: new Date(AHORA.getTime() - MIN), nota: 'no vino' })
      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })

      expect(await reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA')).toBe(1)

      expect(f).toMatchObject({ estado: 'APLICADO', resultado: HECHA, resueltoPor: null })
      expect(efecto).toHaveBeenCalledWith(
        'VENTA',
        { venueId: 'v1', orgId: 'org1', staffId: 's1', celularId: 'cel1' },
        JSON.parse(f.cuerpoJson),
        NACIO,
        expect.anything(), // I8: la transacción del candado
      )
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CAMPO_RETENIDO_DESCARTE_REVERTIDO',
          entityId: 'r1',
          data: expect.objectContaining({ descartadoPor: 'sup1', notaDelDescarte: 'no vino' }),
        }),
      )
      expect(aplicar).not.toHaveBeenCalled()
    })

    it('PENDIENTE con efecto → APLICADO; sin efecto (o a medias) no se toca; APLICADO y APLICANDO en vuelo ni se consultan', async () => {
      const hecha = retenido({ id: 'r1', cuerpoJson: cuerpoVenta({ serialNumber: 'HECHA' }) })
      const sinEfecto = retenido({ id: 'r2', cuerpoJson: cuerpoVenta({ serialNumber: 'NADA' }) })
      const aMedias = retenido({ id: 'r3', cuerpoJson: cuerpoVenta({ serialNumber: 'MEDIAS' }) })
      const yaAplicada = retenido({ id: 'r4', estado: 'APLICADO', resultado: { paymentId: 'p4' } })
      const enVuelo = retenido({ id: 'r5', estado: 'APLICANDO', updatedAt: new Date(AHORA.getTime() - MIN) })
      efecto.mockImplementation(async (_t: string, _c: unknown, cuerpo: any) =>
        cuerpo.serialNumber === 'HECHA'
          ? { hecho: true, resultado: HECHA }
          : cuerpo.serialNumber === 'MEDIAS'
            ? { hecho: false, aMedias: true }
            : { hecho: false },
      )
      const antes = filas.map(f => ({ ...f }))

      expect(await reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA')).toBe(1)

      expect(hecha).toMatchObject({ estado: 'APLICADO', resultado: HECHA })
      expect([sinEfecto, aMedias, yaAplicada, enVuelo]).toEqual(antes.slice(1))
      expect(efecto).toHaveBeenCalledTimes(3)
    })

    it('sólo los de ESE celular, ESA sucursal y ESE tipo, con tope', async () => {
      retenido({ id: 'r1', celularId: 'cel2' })
      retenido({ id: 'r2', venueId: 'v2' })
      retenido({ id: 'r3', tipo: 'ENTRADA' })
      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })

      expect(await reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA')).toBe(0)

      expect(filas.every(f => f.estado === 'PENDIENTE')).toBe(true)
      expect(efecto).not.toHaveBeenCalled()
      // I8: la consulta barata ya filtra por celular, sucursal y tipo; sin candidatos no hay candado ni selección.
      expect(db.envioRetenidoDeCampo.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ celularId: 'cel1', venueId: 'v1', tipo: 'VENTA' }) }),
      )
      expect(db.envioRetenidoDeCampo.findMany).not.toHaveBeenCalled()
    })
  })
})

describe('arreglo final 7: decidir y reconciliar van en fila por celular (I8, R6-1); el gancho no se queda ciego (R6-2)', () => {
  const HECHA = { orderId: 'o', paymentId: 'p', saleVerificationId: 'sv', recuperado: true }
  const pendiente = <T>() => {
    let soltar!: (v: T) => void
    const promesa = new Promise<T>(r => (soltar = r))
    return { promesa, soltar }
  }
  /** Deja correr lo que esté listo (p. ej. un gancho que, si no espera el candado, ya habría terminado). */
  const dejaCorrer = async () => {
    for (let i = 0; i < 30; i++) await tick()
  }
  const valor = (x: any) => (x instanceof Date ? x.getTime() : x)
  beforeEach(() => {
    // Como Postgres: filtra, ORDENA según `orderBy` y luego corta en `take`.
    db.envioRetenidoDeCampo.findMany.mockImplementation(async ({ where, take, orderBy }: any) => {
      await tick()
      const orden: any[] = (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(Boolean)
      const cmp = (a: any, b: any) => {
        for (const o of orden) {
          const [k, dir] = Object.entries(o)[0] as [string, string]
          const [x, y] = [valor(a[k]), valor(b[k])]
          if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1)
        }
        return 0
      }
      return filas
        .filter(f => coincide(f, where))
        .sort(cmp)
        .slice(0, take)
        .map(f => ({ ...f }))
    })
  })
  const llaveDelCandado = () => db.$queryRaw.mock.calls.map((c: any[]) => c.slice(1).join('|'))

  describe('I8 · las decisiones y el gancho no se intercalan (tabla de intercalaciones)', () => {
    it('R6-1 · «Descartar» consulta (nada), la venta normal termina y su gancho llega: espera el candado, ve el DESCARTADO y lo deja APLICADO con la reversión', async () => {
      const f = retenido()
      const consulta = pendiente<any>()
      efecto.mockImplementationOnce(async () => consulta.promesa)
      const d = resolver('DESCARTAR', { nota: 'no vino' })
      while (!efecto.mock.calls.length) await tick()

      // La venta normal ya existe; su gancho corre mientras «Descartar» tiene el candado.
      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      let terminoElGancho = false
      const gancho = reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA').finally(() => (terminoElGancho = true))
      await dejaCorrer()
      expect(terminoElGancho).toBe(false) // espera su turno: no se salta la fila ocupada

      consulta.soltar({ hecho: false })
      expect(await d).toEqual({ estado: 'DESCARTADO', repetida: false })
      expect(await gancho).toBe(1)
      expect(f).toMatchObject({ estado: 'APLICADO', resultado: HECHA })
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CAMPO_RETENIDO_DESCARTE_REVERTIDO',
          entityId: 'r1',
          data: expect.objectContaining({ descartadoPor: 'sup1', notaDelDescarte: 'no vino' }),
        }),
      )
      expect(llaveDelCandado()).toEqual(['campo-retenidos:cel1', 'campo-retenidos:cel1'])
    })

    it('al revés: el gancho llegó antes de que «Descartar» tomara el candado → la deja APLICADO y «Descartar» contesta YA_APLICADO', async () => {
      const f = retenido()
      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      expect(await reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA')).toBe(1)
      await expect(resolver('DESCARTAR')).rejects.toMatchObject({ code: 'YA_APLICADO' })
      expect(f).toMatchObject({ estado: 'APLICADO', resultado: HECHA })
    })

    it('variante de R6-1 · la gracia consulta (nada), la venta normal termina y su gancho no ve fila todavía: la gracia vuelve a mirar al soltar el candado → APLICADO', async () => {
      const e = envio() // no reportada: nacería PENDIENTE
      const consulta = pendiente<any>()
      efecto.mockImplementationOnce(async () => consulta.promesa)
      const g = recibirEnGracia(celular(), e)
      while (!efecto.mock.calls.length) await tick()

      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      expect(await reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA')).toBe(0) // aún no hay fila: sin candado, sin trabajo

      consulta.soltar({ hecho: false })
      expect(await g).toEqual({ status: 200, body: { resuelto: 'APLICADO', resultado: HECHA } })
      expect(filas).toHaveLength(1)
      expect(filas[0]).toMatchObject({ estado: 'APLICADO', motivo: 'NO_REPORTADA', resultado: HECHA })
      expect(aplicar).not.toHaveBeenCalled()
    })

    it('el gancho pasó antes de que la gracia tomara el candado → su consulta (dentro) ve la venta y nace APLICADO', async () => {
      const e = envio()
      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      expect(await reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA')).toBe(0)
      expect(await recibirEnGracia(celular(), e)).toEqual({ status: 200, body: { resuelto: 'APLICADO', resultado: HECHA } })
      expect(filas[0]).toMatchObject({ estado: 'APLICADO' })
    })

    it('el rechazo de la gracia regresa a PENDIENTE con el candado: el gancho que llega mientras decide espera, ve la PENDIENTE → APLICADO', async () => {
      const e = envio()
      aplicar.mockResolvedValue(rechazado())
      const consulta = pendiente<any>()
      efecto.mockResolvedValueOnce({ hecho: false }).mockImplementationOnce(async () => consulta.promesa)
      const g = recibirEnGracia(reportado(e), e)
      while (efecto.mock.calls.length < 2) await tick()

      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      let terminoElGancho = false
      const gancho = reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA').finally(() => (terminoElGancho = true))
      await dejaCorrer()
      expect(terminoElGancho).toBe(false)

      consulta.soltar({ hecho: false })
      expect(await g).toEqual({ status: 202, body: { retenido: true, motivo: 'RECHAZADO' } })
      expect(await gancho).toBe(1)
      expect(filas[0]).toMatchObject({ estado: 'APLICADO', resultado: HECHA })
    })

    it('el rechazo de «Aplicar» regresa a PENDIENTE con el candado: el gancho espera y la deja APLICADO', async () => {
      const f = retenido()
      aplicar.mockResolvedValue(rechazado())
      const consulta = pendiente<any>()
      efecto.mockResolvedValueOnce({ hecho: false }).mockImplementationOnce(async () => consulta.promesa)
      const a = resolver('APLICAR')
      while (efecto.mock.calls.length < 2) await tick()

      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      let terminoElGancho = false
      const gancho = reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA').finally(() => (terminoElGancho = true))
      await dejaCorrer()
      expect(terminoElGancho).toBe(false)

      consulta.soltar({ hecho: false })
      await expect(a).rejects.toMatchObject({ code: 'NO_SE_PUDO_APLICAR' })
      expect(await gancho).toBe(1)
      expect(f).toMatchObject({ estado: 'APLICADO', resultado: HECHA })
    })

    it('reanudar que ya no procede (24 h) regresa a PENDIENTE con el candado: el gancho espera y la deja APLICADO', async () => {
      const e = envio()
      const f = retenido({
        huella: huellaDelEnvio(e.tipo, e.venueId, e.cuerpoJson),
        cuerpoJson: e.cuerpoJson,
        estado: 'APLICANDO',
        motivo: 'APLICADO_EN_GRACIA',
        updatedAt: new Date(AHORA.getTime() - 6 * MIN),
      })
      const consulta = pendiente<any>()
      efecto.mockImplementationOnce(async () => consulta.promesa)
      const g = recibirEnGracia(reportado(e, { desvinculadoAt: new Date(AHORA.getTime() - 25 * HORA) }), e)
      while (!efecto.mock.calls.length) await tick()

      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      let terminoElGancho = false
      const gancho = reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA').finally(() => (terminoElGancho = true))
      await dejaCorrer()
      expect(terminoElGancho).toBe(false)

      consulta.soltar({ hecho: false })
      expect(await g).toEqual({ status: 202, body: { retenido: true, motivo: 'FUERA_DE_PLAZO' } })
      expect(await gancho).toBe(1)
      expect(f).toMatchObject({ estado: 'APLICADO', resultado: HECHA })
    })

    it('una EJECUCIÓN en vuelo («Aplicar» ejecutando) no detiene al gancho ni la toca: llega APLICADO por su propio efecto', async () => {
      const f = retenido()
      const ejecucion = pendiente<any>()
      aplicar.mockImplementationOnce(async () => ejecucion.promesa)
      const a = resolver('APLICAR')
      while (!aplicar.mock.calls.length) await tick()
      efecto.mockClear()

      expect(await reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA')).toBe(0) // no espera a la ejecución: no tiene el candado
      expect(efecto).not.toHaveBeenCalled()
      expect(f.estado).toBe('APLICANDO')

      ejecucion.soltar(aplicado())
      expect(await a).toMatchObject({ estado: 'APLICADO', repetida: false })
    })

    it('el candado es por celular: lo de otro celular no espera', async () => {
      retenido()
      retenido({ id: 'r2', celularId: 'cel2', huella: 'k'.repeat(64) })
      const consulta = pendiente<any>()
      efecto.mockImplementationOnce(async () => consulta.promesa)
      const d = resolver('DESCARTAR')
      while (!efecto.mock.calls.length) await tick()

      efecto.mockResolvedValue({ hecho: true, resultado: HECHA })
      expect(await reconciliarConLaRutaNormal('cel2', 'v1', 'VENTA')).toBe(1)
      expect(filas[1].estado).toBe('APLICADO')
      consulta.soltar({ hecho: false })
      await d
    })
  })

  describe('el costo de la ruta normal', () => {
    it('un celular sin retenidos: UNA consulta (por celular, prefijo del único), sin transacción ni candado ni selección', async () => {
      retenido({ estado: 'APLICADO' }) // lo aplicado no cuenta
      retenido({ id: 'r2', estado: 'DESCARTADO', resueltoAt: new Date(AHORA.getTime() - 25 * HORA) }) // historial viejo tampoco
      expect(await reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA')).toBe(0)
      expect(db.envioRetenidoDeCampo.findFirst).toHaveBeenCalledTimes(1)
      expect(db.envioRetenidoDeCampo.findFirst.mock.calls[0][0]).toMatchObject({
        where: { celularId: 'cel1', venueId: 'v1', tipo: 'VENTA' },
        select: { id: true },
      })
      expect(db.$transaction).not.toHaveBeenCalled()
      expect(db.$queryRaw).not.toHaveBeenCalled()
      expect(db.envioRetenidoDeCampo.findMany).not.toHaveBeenCalled()
      expect(efecto).not.toHaveBeenCalled()
    })
  })

  describe('R6-2 · el historial no tapa lo nuevo', () => {
    it('los 501 de Codex: 500 DESCARTADO sin efecto + un envío nuevo PENDIENTE cuya venta normal terminó → el nuevo queda APLICADO', async () => {
      for (let i = 0; i < 500; i++) {
        retenido({
          id: `d${i}`,
          huella: `d${i}`,
          cuerpoJson: cuerpoVenta({ serialNumber: `VIEJA${i}` }),
          estado: 'DESCARTADO',
          resueltoAt: new Date(AHORA.getTime() - 2 * HORA),
          createdAt: new Date(AHORA.getTime() - 3 * HORA + i),
        })
      }
      const nuevo = retenido({ id: 'nuevo', huella: 'nuevo', cuerpoJson: cuerpoVenta({ serialNumber: 'NUEVA' }), createdAt: AHORA })
      efecto.mockImplementation(async (_t: string, _c: unknown, cuerpo: any) =>
        cuerpo.serialNumber === 'NUEVA' ? { hecho: true, resultado: HECHA } : { hecho: false },
      )

      expect(await reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA')).toBe(1)
      expect(nuevo).toMatchObject({ estado: 'APLICADO', resultado: HECHA })
      expect(efecto.mock.calls.some((c: any[]) => c[2].serialNumber === 'NUEVA')).toBe(true)
    })

    it('los DESCARTADO: sólo los resueltos en las últimas 24 h, el más reciente primero (también con más de 500)', async () => {
      const viejo = retenido({
        id: 'viejo',
        huella: 'viejo',
        cuerpoJson: cuerpoVenta({ serialNumber: 'VIEJO' }),
        estado: 'DESCARTADO',
        resueltoAt: new Date(AHORA.getTime() - 25 * HORA),
        createdAt: new Date(AHORA.getTime() - 30 * HORA), // el más viejo: un orden por antigüedad lo elegiría primero
      })
      for (let i = 0; i < 501; i++) {
        retenido({
          id: `d${i}`,
          huella: `d${i}`,
          cuerpoJson: cuerpoVenta({ serialNumber: i === 500 ? 'RECIENTE' : `OTRA${i}` }),
          estado: 'DESCARTADO',
          resueltoAt: new Date(AHORA.getTime() - 20 * HORA + i * 1000), // el d500 es el último descartado
          createdAt: new Date(AHORA.getTime() - 23 * HORA),
        })
      }
      efecto.mockImplementation(async (_t: string, _c: unknown, cuerpo: any) =>
        ['RECIENTE', 'VIEJO'].includes(cuerpo.serialNumber) ? { hecho: true, resultado: HECHA } : { hecho: false },
      )

      expect(await reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA')).toBe(1)
      expect(filas.find(f => f.id === 'd500')).toMatchObject({ estado: 'APLICADO' })
      expect(viejo.estado).toBe('DESCARTADO')
      expect(efecto.mock.calls.some((c: any[]) => c[2].serialNumber === 'VIEJO')).toBe(false)
      expect(efecto).toHaveBeenCalledTimes(500)
    })

    it('PENDIENTE y APLICANDO sin dueño van aparte, los más recientes primero, con su propio tope', async () => {
      retenido({ id: 'p1' })
      expect(await reconciliarConLaRutaNormal('cel1', 'v1', 'VENTA')).toBe(0)
      const [vivas, descartadas] = db.envioRetenidoDeCampo.findMany.mock.calls.map((c: any[]) => c[0])
      expect(vivas).toMatchObject({ take: 500, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
      expect(descartadas).toMatchObject({ take: 500, orderBy: [{ resueltoAt: 'desc' }, { id: 'desc' }] })
      expect(descartadas.where).toMatchObject({ estado: 'DESCARTADO', resueltoAt: { gte: new Date(AHORA.getTime() - 24 * HORA) } })
    })
  })
})

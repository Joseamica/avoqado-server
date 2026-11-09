/**
 * La gracia de 24 h y «por revisar» (App de campo, bloque 1, Tarea 7). `aplicarEnvio` va mockeado (lo prueba
 * envioDeCampo.test.ts); la huella es la real. Los retenidos viven en una tabla en memoria con el MISMO comportamiento que
 * importa de Postgres: el único `(celularId, huella)` (P2002) y los `updateMany` condicionados por estado (el CAS).
 */
import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import { ConflictError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { staffHasPermissionInVenue } from '@/middlewares/checkPermission.middleware'
import { sucursalesDeLaPersona } from '@/services/tpv/campo/celular/personasDeCampo'
import { aplicarEnvio, huellaDelEnvio } from '@/services/tpv/campo/celular/envioDeCampo'
import { listarRetenidos, recibirEnGracia, resolverRetenido } from '@/services/tpv/campo/celular/graciaDelCelular.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
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
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/middlewares/checkPermission.middleware', () => ({ staffHasPermissionInVenue: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/personasDeCampo', () => ({ sucursalesDeLaPersona: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/envioDeCampo', () => ({
  ...jest.requireActual('@/services/tpv/campo/celular/envioDeCampo'),
  aplicarEnvio: jest.fn(),
}))

const db = prisma as any
const aplicar = aplicarEnvio as jest.Mock
const sucursales = sucursalesDeLaPersona as jest.Mock
const permiso = staffHasPermissionInVenue as jest.Mock
const AHORA = new Date('2026-11-09T12:00:00.000Z')
const HORA = 60 * 60 * 1000
const DESVINCULADO = new Date(AHORA.getTime() - 2 * HORA)

/** La tabla de retenidos en memoria. */
let filas: any[]
const coincide = (f: any, where: any) =>
  Object.entries(where).every(([k, v]: [string, any]) => (v && typeof v === 'object' && 'in' in v ? v.in.includes(f[k]) : f[k] === v))
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
const aplicado = (status = 201, body: object = { orderId: 'o', paymentId: 'p', repetida: false }) => ({ tipo: 'APLICADO', status, body })
const rechazado = (code = 'SIM_YA_VENDIDA') => ({ tipo: 'RECHAZADO', rechazo: { code, message: 'Esta SIM ya se vendió.' } })

beforeEach(() => {
  jest.resetAllMocks()
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }).setSystemTime(AHORA)
  filas = []
  db.venue.findUnique.mockImplementation(async ({ where }: any) => ({ organizationId: where.id === 'vOtra' ? 'org2' : 'org1' }))
  db.venue.findMany.mockResolvedValue([{ id: 'v1', name: 'Sucursal Centro', timezone: 'America/Mexico_City' }])
  db.staff.findMany.mockResolvedValue([{ id: 's1', firstName: 'Ana', lastName: 'Campo' }])
  db.envioRetenidoDeCampo.findUnique.mockImplementation(
    async ({ where }: any) =>
      filas.find(f => f.celularId === where.celularId_huella.celularId && f.huella === where.celularId_huella.huella) ?? null,
  )
  db.envioRetenidoDeCampo.findFirst.mockImplementation(async ({ where }: any) => {
    await tick()
    return filas.find(f => coincide(f, where)) ?? null
  })
  db.envioRetenidoDeCampo.updateMany.mockImplementation(async ({ where, data }: any) => {
    await tick()
    const m = filas.filter(f => coincide(f, where))
    m.forEach(f => Object.assign(f, data))
    return { count: m.length }
  })
  db.envioRetenidoDeCampo.create.mockImplementation(async ({ data }: any) => {
    if (filas.some(f => f.celularId === data.celularId && f.huella === data.huella)) {
      throw new Prisma.PrismaClientKnownRequestError('único', { code: 'P2002', clientVersion: 'x' })
    }
    const f = { id: `r${filas.length + 1}`, estado: 'PENDIENTE', rechazo: null, resultado: null, nota: null, createdAt: AHORA, ...data }
    filas.push(f)
    return f
  })
  sucursales.mockResolvedValue([{ staffVenueId: 'sv1', venueId: 'v1', nombre: 'Sucursal Centro', role: 'CASHIER', pin: null }])
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
    expect(filas).toHaveLength(0)
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
    expect(filas[0]).toMatchObject({ motivo: 'RECHAZADO', rechazo: { code: 'SIM_YA_VENDIDA', message: 'Esta SIM ya se vendió.' } })
  })

  it('VENTA_EN_PROCESO se propaga y no se retiene', async () => {
    const e = envio()
    const enProceso = new ConflictError('procesando', 'VENTA_EN_PROCESO')
    aplicar.mockRejectedValue(enProceso)
    await expect(recibirEnGracia(reportado(e), e)).rejects.toBe(enProceso)
    expect(filas).toHaveLength(0)
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
    const e = envio(JSON.stringify({ ventaLlave: randomUUID(), photoUrls: ['https://example.test/a.jpg'] }), 'EVIDENCIA')
    aplicar.mockResolvedValue(aplicado(200, { success: true }))
    expect(await recibirEnGracia(celular(), e)).toEqual({ status: 200, body: { success: true, aplicadoEnGracia: true } })
    expect(permiso).toHaveBeenCalledWith({ staffId: 's1', venueId: 'v1', permission: 'payments:create' })
  })

  it('evidencia de una venta sin ficha completa (o del celular nuevo) → retenida RECHAZADO VENTA_PENDIENTE', async () => {
    const e = envio(JSON.stringify({ ventaLlave: randomUUID(), photoUrls: ['https://example.test/a.jpg'] }), 'EVIDENCIA')
    aplicar.mockResolvedValue({ tipo: 'RECHAZADO', rechazo: { code: 'VENTA_PENDIENTE', message: 'La venta aún no está completa.' } })
    expect((await recibirEnGracia(celular(), e)).body).toEqual({ retenido: true, motivo: 'RECHAZADO' })
    expect(filas[0].rechazo).toMatchObject({ code: 'VENTA_PENDIENTE' })
  })
})

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
    createdAt: AHORA,
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
    expect(db.envioRetenidoDeCampo.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: 'org1', estado: { in: ['PENDIENTE', 'APLICANDO'] } },
      data: { estado: 'APLICANDO' },
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

      const aplicando = resolver('APLICAR').then(
        r => r,
        e => e,
      )
      if (!descartaPrimero) {
        while (f.estado !== 'APLICANDO') await tick() // «Aplicar» ya tomó el retenido
      }
      const descartando = resolver('DESCARTAR').then(
        r => r,
        e => e,
      )
      const d = await descartando
      if (aplicar.mock.calls.length) soltar()
      const a = await aplicando

      if (f.estado === 'DESCARTADO') {
        expect(aplicar).not.toHaveBeenCalled()
        expect(a).toMatchObject({ code: 'YA_RESUELTO' })
      } else {
        expect(f.estado).toBe('APLICADO')
        expect(aplicar).toHaveBeenCalledTimes(1)
        expect(d).toMatchObject({ code: 'APLICACION_A_MEDIAS' })
      }
      expect(f.estado).toBe(descartaPrimero ? 'DESCARTADO' : 'APLICADO')
    }
  })

  it('persona dada de baja + «Aplicar» una ENTRADA → 422 PERSONA_SIN_ASIGNACION sin tocar el estado ni checar', async () => {
    const f = retenido({ tipo: 'ENTRADA', cuerpoJson: JSON.stringify({ llave: randomUUID() }) })
    sucursales.mockResolvedValue([])
    await expect(resolver('APLICAR')).rejects.toMatchObject({
      statusCode: 422,
      code: 'NO_SE_PUDO_APLICAR',
      details: { motivo: 'PERSONA_SIN_ASIGNACION' },
    })
    expect(aplicar).not.toHaveBeenCalled()
    expect(f.estado).toBe('PENDIENTE')
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
          createdAt: AHORA,
          estado: 'PENDIENTE',
        },
      ],
    })
  })

  it('el resumen de cada tipo: checada → hora local, custodia → series, evidencia → fotos; el rechazo sin su detalle', async () => {
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
    expect(items[4].rechazo).toEqual({ code: 'SIM_YA_VENDIDA', message: 'ya' })
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

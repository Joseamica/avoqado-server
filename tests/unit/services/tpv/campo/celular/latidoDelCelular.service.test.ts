/**
 * El latido del celular de campo (App de campo, bloque 1, Tarea 5): guarda la foto de lo que tiene por subir sólo mientras
 * está vinculado (desvincular la congela) y le dice al celular en qué estado está.
 */
import prisma from '@/utils/prismaClient'
import { sucursalesParaElCelular } from '@/services/tpv/campo/celular/sesionDeCelular'
import { registrarLatido } from '@/services/tpv/campo/celular/latidoDelCelular.service'
import { latidoSchema } from '@/schemas/tpv/campo.schema'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { celularDeCampo: { updateMany: jest.fn(), update: jest.fn(), findUniqueOrThrow: jest.fn() }, staff: { findUnique: jest.fn() } },
}))
jest.mock('@/services/tpv/campo/celular/sesionDeCelular', () => ({ sucursalesParaElCelular: jest.fn() }))

const db = prisma as any
const paraElCelular = sucursalesParaElCelular as jest.Mock
const AHORA = new Date('2026-11-09T12:00:00.000Z')
const H = (n: number) => 'ab'.repeat(32).slice(0, 63) + String(n % 10)
const vinculado = { id: 'cel1', organizationId: 'org1', staffId: 'staff1', staffIdVinculado: 'staff1', desvinculadoAt: null, pinSal: 'sal' }
const DESVINCULADO_AT = new Date('2026-11-09T02:00:00.000Z')
const desvinculado = { ...vinculado, staffIdVinculado: null, desvinculadoAt: DESVINCULADO_AT }
const sucursal = { venueId: 'vA', nombre: 'Centro', verificadorPin: null }
const latido = {
  porSubir: { total: 3, ventas: 2, fotos: 1 },
  huellas: [H(1), H(2)],
  aparato: { marca: 'Samsung', modelo: 'A15', versionAndroid: '14', versionApp: '1.0.0' },
}

beforeEach(() => {
  jest.useFakeTimers({ now: AHORA })
  jest.clearAllMocks()
  db.celularDeCampo.updateMany.mockResolvedValue({ count: 1 })
  db.celularDeCampo.update.mockResolvedValue({})
  db.staff.findUnique.mockResolvedValue({ firstName: 'Ana', lastName: 'Campo' })
  paraElCelular.mockResolvedValue([sucursal])
})
afterEach(() => jest.useRealTimers())

describe('registrarLatido', () => {
  it('vinculado: guarda visto, por subir, el detalle, las huellas y el aparato SÓLO si sigue vinculado; VINCULADO con sus sucursales', async () => {
    const r = await registrarLatido(vinculado as any, latido)

    expect(db.celularDeCampo.updateMany).toHaveBeenCalledWith({
      where: { id: 'cel1', staffIdVinculado: { not: null } },
      data: {
        vistoAt: AHORA,
        porSubir: 3,
        porSubirDetalle: { ventas: 2, fotos: 1 },
        huellasPorSubir: [H(1), H(2)],
        huellasReportadasAt: AHORA,
        marca: 'Samsung',
        modelo: 'A15',
        versionAndroid: '14',
        versionApp: '1.0.0',
      },
    })
    expect(db.celularDeCampo.update).not.toHaveBeenCalled()
    expect(r).toEqual({
      estado: 'VINCULADO',
      graciaHasta: null,
      persona: { staffId: 'staff1', nombre: 'Ana Campo' },
      sucursales: [sucursal],
      horaDelServidor: AHORA.toISOString(),
    })
  })

  it('desvinculado: sólo el visto (la foto congelada no se toca) y DESVINCULADO con graciaHasta = desvinculadoAt + 24 h', async () => {
    const r = await registrarLatido(desvinculado as any, latido)

    expect(db.celularDeCampo.updateMany).not.toHaveBeenCalled()
    expect(db.celularDeCampo.update).toHaveBeenCalledWith({ where: { id: 'cel1' }, data: { vistoAt: AHORA } })
    expect(paraElCelular).not.toHaveBeenCalled()
    expect(r).toEqual({
      estado: 'DESVINCULADO',
      graciaHasta: '2026-11-10T02:00:00.000Z',
      persona: { staffId: 'staff1', nombre: 'Ana Campo' },
      sucursales: [],
      horaDelServidor: AHORA.toISOString(),
    })
  })

  it('lo desvincularon entre el middleware y el latido: no toca la foto, deja el visto y contesta DESVINCULADO', async () => {
    db.celularDeCampo.updateMany.mockResolvedValue({ count: 0 })
    db.celularDeCampo.findUniqueOrThrow.mockResolvedValue({ ...desvinculado })

    const r = await registrarLatido(vinculado as any, latido)

    expect(db.celularDeCampo.update).toHaveBeenCalledWith({ where: { id: 'cel1' }, data: { vistoAt: AHORA } })
    expect(r).toMatchObject({ estado: 'DESVINCULADO', graciaHasta: '2026-11-10T02:00:00.000Z', sucursales: [] })
  })

  it('vinculado sin ninguna sucursal (dado de baja) → DADO_DE_BAJA, sucursales vacías; la foto sí se guarda', async () => {
    paraElCelular.mockResolvedValue([])

    const r = await registrarLatido(vinculado as any, { porSubir: { total: 0 }, huellas: [] })

    expect(db.celularDeCampo.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ porSubir: 0, porSubirDetalle: {}, huellasPorSubir: [] }) }),
    )
    expect(r).toMatchObject({ estado: 'DADO_DE_BAJA', graciaHasta: null, sucursales: [] })
  })
})

describe('latidoSchema', () => {
  const valido = (body: unknown) => latidoSchema.safeParse({ body }).success

  it('acepta hasta 500 huellas; 501 → inválido', () => {
    expect(valido({ porSubir: { total: 500 }, huellas: Array.from({ length: 500 }, (_, i) => H(i)) })).toBe(true)
    expect(valido({ porSubir: { total: 501 }, huellas: Array.from({ length: 501 }, (_, i) => H(i)) })).toBe(false)
  })

  it('una huella que no son 64 hex en minúsculas → inválido', () => {
    for (const mala of ['ab'.repeat(31), 'AB'.repeat(32), 'zz'.repeat(32), `${'ab'.repeat(32)}0`]) {
      expect(valido({ porSubir: { total: 1 }, huellas: [mala] })).toBe(false)
    }
  })

  it('totales enteros no negativos, sin campos de más, y el aparato sin aparatoId', () => {
    expect(valido({ porSubir: { total: -1 }, huellas: [] })).toBe(false)
    expect(valido({ porSubir: { total: 1.5 }, huellas: [] })).toBe(false)
    expect(valido({ porSubir: { total: 1 }, huellas: [], otra: 1 })).toBe(false)
    expect(valido({ porSubir: { total: 1 }, huellas: [], aparato: { aparatoId: 'x'.repeat(10) } })).toBe(false)
    expect(valido(latido)).toBe(true)
  })
})

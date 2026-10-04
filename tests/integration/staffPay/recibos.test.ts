// tests/integration/staffPay/recibos.test.ts
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as XLSX from 'xlsx'
import { exportarRecibo, marcarPagado, previewPagado, reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { agregarAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import { guardarAjusteDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'
import { getRowCapForFormat } from '@/services/dashboard/export.helpers'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, tablaMindform, TZ } from './_mundo'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => {
    const l = venueIds.filter(v => (global as any).__legibles.includes(v))
    return { venueIds: l, parcial: l.length < new Set(venueIds).size }
  }),
  tienePermisoEn: jest.fn(async () => true),
  // Lo que «marcar pagado» y el cierre resuelven ANTES de su transacción (revisión A8, Importante 2).
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds.filter(v => (global as any).__cierre.includes(v))),
  assertPermisoEnSedes: jest.fn(async (_u: string, venueIds: string[]) => {
    const permitidas: string[] = (global as any).__cierre
    if (venueIds.some(v => !permitidas.includes(v)))
      throw Object.assign(new Error('Necesitas cerrar en todas las sedes'), { statusCode: 403 })
  }),
}))
// El tope real del archivo (1,000 / 10,000); una prueba lo baja a 2 para ver el error sin crear miles de renglones.
jest.mock('@/services/dashboard/export.helpers', () => {
  const real = jest.requireActual('@/services/dashboard/export.helpers')
  return { ...real, getRowCapForFormat: jest.fn(real.getRowCapForFormat) }
})

const AHORA = new Date('2026-09-02T12:00:00Z')
let m: Mundo
let bsf: { venueId: string; productId: string }
let periodId: string

beforeAll(async () => {
  m = await crearMundo('recibos')
  bsf = await crearSede(m.orgId, m.key, 'bsf')
  await prisma.staffVenue.create({ data: { staffId: m.ana, venueId: bsf.venueId, role: 'MANAGER', active: true } })
  ;(global as any).__sedes = [m.venueId, bsf.venueId]
  ;(global as any).__legibles = [m.venueId, bsf.venueId]
  ;(global as any).__cierre = [m.venueId, bsf.venueId]
  await tablaMindform(m)
  await tablaMindform(m, bsf.venueId)
  await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) }) // PN $570
  await clase(m, {
    staffId: m.ana,
    inicioIso: '2026-08-05T14:00:00Z',
    reservas: confirmadas(5),
    venueId: bsf.venueId,
    productId: bsf.productId,
  }) // BSF $460
  await clase(m, { staffId: m.sofia, inicioIso: '2026-08-06T14:00:00Z', reservas: confirmadas(8) }) // PN $480
  await agregarAjusteManual({
    userId: m.owner,
    venueId: m.venueId,
    sede: m.venueId,
    staffId: m.sofia,
    amount: 200,
    reason: 'Bono puntualidad',
    fecha: '2026-08-20',
    clientKey: `${m.key}-bono`,
  })
  // Un descuento manual: el PDF y el Excel tienen que llevar su signo (Codex R2-R1-14).
  await agregarAjusteManual({
    userId: m.owner,
    venueId: m.venueId,
    sede: m.venueId,
    staffId: m.sofia,
    amount: -50,
    reason: 'Descuento por retardo',
    fecha: '2026-08-21',
    clientKey: `${m.key}-desc`,
  })
  const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
  periodId = (
    await cerrarPeriodo({
      userId: m.owner,
      venueId: m.venueId,
      fecha: '2026-08-15',
      ahora: AHORA,
      huellaEsperada: p.huella,
      confirmarHuerfanas: true,
    })
  ).periodId
})
afterAll(() => borrarMundo(m))
afterEach(() => {
  ;(global as any).__sedes = [m.venueId, bsf.venueId]
  ;(global as any).__legibles = [m.venueId, bsf.venueId]
  ;(global as any).__cierre = [m.venueId, bsf.venueId]
})

const recibo = (staffId: string, extra: Partial<{ limit: number; cursor: string; fecha: string; sede: string }> = {}) =>
  reciboDePersona({
    userId: m.owner,
    venueId: m.venueId,
    staffId,
    fecha: extra.fecha ?? '2026-08-15',
    limit: extra.limit ?? 100,
    cursor: extra.cursor,
    sede: extra.sede,
  })

/** Cada prueba de pago pone el estado que necesita AL EMPEZAR (Codex R2-Nuevo 6): ninguna depende del orden. */
async function estadoDePago(pagados: string[]) {
  await prisma.staffPayStatement.updateMany({ where: { periodId }, data: { paidAt: null, paidById: null, paidNote: null } })
  if (pagados.length) {
    await prisma.staffPayStatement.updateMany({
      where: { periodId, staffId: { in: pagados } },
      data: { paidAt: new Date(), paidById: m.owner },
    })
  }
}

describe('recibos (spec §6.5, §7.3)', () => {
  it('el recibo cerrado se lee de lo congelado: clases y ajustes, en orden (fecha de servicio, id), con su total', async () => {
    const r = await recibo(m.sofia)
    expect(r).toMatchObject({
      persona: 'Sofia QA',
      periodo: { estado: 'CLOSED', start: '2026-08-01' },
      total: '630.00',
      cantidad: 3,
      siguiente: null,
      pagadoEn: null,
      parcial: false,
    })
    expect(r.renglones.map(x => [x.tipo, x.concepto, x.monto])).toEqual([
      ['CLASE', 'Reformer', '480.00'],
      ['AJUSTE', 'Bono puntualidad', '200.00'],
      ['AJUSTE', 'Descuento por retardo', '-50.00'],
    ])
  })

  it('el recibo se pagina con cursor y el total es del recibo ENTERO, no de la página (Codex R2-R1-20)', async () => {
    const p1 = await recibo(m.sofia, { limit: 2 })
    expect(p1).toMatchObject({ total: '630.00', cantidad: 3 })
    expect(p1.renglones.map(x => x.monto)).toEqual(['480.00', '200.00'])
    expect(p1.siguiente).not.toBeNull()
    const p2 = await recibo(m.sofia, { limit: 2, cursor: p1.siguiente! })
    expect(p2.renglones.map(x => x.monto)).toEqual(['-50.00'])
    expect(p2).toMatchObject({ total: '630.00', siguiente: null })
  })

  it('el recibo de un periodo ABIERTO junta en UNA consulta la valoración en vivo y los ajustes, con el mismo cursor (Codex R2-R1-20)', async () => {
    await clase(m, { staffId: m.carla, inicioIso: '2026-09-03T14:00:00Z', reservas: confirmadas(8) }) // PN $480 (Coach), en vivo
    await agregarAjusteManual({
      userId: m.owner,
      venueId: m.venueId,
      sede: m.venueId,
      staffId: m.carla,
      amount: 100,
      reason: 'Bono de septiembre',
      fecha: '2026-09-10',
      clientKey: `${m.key}-sep`,
    })
    const p1 = await recibo(m.carla, { fecha: '2026-09-15', limit: 1 })
    expect(p1).toMatchObject({ periodo: { estado: 'OPEN', start: '2026-09-01' }, total: '580.00', cantidad: 2 })
    expect(p1.renglones.map(x => [x.tipo, x.monto])).toEqual([['CLASE', '480.00']])
    const p2 = await recibo(m.carla, { fecha: '2026-09-15', limit: 1, cursor: p1.siguiente! })
    expect(p2.renglones.map(x => [x.tipo, x.concepto, x.monto])).toEqual([['AJUSTE', 'Bono de septiembre', '100.00']])
    expect(p2).toMatchObject({ total: '580.00', siguiente: null })
  })

  it('la zona horaria sale de la MISMA instantánea que los montos: nunca el día de antes con el monto de después (Codex R5)', async () => {
    // 2026-10-01T05:30Z = 30-sep 23:30 en Ciudad de México (septiembre) y 1-oct 00:30 en Cancún (octubre).
    const id = await clase(m, { staffId: m.sofia, inicioIso: '2026-10-01T05:30:00Z', reservas: confirmadas(8) }) // $480 en vivo
    try {
      const r = await reciboDePersona({
        userId: m.owner,
        venueId: m.venueId,
        staffId: m.sofia,
        fecha: '2026-09-15',
        limit: 100,
        // Entre la preparación y la instantánea: la sede cambia a Cancún y la clase pasa a $900.
        trasPreparar: async () => {
          await prisma.venue.update({ where: { id: m.venueId }, data: { timezone: 'America/Cancun' } })
          await guardarAjusteDeClase({
            venueId: m.venueId,
            classSessionId: id,
            payCountOverride: null,
            payAmountOverride: 900,
            payExcluded: false,
            reason: 'Clase privada',
            actorId: m.owner,
          })
        },
      })
      // Con la zona de la instantánea (Cancún) la clase es de octubre: septiembre no la trae, ni a $480 ni a $900.
      expect(r.renglones.map(x => x.monto)).not.toContain('900.00')
      expect(r.renglones.some(x => x.fecha === '2026-09-30')).toBe(false)
    } finally {
      await prisma.venue.update({ where: { id: m.venueId }, data: { timezone: TZ } })
    }
  })

  it('vista parcial: con permiso sólo en PN no ve los renglones de BSF ni su monto', async () => {
    ;(global as any).__legibles = [m.venueId]
    const r = await recibo(m.ana)
    expect(r).toMatchObject({ total: '570.00', parcial: true })
    expect(r.renglones).toHaveLength(1)
  })

  it('filtro de sede: sólo los renglones de esa sede y su total (Codex R2-R1-21)', async () => {
    const r = await recibo(m.ana, { sede: bsf.venueId })
    expect(r).toMatchObject({ total: '460.00', cantidad: 1, parcial: false })
    expect(r.renglones.map(x => x.monto)).toEqual(['460.00'])
  })

  it('apagar BSF después del cierre NO cambia el recibo cerrado de Ana (Codex R1-1)', async () => {
    ;(global as any).__sedes = [m.venueId]
    const r = await recibo(m.ana)
    expect(r).toMatchObject({ total: '1030.00', parcial: false })
  })

  it('eliminar a la persona del equipo NO esconde su recibo histórico: sus devengos acreditan la relación (Codex bloque A #4)', async () => {
    // La eliminación permanente del equipo borra el StaffVenue y conserva el Staff y sus devengos.
    const membresias = await prisma.staffVenue.findMany({
      where: { staffId: m.sofia },
      select: { staffId: true, venueId: true, role: true, active: true },
      take: 10,
    })
    await prisma.staffVenue.deleteMany({ where: { staffId: m.sofia } })
    try {
      await expect(recibo(m.sofia)).resolves.toMatchObject({ persona: 'Sofia QA', total: '630.00', cantidad: 3 })
      const xlsx = await exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId: m.sofia, fecha: '2026-08-15', format: 'xlsx' })
      expect(xlsx.nombre).toMatch(/^recibo-sofia-qa-/)
    } finally {
      await prisma.staffVenue.createMany({ data: membresias })
    }
    // Sin membresía NI devengos en la organización: nunca el nombre de alguien ajeno.
    const ajena = await prisma.staff.create({
      data: { email: `${m.key}-ajena-recibo@example.test`, firstName: 'Ajena', lastName: 'QA', active: true },
    })
    await expect(recibo(ajena.id)).rejects.toMatchObject({ statusCode: 404, message: 'Persona no encontrada' })
  })

  it('renombrar la sede después del cierre no cambia el recibo cerrado: manda el nombre congelado (Codex bloque A #8)', async () => {
    const original = (await prisma.venue.findUniqueOrThrow({ where: { id: m.venueId }, select: { name: true } })).name
    await prisma.venue.update({ where: { id: m.venueId }, data: { name: 'Centro' } })
    try {
      const r = await recibo(m.sofia)
      expect(r.renglones.map(x => x.sede)).toEqual([original, original, original])
    } finally {
      await prisma.venue.update({ where: { id: m.venueId }, data: { name: original } })
    }
  })

  it('marcar pagado: el recibo que incluye BSF exige permiso en BSF; el que sólo es de PN no', async () => {
    await estadoDePago([])
    ;(global as any).__cierre = [m.venueId]
    const sinPermiso = { statusCode: 403, message: expect.stringMatching(/necesitas el permiso de cerrar periodos en todas/) }
    await expect(marcarPagado({ userId: m.owner, venueId: m.venueId, periodId, staffId: m.ana })).rejects.toMatchObject(sinPermiso)
    expect(await marcarPagado({ userId: m.owner, venueId: m.venueId, periodId, staffId: m.sofia })).toEqual({ marcados: 1 })
    await expect(marcarPagado({ userId: m.owner, venueId: m.venueId, periodId })).rejects.toMatchObject(sinPermiso)
  })

  it('la huella de un preview viejo no marca: Ana pasó de pendiente a pagada DESPUÉS del preview (Codex R1-10, R2-Nuevo 6)', async () => {
    await estadoDePago([]) // Ana y Sofía pendientes
    const pv = await previewPagado({ userId: m.owner, venueId: m.venueId, periodId })
    expect(pv).toMatchObject({ cantidad: 2, total: '1660.00' })
    expect(pv.recibos.map(r => r.staffId).sort()).toEqual([m.ana, m.sofia].sort())
    // Transición REAL: Ana pasa de pendiente a pagada.
    expect(await marcarPagado({ userId: m.owner, venueId: m.venueId, periodId, staffId: m.ana })).toEqual({ marcados: 1 })
    await expect(marcarPagado({ userId: m.owner, venueId: m.venueId, periodId, huellaEsperada: pv.huella })).rejects.toMatchObject({
      code: 'HUELLA_CAMBIO',
    })
    expect(await prisma.staffPayStatement.findFirstOrThrow({ where: { periodId, staffId: m.sofia } })).toMatchObject({ paidAt: null })
  })

  it('un recibo pendiente que aparece después del preview: HUELLA_CAMBIO y no se marca ninguno (Codex R2-Nuevo 1)', async () => {
    await estadoDePago([])
    const pv = await previewPagado({ userId: m.owner, venueId: m.venueId, periodId })
    const nuevo = await prisma.staffPayStatement.create({ data: { periodId, staffId: m.carla, total: new Prisma.Decimal(100) } })
    try {
      await expect(marcarPagado({ userId: m.owner, venueId: m.venueId, periodId, huellaEsperada: pv.huella })).rejects.toMatchObject({
        code: 'HUELLA_CAMBIO',
      })
      expect(await prisma.staffPayStatement.count({ where: { periodId, paidAt: { not: null } } })).toBe(0)
    } finally {
      await prisma.staffPayStatement.delete({ where: { id: nuevo.id } })
    }
  })

  it('con la huella vigente marca EXACTAMENTE los que el preview confirmó', async () => {
    await estadoDePago([m.sofia])
    const pv = await previewPagado({ userId: m.owner, venueId: m.venueId, periodId })
    expect(pv).toMatchObject({ cantidad: 1, total: '1030.00' })
    expect(await marcarPagado({ userId: m.owner, venueId: m.venueId, periodId, huellaEsperada: pv.huella })).toEqual({ marcados: 1 })
    expect(await prisma.staffPayStatement.count({ where: { periodId, paidAt: null } })).toBe(0)
    // El ActivityLog dice cuánto se marcó y de qué periodo (revisión A8, menor 3).
    const log = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'SERVICE_PAY_MARKED_PAID', entityId: periodId },
      orderBy: { createdAt: 'desc' },
    })
    expect(log.data).toMatchObject({ staffId: 'todos', marcados: 1, total: '1030.00', periodo: { start: '2026-08-01', end: '2026-08-31' } })
  })

  it('marcar pagado dos veces no hace nada; «a todos» marca sólo los pendientes', async () => {
    await estadoDePago([m.sofia])
    expect(await marcarPagado({ userId: m.owner, venueId: m.venueId, periodId, staffId: m.sofia })).toEqual({ marcados: 0 })
    expect(await marcarPagado({ userId: m.owner, venueId: m.venueId, periodId })).toEqual({ marcados: 1 })
    expect(await prisma.staffPayStatement.count({ where: { periodId, paidAt: null } })).toBe(0)
  })

  it('no se marca pagado un periodo abierto', async () => {
    const abierto = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: new Date('2026-10-01T00:00:00Z'),
        periodEnd: new Date('2026-10-31T00:00:00Z'),
        venueIds: [m.venueId],
      },
    })
    await expect(marcarPagado({ userId: m.owner, venueId: m.venueId, periodId: abierto.id })).rejects.toThrow(/cerrado/)
  })

  it('un cursor emitido con el periodo ABIERTO no se sigue después del cierre: RECIBO_CAMBIO; sin cursor se lee lo cerrado (Codex R3-Nuevo 3)', async () => {
    // Julio: un mes propio de esta prueba (ninguna otra lo toca).
    await clase(m, { staffId: m.sofia, inicioIso: '2026-07-06T14:00:00Z', reservas: confirmadas(8) }) // $480
    await clase(m, { staffId: m.sofia, inicioIso: '2026-07-07T14:00:00Z', reservas: confirmadas(9) }) // $520
    const p1 = await recibo(m.sofia, { fecha: '2026-07-15', limit: 1 })
    expect(p1).toMatchObject({ periodo: { estado: 'OPEN' }, cantidad: 2 })
    expect(p1.siguiente).toMatch(/^A\./)
    const pv = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-07-15', ahora: AHORA })
    await cerrarPeriodo({
      userId: m.owner,
      venueId: m.venueId,
      fecha: '2026-07-15',
      ahora: AHORA,
      huellaEsperada: pv.huella,
      confirmarHuerfanas: true,
    })
    const cambio = {
      code: 'RECIBO_CAMBIO',
      statusCode: 409,
      message: 'El periodo cambió mientras leías: vuelve a cargar el recibo desde el principio.',
    }
    await expect(recibo(m.sofia, { fecha: '2026-07-15', limit: 1, cursor: p1.siguiente! })).rejects.toMatchObject(cambio)
    // El cursor del desglose en vivo (`venueId:classSessionId`) tampoco se sigue en el recibo cerrado.
    await expect(recibo(m.sofia, { fecha: '2026-07-15', limit: 1, cursor: `${m.venueId}:clase-x` })).rejects.toMatchObject(cambio)
    const otraVez = await recibo(m.sofia, { fecha: '2026-07-15', limit: 1 })
    expect(otraVez).toMatchObject({ periodo: { estado: 'CLOSED' }, total: '1000.00', cantidad: 2 })
    expect(otraVez.siguiente).toMatch(/^C\./)
  })

  it('cerrar el periodo A MEDIA exportación no descuadra el archivo: sus renglones suman su total (Codex R3-Nuevo 1, R4)', async () => {
    // Junio: un mes propio de esta prueba. Recibo ABIERTO de Sofía con 2 renglones en vivo ($480 + $520) y lotes de 1:
    // entre el lote 1 y el 2, OTRA conexión (el cliente global) cierra junio y termina antes de seguir.
    await clase(m, { staffId: m.sofia, inicioIso: '2026-06-08T14:00:00Z', reservas: confirmadas(8) })
    await clase(m, { staffId: m.sofia, inicioIso: '2026-06-09T14:00:00Z', reservas: confirmadas(9) })
    let cerrado = false
    const xlsx = await exportarRecibo({
      userId: m.owner,
      venueId: m.venueId,
      staffId: m.sofia,
      fecha: '2026-06-15',
      format: 'xlsx',
      tamLote: 1,
      entreLotes: async () => {
        if (cerrado) return
        cerrado = true
        const pv = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-06-15', ahora: AHORA })
        await cerrarPeriodo({
          userId: m.owner,
          venueId: m.venueId,
          fecha: '2026-06-15',
          ahora: AHORA,
          huellaEsperada: pv.huella,
          confirmarHuerfanas: true,
        })
      },
    })
    // El cierre sí ocurrió a media exportación…
    expect(cerrado).toBe(true)
    expect(
      (
        await prisma.servicePayPeriod.findFirstOrThrow({
          where: { organizationId: m.orgId, periodStart: new Date('2026-06-01T00:00:00Z') },
        })
      ).status,
    ).toBe('CLOSED')
    // …y aun así el archivo es de UN instante: los dos renglones y un total que los suma.
    const libro = XLSX.read(xlsx.encoded.buffer)
    const montos = XLSX.utils
      .sheet_to_json<Record<string, unknown>>(libro.Sheets[libro.SheetNames[0]], { raw: true })
      .map(f => Object.values(f).at(-1))
    expect(montos).toEqual([480, 520, 1000])
  })

  it('un cursor de OTRO recibo no se sigue: otra persona u otro filtro de sede ⇒ RECIBO_CAMBIO (revisión A8, Importante 1)', async () => {
    const p1 = await recibo(m.sofia, { limit: 2 })
    expect(p1.siguiente).toMatch(/^C\.[0-9a-f]{12}\./)
    const cambio = { code: 'RECIBO_CAMBIO', statusCode: 409 }
    // Sin la llave, Ana devolvía sólo sus renglones posteriores al instante de Sofía, con su total completo.
    await expect(recibo(m.ana, { limit: 2, cursor: p1.siguiente! })).rejects.toMatchObject(cambio)
    await expect(recibo(m.sofia, { limit: 2, cursor: p1.siguiente!, sede: m.venueId })).rejects.toMatchObject(cambio)
    // El mismo recibo sí lo sigue.
    expect((await recibo(m.sofia, { limit: 2, cursor: p1.siguiente! })).renglones.map(x => x.monto)).toEqual(['-50.00'])
  })

  it('el servicio acota `limit`: 10,000 pedidos ⇒ 500 renglones, con el total y la cuenta del recibo ENTERO (revisión A8)', async () => {
    const extra = Array.from({ length: 501 }, (_, i) => ({
      organizationId: m.orgId,
      venueId: m.venueId,
      periodId,
      staffId: m.carla,
      concept: 'MANUAL' as const,
      amount: new Prisma.Decimal(1),
      reason: `Ajuste ${i}`,
      descriptor: { fecha: '2026-08-10' },
    }))
    await prisma.serviceEarning.createMany({ data: extra })
    try {
      const r = await recibo(m.carla, { limit: 10_000 })
      expect(r.renglones).toHaveLength(500)
      expect(r).toMatchObject({ cantidad: 501, total: '501.00' })
      expect(r.siguiente).not.toBeNull()
    } finally {
      await prisma.serviceEarning.deleteMany({ where: { periodId, staffId: m.carla, concept: 'MANUAL' } })
    }
  })

  it('arriba del tope del archivo se explica y no se recorta (D6; tope simulado en 2)', async () => {
    const tope = getRowCapForFormat as jest.Mock
    tope.mockReturnValueOnce(2)
    await expect(
      exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId: m.sofia, fecha: '2026-08-15', format: 'xlsx' }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Este recibo tiene 3 renglones; el XLSX admite 1. Pide ayuda a Avoqado.' })
    tope.mockReturnValueOnce(2)
    await expect(
      exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId: m.sofia, fecha: '2026-08-15', format: 'pdf' }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Este recibo tiene 3 renglones; el PDF admite 1. Descárgalo en Excel.' })
  })

  it('exporta el recibo en PDF y en Excel recorriendo todas sus páginas; el Excel lleva el descuento con su signo', async () => {
    const pdf = await exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId: m.sofia, fecha: '2026-08-15', format: 'pdf' })
    expect(pdf.encoded.contentType).toBe('application/pdf')
    // pdfkit comprime el contenido: del PDF sólo se comprueba que lo es. Lo que lleva lo garantiza `filasDelRecibo`,
    // que alimenta a los dos formatos y tiene su prueba unitaria (Codex R2-R1-14).
    expect(pdf.encoded.buffer.subarray(0, 4).toString()).toBe('%PDF')
    expect(pdf.nombre).toMatch(/^recibo-sofia-qa-2026-08-01/)
    const xlsx = await exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId: m.sofia, fecha: '2026-08-15', format: 'xlsx' })
    // El contenido, no sólo los bytes (Codex R1-14): cada monto con su signo y el total, contra lo persistido. En el Excel
    // el monto es una celda NUMÉRICA (el dueño la suma — revisión A8, menor 5), no texto.
    const libro = XLSX.read(xlsx.encoded.buffer)
    const hoja = libro.Sheets[libro.SheetNames[0]]
    const filas = XLSX.utils.sheet_to_json<Record<string, unknown>>(hoja, { raw: true })
    const montos = filas.map(f => Object.values(f).at(-1))
    expect(montos).toEqual([480, 200, -50, 630])
    expect(hoja.F2.t).toBe('n')
    const persistido = await prisma.serviceEarning.aggregate({ where: { periodId, staffId: m.sofia }, _sum: { amount: true } })
    expect(montos.at(-1)).toBe(Number(persistido._sum.amount!.toFixed(2)))
  })
})

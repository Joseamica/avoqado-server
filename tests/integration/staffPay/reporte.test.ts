import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { reportePeriodo, detallePersona, excepcionesPeriodo, huerfanasPeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { agregarAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { marcarPagado, reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { borrarMundo, clase as claseF2, confirmadas as confirmadasF2, crearMundo, crearSede, Mundo, tablaMindform } from './_mundo'

const mockSedesLegibles = jest.fn()
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesLegibles: (...a: unknown[]) => mockSedesLegibles(...a),
  // Codex R3-Nuevo 2: el reporte ya no llama `sedesLegibles`; lee el alcance con `alcanceLegibleDelPeriodo`
  // (sedes guardadas ∪ activas, filtradas por permiso). Para no reescribir los casos de la fase 1, `mockSedesLegibles`
  // sigue diciendo QUÉ puede leer el usuario y, si `__sedes` no está puesto, también qué sedes tienen el módulo.
  sedesConServicePay: jest.fn(async () => (global as any).__sedes ?? (await mockSedesLegibles())?.venueIds ?? []),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => {
    const permiso = await mockSedesLegibles()
    if (!permiso) return { venueIds, parcial: false }
    const l = venueIds.filter(v => permiso.venueIds.includes(v))
    return { venueIds: l, parcial: permiso.parcial || l.length < new Set(venueIds).size }
  }),
  tienePermisoEn: jest.fn(async () => true),
  // El cierre resuelve sus permisos ANTES de la transacción con `sedesConPermiso` (A8): sin esto llamaría al real.
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
}))

const key = `reporte-${process.pid}-${Date.now()}`
let org: string, pn: string, bsf: string, ana: string, hc: string
const AYER = new Date(Date.now() - 86400000)
const ayer = () => AYER
// El reporte se pide por el periodo que contiene AYER: así no falla el día 1 de cada mes.
const FECHA = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(AYER)

async function venueConTabla(s: string) {
  const v = (
    await prisma.venue.create({ data: { organizationId: org, name: `${key}-${s}`, slug: `${key}-${s}`, timezone: 'America/Mexico_City' } })
  ).id
  const cat = await prisma.menuCategory.create({ data: { venueId: v, name: 'C', slug: `${key}-${s}-c`, availableDays: [] } })
  const p = (
    await prisma.product.create({
      data: {
        venueId: v,
        categoryId: cat.id,
        sku: `${key}-${s}-p`,
        name: 'Reformer',
        type: 'CLASS',
        price: new Prisma.Decimal(300),
        duration: 50,
        maxParticipants: 10,
        tags: [],
        allergens: [],
      },
    })
  ).id
  const t = await prisma.servicePayTable.create({ data: { venueId: v, name: 'Todas', productIds: [] } })
  const ver = await prisma.servicePayTableVersion.create({
    data: { tableId: t.id, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1, maxCount: 3 },
  })
  await prisma.servicePayTableCell.createMany({
    data: [0, 1, 2, 3].map(count => ({ versionId: ver.id, payLevelId: hc, count, amount: new Prisma.Decimal(100 * count) })),
  })
  return { v, p }
}

beforeAll(async () => {
  org = (await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })).id
  hc = (await prisma.staffPayLevel.create({ data: { organizationId: org, name: 'Head Coach' } })).id
  ana = (await prisma.staff.create({ data: { email: `${key}@example.test`, firstName: 'Ana', lastName: 'T', active: true } })).id
  await prisma.staffPayLevelAssignment.create({
    data: { organizationId: org, staffId: ana, payLevelId: hc, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1 },
  })
  const a = await venueConTabla('pn')
  const b = await venueConTabla('bsf')
  pn = a.v
  bsf = b.v
  for (const [v, p, n] of [
    [pn, a.p, 2],
    [bsf, b.p, 3],
  ] as const) {
    const s = ayer()
    const cs = await prisma.classSession.create({
      data: {
        venueId: v,
        productId: p,
        startsAt: s,
        endsAt: new Date(s.getTime() + 3000000),
        duration: 50,
        capacity: 3,
        assignedStaffId: ana,
      },
    })
    await prisma.reservation.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        venueId: v,
        classSessionId: cs.id,
        productId: p,
        confirmationCode: `${key}-${v}-${i}`,
        status: 'CONFIRMED' as const,
        startsAt: s,
        endsAt: cs.endsAt,
        duration: 50,
        blockedEndsAt: cs.endsAt,
        partySize: 1,
        confirmedAt: s,
      })),
    })
  }
  const s = ayer()
  await prisma.classSession.create({
    data: {
      venueId: pn,
      productId: a.p,
      startsAt: s,
      endsAt: new Date(s.getTime() + 3000000),
      duration: 50,
      capacity: 3,
      assignedStaffId: null,
    },
  })
  await prisma.reservation.create({
    data: {
      venueId: pn,
      productId: a.p,
      classSessionId: null,
      confirmationCode: `${key}-huerfana`,
      status: 'CONFIRMED',
      startsAt: s,
      endsAt: new Date(s.getTime() + 3000000),
      duration: 50,
      blockedEndsAt: new Date(s.getTime() + 3000000),
      partySize: 1,
    },
  })
})
afterAll(async () => {
  if (!org) return
  await prisma.venue.deleteMany({ where: { organizationId: org } })
  await prisma.staffPayLevelAssignment.deleteMany({ where: { organizationId: org } })
  await prisma.staffPayLevel.deleteMany({ where: { organizationId: org } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: key } } })
  await prisma.organization.delete({ where: { id: org } })
})

describe('reporte — feature nueva', () => {
  it('junta las dos sedes por persona y cuenta excepciones y huérfanas', async () => {
    mockSedesLegibles.mockResolvedValue({ venueIds: [pn, bsf], parcial: false })
    const r = await reportePeriodo({ userId: ana, venueId: pn, fecha: FECHA, offset: 0, limit: 50 })
    expect(r.parcial).toBe(false)
    expect(r.tarjetas).toMatchObject({ total: '500.00', clases: 2, personas: 1, excepciones: 1 })
    expect(r.personas.items[0]).toMatchObject({ staffName: 'Ana T', clases: 2, total: '500.00', payLevelName: 'Head Coach' })
    expect(r.huerfanas).toBe(1)
  })
  it('el detalle de una persona recorre las dos sedes con cursor', async () => {
    mockSedesLegibles.mockResolvedValue({ venueIds: [pn, bsf], parcial: false })
    const p1 = await detallePersona({ userId: ana, venueId: pn, staffId: ana, fecha: FECHA, limit: 1 })
    expect(p1.items).toHaveLength(1)
    // Los campos del ancla (A4) no salen en el desglose: `payAmountOverride` saldría como "500" junto a `monto` "500.00".
    expect(p1.items[0]).not.toHaveProperty('payAmountOverride')
    expect(p1.items[0]).not.toHaveProperty('periodoOrigen')
    const p2 = await detallePersona({ userId: ana, venueId: pn, staffId: ana, fecha: FECHA, despuesDe: p1.nextCursor!, limit: 1 })
    expect(p2.items).toHaveLength(1)
    expect(p2.items[0].venueId).not.toBe(p1.items[0].venueId)
  })
  it('excepciones y huérfanas se listan', async () => {
    mockSedesLegibles.mockResolvedValue({ venueIds: [pn, bsf], parcial: false })
    expect((await excepcionesPeriodo({ userId: ana, venueId: pn, fecha: FECHA, limit: 10 })).items[0].motivo).toBe('SIN_COACH')
    expect((await huerfanasPeriodo({ userId: ana, venueId: pn, fecha: FECHA, offset: 0, limit: 10 })).total).toBe(1)
  })
})

describe('reporte — regresión (Review Focus 3)', () => {
  it('permiso en una sola sede: vista parcial con sólo esa sede', async () => {
    mockSedesLegibles.mockResolvedValue({ venueIds: [pn], parcial: true })
    const r = await reportePeriodo({ userId: ana, venueId: pn, fecha: FECHA, offset: 0, limit: 50 })
    expect(r.parcial).toBe(true)
    expect(r.venueIds).toEqual([pn])
    expect(r.tarjetas.total).toBe('200.00')
  })
  it('sin ninguna sede legible responde vacío y parcial, sin consultar valoración', async () => {
    mockSedesLegibles.mockResolvedValue({ venueIds: [], parcial: true })
    const r = await reportePeriodo({ userId: ana, venueId: pn, fecha: FECHA, offset: 0, limit: 50 })
    expect(r.personas.items).toEqual([])
  })
})

describe('reporte — filtro de sede y «nada se trunca» (fix round 1, spec §7.3)', () => {
  it('sede: BSF devuelve sólo los totales de BSF', async () => {
    mockSedesLegibles.mockResolvedValue({ venueIds: [pn, bsf], parcial: false })
    const r = await reportePeriodo({ userId: ana, venueId: pn, fecha: FECHA, sede: bsf, offset: 0, limit: 50 })
    expect(r.venueIds).toEqual([bsf])
    expect(r.parcial).toBe(false)
    expect(r.tarjetas).toMatchObject({ total: '300.00', clases: 1, excepciones: 0 })
    expect(r.personas.items[0]).toMatchObject({ total: '300.00', venueIds: [bsf] })
    expect(r.huerfanas).toBe(0)
    const d = await detallePersona({ userId: ana, venueId: pn, staffId: ana, fecha: FECHA, sede: bsf, limit: 10 })
    expect(d.items.map(i => i.venueId)).toEqual([bsf])
    expect((await excepcionesPeriodo({ userId: ana, venueId: pn, fecha: FECHA, sede: bsf, limit: 10 })).items).toEqual([])
    expect((await huerfanasPeriodo({ userId: ana, venueId: pn, fecha: FECHA, sede: bsf, offset: 0, limit: 10 })).total).toBe(0)
  })
  it('sede que el usuario no puede leer: alcance vacío (no otras sedes) y parcial', async () => {
    mockSedesLegibles.mockResolvedValue({ venueIds: [pn], parcial: true })
    const r = await reportePeriodo({ userId: ana, venueId: pn, fecha: FECHA, sede: bsf, offset: 0, limit: 50 })
    expect(r.venueIds).toEqual([])
    expect(r.parcial).toBe(true)
    expect(r.tarjetas).toMatchObject({ total: '0.00', clases: 0, excepciones: 0 })
    expect(r.personas.items).toEqual([])
    expect(r.huerfanas).toBe(0)
    expect((await detallePersona({ userId: ana, venueId: pn, staffId: ana, fecha: FECHA, sede: bsf, limit: 10 })).items).toEqual([])
    expect((await huerfanasPeriodo({ userId: ana, venueId: pn, fecha: FECHA, sede: bsf, offset: 0, limit: 10 })).total).toBe(0)
  })
  it('truncado es false cuando ninguna sede llega al tope de personas', async () => {
    mockSedesLegibles.mockResolvedValue({ venueIds: [pn, bsf], parcial: false })
    const r = await reportePeriodo({ userId: ana, venueId: pn, fecha: FECHA, offset: 0, limit: 50 })
    expect(r.truncado).toBe(false)
  })
  it('un offset negativo (llamada sin Zod, p. ej. el MCP) se trata como 0', async () => {
    mockSedesLegibles.mockResolvedValue({ venueIds: [pn, bsf], parcial: false })
    const r = await reportePeriodo({ userId: ana, venueId: pn, fecha: FECHA, offset: -5, limit: 50 })
    expect(r.personas.offset).toBe(0)
    expect(r.personas.items).toHaveLength(1)
    const h = await huerfanasPeriodo({ userId: ana, venueId: pn, fecha: FECHA, offset: -5, limit: 10 })
    expect(h.items).toHaveLength(1)
  })
})

describe('reporte de la fase 2: ajustes en el abierto, congelado en el cerrado', () => {
  let w: Mundo
  const AHORA = new Date('2026-09-02T12:00:00Z')
  beforeAll(async () => {
    w = await crearMundo('reporte-f2')
    await tablaMindform(w)
  })
  afterAll(() => borrarMundo(w))

  it('el abierto suma los ajustes guardados y muestra a quien sólo tiene un ajuste', async () => {
    mockSedesLegibles.mockResolvedValue({ venueIds: [w.venueId], parcial: false })
    ;(global as any).__sedes = [w.venueId]
    await claseF2(w, { staffId: w.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadasF2(8) })
    await agregarAjusteManual({
      userId: w.owner,
      venueId: w.venueId,
      sede: w.venueId,
      staffId: w.carla,
      amount: 150,
      reason: 'Bono',
      fecha: '2026-08-10',
      clientKey: `${w.key}-b1`,
      ahora: AHORA,
    })
    const r = await reportePeriodo({ userId: w.owner, venueId: w.venueId, fecha: '2026-08-15', offset: 0, limit: 50 })
    expect(r.periodo).toMatchObject({ estado: 'OPEN', start: '2026-08-01' })
    expect(r.tarjetas).toMatchObject({ total: '720.00', personas: 2 })
    expect(r.personas.items.find(p => p.staffId === w.carla)).toMatchObject({
      clases: 0,
      ajustes: '150.00',
      total: '150.00',
      venueIds: [w.venueId],
    })
    // Codex R2-R1-12: ordenadas por nombre y paginadas EN SQL; el total sale del COUNT(DISTINCT) aparte.
    expect(r.personas.items.map(p => p.staffName)).toEqual(['Ana QA', 'Carla QA'])
    const pag2 = await reportePeriodo({ userId: w.owner, venueId: w.venueId, fecha: '2026-08-15', offset: 1, limit: 1 })
    expect(pag2.personas).toMatchObject({ total: 2, offset: 1, limit: 1 })
    expect(pag2.personas.items.map(p => p.staffName)).toEqual(['Carla QA'])
    expect(pag2.truncado).toBe(false)
  })

  it('el cerrado se lee de lo congelado aunque después cambien las reservas', async () => {
    const p = await previewCierre({ userId: w.owner, venueId: w.venueId, fecha: '2026-08-15', ahora: AHORA })
    await cerrarPeriodo({
      userId: w.owner,
      venueId: w.venueId,
      fecha: '2026-08-15',
      ahora: AHORA,
      huellaEsperada: p.huella,
      confirmarHuerfanas: true,
    })
    await prisma.reservation.updateMany({ where: { venueId: w.venueId }, data: { status: 'CANCELLED' } })
    const r = await reportePeriodo({ userId: w.owner, venueId: w.venueId, fecha: '2026-08-15', offset: 0, limit: 50 })
    expect(r.periodo.estado).toBe('CLOSED')
    expect(r.tarjetas).toMatchObject({ total: '720.00', clases: 1, personas: 2, pagadas: 0, excepciones: 0 })
    expect(r.personas.items.find(p => p.staffId === w.ana)).toMatchObject({ clases: 1, total: '570.00', pagadoEn: null })
    // Misma regla de sedes que el abierto: donde hubo dinero (Carla sólo tiene su bono en PN).
    expect(r.personas.items.find(p => p.staffId === w.carla)).toMatchObject({ clases: 0, ajustes: '150.00', venueIds: [w.venueId] })
    // Codex R2-R1-12: también el cerrado se ordena por nombre y se pagina en SQL.
    expect(r.personas.items.map(p => p.staffName)).toEqual(['Ana QA', 'Carla QA'])
    const pag2 = await reportePeriodo({ userId: w.owner, venueId: w.venueId, fecha: '2026-08-15', offset: 1, limit: 1 })
    expect(pag2.personas).toMatchObject({ total: 2, offset: 1, limit: 1 })
    expect(pag2.personas.items.map(p => p.staffName)).toEqual(['Carla QA'])
    // Codex R2-R1-21: el desglose EN VIVO de un periodo cerrado no devuelve una lista vacía: dice que se consulte el recibo.
    await expect(
      detallePersona({ userId: w.owner, venueId: w.venueId, staffId: w.ana, fecha: '2026-08-15', limit: 50 }),
    ).rejects.toMatchObject({
      code: 'PERIODO_CERRADO',
      statusCode: 409,
      message: 'Este periodo ya se cerró: consulta el recibo.',
    })
    // Lo mismo las excepciones y las huérfanas: valoran en vivo y listarían una clase creada después del cierre.
    const cerrado = { code: 'PERIODO_CERRADO', statusCode: 409, message: 'Este periodo ya se cerró: consulta el recibo.' }
    await expect(excepcionesPeriodo({ userId: w.owner, venueId: w.venueId, fecha: '2026-08-15', limit: 50 })).rejects.toMatchObject(cerrado)
    await expect(
      huerfanasPeriodo({ userId: w.owner, venueId: w.venueId, fecha: '2026-08-15', offset: 0, limit: 50 }),
    ).rejects.toMatchObject(cerrado)
  })

  it('el contador de pagadas es del periodo entero aunque la página traiga una sola persona (Codex R1-23)', async () => {
    const r0 = await reportePeriodo({ userId: w.owner, venueId: w.venueId, fecha: '2026-08-15', offset: 0, limit: 1 })
    await marcarPagado({ userId: w.owner, venueId: w.venueId, periodId: r0.periodo.id!, staffId: w.carla })
    const r = await reportePeriodo({ userId: w.owner, venueId: w.venueId, fecha: '2026-08-15', offset: 0, limit: 1 })
    expect(r.tarjetas).toMatchObject({ personas: 2, pagadas: 1 })
    expect(r.personas.items).toHaveLength(1)
    expect(r.personas.items[0]).toMatchObject({ staffName: 'Ana QA', pagadoEn: null })
    const pag2 = await reportePeriodo({ userId: w.owner, venueId: w.venueId, fecha: '2026-08-15', offset: 1, limit: 1 })
    expect(pag2.tarjetas).toMatchObject({ pagadas: 1 })
    expect(pag2.personas.items[0].pagadoEn).toEqual(expect.any(String))
  })

  it('una diferencia liquidada desde una sede que YA apagó el módulo sigue en el reporte y en el recibo del periodo abierto (Codex R3-Nuevo 2)', async () => {
    const x = await crearMundo('reporte-f2-bsf')
    try {
      await tablaMindform(x)
      const bsf = await crearSede(x.orgId, x.key, 'bsf')
      ;(global as any).__sedes = [x.venueId] // BSF apagó el módulo; quien lee tiene permiso en las dos
      mockSedesLegibles.mockResolvedValue({ venueIds: [x.venueId, bsf.venueId], parcial: false })
      await claseF2(x, { staffId: x.ana, inicioIso: '2026-09-04T14:00:00Z', reservas: confirmadasF2(8) }) // PN $570 en vivo
      // Lo que deja «Liquidar» (B2) con «sumar la sede»: BSF en el alcance del periodo abierto y su RECONCILE de +$40.
      const sept = await prisma.servicePayPeriod.create({
        data: {
          organizationId: x.orgId,
          periodStart: fechaComoDbDate('2026-09-01'),
          periodEnd: fechaComoDbDate('2026-09-30'),
          venueIds: [x.venueId, bsf.venueId].sort(),
        },
      })
      await prisma.serviceEarning.create({
        data: {
          organizationId: x.orgId,
          venueId: bsf.venueId,
          periodId: sept.id,
          staffId: x.ana,
          concept: 'RECONCILE',
          sourceType: 'CLASS_SESSION',
          sourceId: 'clase-de-agosto-en-bsf',
          amount: new Prisma.Decimal(40),
          reason: 'Diferencia de una clase ya cerrada',
          descriptor: { clase: 'Reformer', fecha: '2026-08-05' },
        },
      })
      const r = await reportePeriodo({ userId: x.owner, venueId: x.venueId, fecha: '2026-09-15', offset: 0, limit: 50 })
      expect(r).toMatchObject({ parcial: false, tarjetas: { total: '610.00' } })
      expect(r.personas.items.find(p => p.staffId === x.ana)).toMatchObject({ ajustes: '40.00', total: '610.00' })
      const recibo = await reciboDePersona({ userId: x.owner, venueId: x.venueId, staffId: x.ana, fecha: '2026-09-15', limit: 100 })
      expect(recibo.total).toBe('610.00')
      // Sedes por persona = donde hubo dinero: clases en PN + la diferencia de BSF.
      const ambas = [x.venueId, bsf.venueId].sort()
      expect(r.personas.items.find(p => p.staffId === x.ana)!.venueIds).toEqual(ambas)

      // Un ajuste en una sede NO legible no aparece ni suma en el ABIERTO: Sofía sólo tiene un bono en BSF.
      await prisma.serviceEarning.create({
        data: {
          organizationId: x.orgId,
          venueId: bsf.venueId,
          periodId: sept.id,
          staffId: x.sofia,
          concept: 'MANUAL',
          clientKey: `${x.key}-bono-sofia`,
          amount: new Prisma.Decimal(100),
          reason: 'Bono',
          descriptor: { fecha: '2026-09-10' },
        },
      })
      mockSedesLegibles.mockResolvedValue({ venueIds: [x.venueId], parcial: true }) // el lector sólo puede leer PN
      const soloPn = await reportePeriodo({ userId: x.owner, venueId: x.venueId, fecha: '2026-09-15', offset: 0, limit: 50 })
      expect(soloPn).toMatchObject({ parcial: true, venueIds: [x.venueId], tarjetas: { total: '570.00', personas: 1 } })
      expect(soloPn.personas.total).toBe(1)
      expect(soloPn.personas.items).toEqual([
        expect.objectContaining({ staffId: x.ana, ajustes: '0.00', total: '570.00', venueIds: [x.venueId] }),
      ])

      // Se cierra septiembre y se vuelve a leer: misma regla de sedes y vista parcial en el CERRADO.
      mockSedesLegibles.mockResolvedValue({ venueIds: [x.venueId, bsf.venueId], parcial: false })
      const AHORA_OCT = new Date('2026-10-02T12:00:00Z')
      const p = await previewCierre({ userId: x.owner, venueId: x.venueId, fecha: '2026-09-15', ahora: AHORA_OCT })
      await cerrarPeriodo({
        userId: x.owner,
        venueId: x.venueId,
        fecha: '2026-09-15',
        ahora: AHORA_OCT,
        huellaEsperada: p.huella,
        confirmarHuerfanas: true,
      })
      const todo = await reportePeriodo({ userId: x.owner, venueId: x.venueId, fecha: '2026-09-15', offset: 0, limit: 50 })
      expect(todo).toMatchObject({ parcial: false, periodo: { estado: 'CLOSED' }, tarjetas: { total: '710.00', personas: 2 } })
      expect(todo.personas.items.find(i => i.staffId === x.ana)).toMatchObject({ total: '610.00', venueIds: ambas })
      expect(todo.personas.items.find(i => i.staffId === x.sofia)).toMatchObject({ total: '100.00', venueIds: [bsf.venueId] })
      mockSedesLegibles.mockResolvedValue({ venueIds: [x.venueId], parcial: true })
      const parcial = await reportePeriodo({ userId: x.owner, venueId: x.venueId, fecha: '2026-09-15', offset: 0, limit: 50 })
      expect(parcial).toMatchObject({ parcial: true, venueIds: [x.venueId], tarjetas: { total: '570.00', personas: 1 } })
      expect(parcial.personas.items).toEqual([
        expect.objectContaining({ staffId: x.ana, ajustes: '0.00', total: '570.00', venueIds: [x.venueId] }),
      ])
    } finally {
      ;(global as any).__sedes = undefined
      await borrarMundo(x)
    }
  })
})

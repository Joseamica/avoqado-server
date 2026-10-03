import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { reportePeriodo, detallePersona, excepcionesPeriodo, huerfanasPeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'

const mockSedesLegibles = jest.fn()
jest.mock('@/services/dashboard/staffPay/acceso', () => ({ sedesLegibles: (...a: unknown[]) => mockSedesLegibles(...a) }))

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

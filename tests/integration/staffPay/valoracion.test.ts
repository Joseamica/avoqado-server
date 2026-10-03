import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { valorarClases, resumenPorPersona, contarPorEstado } from '@/services/dashboard/staffPay/valoracion'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'

const key = `valoracion-${process.pid}-${Date.now()}`
const TZ = 'America/Mexico_City'
const ids: {
  org?: string
  pn?: string
  bsf?: string
  productPn?: string
  productBsf?: string
  ana?: string
  sofia?: string
  sinNivel?: string
  hc?: string
  coach?: string
} = {}
const DESDE = new Date('2026-09-01T06:00:00.000Z') // 1-sep 00:00 CDMX
const HASTA = new Date('2026-10-01T06:00:00.000Z')
const AHORA = new Date('2026-10-02T00:00:00.000Z')

// Tabla real de Mindform (spec §1)
const PN_HC = [0, 430, 430, 430, 430, 460, 490, 530, 570, 610, 650]
const PN_C = [0, 400, 400, 400, 400, 400, 400, 440, 480, 520, 560]
const BSF_HC = [0, 440, 470, 500, 530, 560]
const BSF_C = [0, 420, 435, 450, 470, 490]

let seq = 0
async function clase(
  venueId: string,
  productId: string,
  staffId: string | null,
  inicioIso: string,
  reservas: Array<{ status: string; partySize?: number; confirmed?: boolean }>,
  extra: Partial<{ status: 'CANCELLED'; endIso: string }> = {},
) {
  const startsAt = new Date(inicioIso)
  const endsAt = new Date(extra.endIso ?? new Date(startsAt.getTime() + 50 * 60000).toISOString())
  const cs = await prisma.classSession.create({
    data: {
      venueId,
      productId,
      startsAt,
      endsAt,
      duration: 50,
      capacity: 12,
      assignedStaffId: staffId,
      status: extra.status ?? 'SCHEDULED',
    },
  })
  if (reservas.length) {
    await prisma.reservation.createMany({
      data: reservas.map(r => ({
        venueId,
        classSessionId: cs.id,
        productId,
        confirmationCode: `${key}-${++seq}`,
        status: r.status as any,
        startsAt,
        endsAt,
        duration: 50,
        blockedEndsAt: endsAt,
        partySize: r.partySize ?? 1,
        confirmedAt: r.confirmed === false ? null : new Date(startsAt.getTime() - 86400000),
      })),
    })
  }
  return cs.id
}
const confirmadas = (n: number) => Array.from({ length: n }, () => ({ status: 'CONFIRMED' }))

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })
  ids.org = org.id
  const mkVenue = async (s: string) => {
    const v = await prisma.venue.create({ data: { organizationId: org.id, name: `${key}-${s}`, slug: `${key}-${s}`, timezone: TZ } })
    const cat = await prisma.menuCategory.create({ data: { venueId: v.id, name: 'Clases', slug: `${key}-${s}-c`, availableDays: [] } })
    const p = await prisma.product.create({
      data: {
        venueId: v.id,
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
    return { venueId: v.id, productId: p.id }
  }
  const pn = await mkVenue('pn')
  const bsf = await mkVenue('bsf')
  Object.assign(ids, { pn: pn.venueId, productPn: pn.productId, bsf: bsf.venueId, productBsf: bsf.productId })
  const mkStaff = async (n: string) =>
    (await prisma.staff.create({ data: { email: `${key}-${n}@example.test`, firstName: n, lastName: 'Test', active: true } })).id
  ids.ana = await mkStaff('Ana')
  ids.sofia = await mkStaff('Sofia')
  ids.sinNivel = await mkStaff('SinNivel')
  ids.hc = (await prisma.staffPayLevel.create({ data: { organizationId: org.id, name: 'Head Coach', sortOrder: 0 } })).id
  ids.coach = (await prisma.staffPayLevel.create({ data: { organizationId: org.id, name: 'Coach', sortOrder: 1 } })).id
  await prisma.staffPayLevelAssignment.createMany({
    data: [
      { organizationId: org.id, staffId: ids.ana, payLevelId: ids.hc, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1 },
      { organizationId: org.id, staffId: ids.sofia, payLevelId: ids.coach, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1 },
    ],
  })
  const mkTabla = async (venueId: string, max: number, hc: number[], c: number[]) => {
    const t = await prisma.servicePayTable.create({ data: { venueId, name: 'Todas las clases', productIds: [] } })
    const v = await prisma.servicePayTableVersion.create({
      data: { tableId: t.id, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1, maxCount: max },
    })
    await prisma.servicePayTableCell.createMany({
      data: [
        ...hc.map((amount, count) => ({ versionId: v.id, payLevelId: ids.hc!, count, amount: new Prisma.Decimal(amount) })),
        ...c.map((amount, count) => ({ versionId: v.id, payLevelId: ids.coach!, count, amount: new Prisma.Decimal(amount) })),
      ],
    })
    return { tableId: t.id, versionId: v.id }
  }
  await mkTabla(ids.pn!, 10, PN_HC, PN_C)
  await mkTabla(ids.bsf!, 5, BSF_HC, BSF_C)
})

afterAll(async () => {
  // Sin org (beforeAll falló) un `organizationId: undefined` quitaría el filtro y borraría TODAS las sedes.
  if (!ids.org) return
  await prisma.venue.deleteMany({ where: { organizationId: ids.org } })
  await prisma.staffPayLevelAssignment.deleteMany({ where: { organizationId: ids.org } })
  await prisma.staffPayLevel.deleteMany({ where: { organizationId: ids.org } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: key } } })
  await prisma.organization.delete({ where: { id: ids.org } })
})

const filtro = (venueId: string, extra: Partial<{ claseIds: string[] }> = {}) => ({
  venueId,
  organizationId: ids.org!,
  tz: TZ,
  desde: DESDE,
  hasta: HASTA,
  ahora: AHORA,
  ...extra,
})
async function valorUna(venueId: string, claseId: string) {
  const [v] = await valorarClases(prisma, filtro(venueId, { claseIds: [claseId] }), { limite: 10 })
  return v
}

describe('valoración — feature nueva: las 30 cifras de Mindform', () => {
  const casos: Array<[string, 'pn' | 'bsf', 'ana' | 'sofia', number, number]> = []
  for (let n = 1; n <= 10; n++) casos.push([`PN Head Coach ${n}`, 'pn', 'ana', n, PN_HC[n]], [`PN Coach ${n}`, 'pn', 'sofia', n, PN_C[n]])
  for (let n = 1; n <= 5; n++)
    casos.push([`BSF Head Coach ${n}`, 'bsf', 'ana', n, BSF_HC[n]], [`BSF Coach ${n}`, 'bsf', 'sofia', n, BSF_C[n]])

  it.each(casos)('%s', async (_n, sede, coach, lugares, esperado) => {
    const venueId = sede === 'pn' ? ids.pn! : ids.bsf!
    const productId = sede === 'pn' ? ids.productPn! : ids.productBsf!
    const id = await clase(venueId, productId, ids[coach]!, '2026-09-10T14:00:00.000Z', confirmadas(lugares))
    const v = await valorUna(venueId, id)
    expect(v.estado).toBe('OK')
    expect(v.conteo).toBe(lugares)
    expect(Number(v.monto)).toBe(esperado)
  })
})

describe('valoración — feature nueva: bordes', () => {
  it('0 lugares usa la fila 0 capturada ($0), no es excepción', async () => {
    const id = await clase(ids.pn!, ids.productPn!, ids.ana!, '2026-09-11T14:00:00.000Z', [])
    expect(await valorUna(ids.pn!, id)).toMatchObject({ estado: 'OK', conteo: 0 })
  })
  it('sobrecupo (11 en techo 10) paga la fila 10', async () => {
    const id = await clase(ids.pn!, ids.productPn!, ids.ana!, '2026-09-11T15:00:00.000Z', confirmadas(11))
    const v = await valorUna(ids.pn!, id)
    expect(v.conteo).toBe(11)
    expect(Number(v.monto)).toBe(650)
  })
  it('partySize > 1 suma lugares', async () => {
    const id = await clase(ids.pn!, ids.productPn!, ids.ana!, '2026-09-11T16:00:00.000Z', [{ status: 'CONFIRMED', partySize: 3 }])
    expect((await valorUna(ids.pn!, id)).conteo).toBe(3)
  })
  it('BOOKED: COMPLETED y CHECKED_IN cuentan; PENDING y CANCELLED no; NO_SHOW sólo si se confirmó', async () => {
    const id = await clase(ids.pn!, ids.productPn!, ids.ana!, '2026-09-12T14:00:00.000Z', [
      { status: 'COMPLETED' },
      { status: 'CHECKED_IN' },
      { status: 'PENDING', confirmed: false },
      { status: 'CANCELLED' },
      { status: 'NO_SHOW', confirmed: true },
      { status: 'NO_SHOW', confirmed: false },
    ])
    expect((await valorUna(ids.pn!, id)).conteo).toBe(3)
  })
  it('sin coach → excepción SIN_COACH', async () => {
    const id = await clase(ids.pn!, ids.productPn!, null, '2026-09-12T15:00:00.000Z', confirmadas(2))
    expect(await valorUna(ids.pn!, id)).toMatchObject({ estado: 'EXCEPCION', motivo: 'SIN_COACH', monto: null })
  })
  it('coach sin nivel → COACH_SIN_NIVEL; «Ajustar monto» la resuelve', async () => {
    const id = await clase(ids.pn!, ids.productPn!, ids.sinNivel!, '2026-09-12T16:00:00.000Z', confirmadas(2))
    expect((await valorUna(ids.pn!, id)).motivo).toBe('COACH_SIN_NIVEL')
    await prisma.classSessionPayState.create({
      data: { classSessionId: id, payAmountOverride: new Prisma.Decimal(500), overrideReason: 'masterclass' },
    })
    expect(await valorUna(ids.pn!, id)).toMatchObject({ estado: 'OK', tieneAjuste: true })
    expect(Number((await valorUna(ids.pn!, id)).monto)).toBe(500)
  })
  it('«Corregir conteo» manda sobre lo calculado', async () => {
    const id = await clase(ids.pn!, ids.productPn!, ids.ana!, '2026-09-13T14:00:00.000Z', confirmadas(7))
    await prisma.classSessionPayState.create({ data: { classSessionId: id, payCountOverride: 8, overrideReason: 'eran 8' } })
    const v = await valorUna(ids.pn!, id)
    expect(v.conteoCalculado).toBe(7)
    expect(v.conteo).toBe(8)
    expect(Number(v.monto)).toBe(570)
  })
  it('clase excluida → EXCLUIDA, sin monto', async () => {
    const id = await clase(ids.pn!, ids.productPn!, null, '2026-09-13T15:00:00.000Z', [])
    await prisma.classSessionPayState.create({ data: { classSessionId: id, payExcluded: true, overrideReason: 'prueba interna' } })
    expect(await valorUna(ids.pn!, id)).toMatchObject({ estado: 'EXCLUIDA', monto: null })
  })
  it('celda vacía del techo → SIN_MONTO_PARA_ESE_CONTEO (nunca baja de fila)', async () => {
    const t = await prisma.servicePayTable.findFirstOrThrow({ where: { venueId: ids.bsf! } })
    const v2 = await prisma.servicePayTableVersion.create({
      data: { tableId: t.id, effectiveFrom: fechaComoDbDate('2026-09-20'), revision: 1, maxCount: 5 },
    })
    await prisma.servicePayTableCell.createMany({
      data: [0, 1, 2, 3, 4].map(count => ({ versionId: v2.id, payLevelId: ids.coach!, count, amount: new Prisma.Decimal(400) })),
    })
    try {
      const id = await clase(ids.bsf!, ids.productBsf!, ids.sofia!, '2026-09-21T14:00:00.000Z', confirmadas(6))
      expect(await valorUna(ids.bsf!, id)).toMatchObject({ estado: 'EXCEPCION', motivo: 'SIN_MONTO_PARA_ESE_CONTEO' })
    } finally {
      await prisma.servicePayTableVersion.delete({ where: { id: v2.id } })
    }
  })
  it('clase cancelada o que no ha terminado no entra', async () => {
    const cancelada = await clase(ids.pn!, ids.productPn!, ids.ana!, '2026-09-14T14:00:00.000Z', confirmadas(3), { status: 'CANCELLED' })
    const futura = await clase(ids.pn!, ids.productPn!, ids.ana!, '2026-10-01T23:30:00.000Z', confirmadas(3), {
      endIso: '2026-10-02T01:00:00.000Z',
    })
    const rows = await valorarClases(prisma, filtro(ids.pn!, { claseIds: [cancelada, futura] }), { limite: 10 })
    expect(rows).toHaveLength(0)
  })
  it('una clase anclada (originPeriodId) no entra en vivo', async () => {
    const id = await clase(ids.pn!, ids.productPn!, ids.ana!, '2026-09-14T15:00:00.000Z', confirmadas(3))
    await prisma.classSessionPayState.create({ data: { classSessionId: id, originPeriodId: 'periodo-cerrado-ficticio' } })
    expect(await valorarClases(prisma, filtro(ids.pn!, { claseIds: [id] }), { limite: 10 })).toHaveLength(0)
  })
  it('cambio de nivel el día 16: el 15 sigue como Coach, el 16 ya es Head Coach', async () => {
    const s = (
      await prisma.staff.create({ data: { email: `${key}-sube@example.test`, firstName: 'Sube', lastName: 'Test', active: true } })
    ).id
    await prisma.staffPayLevelAssignment.createMany({
      data: [
        { organizationId: ids.org!, staffId: s, payLevelId: ids.coach!, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1 },
        { organizationId: ids.org!, staffId: s, payLevelId: ids.hc!, effectiveFrom: fechaComoDbDate('2026-09-16'), revision: 1 },
      ],
    })
    const d15 = await clase(ids.pn!, ids.productPn!, s, '2026-09-15T20:00:00.000Z', confirmadas(8))
    const d16 = await clase(ids.pn!, ids.productPn!, s, '2026-09-16T20:00:00.000Z', confirmadas(8))
    expect(Number((await valorUna(ids.pn!, d15)).monto)).toBe(480)
    expect(Number((await valorUna(ids.pn!, d16)).monto)).toBe(570)
  })
  it('dos revisiones de nivel el mismo día: gana la mayor', async () => {
    const s = (await prisma.staff.create({ data: { email: `${key}-rev@example.test`, firstName: 'Rev', lastName: 'Test', active: true } }))
      .id
    await prisma.staffPayLevelAssignment.createMany({
      data: [
        { organizationId: ids.org!, staffId: s, payLevelId: ids.hc!, effectiveFrom: fechaComoDbDate('2026-09-01'), revision: 1 },
        { organizationId: ids.org!, staffId: s, payLevelId: ids.coach!, effectiveFrom: fechaComoDbDate('2026-09-01'), revision: 2 },
      ],
    })
    const id = await clase(ids.pn!, ids.productPn!, s, '2026-09-17T20:00:00.000Z', confirmadas(8))
    expect((await valorUna(ids.pn!, id)).payLevelName).toBe('Coach')
  })
  it('tabla específica sin versión vigente no desplaza a la general', async () => {
    const t = await prisma.servicePayTable.create({ data: { venueId: ids.pn!, name: 'Sólo Reformer', productIds: [ids.productPn!] } })
    try {
      await prisma.servicePayTableVersion.create({
        data: { tableId: t.id, effectiveFrom: fechaComoDbDate('2026-12-01'), revision: 1, maxCount: 10 },
      })
      const id = await clase(ids.pn!, ids.productPn!, ids.ana!, '2026-09-18T20:00:00.000Z', confirmadas(8))
      expect(Number((await valorUna(ids.pn!, id)).monto)).toBe(570)
    } finally {
      await prisma.servicePayTable.delete({ where: { id: t.id } })
    }
  })
  it('zona horaria: una clase a las 23:30 del 30-sep en CDMX es de septiembre', async () => {
    const id = await clase(ids.pn!, ids.productPn!, ids.ana!, '2026-10-01T05:30:00.000Z', confirmadas(1), {
      endIso: '2026-10-01T06:20:00.000Z',
    })
    const v = await valorUna(ids.pn!, id)
    expect(v.fechaLocal).toBe('2026-09-30')
  })
})

/**
 * Sede aislada por prueba: las reglas de tabla se prueban sin tocar las tablas compartidas de PN/BSF, así que una
 * prueba que falle no contamina a las demás. Se borran en afterAll con el resto de sedes de la org.
 */
let sedes = 0
async function sedeAislada(productos = 1) {
  const s = `aislada-${++sedes}`
  const v = await prisma.venue.create({ data: { organizationId: ids.org!, name: `${key}-${s}`, slug: `${key}-${s}`, timezone: TZ } })
  const cat = await prisma.menuCategory.create({ data: { venueId: v.id, name: 'Clases', slug: `${key}-${s}-c`, availableDays: [] } })
  const productIds: string[] = []
  for (let i = 0; i < productos; i++) {
    const p = await prisma.product.create({
      data: {
        venueId: v.id,
        categoryId: cat.id,
        sku: `${key}-${s}-p${i}`,
        name: `Clase ${i}`,
        type: 'CLASS',
        price: new Prisma.Decimal(300),
        duration: 50,
        maxParticipants: 10,
        tags: [],
        allergens: [],
      },
    })
    productIds.push(p.id)
  }
  return { venueId: v.id, productIds }
}
/** Tabla con una versión y la misma cifra en todas las celdas (0..10) del nivel Coach. */
async function tablaPlana(
  venueId: string,
  monto: number,
  o: { productIds?: string[]; desde?: string; archivedFrom?: string; tableId?: string; revision?: number } = {},
) {
  const tableId =
    o.tableId ??
    (
      await prisma.servicePayTable.create({
        data: {
          venueId,
          name: `t-${monto}`,
          productIds: o.productIds ?? [],
          archivedFrom: o.archivedFrom ? fechaComoDbDate(o.archivedFrom) : null,
        },
      })
    ).id
  const v = await prisma.servicePayTableVersion.create({
    data: { tableId, effectiveFrom: fechaComoDbDate(o.desde ?? '2026-01-01'), revision: o.revision ?? 1, maxCount: 10 },
  })
  await prisma.servicePayTableCell.createMany({
    data: Array.from({ length: 11 }, (_, count) => ({ versionId: v.id, payLevelId: ids.coach!, count, amount: new Prisma.Decimal(monto) })),
  })
  return { tableId, versionId: v.id }
}

describe('valoración — feature nueva: reglas de tabla, coach y totales', () => {
  it('la tabla específica del producto (con versión vigente) gana a la general; otro producto sigue con la general', async () => {
    const { venueId, productIds } = await sedeAislada(2)
    const [reformer, otro] = productIds
    await tablaPlana(venueId, 100)
    await tablaPlana(venueId, 999, { productIds: [reformer] })
    const a = await clase(venueId, reformer, ids.sofia!, '2026-09-10T14:00:00.000Z', confirmadas(3))
    const b = await clase(venueId, otro, ids.sofia!, '2026-09-10T16:00:00.000Z', confirmadas(3))
    expect(await valorUna(venueId, a)).toMatchObject({ estado: 'OK' })
    expect(Number((await valorUna(venueId, a)).monto)).toBe(999)
    expect(Number((await valorUna(venueId, b)).monto)).toBe(100)
  })

  it('dos versiones de tabla el mismo día: gana la revisión mayor', async () => {
    const { venueId, productIds } = await sedeAislada()
    const { tableId, versionId: rev1 } = await tablaPlana(venueId, 100, { desde: '2026-09-01', revision: 1 })
    const { versionId: rev2 } = await tablaPlana(venueId, 200, { tableId, desde: '2026-09-01', revision: 2 })
    const id = await clase(venueId, productIds[0], ids.sofia!, '2026-09-10T14:00:00.000Z', confirmadas(3))
    const v = await valorUna(venueId, id)
    expect(v.tableVersionId).toBe(rev2)
    expect(v.tableVersionId).not.toBe(rev1)
    expect(Number(v.monto)).toBe(200)
  })

  it('archivedFrom: antes de la fecha la tabla sigue aplicando (en hora local); desde esa fecha no → SIN_TABLA, o la siguiente', async () => {
    const { venueId, productIds } = await sedeAislada()
    const p = productIds[0]
    await tablaPlana(venueId, 100, { archivedFrom: '2026-09-20' })
    // 2026-09-20T05:30Z = 19-sep 23:30 en CDMX: todavía antes del archivo.
    const antes = await clase(venueId, p, ids.sofia!, '2026-09-20T05:30:00.000Z', confirmadas(3), { endIso: '2026-09-20T06:20:00.000Z' })
    const desde = await clase(venueId, p, ids.sofia!, '2026-09-20T15:00:00.000Z', confirmadas(3))
    expect(Number((await valorUna(venueId, antes)).monto)).toBe(100)
    expect(await valorUna(venueId, desde)).toMatchObject({ estado: 'EXCEPCION', motivo: 'SIN_TABLA', tableVersionId: null, monto: null })
    // La tabla que la reemplaza a partir del 20 toma su lugar, sin tocar lo anterior.
    await tablaPlana(venueId, 200, { desde: '2026-09-20' })
    expect(Number((await valorUna(venueId, desde)).monto)).toBe(200)
    expect(Number((await valorUna(venueId, antes)).monto)).toBe(100)
  })

  it('«Ajustar monto» NO resuelve SIN_COACH: sigue excepción, sin monto, y no suma en los totales', async () => {
    const { venueId, productIds } = await sedeAislada()
    await tablaPlana(venueId, 100)
    const id = await clase(venueId, productIds[0], null, '2026-09-10T14:00:00.000Z', confirmadas(3))
    await prisma.classSessionPayState.create({
      data: { classSessionId: id, payAmountOverride: new Prisma.Decimal(500), overrideReason: 'sin coach pero con monto' },
    })
    expect(await valorUna(venueId, id)).toMatchObject({ estado: 'EXCEPCION', motivo: 'SIN_COACH', monto: null, tieneAjuste: true })
    const estados = await contarPorEstado(prisma, filtro(venueId))
    expect(estados).toMatchObject({ ok: 0, excluidas: 0, excepciones: 1 })
    expect(Number(estados.total)).toBe(0)
    expect(await resumenPorPersona(prisma, filtro(venueId))).toEqual([])
  })

  it('coach dado de baja (Staff inactivo y sin acceso a la sede) cobra la clase que sí dio', async () => {
    const s = (
      await prisma.staff.create({ data: { email: `${key}-baja@example.test`, firstName: 'Baja', lastName: 'Test', active: false } })
    ).id
    await prisma.staffVenue.create({
      data: { staffId: s, venueId: ids.pn!, role: 'WAITER', active: false, endDate: new Date('2026-09-25T00:00:00.000Z') },
    })
    await prisma.staffPayLevelAssignment.create({
      data: { organizationId: ids.org!, staffId: s, payLevelId: ids.coach!, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1 },
    })
    const id = await clase(ids.pn!, ids.productPn!, s, '2026-09-19T20:00:00.000Z', confirmadas(3))
    expect(await valorUna(ids.pn!, id)).toMatchObject({ estado: 'OK', staffId: s, payLevelName: 'Coach' })
    expect(Number((await valorUna(ids.pn!, id)).monto)).toBe(PN_C[3])
    const resumen = await resumenPorPersona(prisma, filtro(ids.pn!))
    expect(resumen.find(r => r.staffId === s)).toMatchObject({ clases: 1 })
  })
})

describe('valoración — feature nueva: agregados en la base', () => {
  it('el resumen por persona y el conteo por estado cuadran con el detalle', async () => {
    const detalle = await valorarClases(prisma, filtro(ids.bsf!), { limite: 1000 })
    const ok = detalle.filter(d => d.estado === 'OK')
    const resumen = await resumenPorPersona(prisma, filtro(ids.bsf!))
    const totalResumen = resumen.reduce((s, r) => s + Number(r.total), 0)
    const totalDetalle = ok.reduce((s, d) => s + Number(d.monto), 0)
    expect(totalResumen).toBe(totalDetalle)
    const estados = await contarPorEstado(prisma, filtro(ids.bsf!))
    expect(estados.ok).toBe(ok.length)
    expect(Number(estados.total)).toBe(totalDetalle)
  })
  it('el cursor recorre todo sin repetir ni saltar', async () => {
    const todas = await valorarClases(prisma, filtro(ids.pn!), { limite: 1000 })
    const paginadas: string[] = []
    let despuesDe: string | undefined
    for (;;) {
      const p = await valorarClases(prisma, filtro(ids.pn!), { despuesDe, limite: 7 })
      if (!p.length) break
      paginadas.push(...p.map(x => x.classSessionId))
      despuesDe = p[p.length - 1].classSessionId
    }
    expect(paginadas).toEqual(todas.map(x => x.classSessionId))
  })
})

/**
 * Número de vinculación (spec §5.2), contra Postgres real: el filtro de alertas de la lista
 * (`findVerificationIdsWithNumberAlert`, una sola consulta) devuelve EXACTAMENTE las mismas ventas que la fila
 * (`findDuplicatesForSales` + `computeNumberAlerts`). Si no coinciden, el back-office filtra «repetidos» y ve otra cosa.
 * Además, el SQL de repetidos cuenta y ordena bien: total exacto con más de 5 llaves y un histórico sin fecha al final.
 * A11b: el ICCID se compara normalizado (…901f = …901F), 9 dígitos de importación y de venta externa, el portado faltante
 * con y sin su foto, y la venta que pasa de portabilidad a línea nueva (su portado se borra).
 * B0: el filtro sólo recorre las ventas del rango (una fuera del rango no sale, pero sí cuenta como repetida) y recorta el
 * ICCID como `trim()` de JS (un tabulador al final ya no lo separa de su histórico).
 *   TEST_DATABASE_URL='postgresql://…/avoqado_<tarea>_test_<fecha>' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/playtelecom/linkingNumberAlertFilter.integration.test.ts
 */
import { randomUUID } from 'crypto'
import cuid from 'cuid'
import type { SaleVerificationNumberSource } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  findDuplicatesForSales,
  findVerificationIdsWithNumberAlert,
  type NumberAlertFilter,
} from '@/services/playtelecom/linkingNumber.duplicates'
import { computeNumberAlerts, type NumberAlertCode } from '@/services/playtelecom/linkingNumber.rules'
import { editOrgSaleVerification } from '@/services/dashboard/sale-verification.org.dashboard.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { broadcastToUser: jest.fn() } }))

const tag = `vinculacion-${randomUUID()}`
const ORG = cuid()
const OTHER_ORG = cuid()
const PORT_ORG = cuid() // sólo para la venta que pasa de portabilidad a línea nueva: se edita a media prueba
const ORGS = [ORG, OTHER_ORG, PORT_ORG]
// Octubre en la hora del negocio, con los mismos extremos que `parseRange` (fin en 23:59:59.999 local).
const range = { from: new Date('2026-10-01T06:00:00.000Z'), to: new Date('2026-11-01T05:59:59.999Z') }
const ids: Record<string, string> = {}
let staffId = ''
const venueIds: string[] = []

type Venta = {
  org?: string
  linking?: string
  linkingSource?: SaleVerificationNumberSource
  ported?: string
  portedSource?: SaleVerificationNumberSource
  isPortabilidad?: boolean
  photos?: string[]
  iccid?: string
  external?: boolean
  paidAt?: Date
}

async function venta(nombre: string, v: Venta) {
  const venueId = venueIds[ORGS.indexOf(v.org ?? ORG)]
  const total = 100
  const order = await prisma.order.create({
    data: { venueId, orderNumber: randomUUID(), subtotal: total, taxAmount: 0, total, type: v.external ? 'MANUAL_ENTRY' : 'DINE_IN' },
  })
  const payment = await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      amount: total,
      method: 'CASH',
      status: 'COMPLETED',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: total,
      createdAt: v.paidAt ?? new Date('2026-10-15T18:00:00.000Z'),
    },
  })
  const sv = await prisma.saleVerification.create({
    data: {
      venueId,
      paymentId: payment.id,
      staffId,
      photos: v.photos ?? [],
      status: 'PENDING',
      isPortabilidad: !!v.isPortabilidad,
      serialNumbers: [v.iccid ?? `${nombre}-iccid`],
      linkingNumber: v.linking ?? null,
      linkingNumberSource: v.linking ? (v.linkingSource ?? 'TPV') : null,
      portedNumber: v.ported ?? null,
      portedNumberSource: v.ported ? (v.portedSource ?? 'TPV') : null,
    },
  })
  ids[nombre] = sv.id
}

beforeAll(async () => {
  for (const org of ORGS) {
    await prisma.organization.create({ data: { id: org, name: tag, email: `${org}@example.test`, phone: '5500000000' } })
    venueIds.push((await prisma.venue.create({ data: { organizationId: org, name: `Tienda ${org}`, slug: `${tag}-${org}` } })).id)
  }
  staffId = (await prisma.staff.create({ data: { email: `${tag}@example.test`, firstName: 'Ana', lastName: 'Promotora' } })).id

  await venta('s1', { linking: '5512345678', photos: ['f1'], iccid: 'ICC1' })
  // Su portado choca con la vinculación de s1: un teléfono es una línea, sin importar el campo.
  await venta('s2', { isPortabilidad: true, linking: '5587654321', ported: '5512345678', photos: ['f1', 'f2'], iccid: 'ICC2' })
  // 9 dígitos de la terminal, cobrada justo en el extremo final del rango: sale con y sin filtro.
  await venta('s3', { linking: '551234567', photos: ['f1'], paidAt: range.to })
  await venta('s3b', { linking: '551234568', linkingSource: 'BACKOFFICE', photos: ['f1'] }) // 9 confirmado: sin alerta
  await venta('s4', { photos: ['f1'] }) // foto sin número
  await venta('s5', { external: true }) // venta externa sin número (nace sin fotos)
  await venta('s5b', {}) // terminal que aún espera su foto: no se marca
  // Su propio ICCID en el histórico no la hace repetida, ni la misma línea en OTRA organización.
  await venta('s6', { linking: '5599999999', photos: ['f1'], iccid: 'ICC6' })
  await venta('otra', { org: OTHER_ORG, linking: '5599999999', photos: ['f1'] })
  await venta('s7', { linking: '5511111111', photos: ['f1'], iccid: 'ICC7' }) // choca con el histórico de otro ICCID
  // El mismo número en vinculación y portado de la MISMA venta no es repetido consigo misma.
  await venta('s8', { isPortabilidad: true, linking: '5522222222', ported: '5522222222', photos: ['f1', 'f2'] })
  await venta('s9', { linking: '5533333333', photos: ['f1'] }) // + 5 históricos sin fecha
  await venta('s10', { linking: '5512345678', photos: ['f1'], paidAt: new Date('2026-09-15T18:00:00.000Z') }) // fuera del rango
  // A(X,n) + histórico(X,n) + B(Y,n): el histórico de su propio ICCID no es repetido de A, pero B sí lo es (y A de B).
  await venta('a', { linking: '5544444444', photos: ['f1'], iccid: 'ICC-X' })
  await venta('b', { linking: '5544444444', photos: ['f1'], iccid: 'ICC-Y' })
  // C2: la venta capturó el ICCID con «f» minúscula; el histórico (normalizado) lo trae con «F». Es la misma SIM: no repetido.
  await venta('s11', { linking: '5555555555', photos: ['f1'], iccid: '8952140012345678901f' })
  // 9 dígitos de la importación y de Ventas externas también avisan: sólo el back-office confirma uno de 9.
  await venta('s3c', { linking: '551234569', linkingSource: 'IMPORT', photos: ['f1'] })
  await venta('s3d', { linking: '551234560', linkingSource: 'EXTERNAL_SALE', external: true })
  // Portado faltante: sin su foto aún no (la terminal lo manda con ella); con su foto o en venta externa, sí.
  await venta('p1', { isPortabilidad: true, linking: '5560000001', photos: ['f1', ''] })
  await venta('p2', { isPortabilidad: true, linking: '5560000002', photos: ['f1', 'f2'] })
  await venta('p3', { isPortabilidad: true, linking: '5560000003', external: true })
  // Punto 4: portabilidad con portado de 9 dígitos, que choca con otra venta (de 9 confirmado por el back-office).
  await venta('q1', {
    org: PORT_ORG,
    isPortabilidad: true,
    linking: '5566666666',
    ported: '557777777',
    photos: ['f1', 'f2'],
    iccid: 'ICC-Q1',
  })
  await venta('q2', { org: PORT_ORG, linking: '557777777', linkingSource: 'BACKOFFICE', photos: ['f1'], iccid: 'ICC-Q2' })
  // B0: «fuera» se cobró en septiembre: no sale en el filtro de octubre, pero hace repetida a «dentro».
  await venta('fuera', { linking: '5588888880', photos: ['f1'], paidAt: new Date('2026-09-20T18:00:00.000Z') })
  await venta('dentro', { linking: '5588888880', photos: ['f1'] })
  // B0 (A11b): el ICCID trae un tabulador al final y «f» minúscula; `trim()` lo quita, `btrim` no. Es su propio histórico.
  await venta('t1', { linking: '5577777770', photos: ['f1'], iccid: '8952140012345678902f\t' })

  await prisma.historicalLinkingNumber.createMany({
    data: [
      { organizationId: ORG, iccid: 'ICC6', number: '5599999999', importBatch: tag },
      { organizationId: ORG, iccid: 'ICC-OTRA', number: '5511111111', importBatch: tag, saleDate: new Date('2026-05-01T18:00:00Z') },
      ...['H1', 'H2', 'H3', 'H4', 'H5'].map(iccid => ({ organizationId: ORG, iccid, number: '5533333333', importBatch: tag })),
      { organizationId: ORG, iccid: 'ICC-X', number: '5544444444', importBatch: tag },
      { organizationId: ORG, iccid: '8952140012345678901F', number: '5555555555', importBatch: tag },
      { organizationId: ORG, iccid: '8952140012345678902F', number: '5577777770', importBatch: tag },
    ],
  })
})

afterAll(async () => {
  if (venueIds.length > 0) {
    await prisma.activityLog.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.saleVerification.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.payment.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.order.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  }
  await prisma.historicalLinkingNumber.deleteMany({ where: { organizationId: { in: ORGS } } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.organization.deleteMany({ where: { id: { in: ORGS } } })
  await prisma.$disconnect()
})

const CODES: Record<NumberAlertFilter, (c: NumberAlertCode[]) => boolean> = {
  any: c => c.length > 0,
  duplicate: c => c.includes('LINKING_DUPLICATE') || c.includes('PORTED_DUPLICATE'),
  missing: c => c.includes('LINKING_MISSING') || c.includes('PORTED_MISSING'),
  not10: c => c.includes('NOT_10_DIGITS'),
}

/** Lo que pinta la fila de la lista: las ventas de la organización cobradas en el rango, con sus alertas. */
async function alertasDeLaFila(org = ORG) {
  const svs = await prisma.saleVerification.findMany({
    where: { venue: { organizationId: org }, payment: { createdAt: { gte: range.from, lte: range.to } } },
    select: {
      id: true,
      linkingNumber: true,
      linkingNumberSource: true,
      portedNumber: true,
      portedNumberSource: true,
      isPortabilidad: true,
      photos: true,
      serialNumbers: true,
      payment: { select: { order: { select: { type: true } } } },
    },
    take: 100,
  })
  const dups = await findDuplicatesForSales(
    org,
    svs.map(s => ({
      key: s.id,
      verificationId: s.id,
      iccid: s.serialNumbers[0] ?? null,
      linkingNumber: s.linkingNumber,
      portedNumber: s.portedNumber,
    })),
  )
  return svs.map(s => ({
    id: s.id,
    codes: computeNumberAlerts({
      ...s,
      isExternalSale: s.payment.order.type === 'MANUAL_ENTRY',
      linkingDuplicate: !!dups.get(s.id)?.linking,
      portedDuplicate: !!dups.get(s.id)?.ported,
    }),
  }))
}

const nombres = (lista: string[]) => lista.map(id => Object.keys(ids).find(n => ids[n] === id) ?? id).sort()

describe('filtro de alertas del número = alertas de la fila', () => {
  it.each<[NumberAlertFilter, string[]]>([
    ['duplicate', ['a', 'b', 'dentro', 's1', 's2', 's7', 's9']],
    ['not10', ['s3', 's3c', 's3d']],
    ['missing', ['p2', 'p3', 's4', 's5']],
    ['any', ['a', 'b', 'dentro', 'p2', 'p3', 's1', 's2', 's3', 's3c', 's3d', 's4', 's5', 's7', 's9']],
  ])('%s: el SQL y la fila dan las mismas ventas', async (kind, esperadas) => {
    const filas = await alertasDeLaFila()

    const delSql = await findVerificationIdsWithNumberAlert(ORG, kind, range)
    const deLaFila = filas.filter(f => CODES[kind](f.codes)).map(f => f.id)

    expect(nombres(delSql)).toEqual(esperadas)
    expect(nombres(deLaFila)).toEqual(esperadas)
  })
})

describe('B0: el filtro sólo recorre las ventas del rango', () => {
  it('una venta fuera del rango no sale, pero sí hace repetida a la del rango con quien comparte número', async () => {
    for (const kind of ['duplicate', 'any'] as const) {
      const delSql = await findVerificationIdsWithNumberAlert(ORG, kind, range)
      expect(delSql).toContain(ids.dentro)
      expect(delSql).not.toContain(ids.fuera)
    }
    // La fila dice lo mismo: el repetido de «dentro» es la venta de septiembre.
    const res = await findDuplicatesForSales(ORG, [
      { key: 'dentro', verificationId: ids.dentro, iccid: 'dentro-iccid', linkingNumber: '5588888880', portedNumber: null },
    ])
    expect(res.get('dentro')?.linking).toEqual({
      total: 1,
      matches: [expect.objectContaining({ kind: 'SALE', verificationId: ids.fuera })],
    })
  })

  it('un ICCID con tabulador al final y «f» minúscula es el de su histórico, en el filtro y en la fila', async () => {
    expect((await alertasDeLaFila()).find(f => f.id === ids.t1)?.codes).toEqual([])
    for (const kind of ['duplicate', 'any'] as const) {
      expect(await findVerificationIdsWithNumberAlert(ORG, kind, range)).not.toContain(ids.t1)
    }
  })
})

describe('findDuplicatesForSales contra Postgres', () => {
  it('total exacto con más de 5 llaves, y un histórico sin fecha nunca tapa a la venta fechada', async () => {
    const res = await findDuplicatesForSales(ORG, [
      { key: 'nueva', verificationId: null, iccid: null, linkingNumber: '5533333333', portedNumber: null },
    ])

    const linking = res.get('nueva')?.linking
    expect(linking?.total).toBe(6) // s9 + 5 históricos
    expect(linking?.matches).toHaveLength(3)
    expect(linking?.matches[0]).toMatchObject({ kind: 'SALE', verificationId: ids.s9, staffName: 'Ana Promotora' })
    expect(linking?.matches.slice(1)).toEqual([
      { kind: 'HISTORICAL', date: null },
      { kind: 'HISTORICAL', date: null },
    ])
  })

  it('A(X,n) + histórico(X,n) + B(Y,n): para A sólo B es repetido (su propio histórico no); B sí choca con A', async () => {
    const res = await findDuplicatesForSales(ORG, [
      { key: 'a', verificationId: ids.a, iccid: 'ICC-X', linkingNumber: '5544444444', portedNumber: null },
      { key: 'b', verificationId: ids.b, iccid: 'ICC-Y', linkingNumber: '5544444444', portedNumber: null },
    ])

    expect(res.get('a')?.linking).toEqual({ total: 1, matches: [expect.objectContaining({ kind: 'SALE', verificationId: ids.b })] })
    const b = res.get('b')?.linking
    expect(b).toBeDefined()
    expect(b?.matches).toContainEqual(expect.objectContaining({ kind: 'SALE', verificationId: ids.a }))
  })

  it('cuenta la venta fuera del rango y nunca la de otra organización', async () => {
    const res = await findDuplicatesForSales(ORG, [
      { key: 's1', verificationId: ids.s1, iccid: 'ICC1', linkingNumber: '5512345678', portedNumber: null },
      { key: 's6', verificationId: ids.s6, iccid: 'ICC6', linkingNumber: '5599999999', portedNumber: null },
    ])

    expect(res.get('s1')?.linking?.total).toBe(2) // s2 (portado) y s10
    expect(res.get('s6')).toEqual({})
  })
})

describe('portabilidad → línea nueva (A11b punto 4)', () => {
  it('se borra el portado: la fila queda sin alertas y la otra venta con ese número ya no sale repetida', async () => {
    expect(nombres(await findVerificationIdsWithNumberAlert(PORT_ORG, 'duplicate', range))).toEqual(['q1', 'q2'])
    expect(nombres(await findVerificationIdsWithNumberAlert(PORT_ORG, 'not10', range))).toEqual(['q1'])

    await editOrgSaleVerification(PORT_ORG, {
      saleVerificationId: ids.q1,
      editedById: staffId,
      isPortabilidad: false,
      reason: 'Era línea nueva, no portabilidad',
    })

    for (const kind of ['any', 'duplicate', 'not10', 'missing'] as const) {
      expect(await findVerificationIdsWithNumberAlert(PORT_ORG, kind, range)).toEqual([])
    }
    expect((await alertasDeLaFila(PORT_ORG)).map(f => f.codes)).toEqual([[], []])
    await expect(
      prisma.saleVerification.findUnique({
        where: { id: ids.q1 },
        select: { isPortabilidad: true, portedNumber: true, portedNumberSource: true, portedNumberSetAt: true },
      }),
    ).resolves.toEqual({ isPortabilidad: false, portedNumber: null, portedNumberSource: null, portedNumberSetAt: null })
    const log = await prisma.activityLog.findFirst({
      where: { entityId: ids.q1, action: 'SALE_VERIFICATION_EDIT' },
      select: { data: true },
    })
    expect(log?.data).toMatchObject({ before: { portedNumber: '557777777' }, after: { portedNumber: null } })
  })
})

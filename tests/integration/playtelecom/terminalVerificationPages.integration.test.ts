/**
 * Lecturas de la TPV (spec §5.3.3, plan A6) contra Postgres real: el SQL de la página ordena GLOBALMENTE antes del
 * límite (foto faltante primero, de la más vieja a la más nueva, luego id), el cursor de tres llaves trae justo las que
 * faltan, y todo busca en la organización del token (la venta que el job de SIM de evento movió de tienda sigue saliendo).
 *   TEST_DATABASE_URL='postgresql://…/avoqado_<tarea>_test_<fecha>' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/playtelecom/terminalVerificationPages.integration.test.ts
 */
import { randomUUID } from 'crypto'
import cuid from 'cuid'
import type { SaleVerificationRejectionReason, SaleVerificationStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import {
  checkTerminalNumber,
  getActionableVerifications,
  getPendingVerifications,
  getVerificationForCorrection,
  getVerificationStatuses,
} from '@/services/tpv/sale-verification.service'

// El interruptor y el módulo son de otra tarea (A3, `moduleService`); aquí se prueba el SQL de las lecturas.
jest.mock('@/services/playtelecom/linkingNumber.flag', () => ({ __esModule: true, isLinkingNumberEnabledForOrg: async () => true }))

const tag = `lecturas-tpv-${randomUUID()}`
const ORG = cuid()
const OTHER_ORG = cuid()
let venueA = ''
let venueB = ''
let venueOther = ''
const staff: Record<'p1' | 'p2' | 'p3' | 'p4', string> = { p1: '', p2: '', p3: '', p4: '' }
const ids: Record<string, { sv: string; payment: string }> = {}
let paymentWithoutVerification = ''

type Venta = {
  name: string
  venueId: string
  staffId: string
  createdAt: Date
  photos?: string[]
  isPortabilidad?: boolean
  status?: SaleVerificationStatus
  rejectionReasons?: SaleVerificationRejectionReason[]
  reviewNotes?: string
  linkingNumber?: string
}

/** Muchas ventas en tres INSERT (orden, pago, verificación), con ids cuid v1. */
async function ventas(list: Venta[]) {
  const rows = list.map(v => ({ v, order: cuid(), payment: cuid(), sv: cuid() }))
  await prisma.order.createMany({
    data: rows.map(r => ({ id: r.order, venueId: r.v.venueId, orderNumber: randomUUID(), subtotal: 100, taxAmount: 0, total: 100 })),
  })
  await prisma.payment.createMany({
    data: rows.map(r => ({
      id: r.payment,
      venueId: r.v.venueId,
      orderId: r.order,
      amount: 100,
      method: 'CASH' as const,
      status: 'COMPLETED' as const,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
    })),
  })
  await prisma.saleVerification.createMany({
    data: rows.map(r => ({
      id: r.sv,
      venueId: r.v.venueId,
      paymentId: r.payment,
      staffId: r.v.staffId,
      photos: r.v.photos ?? ['f1'],
      status: r.v.status ?? 'PENDING',
      isPortabilidad: !!r.v.isPortabilidad,
      serialNumbers: [`ICC-${r.v.name}`],
      rejectionReasons: r.v.rejectionReasons ?? [],
      reviewNotes: r.v.reviewNotes ?? null,
      linkingNumber: r.v.linkingNumber ?? null,
      linkingNumberSource: r.v.linkingNumber ? ('TPV' as const) : null,
      createdAt: r.v.createdAt,
    })),
  })
  for (const r of rows) ids[r.v.name] = { sv: r.sv, payment: r.payment }
}

const at = (iso: string, minutes = 0) => new Date(Date.parse(iso) + minutes * 60_000)
const idsOf = (page: { data: Array<{ id: string }> }) => page.data.map(d => d.id)

beforeAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await prisma.organization.create({ data: { id: org, name: tag, email: `${org}@example.test`, phone: '5500000000' } })
  }
  venueA = (await prisma.venue.create({ data: { organizationId: ORG, name: `${tag} A`, slug: `${tag}-a` } })).id
  venueB = (await prisma.venue.create({ data: { organizationId: ORG, name: `${tag} B`, slug: `${tag}-b` } })).id
  venueOther = (await prisma.venue.create({ data: { organizationId: OTHER_ORG, name: `${tag} C`, slug: `${tag}-c` } })).id
  for (const k of ['p1', 'p2', 'p3', 'p4'] as const) {
    staff[k] = (await prisma.staff.create({ data: { email: `${tag}-${k}@example.test`, firstName: k, lastName: 'Promotor' } })).id
  }

  // p1: 205 pendientes completas.
  await ventas(
    Array.from({ length: 205 }, (_, i) => ({
      name: `p1-${i}`,
      venueId: venueA,
      staffId: staff.p1,
      createdAt: at('2026-10-01T15:00:00Z', i),
    })),
  )

  // p2: 200 viejas completas, una nueva sin foto y dos portabilidades con una sola de sus dos fotos.
  await ventas([
    {
      name: 'p2-porta-completa',
      venueId: venueA,
      staffId: staff.p2,
      isPortabilidad: true,
      photos: ['f1', 'f2'],
      createdAt: at('2026-09-01T15:00:00Z'),
    },
    ...Array.from({ length: 200 }, (_, i) => ({
      name: `p2-${i}`,
      venueId: venueA,
      staffId: staff.p2,
      createdAt: at('2026-10-01T15:00:00Z', i),
    })),
    {
      name: 'p2-porta-solo-1',
      venueId: venueA,
      staffId: staff.p2,
      isPortabilidad: true,
      photos: ['f1'],
      createdAt: at('2026-10-10T15:00:00Z'),
    },
    {
      name: 'p2-porta-solo-2',
      venueId: venueA,
      staffId: staff.p2,
      isPortabilidad: true,
      photos: ['', 'f2'],
      createdAt: at('2026-10-11T15:00:00Z'),
    },
    { name: 'p2-nueva-sin-foto', venueId: venueA, staffId: staff.p2, photos: [], createdAt: at('2026-10-20T15:00:00Z') },
  ])

  // p3: la movida a la tienda B, un empate de hora, una FAILED, las que ya no son del promotor y otra organización.
  const tie = at('2026-10-05T15:00:00Z')
  await ventas([
    { name: 'p3-movida', venueId: venueB, staffId: staff.p3, linkingNumber: '5512345678', createdAt: at('2026-10-03T15:00:00Z') },
    { name: 'p3-empate-1', venueId: venueA, staffId: staff.p3, createdAt: tie },
    { name: 'p3-empate-2', venueId: venueA, staffId: staff.p3, createdAt: tie },
    {
      name: 'p3-revisar',
      venueId: venueA,
      staffId: staff.p3,
      status: 'FAILED',
      rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'],
      reviewNotes: 'Foto borrosa',
      createdAt: at('2026-10-04T15:00:00Z'),
    },
    { name: 'p3-aprobada', venueId: venueA, staffId: staff.p3, status: 'COMPLETED', createdAt: at('2026-10-02T15:00:00Z') },
    { name: 'p3-rechazada', venueId: venueA, staffId: staff.p3, status: 'REJECTED', createdAt: at('2026-10-02T16:00:00Z') },
    { name: 'p3-otra-org', venueId: venueOther, staffId: staff.p3, createdAt: at('2026-10-01T15:00:00Z') },
  ])
  // p4: 199 completas en minutos distintos y, justo en el corte de página (posiciones 200 y 201), dos a la misma hora.
  const corte = at('2026-10-01T15:00:00Z', 199)
  await ventas([
    ...Array.from({ length: 199 }, (_, i) => ({
      name: `p4-${i}`,
      venueId: venueA,
      staffId: staff.p4,
      createdAt: at('2026-10-01T15:00:00Z', i),
    })),
    { name: 'p4-corte-a', venueId: venueA, staffId: staff.p4, createdAt: corte },
    { name: 'p4-corte-b', venueId: venueA, staffId: staff.p4, createdAt: corte },
  ])

  const order = await prisma.order.create({ data: { venueId: venueA, orderNumber: randomUUID(), subtotal: 100, taxAmount: 0, total: 100 } })
  paymentWithoutVerification = (
    await prisma.payment.create({
      data: {
        venueId: venueA,
        orderId: order.id,
        amount: 100,
        method: 'CASH',
        status: 'COMPLETED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
      },
    })
  ).id

  jest.spyOn(moduleService, 'isModuleEnabled').mockResolvedValue(true)
}, 120_000)

afterAll(async () => {
  const venueIds = [venueA, venueB, venueOther].filter(Boolean)
  if (venueIds.length > 0) {
    await prisma.saleVerification.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.payment.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.order.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  }
  const staffIds = Object.values(staff).filter(Boolean)
  if (staffIds.length > 0) await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } })
  await prisma.$disconnect()
})

describe('pending: tope de 200, total y cursor', () => {
  it('con 205 pendientes devuelve 200, total 205, y el cursor trae las 5 que faltan sin repetir ninguna', async () => {
    const first = await getPendingVerifications(ORG, staff.p1)
    expect(first.data).toHaveLength(200)
    expect(first.total).toBe(205)
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await getPendingVerifications(ORG, staff.p1, first.nextCursor!)
    expect(second.data).toHaveLength(5)
    expect(second.total).toBe(205)
    expect(second.nextCursor).toBeNull()

    const all = [...idsOf(first), ...idsOf(second)]
    expect(all).toEqual(Array.from({ length: 205 }, (_, i) => ids[`p1-${i}`].sv)) // de la más vieja a la más nueva
  })

  it('con 200 viejas completas y una nueva sin foto, las que les falta foto salen primero, en la primera página', async () => {
    const first = await getPendingVerifications(ORG, staff.p2)

    expect(first.total).toBe(204)
    expect(idsOf(first).slice(0, 4)).toEqual([
      ids['p2-porta-solo-1'].sv, // portabilidad con 1 de 2
      ids['p2-porta-solo-2'].sv, // ['', f2] también es 1 de 2
      ids['p2-nueva-sin-foto'].sv,
      ids['p2-porta-completa'].sv, // luego las completas, la más vieja primero
    ])
    expect(first.data[2]).toMatchObject({ photos: [], requiredPhotos: 1 })

    const second = await getPendingVerifications(ORG, staff.p2, first.nextCursor!)
    expect(idsOf(second)).toEqual([ids['p2-196'].sv, ids['p2-197'].sv, ids['p2-198'].sv, ids['p2-199'].sv])
    expect(second.nextCursor).toBeNull()
  })

  it('busca en la organización: la venta movida a otra tienda sigue; la de otra organización y las ya revisadas, no', async () => {
    const page = await getPendingVerifications(ORG, staff.p3)

    const tie = [ids['p3-empate-1'].sv, ids['p3-empate-2'].sv].sort()
    expect(idsOf(page)).toEqual([ids['p3-movida'].sv, ...tie]) // mismo instante: desempata el id
    expect(page.total).toBe(3)
    expect(page.data[0]).toMatchObject({ linkingNumber: '5512345678', linkingNumberLocked: false, alerts: [] })
    expect(page.data[0]).not.toHaveProperty('status')
  })
})

describe('empate de hora justo en el corte de página', () => {
  it('la 200 y la 201 tienen el mismo createdAt: el id desempata y el cursor trae la que falta, sin repetir ni perder', async () => {
    const [primeroEnId, segundoEnId] = [ids['p4-corte-a'].sv, ids['p4-corte-b'].sv].sort()

    const first = await getPendingVerifications(ORG, staff.p4)
    expect(first.total).toBe(201)
    expect(first.data).toHaveLength(200)
    expect(first.data[199].id).toBe(primeroEnId)

    const second = await getPendingVerifications(ORG, staff.p4, first.nextCursor!)
    expect(idsOf(second)).toEqual([segundoEnId])
    expect(second.nextCursor).toBeNull()

    expect([...idsOf(first), ...idsOf(second)]).toEqual([
      ...Array.from({ length: 199 }, (_, i) => ids[`p4-${i}`].sv),
      primeroEnId,
      segundoEnId,
    ])
  })
})

describe('actionable', () => {
  it('trae PENDING y FAILED del promotor en la organización, con motivos y notas', async () => {
    const page = await getActionableVerifications(venueA, ORG, staff.p3)

    expect(page.total).toBe(4)
    expect(idsOf(page)).toEqual([ids['p3-movida'].sv, ids['p3-revisar'].sv, ...[ids['p3-empate-1'].sv, ids['p3-empate-2'].sv].sort()])
    expect(page.data[1]).toMatchObject({ status: 'FAILED', rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'], reviewNotes: 'Foto borrosa' })
  })
})

describe('detalle', () => {
  it('encuentra la venta movida y no la de otra organización', async () => {
    await expect(getVerificationForCorrection(ORG, staff.p3, ids['p3-movida'].sv)).resolves.toMatchObject({ status: 'PENDING' })
    await expect(getVerificationForCorrection(ORG, staff.p3, ids['p3-otra-org'].sv)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('status', () => {
  it('COMPLETED, FAILED y NONE (pago sin verificación y pago de otra organización)', async () => {
    const data = await getVerificationStatuses(venueA, ORG, [
      ids['p3-aprobada'].payment,
      ids['p3-revisar'].payment,
      paymentWithoutVerification,
      ids['p3-otra-org'].payment,
    ])
    expect(data.map(d => d.status)).toEqual(['COMPLETED', 'FAILED', 'NONE', 'NONE'])
  })
})

describe('number-check', () => {
  it('con su propio verificationId no se marca a sí misma; desde otra venta, sí está repetido', async () => {
    const base = { venueId: venueA, orgId: ORG, staffId: staff.p3, number: '55 1234 5678', kind: 'linking' as const }
    await expect(checkTerminalNumber({ ...base, verificationId: ids['p3-movida'].sv })).resolves.toEqual({ duplicate: false })
    await expect(checkTerminalNumber({ ...base, verificationId: ids['p3-empate-1'].sv })).resolves.toEqual({ duplicate: true })
    await expect(checkTerminalNumber({ ...base, number: '5599990000' })).resolves.toEqual({ duplicate: false })
  })
})

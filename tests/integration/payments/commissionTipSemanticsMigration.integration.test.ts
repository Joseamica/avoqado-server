/**
 * 🔴 Dinero (auditoría de Codex, 29-sep-2026): `CommissionCalculation.tipAmount` pasó a significar «la
 * propina que ENTRÓ a la base» (0 si la config la excluye). El código anterior guardaba la propina cruda
 * aunque la config la excluyera; leída con el significado nuevo, un reembolso de toda la venta revertía el
 * 90 % de la comisión en vez del 100 %. La migración normaliza lo que dejó el código anterior: filas
 * materializadas y efectos del outbox todavía sin entregar.
 *
 * Se ejecuta el SQL REAL del archivo de migración, acotado al negocio de la prueba (la base de CI es
 * compartida por las suites que corren a la par; el archivo corre sin acotar en `migrate deploy`).
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createRefundCommission } from '@/services/dashboard/commission/commission-calculation.service'

jest.setTimeout(30000)
const MIGRATIONS_DIR = path.join(__dirname, '../../../prisma/migrations')
let organizationId: string, venueId: string, staffId: string, orderId: string

function migrationStatements(): string[] {
  const dir = fs.readdirSync(MIGRATIONS_DIR).find(name => name.endsWith('_comisiones_propina_fuera_de_la_base'))
  if (!dir) throw new Error('falta la migración *_comisiones_propina_fuera_de_la_base')
  return fs
    .readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
}

beforeAll(() => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/)
})
beforeEach(async () => {
  organizationId = 'tip-semantics-' + randomUUID()
  await prisma.organization.create({
    data: { id: organizationId, name: organizationId, email: organizationId + '@example.test', phone: '5500000000' },
  })
  venueId = (await prisma.venue.create({ data: { organizationId, name: organizationId, slug: organizationId } })).id
  staffId = (await prisma.staff.create({ data: { email: organizationId + '@example.test', firstName: 'Propina', lastName: 'Fixture' } })).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'CASHIER' } })
  orderId = (
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: 100,
        taxAmount: 0,
        total: 110,
        paidAmount: 110,
        remainingBalance: 0,
        paymentStatus: 'PAID',
        status: 'COMPLETED',
      },
    })
  ).id
})
afterEach(async () => {
  await prisma.paymentEffect.deleteMany({ where: { venueId } })
  await prisma.commissionCalculation.deleteMany({ where: { venueId } })
  await prisma.commissionConfig.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.delete({ where: { id: venueId } })
  await prisma.staff.delete({ where: { id: staffId } })
  await prisma.organization.delete({ where: { id: organizationId } })
})

const pago = (amount: number, tipAmount: number, extra: Partial<Prisma.PaymentUncheckedCreateInput> = {}) =>
  prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount,
      tipAmount,
      method: 'CASH',
      status: 'COMPLETED',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: amount,
      processedById: staffId,
      ...extra,
    },
  })
const config = (includeTips: boolean) =>
  prisma.commissionConfig.create({
    data: {
      venueId,
      name: `Regla ${includeTips}`,
      createdById: staffId,
      recipient: 'PROCESSOR',
      defaultRate: 0.1,
      categoryIds: [],
      includeTips,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    },
  })
// Una fila como la dejaba el código anterior: propina CRUDA aunque la regla la excluyera de la base.
const filaVieja = (configId: string, paymentId: string, baseAmount: number) =>
  ({
    venueId,
    staffId,
    paymentId,
    orderId,
    configId,
    baseAmount,
    tipAmount: 10,
    discountAmount: 0,
    taxAmount: 0,
    effectiveRate: 0.1,
    grossCommission: baseAmount / 10,
    netCommission: baseAmount / 10,
    calcType: 'PERCENTAGE',
  }) as const

async function migrar(): Promise<void> {
  for (const sentencia of migrationStatements()) await prisma.$executeRawUnsafe(`${sentencia} AND fila."venueId" = '${venueId}'`)
}

it('🔴 la regla que EXCLUYE la propina queda con propina 0 en la base; la que la incluye no se toca', async () => {
  const sin = await config(false)
  const con = await config(true)
  const cobro = await pago(100, 10)
  const vieja = await prisma.commissionCalculation.create({ data: filaVieja(sin.id, cobro.id, 100) })
  const incluida = await prisma.commissionCalculation.create({ data: filaVieja(con.id, cobro.id, 110) })

  await migrar()

  expect(Number((await prisma.commissionCalculation.findUniqueOrThrow({ where: { id: vieja.id } })).tipAmount)).toBe(0)
  expect(Number((await prisma.commissionCalculation.findUniqueOrThrow({ where: { id: incluida.id } })).tipAmount)).toBe(10)
})

it('🔴 los efectos sin entregar se normalizan; los ya entregados (DONE) conservan su foto', async () => {
  const sin = await config(false)
  const cobro = await pago(100, 10)
  const efecto = (status: string, dedupeKey: string) =>
    prisma.paymentEffect.create({
      data: {
        venueId,
        paymentId: cobro.id,
        orderId,
        kind: 'COMMISSION',
        dedupeKey,
        status,
        payload: JSON.parse(JSON.stringify(filaVieja(sin.id, cobro.id, 100))),
      },
    })
  const pendiente = await efecto('PENDING', 'pendiente')
  const muerto = await efecto('DEAD_LETTER', 'muerto')
  const entregado = await efecto('DONE', 'entregado')

  await migrar()

  const propina = async (id: string) => (await prisma.paymentEffect.findUniqueOrThrow({ where: { id } })).payload as any
  expect(Number((await propina(pendiente.id)).tipAmount)).toBe(0)
  expect(Number((await propina(muerto.id)).tipAmount)).toBe(0)
  expect(Number((await propina(entregado.id)).tipAmount)).toBe(10)
})

it('🔴 tras migrar, devolver TODA la venta (sin la propina) revierte el 100 % de la comisión', async () => {
  const sin = await config(false)
  const cobro = await pago(100, 10)
  await prisma.commissionCalculation.create({ data: filaVieja(sin.id, cobro.id, 100) })
  await migrar()
  const reembolso = await pago(-100, 0, { type: 'REFUND', processorData: { originalPaymentId: cobro.id } })

  const [reverso] = await createRefundCommission(reembolso.id, cobro.id)

  expect(reverso.netCommission).toBeCloseTo(-10, 2)
})

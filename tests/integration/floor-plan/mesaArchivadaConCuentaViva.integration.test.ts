/**
 * Cuentas fuera del plano (23-oct-2026), hueco 3, contra Postgres real: una cuenta VIVA en una mesa ARCHIVADA (la abrió o la movió
 * un aparato sin red con el plano viejo) no salía en `/tables` de ningún aparato. Ahora la mesa vuelve mientras tenga la cuenta:
 *   · con `archived: true` y SIN posición (las tres apps la ponen en «Sin ubicación en el plano» / Lista y no tapa a la mesa que
 *     tomó su lugar; Codex r1 #1);
 *   · la versión del plano cuenta el mismo conjunto de mesas (Codex r1 #2).
 *   TEST_DATABASE_URL='postgresql://…/avoqado_cuentasplano_test_20261023' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/floor-plan/mesaArchivadaConCuentaViva.integration.test.ts
 * Sin limpieza a propósito: venue único por prueba en una base desechable.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { clearTablesVersionCache, readTablesVersions } from '@/services/mobile/tablesVersion.service'
import { getTablesWithStatus } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const target = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(target.pathname)) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_cuentasplano_test_20261023).')
}

let venueId = ''

beforeEach(async () => {
  clearTablesVersionCache()
  venueId = `cuentasplano-${randomUUID()}`
  await prisma.organization.create({
    data: { id: venueId, name: 'Cuentas plano org', email: `${venueId}@example.test`, phone: '5500000000' },
  })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: 'Cuentas plano', slug: venueId } })
})

afterAll(() => prisma.$disconnect())

const mesa = (number: string, active: boolean) =>
  prisma.table.create({ data: { venueId, number, capacity: 4, qrCode: randomUUID(), active, positionX: 0.5, positionY: 0.5 } })
const cuentaEn = (tableId: string, status: 'PENDING' | 'COMPLETED' | 'CANCELLED') =>
  prisma.order.create({ data: { venueId, tableId, orderNumber: randomUUID(), status, subtotal: 100, taxAmount: 0, total: 100 } })

describe('getTablesWithStatus — mesa archivada con una cuenta viva', () => {
  it('vuelve sin posición y marcada; las archivadas sin cuenta viva no salen', async () => {
    const m1 = await mesa('1', true)
    const m2 = await mesa('2', false)
    const m3 = await mesa('3', false)
    const m4 = await mesa('4', false)
    await mesa('5', false)
    const viva = await cuentaEn(m2.id, 'PENDING')
    await cuentaEn(m3.id, 'COMPLETED')
    await cuentaEn(m4.id, 'CANCELLED')

    const mesas = await getTablesWithStatus(venueId)

    expect(mesas.map(m => m.number)).toEqual(['1', '2'])
    const archivada = mesas.find(m => m.id === m2.id)!
    expect(archivada).toMatchObject({ archived: true, positionX: null, positionY: null })
    expect(archivada.openOrders?.map(o => o.id)).toEqual([viva.id])
    const activa = mesas.find(m => m.id === m1.id)!
    expect(activa.archived).toBeUndefined()
    expect(activa).toMatchObject({ positionX: 0.5, positionY: 0.5 })
  })

  it('la versión del plano cambia si cambia la mesa archivada que sigue en el plano', async () => {
    const m2 = await mesa('2', false)
    await cuentaEn(m2.id, 'PENDING')
    const antes = await readTablesVersions(venueId)
    await prisma.table.update({ where: { id: m2.id }, data: { number: '2B' } })
    const despues = await readTablesVersions(venueId)
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('regresión: una archivada SIN cuenta viva no mueve la versión al cambiar', async () => {
    const m5 = await mesa('5', false)
    const antes = await readTablesVersions(venueId)
    await prisma.table.update({ where: { id: m5.id }, data: { number: '5B' } })
    expect((await readTablesVersions(venueId)).tablesVersion).toBe(antes.tablesVersion)
  })
})

describe('tablesVersion — el puntero de una mesa archivada que sigue en el plano (Codex r2 #2)', () => {
  it('cambiar la cuenta APUNTADA (sin tableId) de una archivada recuperada mueve la versión', async () => {
    const m2 = await mesa('2', false)
    await cuentaEn(m2.id, 'PENDING') // la que la recupera por tableId
    const apuntada = await prisma.order.create({
      data: { venueId, orderNumber: randomUUID(), status: 'PENDING', subtotal: 50, taxAmount: 0, total: 50 },
    })
    await prisma.table.update({ where: { id: m2.id }, data: { currentOrderId: apuntada.id } })
    clearTablesVersionCache()
    const antes = await readTablesVersions(venueId)
    await prisma.order.update({ where: { id: apuntada.id }, data: { customerName: 'Ana' } })
    expect((await readTablesVersions(venueId)).tablesVersion).not.toBe(antes.tablesVersion)
  })
})

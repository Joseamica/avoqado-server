/**
 * hz:nube0000:naf9f31c (encargo 64000e, 18-nov-2026) — «Liberar mesa» sin red con la MESA VIEJA. Postgres REAL.
 *
 * Con el plano atrasado, la TPV abre una cuenta que otro aparato ya movió de M8 a M9 con la sesión todavía en M8. Si después la salda
 * en efectivo sin red, encola `CLEAR_TABLE { tableId: M8, orderId: <la cuenta> }`. El SERVIDOR revisaba que la cuenta ya no debiera y
 * que M8 no tuviera otra cuenta con deuda, pero NO que la cuenta fuera de M8: liberaba M8 (que ya no tenía nada que ver), le borraba
 * una reservación y dejaba un `TABLE_CLEARED` falso en la bitácora. M9 la suelta el propio cobro (`releaseTableIfSettled`).
 *
 * Regla: si el `CLEAR_TABLE` nombra una cuenta de la sucursal que hoy está en OTRA mesa, no hay nada suyo que liberar en `tableId`:
 * ACK sin tocar nada (`mesaSinCambios`, sin nombrar la cuenta). Sin cuenta (apps viejas) o con la cuenta en esa mesa, como hoy.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { clearTableDeLaCuenta, moveOrderToTable } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const fixture = `naf9-${randomUUID().slice(0, 8)}`
let seq = 0

interface Negocio {
  venueId: string
  /** La TPV con el plano atrasado. */
  mesero: string
  productId: string
}
let libre: Negocio // propiedad de mesa APAGADA
let conDueno: Negocio // propiedad de mesa ENCENDIDA

const replay = (n: Negocio, intents: any[]) =>
  processIntents({ venueId: n.venueId, staffId: n.mesero, deviceId: `tpv-${n.mesero}`, intents, authorizeIntent: () => true })
const open = (tableId: string, localOrderId: string) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'OPEN_TABLE' as const,
  payload: { tableId, covers: 2, localOrderId },
  createdAtLocal: Date.now() - 60_000,
})
const add = (n: Negocio, localOrderId: string) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'ADD_ITEMS' as const,
  payload: { localOrderId, items: [{ productId: n.productId, quantity: 2 }] },
})
const pay = (orderId: string, amountCents: number) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'PAY_CASH' as const,
  payload: { orderId, amountCents, tipCents: 0, method: 'CASH' },
})
const clear = (tableId: string, cuenta?: { orderId: string } | { localOrderId: string }) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'CLEAR_TABLE' as const,
  payload: { tableId, ...(cuenta ?? {}) },
})

async function crearNegocio(propiedad: boolean): Promise<Negocio> {
  const nombre = `${fixture}-${propiedad ? 'dueno' : 'libre'}`
  const org = await prisma.organization.create({ data: { name: nombre, email: `${nombre}@example.test`, phone: '' } })
  const venueId = (
    await prisma.venue.create({ data: { organizationId: org.id, name: nombre, slug: nombre, type: 'RESTAURANT', status: 'TRIAL' } })
  ).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false, enforceTableOwnership: propiedad } })
  const mesero = (
    await prisma.staff.create({ data: { email: `uno-${nombre}@staff.test`, firstName: 'Mesero', lastName: 'uno', active: true } })
  ).id
  await prisma.staffVenue.create({ data: { venueId, staffId: mesero, role: 'WAITER' } })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cocina', slug: `cocina-${nombre}` } })
  const productId = (
    await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Ensalada', sku: `NAF9-${nombre}`, price: 120 } })
  ).id
  return { venueId, mesero, productId }
}

async function mesa(n: Negocio): Promise<string> {
  return (await prisma.table.create({ data: { venueId: n.venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } }))
    .id
}
const laMesa = (tableId: string) =>
  prisma.table.findUniqueOrThrow({ where: { id: tableId }, select: { status: true, currentOrderId: true } })
const liberacionesDe = (venueId: string, tableId: string) =>
  prisma.activityLog.count({ where: { venueId, action: 'TABLE_CLEARED', entity: 'Table', entityId: tableId } })

/** La cuenta nace en M8 (en línea) y OTRO aparato la mueve a M9; la hostess aparta M8 para una reservación. */
async function cuentaMovida(n: Negocio) {
  const m8 = await mesa(n)
  const m9 = await mesa(n)
  const local = randomUUID()
  const acks = await replay(n, [open(m8, local), add(n, local)])
  expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED'])
  const cuenta = String(acks[0].result!.orderId)
  await moveOrderToTable(n.venueId, cuenta, m9)
  await prisma.table.update({ where: { id: m8 }, data: { status: 'RESERVED' } })
  expect(await laMesa(m8)).toEqual({ status: 'RESERVED', currentOrderId: null })
  return { m8, m9, cuenta, local }
}

beforeAll(async () => {
  libre = await crearNegocio(false)
  conDueno = await crearNegocio(true)
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

describe('naf9f31c · «Liberar mesa» con la mesa vieja de una cuenta que otro aparato movió', () => {
  for (const [nombre, negocio] of [
    ['propiedad apagada', () => libre],
    ['propiedad encendida', () => conDueno],
  ] as const) {
    it(`${nombre}: la cuenta saldada está en M9 y el CLEAR trae M8 → ACK sin cambios; M8 conserva su reservación`, async () => {
      const n = negocio()
      const { m8, m9, cuenta } = await cuentaMovida(n)

      const acks = await replay(n, [pay(cuenta, 24000), clear(m8, { orderId: cuenta })])

      expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED'])
      expect(acks[1].result).toEqual({ tableId: m8, mesaSinCambios: true })
      expect(await laMesa(m8)).toEqual({ status: 'RESERVED', currentOrderId: null })
      expect(await liberacionesDe(n.venueId, m8)).toBe(0)
      // M9 la suelta el cobro, no el CLEAR_TABLE.
      expect(await laMesa(m9)).toEqual({ status: 'AVAILABLE', currentOrderId: null })
      expect(await prisma.order.findUniqueOrThrow({ where: { id: cuenta }, select: { paymentStatus: true, tableId: true } })).toEqual({
        paymentStatus: 'PAID',
        tableId: m9,
      })
    })
  }

  it('con el id LOCAL de la apertura (la sesión sin ascender) también se reconoce la mesa vieja', async () => {
    const { m8, cuenta, local } = await cuentaMovida(libre)

    const acks = await replay(libre, [pay(cuenta, 24000), clear(m8, { localOrderId: local })])

    expect(acks[1]).toMatchObject({ status: 'ACKED', result: { tableId: m8, mesaSinCambios: true } })
    expect(await laMesa(m8)).toEqual({ status: 'RESERVED', currentOrderId: null })
  })

  it('la cuenta movida todavía debe: tampoco se toca M8 ni la cuenta', async () => {
    const { m8, m9, cuenta } = await cuentaMovida(libre)

    const [ack] = await replay(libre, [clear(m8, { orderId: cuenta })])

    expect(ack).toMatchObject({ status: 'ACKED', result: { tableId: m8, mesaSinCambios: true } })
    expect(await laMesa(m8)).toEqual({ status: 'RESERVED', currentOrderId: null })
    expect(await laMesa(m9)).toEqual({ status: 'OCCUPIED', currentOrderId: cuenta })
    expect(await liberacionesDe(libre.venueId, m8)).toBe(0)
  })

  it('Codex r1 #1 · bajo el candado: si la cuenta ya dejó la mesa, liberar con su cuenta no toca la mesa', async () => {
    // El caso de carrera (la cuenta se mueve entre la revisión y la liberación) llega a la liberación con la cuenta ya fuera:
    // la comprobación que cuenta es la que se hace con la mesa y la cuenta bajo el candado.
    const { m8, cuenta } = await cuentaMovida(libre)

    expect(await clearTableDeLaCuenta(libre.venueId, m8, cuenta)).toBe(false)

    expect(await laMesa(m8)).toEqual({ status: 'RESERVED', currentOrderId: null })
    expect(await liberacionesDe(libre.venueId, m8)).toBe(0)
  })

  it('control · la cuenta saldada sigue en su mesa → se libera como hoy', async () => {
    const m8 = await mesa(libre)
    const local = randomUUID()
    const acks = await replay(libre, [open(m8, local), add(libre, local)])
    const cuenta = String(acks[0].result!.orderId)

    const [cobro, ack] = await replay(libre, [pay(cuenta, 24000), clear(m8, { orderId: cuenta })])

    expect(cobro.status).toBe('ACKED')
    expect(ack).toMatchObject({ status: 'ACKED', result: { tableId: m8 } })
    expect(ack.result).not.toHaveProperty('mesaSinCambios')
    expect(await laMesa(m8)).toEqual({ status: 'AVAILABLE', currentOrderId: null })
  })

  it('control · una app vieja (sin cuenta) libera M8 como hoy', async () => {
    const { m8, cuenta } = await cuentaMovida(libre)

    const acks = await replay(libre, [pay(cuenta, 24000), clear(m8)])

    expect(acks[1]).toMatchObject({ status: 'ACKED', result: { tableId: m8 } })
    expect(acks[1].result).not.toHaveProperty('mesaSinCambios')
    expect(await laMesa(m8)).toEqual({ status: 'AVAILABLE', currentOrderId: null })
  })

  it('control · un orderId que no es de nadie: como hoy', async () => {
    const m8 = await mesa(libre)
    const [ack] = await replay(libre, [clear(m8, { orderId: 'cnoexiste000000000000000x' })])
    expect(ack).toMatchObject({ status: 'ACKED', result: { tableId: m8 } })
    expect(ack.result).not.toHaveProperty('mesaSinCambios')
  })
})

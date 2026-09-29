/**
 * La limpieza de órdenes abandonadas contra Postgres REAL.
 *
 * Por qué existe: la limpieza elegía las órdenes vacías y después las borraba por id, sin volver a mirar. `Payment` y
 * `OrderItem` cuelgan de la orden con `onDelete: Cascade`, así que un cobro o un renglón que entraba entre la lectura y
 * el borrado se iba con la orden, sin rastro. Aquí se prueba el borrado bajo el candado de la orden y con relectura.
 *
 * Correr (base desechable; nunca av-db-25):
 *   TEST_DATABASE_URL='postgresql://…/avoqado_h1a_test_20260808' \
 *   npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/jobs/abandoned-orders-cleanup.integration.test.ts
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { AbandonedOrdersCleanupJob } from '@/jobs/abandoned-orders-cleanup.job'

// Borra órdenes reales: sólo corre en una base de prueba local y desechable.
const url = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(url.pathname)) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_h1a_test_20260808).')
}

const HACE_UNA_HORA = () => new Date(Date.now() - 60 * 60 * 1000)

let organizationId: string
let venueId: string
const job = new AbandonedOrdersCleanupJob()

async function orden(clave: string, extra: Partial<{ type: 'TAKEOUT' | 'DINE_IN'; createdAt: Date; updatedAt: Date }> = {}) {
  const creada = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `ABAND-${clave}-${Date.now()}`,
      type: extra.type ?? 'TAKEOUT',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      subtotal: 0,
      taxAmount: 0,
      total: 0,
      createdAt: extra.createdAt ?? HACE_UNA_HORA(),
      updatedAt: extra.updatedAt ?? HACE_UNA_HORA(),
    },
  })
  return creada.id
}

const datosDeCobro = (orderId: string) => ({
  venueId,
  orderId,
  amount: 50,
  method: 'CASH' as const,
  status: 'COMPLETED' as const,
  type: 'REGULAR' as const,
  feePercentage: 0,
  feeAmount: 0,
  netAmount: 50,
})

const existe = async (orderId: string) => (await prisma.order.count({ where: { id: orderId } })) === 1

const solicitudDeTerminal = (orderId: string, extra: { status?: 'PENDING' | 'FAILED'; failureCode?: string | null } = {}) =>
  prisma.terminalPaymentRequest.create({
    data: {
      requestId: `abandonada-${orderId}-${Math.random()}`,
      venueId,
      // Una solicitud en vuelo por terminal (índice único de la ranura): cada prueba usa la suya.
      terminalId: `terminal-${orderId}`,
      orderId,
      amountCents: 5000,
      expiresAt: new Date(Date.now() + 60_000),
      ...extra,
    },
  })

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: 'Org limpieza abandonadas', email: `abandonadas-${Date.now()}@test.com`, phone: '5550000000' },
  })
  organizationId = org.id
  const venue = await prisma.venue.create({
    data: {
      name: 'Limpieza abandonadas',
      slug: `abandonadas-${Date.now()}`,
      organizationId,
      address: 'Test',
      city: 'Test',
      state: 'Test',
      country: 'MX',
      zipCode: '12345',
      timezone: 'America/Mexico_City',
    },
  })
  venueId = venue.id
})

afterAll(async () => {
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
})

describe('limpieza de órdenes abandonadas', () => {
  it('borra una orden abandonada: para llevar, vacía, sin cobros, pendiente y quieta hace más de 30 min', async () => {
    const id = await orden('vacia')
    await job.cleanupNow()
    expect(await existe(id)).toBe(false)
  })

  it('no borra lo que no está abandonado: con renglón, con cobro, reciente, tocada hace poco, de mesa o con cobro en la terminal', async () => {
    const conRenglon = await orden('con-renglon')
    await prisma.orderItem.create({ data: { orderId: conRenglon, quantity: 1, unitPrice: 50, taxAmount: 0, total: 50 } })
    const conCobro = await orden('con-cobro')
    await prisma.payment.create({ data: { ...datosDeCobro(conCobro), status: 'FAILED' } })
    const reciente = await orden('reciente', { createdAt: new Date(), updatedAt: new Date() })
    const tocada = await orden('tocada', { updatedAt: new Date() })
    const deMesa = await orden('de-mesa', { type: 'DINE_IN' })
    const enTerminal = await orden('en-terminal')
    await solicitudDeTerminal(enTerminal)
    // Un FAILED sin código NO es lápida: protege (sin el `IS NOT NULL`, el NOT de un NULL la dejaba pasar).
    const fallidaSinCodigo = await orden('fallida-sin-codigo')
    await solicitudDeTerminal(fallidaSinCodigo, { status: 'FAILED', failureCode: null })
    // Un FAILED con un código real (el banco rechazó) tampoco es lápida: sólo `REJECTED_…` prueba que no hubo cobro.
    const rechazoDelBanco = await orden('rechazo-del-banco')
    await solicitudDeTerminal(rechazoDelBanco, { status: 'FAILED', failureCode: 'BANK_DECLINED' })

    await job.cleanupNow()

    for (const id of [conRenglon, conCobro, reciente, tocada, deMesa, enTerminal, fallidaSinCodigo, rechazoDelBanco]) {
      expect(await existe(id)).toBe(true)
    }
  })

  it('una LÁPIDA de admisión (FAILED + REJECTED_…) prueba que no hubo cobro: no protege a la orden abandonada', async () => {
    const id = await orden('lapida')
    await solicitudDeTerminal(id, { status: 'FAILED', failureCode: 'REJECTED_TERMINAL_NOT_CONNECTED' })

    await job.cleanupNow()

    expect(await existe(id)).toBe(false)
  })

  it('🔴 una orden protegida no ocupa el lote: con lote de 1, la abandonada que sigue SÍ se borra', async () => {
    // Las fechas más viejas de la base: así estas dos son las primeras candidatas aunque haya otras de otras suites.
    const protegida = await orden('protegida-vieja', {
      createdAt: new Date('2001-01-01T00:00:00Z'),
      updatedAt: new Date('2001-01-01T00:00:00Z'),
    })
    await solicitudDeTerminal(protegida)
    const siguiente = await orden('siguiente', { createdAt: new Date('2001-01-02T00:00:00Z'), updatedAt: new Date('2001-01-02T00:00:00Z') })

    const resultado = await new AbandonedOrdersCleanupJob({ lote: 1 }).cleanupNow()

    expect(resultado).toEqual({ selected: 1, deleted: 1, kept: 0, failed: 0 })
    expect(await existe(siguiente)).toBe(false)
    expect(await existe(protegida)).toBe(true)
  })

  // Las carreras usan la orden MÁS vieja de la base y lote de 1: así el `kept` es el de ESTA orden, no el de otra.
  const ANTIGUA = { createdAt: new Date('2000-01-01T00:00:00Z'), updatedAt: new Date('2000-01-01T00:00:00Z') }

  it('🔴 un cobro que entra MIENTRAS corre la limpieza sobrevive, y su orden también', async () => {
    const id = await orden('carrera-cobro', ANTIGUA)
    let avisar!: () => void
    const insertado = new Promise<void>(resolve => (avisar = resolve))

    // El cobro se escribe y la transacción sigue abierta: sostiene el candado de llave foránea sobre la orden.
    const cobro = prisma.$transaction(
      async tx => {
        await tx.payment.create({ data: datosDeCobro(id) })
        avisar()
        await new Promise(resolve => setTimeout(resolve, 1500))
      },
      { timeout: 15_000, maxWait: 5_000 },
    )
    await insertado
    const inicio = Date.now()
    const resultado = await new AbandonedOrdersCleanupJob({ lote: 1 }).cleanupNow()
    await cobro

    // La limpieza tuvo que esperar al cobro (si no esperó, la prueba no ejercitó la carrera).
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(1000)
    // La eligió y la conservó la RELECTURA, no un error tragado.
    expect(resultado).toEqual({ selected: 1, deleted: 0, kept: 1, failed: 0 })
    expect(await existe(id)).toBe(true)
    expect(await prisma.payment.count({ where: { orderId: id } })).toBe(1)
  })

  it('🔴 un renglón que entra MIENTRAS corre la limpieza sobrevive, y su orden también', async () => {
    const id = await orden('carrera-renglon', ANTIGUA)
    let avisar!: () => void
    const insertado = new Promise<void>(resolve => (avisar = resolve))

    const renglon = prisma.$transaction(
      async tx => {
        await tx.orderItem.create({ data: { orderId: id, quantity: 1, unitPrice: 50, taxAmount: 0, total: 50 } })
        avisar()
        await new Promise(resolve => setTimeout(resolve, 1500))
      },
      { timeout: 15_000, maxWait: 5_000 },
    )
    await insertado
    const resultado = await new AbandonedOrdersCleanupJob({ lote: 1 }).cleanupNow()
    await renglon

    expect(resultado).toEqual({ selected: 1, deleted: 0, kept: 1, failed: 0 })
    expect(await existe(id)).toBe(true)
    expect(await prisma.orderItem.count({ where: { orderId: id } })).toBe(1)
  })
})

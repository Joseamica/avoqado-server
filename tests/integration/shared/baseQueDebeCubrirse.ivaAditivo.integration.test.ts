/**
 * La base canónica «lo que la cuenta debe» contra Postgres REAL, con las DOS convenciones de
 * `Order.taxAmount` (memoria `iva-el-precio-de-catalogo-es-final`, mismo discriminador que el CFDI):
 *   · `0`   ⇒ el precio ya trae el IVA (los 8 caminos de venta nativos);
 *   · `> 0` ⇒ el IVA va SEPARADO y suma al total (las órdenes de SoftRestaurant — Testarudo).
 *
 * Por qué existe: el arreglo del 5-sep-2026 dejó la base SIN IVA para la primera convención y
 * se llevó la segunda por delante. La corrida del vigilante del 7-sep pasó de 41 a 31,283 alarmas:
 * 31,241 eran clientes de Testarudo que pagaron EXACTAMENTE `Order.total`, con el «exceso» igual al
 * IVA al centavo. Las pruebas unitarias sólo fijan la FORMA del SQL; ésta lo EJECUTA — la consulta
 * de producción del vigilante (`buildWatchdogSql().details`) y el barrido (`findPaidButOpenOrders`),
 * tal cual, sobre órdenes sembradas con las dos convenciones.
 *
 * Correr:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *   npx jest --selectProjects integration --runTestsByPath tests/integration/shared/baseQueDebeCubrirse.ivaAditivo.integration.test.ts
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { buildWatchdogSql } from '@/jobs/money-integrity-watchdog.job'
import { findPaidButOpenOrders } from '@/services/shared/pagadaPeroAbierta'

// El detalle del vigilante ordena por nombre de venue dentro de cada invariante y corta a 30:
// un nombre que ordena ANTES que cualquier letra garantiza que estas filas entren al detalle.
const VENUE_NAME = '0000 Vigilante IVA aditivo'

let organizationId: string
let venueId: string
const ordenes: Record<string, string> = {}

interface Siembra {
  clave: string
  subtotal: number
  taxAmount: number
  cobrado: number
  abierta?: boolean
  // El IVA separado sólo existe en el histórico importado de SoftRestaurant (`POS`); lo nativo lo trae incluido.
  source?: 'POS' | 'TPV' | 'AVOQADO_IOS'
}

async function sembrar({
  clave,
  subtotal,
  taxAmount,
  cobrado,
  abierta = false,
  source = taxAmount > 0 ? 'POS' : 'TPV',
}: Siembra): Promise<void> {
  const total = subtotal + taxAmount
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `IVA-${clave}-${Date.now()}`,
      type: 'TAKEOUT',
      source,
      status: abierta ? 'PENDING' : 'COMPLETED',
      paymentStatus: abierta ? 'PARTIAL' : 'PAID',
      subtotal,
      taxAmount,
      total,
      paidAmount: cobrado,
      // Fuera de la ventana de gracia del barrido (15 min): que el criterio decida, no el reloj.
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  })
  await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      amount: cobrado,
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: cobrado,
    },
  })
  ordenes[clave] = order.id
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: 'Org IVA aditivo', email: `iva-aditivo-${Date.now()}@test.com`, phone: '5550000000' },
  })
  organizationId = org.id
  const venue = await prisma.venue.create({
    data: {
      name: VENUE_NAME,
      slug: `iva-aditivo-${Date.now()}`,
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

  // Testarudo: $100 de café + $16 de IVA separado. El cliente paga los $116 que dice la cuenta.
  await sembrar({ clave: 'separado-exacto', subtotal: 100, taxAmount: 16, cobrado: 116 })
  // Testarudo con un sobrepago REAL de $10 encima del IVA.
  await sembrar({ clave: 'separado-sobrepago', subtotal: 100, taxAmount: 16, cobrado: 126 })
  // Convención nativa: el precio ya trae el IVA. Paga $100 y no debe nada.
  await sembrar({ clave: 'incluido-exacto', subtotal: 100, taxAmount: 0, cobrado: 100 })
  // Convención nativa con sobrepago real (regresión: esto se seguía viendo antes y se debe seguir viendo).
  await sembrar({ clave: 'incluido-sobrepago', subtotal: 100, taxAmount: 0, cobrado: 110 })
  // Abierta, IVA separado, sólo el subtotal cobrado: FALTAN $16. No está pagada.
  await sembrar({ clave: 'separado-abierta-falta-iva', subtotal: 100, taxAmount: 16, cobrado: 100, abierta: true })
  // Abierta, IVA separado, cobrada completa: SÍ está pagada y sigue abierta.
  await sembrar({ clave: 'separado-abierta-pagada', subtotal: 100, taxAmount: 16, cobrado: 116, abierta: true })
  // Abierta, precio con el IVA incluido, cobrada completa: la que el barrido SÍ repara.
  await sembrar({ clave: 'incluido-abierta-pagada', subtotal: 100, taxAmount: 0, cobrado: 100, abierta: true })
  // Una venta nacida de un presupuesto (iOS): desde el 28-sep nace con el IVA incluido y `taxAmount` 0, así que el
  // barrido también la alcanza.
  await sembrar({ clave: 'presupuesto-abierta-pagada', subtotal: 250, taxAmount: 0, cobrado: 250, abierta: true, source: 'AVOQADO_IOS' })
})

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
})

interface Fila {
  check: string
  venue: string
  order_id: string
  detalle: string
}

describe('vigilante de dinero · SOBREPAGO con la consulta REAL de producción', () => {
  let sobrepagos: Map<string, Fila>

  beforeAll(async () => {
    const filas = await prisma.$queryRawUnsafe<Fila[]>(buildWatchdogSql().details)
    const mias = new Set(Object.values(ordenes))
    sobrepagos = new Map(filas.filter(f => f.check === 'SOBREPAGO' && mias.has(f.order_id)).map(f => [f.order_id, f]))
  })

  it('🔴 pagar EXACTAMENTE la cuenta con IVA separado NO es sobrepago (31,241 falsos positivos de Testarudo)', () => {
    expect(sobrepagos.has(ordenes['separado-exacto'])).toBe(false)
  })

  it('un sobrepago real por encima del IVA separado SÍ se ve, y el exceso es el exceso real', () => {
    const fila = sobrepagos.get(ordenes['separado-sobrepago'])
    expect(fila).toBeDefined()
    expect(fila!.detalle).toContain('cobrado=126.00 cuenta=116.00 exceso=10.00')
  })

  it('REGRESIÓN — con el precio que ya trae el IVA (taxAmount = 0) nada cambia: exacto no suena, sobrepago sí', () => {
    expect(sobrepagos.has(ordenes['incluido-exacto'])).toBe(false)
    expect(sobrepagos.get(ordenes['incluido-sobrepago'])?.detalle).toContain('cobrado=110.00 cuenta=100.00 exceso=10.00')
  })
})

describe('barrido pagada-pero-abierta · el MISMO criterio, ejecutado', () => {
  it('🔴 una cuenta con IVA separado a la que le falta el IVA NO se elige como pagada (el reconciliador la cerraría)', async () => {
    const candidatas = await findPaidButOpenOrders(prisma, { graceMs: 0, limit: 500, now: new Date() })
    const ids = new Set(candidatas.map(c => c.id))

    expect(ids.has(ordenes['separado-abierta-falta-iva'])).toBe(false)
  })

  it('🔴 una cuenta con IVA separado YA pagada tampoco se propone para reparar: el reparador le quitaría el IVA al total', async () => {
    // El reparador escribe `total = subtotal − descuento + cargo + propina`: la convención mexicana, con el IVA DENTRO
    // del precio. Sobre esta cuenta ($100 + $16 de IVA aparte, cobrados $116) dejaría el total en $100 y el cobro
    // exacto se leería como sobrepago de $16. Esa forma sólo existe en el histórico de SoftRestaurant.
    const candidatas = await findPaidButOpenOrders(prisma, { graceMs: 0, limit: 500, now: new Date() })
    const ids = new Set(candidatas.map(c => c.id))

    expect(ids.has(ordenes['separado-abierta-pagada'])).toBe(false)

    // REGRESIÓN — la cuenta con el IVA incluido, pagada y abierta, se sigue proponiendo, con sus números.
    const incluida = candidatas.find(c => c.id === ordenes['incluido-abierta-pagada'])
    expect(incluida).toBeDefined()
    expect(Number(incluida!.base)).toBe(100)
    expect(Number(incluida!.pagado)).toBe(100)
    // …y también la que nació de un presupuesto.
    expect(ids.has(ordenes['presupuesto-abierta-pagada'])).toBe(true)
  })

  it('…y el vigilante la SIGUE reportando como pagada pero abierta: nadie la esconde, la decide una persona', async () => {
    const filas = await prisma.$queryRawUnsafe<Fila[]>(buildWatchdogSql().details)
    const abiertas = new Set(filas.filter(f => f.check === 'PAGADA PERO ABIERTA').map(f => f.order_id))

    expect(abiertas.has(ordenes['separado-abierta-pagada'])).toBe(true)
    expect(abiertas.has(ordenes['separado-abierta-falta-iva'])).toBe(false)
  })
})

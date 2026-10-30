// tests/integration/dashboard/ligaAgregarCliente.integration.test.ts
/**
 * Founder 23-oct: al editar una liga SIN cliente se le puede agregar uno; nunca cambiarlo. Aquí, en Postgres real, que
 * dos guardados a la vez con clientes distintos dejen UNO (el otro recibe 409) y que el mismo cliente dos veces no
 * duplique nada.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="<base desechable>" npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/dashboard/ligaAgregarCliente.integration.test.ts --ci
 */
import prisma from '@/utils/prismaClient'
import { updatePaymentLink } from '@/services/dashboard/paymentLink.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from '../commission/_mundoComisiones'

const PROVEEDOR = 'LIGA_CLIENTE_PRUEBA'
let m: MundoComisiones
let ligaId: string
let ana: string
let beto: string

beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  jest.mocked(logAction).mockClear()
  m = await crearMundoComisiones('ligacli')
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: PROVEEDOR },
    create: { code: PROVEEDOR, name: 'Liga cliente (prueba)', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  const canal = await prisma.ecommerceMerchant.create({
    data: {
      venueId: m.venueId,
      businessName: 'Liga cliente',
      contactEmail: `${m.key}-canal@example.test`,
      publicKey: `pk_test_${m.key}`,
      secretKeyHash: `hash-${m.key}`,
      providerId: proveedor.id,
      providerCredentials: {},
    },
  })
  ligaId = (
    await prisma.paymentLink.create({
      data: {
        shortCode: Math.random().toString(36).slice(2, 10),
        venueId: m.venueId,
        ecommerceMerchantId: canal.id,
        createdById: m.owner,
        title: 'Anticipo',
        amountType: 'OPEN',
        purpose: 'PAYMENT',
      },
    })
  ).id
  ana = (await prisma.customer.create({ data: { venueId: m.venueId, firstName: 'Ana', email: `${m.key}-ana@example.test` } })).id
  beto = (await prisma.customer.create({ data: { venueId: m.venueId, firstName: 'Beto', email: `${m.key}-beto@example.test` } })).id
})
afterEach(async () => {
  if (!m?.venueId) return
  await prisma.paymentLink.deleteMany({ where: { venueId: m.venueId } })
  await prisma.customer.deleteMany({ where: { venueId: m.venueId } })
  await borrarMundoComisiones(m)
})
afterAll(() => prisma.paymentProvider.deleteMany({ where: { code: PROVEEDOR } }))

/** La bitácora está simulada en integración (`integration-setup.ts`): se cuentan sus llamadas. */
const filasDeAgregado = () =>
  jest.mocked(logAction).mock.calls.filter(([a]) => (a as { action: string }).action === 'PAYMENT_LINK_CUSTOMER_ADDED').length

it('dos guardados a la vez con clientes distintos: queda uno y el otro recibe 409', async () => {
  const [a, b] = await Promise.allSettled([
    updatePaymentLink(m.venueId, ligaId, { customerId: ana }, m.owner),
    updatePaymentLink(m.venueId, ligaId, { customerId: beto }, m.owner),
  ])
  const ganadores = [a, b].filter(r => r.status === 'fulfilled')
  const perdedores = [a, b].filter(r => r.status === 'rejected') as PromiseRejectedResult[]
  expect(ganadores).toHaveLength(1)
  expect(perdedores).toHaveLength(1)
  expect(perdedores[0].reason).toMatchObject({ statusCode: 409 })
  const liga = await prisma.paymentLink.findUniqueOrThrow({ where: { id: ligaId }, select: { customerId: true } })
  expect([ana, beto]).toContain(liga.customerId)
  expect(filasDeAgregado()).toBe(1)
})

it('el mismo cliente dos veces a la vez: sin error y una sola fila en la bitácora', async () => {
  const resultados = await Promise.allSettled([
    updatePaymentLink(m.venueId, ligaId, { customerId: ana }, m.owner),
    updatePaymentLink(m.venueId, ligaId, { customerId: ana }, m.owner),
  ])
  expect(resultados.every(r => r.status === 'fulfilled')).toBe(true)
  const liga = await prisma.paymentLink.findUniqueOrThrow({ where: { id: ligaId }, select: { customerId: true } })
  expect(liga.customerId).toBe(ana)
  expect(filasDeAgregado()).toBe(1)
})

it('una liga con cliente no cambia aunque pidan otro', async () => {
  await updatePaymentLink(m.venueId, ligaId, { customerId: ana }, m.owner)
  await expect(updatePaymentLink(m.venueId, ligaId, { customerId: beto }, m.owner)).rejects.toMatchObject({ statusCode: 409 })
  const liga = await prisma.paymentLink.findUniqueOrThrow({ where: { id: ligaId }, select: { customerId: true } })
  expect(liga.customerId).toBe(ana)
})

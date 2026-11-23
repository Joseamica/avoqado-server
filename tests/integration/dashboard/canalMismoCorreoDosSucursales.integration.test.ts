// tests/integration/dashboard/canalMismoCorreoDosSucursales.integration.test.ts
/**
 * D677 (22-nov): la dueña de Mindform quiso abrir el pago en línea de su segunda sucursal (Mindform BSF) con su mismo
 * correo y el SERVIDOR contestó 500 (P2002 en `contactEmail`): el correo de contacto del canal era único en TODA la
 * plataforma. Cada sucursal tiene su propio canal y su propia cuenta de Stripe, y Stripe deja repetir el correo. Aquí, en
 * Postgres real, dos sucursales abren su canal con el mismo correo.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="<base desechable>" npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/dashboard/canalMismoCorreoDosSucursales.integration.test.ts --ci
 */
import prisma from '@/utils/prismaClient'
import { createEcommerceMerchant } from '@/services/dashboard/ecommerceMerchant.service'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from '../commission/_mundoComisiones'

const PROVEEDOR = 'CANAL_MISMO_CORREO_PRUEBA'
let a: MundoComisiones | undefined
let b: MundoComisiones | undefined
let providerId: string

beforeAll(async () => {
  asegurarBaseDePrueba()
  providerId = (
    await prisma.paymentProvider.upsert({
      where: { code: PROVEEDOR },
      create: { code: PROVEEDOR, name: 'Canal mismo correo (prueba)', type: 'PAYMENT_PROCESSOR' },
      update: {},
    })
  ).id
})
beforeEach(async () => {
  a = await crearMundoComisiones('correo-a')
  b = await crearMundoComisiones('correo-b')
})
afterEach(async () => {
  for (const m of [a, b]) {
    if (!m?.venueId) continue
    await prisma.ecommerceMerchant.deleteMany({ where: { venueId: m.venueId } })
    await borrarMundoComisiones(m)
  }
})
afterAll(() => prisma.paymentProvider.deleteMany({ where: { code: PROVEEDOR } }))

it('dos sucursales abren su canal de pago en línea con el mismo correo de contacto', async () => {
  const correo = `${a!.key}-duena@example.test`
  const datos = { channelName: 'Web Principal', contactEmail: correo, providerId, providerCredentials: {} }

  const uno = await createEcommerceMerchant({ ...datos, venueId: a!.venueId })
  const dos = await createEcommerceMerchant({ ...datos, venueId: b!.venueId })

  expect(uno.contactEmail).toBe(correo)
  expect(dos.contactEmail).toBe(correo)
  expect(await prisma.ecommerceMerchant.count({ where: { contactEmail: correo } })).toBe(2)
})

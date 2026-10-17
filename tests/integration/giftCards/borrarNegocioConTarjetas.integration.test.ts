/**
 * Tarjetas de regalo × «Borrar negocio» del dashboard/superadmin (`deleteVenue`, nota 1 del coordinador en C6). Un negocio
 * TRIAL o LIVE_DEMO se puede borrar, pero si vendió tarjetas su saldo es dinero de sus clientes: se niega con 409 y no se
 * borra nada (se cierra). Sin tarjetas, se borra como siempre. Contra base real (la libreta es de sólo inserción).
 *
 * Correr (base desechable): npx jest --selectProjects=integration --runInBand --ci \
 *   --runTestsByPath tests/integration/giftCards/borrarNegocioConTarjetas.integration.test.ts
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { deleteVenue } from '@/services/dashboard/venue.dashboard.service'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'

jest.mock('@/services/modules/module.service', () => ({
  ...jest.requireActual('@/services/modules/module.service'),
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
}))
// deleteVenue borra también la carpeta del negocio en el almacenamiento: aquí nunca sale una llamada de red.
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  deleteVenueFolder: jest.fn().mockResolvedValue(true),
  deleteFileFromStorage: jest.fn().mockResolvedValue(true),
}))

const MENSAJE =
  'Este negocio vendió tarjetas de regalo: su saldo es dinero de sus clientes y no se puede borrar. Ciérralo para conservar su historial.'
const llave = `borrar-tarjetas-${randomUUID()}`

async function negocioTrial(sufijo: string): Promise<{ orgId: string; venueId: string; productId: string }> {
  const org = await prisma.organization.create({
    data: { name: `${llave}-${sufijo}`, email: `${llave}-${sufijo}@example.test`, phone: '5500000000' },
  })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: `Prueba ${sufijo}`, slug: `${llave}-${sufijo}`, status: 'TRIAL' },
  })
  const categoria = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Bebidas', slug: `${llave}-${sufijo}-bebidas` } })
  const producto = await prisma.product.create({
    data: { venueId: venue.id, categoryId: categoria.id, name: 'Café', sku: `${llave}-${sufijo}-cafe`, price: new Prisma.Decimal(45) },
  })
  return { orgId: org.id, venueId: venue.id, productId: producto.id }
}

describe('deleteVenue × tarjetas de regalo', () => {
  it('🔴 un negocio TRIAL que vendió una tarjeta no se borra: 409 con el texto y nada borrado', async () => {
    const n = await negocioTrial('con-tarjeta')
    const c = generateGiftCardCode()
    const sobre = await prisma.giftCard.create({
      data: {
        venueId: n.venueId,
        organizationId: n.orgId,
        codeHash: hashGiftCardCode(c.normalized),
        codeEnc: encryptGiftCardCode(c.normalized),
        codeLast4: c.last4,
        pageToken: generateOpaqueToken(),
        initialAmount: new Prisma.Decimal(500),
        balance: new Prisma.Decimal(500),
        status: 'ACTIVE',
        activatedAt: new Date(),
        termsVersion: '2026-10-14',
        deliveryChannel: 'PRINTED',
      },
    })
    await prisma.giftCardActivity.create({
      data: {
        giftCardId: sobre.id,
        venueId: n.venueId,
        type: 'ACTIVATE',
        amount: new Prisma.Decimal(500),
        balanceAfter: new Prisma.Decimal(500),
      },
    })

    await expect(deleteVenue(n.orgId, n.venueId)).rejects.toMatchObject({ statusCode: 409, message: MENSAJE })

    expect(await prisma.venue.count({ where: { id: n.venueId } })).toBe(1)
    expect(await prisma.product.count({ where: { id: n.productId } })).toBe(1)
    expect(await prisma.giftCard.count({ where: { id: sobre.id } })).toBe(1)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: sobre.id } })).toBe(1)
    // Sin limpieza: la libreta no se puede borrar (por eso existe esta negativa) y la base es desechable.
  })

  it('sin tarjetas, el negocio TRIAL se borra como hoy', async () => {
    const n = await negocioTrial('sin-tarjeta')

    await expect(deleteVenue(n.orgId, n.venueId)).resolves.toBeUndefined()

    expect(await prisma.venue.count({ where: { id: n.venueId } })).toBe(0)
    expect(await prisma.product.count({ where: { id: n.productId } })).toBe(0)
    await prisma.organization.deleteMany({ where: { id: n.orgId } })
  })
})

/**
 * Tarjetas de regalo × limpieza de demos (enmienda E2 del plan 1a, 14-oct). La libreta (`GiftCardActivity`) es de sólo
 * inserción por trigger y el sobre (`GiftCard`) apunta al venue con RESTRICT: sin la excepción, una demo que vendió tarjetas
 * revertiría la limpieza entera cada hora. Contra base real: la guardia del DMMF de la prueba unitaria no ve estas tablas.
 *
 * Correr (base desechable, receta del Step 3): npx jest --selectProjects=integration --runInBand --ci \
 *   --runTestsByPath tests/integration/cleanup/liveDemoCleanupTarjetas.integration.test.ts
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { deleteDisposableDemoSession } from '@/services/cleanup/liveDemoCleanup.service'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'

const llave = `e2-tarjetas-${randomUUID()}`
let demo: { orgId: string; venueId: string; staffId: string; sessionId: string; giftCardId: string; activityId: string }
let control: { orgId: string; venueId: string; giftCardId: string; activityId: string }

/** Un sobre ACTIVE con su ACTIVATE (los ids los pone Prisma: cuid). */
async function sobreConLibreta(venueId: string, organizationId: string): Promise<{ giftCardId: string; activityId: string }> {
  const c = generateGiftCardCode()
  const s = await prisma.giftCard.create({
    data: {
      venueId,
      organizationId,
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
  const a = await prisma.giftCardActivity.create({
    data: { giftCardId: s.id, venueId, type: 'ACTIVATE', amount: new Prisma.Decimal(500), balanceAfter: new Prisma.Decimal(500) },
  })
  return { giftCardId: s.id, activityId: a.id }
}

beforeAll(async () => {
  const orgDemo = await prisma.organization.create({
    data: { name: `${llave}-org-demo`, email: `${llave}-demo@example.test`, phone: '5500000000' },
  })
  const orgControl = await prisma.organization.create({
    data: { name: `${llave}-org-control`, email: `${llave}-control@example.test`, phone: '5500000000' },
  })
  const staff = await prisma.staff.create({ data: { email: `${llave}-staff@example.test`, firstName: 'Demo', lastName: 'Tarjetas' } })
  const venueDemo = await prisma.venue.create({
    data: { organizationId: orgDemo.id, name: 'Demo con tarjetas', slug: `${llave}-demo`, status: 'LIVE_DEMO' },
  })
  const venueControl = await prisma.venue.create({
    data: { organizationId: orgControl.id, name: 'Negocio real', slug: `${llave}-control` },
  })
  await prisma.giftCardSettings.create({ data: { venueId: venueDemo.id, enabled: true, suggestedAmounts: [500] } })
  const sesion = await prisma.liveDemoSession.create({
    data: { sessionId: `${llave}-cookie`, venueId: venueDemo.id, staffId: staff.id, expiresAt: new Date(Date.now() - 60 * 60 * 1000) },
  })
  demo = {
    orgId: orgDemo.id,
    venueId: venueDemo.id,
    staffId: staff.id,
    sessionId: sesion.id,
    ...(await sobreConLibreta(venueDemo.id, orgDemo.id)),
  }
  control = { orgId: orgControl.id, venueId: venueControl.id, ...(await sobreConLibreta(venueControl.id, orgControl.id)) }
})

// Sin afterAll que borre tarjetas: la libreta del control no se puede borrar (es justo lo que se prueba) y la base es desechable.

describe('E2 · la limpieza de una demo vencida que vendió tarjetas de regalo', () => {
  it('🔴 borra la demo entera: libreta, sobres, ajustes y venue', async () => {
    await expect(
      deleteDisposableDemoSession({ id: demo.sessionId, venueId: demo.venueId, staffId: demo.staffId }),
    ).resolves.toBeGreaterThan(0)

    expect(await prisma.venue.count({ where: { id: demo.venueId } })).toBe(0)
    expect(await prisma.giftCard.count({ where: { id: demo.giftCardId } })).toBe(0)
    expect(await prisma.giftCardActivity.count({ where: { id: demo.activityId } })).toBe(0)
    expect(await prisma.giftCardSettings.count({ where: { venueId: demo.venueId } })).toBe(0)
  })

  it('🔴 fuera de esa transacción, un DELETE suelto de la libreta sigue fallando (el negocio real queda intacto)', async () => {
    await expect(prisma.giftCardActivity.delete({ where: { id: control.activityId } })).rejects.toThrow(/sólo admite inserciones/)
    expect(await prisma.giftCard.count({ where: { id: control.giftCardId } })).toBe(1)
    expect(await prisma.giftCardActivity.count({ where: { id: control.activityId } })).toBe(1)
    expect(await prisma.venue.count({ where: { id: control.venueId } })).toBe(1)
  })
})

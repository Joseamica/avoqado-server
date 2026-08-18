import { DeliveryProvider, PaymentMethod } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ensureDeliveryTenderType } from '@/services/delivery-channels/core/deliveryTenderProvisioning.service'
import { normalizeTenderName } from '@/services/dashboard/tenderType.dashboard.service'

// Spec paso 6: al activar el canal, el tipo de pago del proveedor se crea SOLO.
// Sin él, el Payment queda en method=OTHER y se pierden comisión, forma SAT y
// clasificación de arqueo. Idempotente: si el dueño ya lo creó a mano, se reusa.
describe('auto-provisión del tender de delivery (durable)', () => {
  let venueId: string
  let orgId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org tender ${Date.now()}`, email: `t${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: { organizationId: orgId, name: `Venue tender ${Date.now()}`, slug: `vt-${Date.now()}` },
    })
    venueId = venue.id
  })

  afterAll(async () => {
    // Limpieza best-effort: un fallo aquí NUNCA debe enmascarar el resultado de
    // los tests (el venue arrastra Shift y otras filas creadas por el arranque).
    try {
      await prisma.venueTenderTypeRevision.deleteMany({ where: { venueId } })
      await prisma.venueTenderType.deleteMany({ where: { venueId } })
      await prisma.shift.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* fixtures de test: si algo queda, no invalida las aserciones */
    }
  })

  it('crea el tender del proveedor con defaults conservadores', async () => {
    const t = await ensureDeliveryTenderType(venueId, DeliveryProvider.UBER_EATS)
    expect(t.name).toBe('Uber Eats')
    expect(t.baseMethod).toBe(PaymentMethod.OTHER) // el schema lo exige para filas custom
    expect(t.countsAsPhysicalCash).toBe(false) // no entra al cajón
    expect(t.captureTip).toBe(false) // la propina la liquida la plataforma
    expect(t.commissionPercent).toBeNull() // decisión comercial del venue: NO se inventa
    expect(t.satFormaPago).toBeNull() // decisión fiscal del venue: NO se inventa
    expect(t.isSystem).toBe(false)
  })

  it('es IDEMPOTENTE: llamarlo otra vez devuelve el mismo, no duplica', async () => {
    const a = await ensureDeliveryTenderType(venueId, DeliveryProvider.UBER_EATS)
    const b = await ensureDeliveryTenderType(venueId, DeliveryProvider.UBER_EATS)
    expect(b.id).toBe(a.id)
    const n = await prisma.venueTenderType.count({ where: { venueId, normalizedName: normalizeTenderName('Uber Eats') } })
    expect(n).toBe(1)
  })

  it('respeta el que el DUEÑO ya creó a mano: lo reusa y NO lo pisa', async () => {
    const propio = await prisma.venueTenderType.create({
      data: {
        venueId,
        name: 'Rappi',
        normalizedName: normalizeTenderName('Rappi'),
        baseMethod: PaymentMethod.OTHER,
        isSystem: false,
        countsAsPhysicalCash: false,
        captureTip: true, // el dueño la quiere así
        commissionPercent: '28.5',
        satFormaPago: '03', // y ya la configuró
        revision: 1,
      },
    })
    const t = await ensureDeliveryTenderType(venueId, DeliveryProvider.RAPPI)
    expect(t.id).toBe(propio.id)
    expect(t.captureTip).toBe(true) // NO se pisó
    expect(t.commissionPercent?.toString()).toBe('28.5')
    expect(t.satFormaPago).toBe('03')
  })

  it('crea una revisión inicial (el snapshot que congela el cobro)', async () => {
    const t = await ensureDeliveryTenderType(venueId, DeliveryProvider.DIDI_FOOD)
    const rev = await prisma.venueTenderTypeRevision.findFirst({ where: { venueId, tenderTypeId: t.id, revision: t.revision } })
    expect(rev).not.toBeNull()
    expect(rev!.name).toBe('DiDi Food')
  })

  it('dos activaciones concurrentes ⇒ UN solo tender (la carrera la resuelve el unique)', async () => {
    const rs = await Promise.all([
      ensureDeliveryTenderType(venueId, DeliveryProvider.DELIVERECT),
      ensureDeliveryTenderType(venueId, DeliveryProvider.DELIVERECT),
      ensureDeliveryTenderType(venueId, DeliveryProvider.DELIVERECT),
    ])
    expect(new Set(rs.map(r => r.id)).size).toBe(1)
  })
})

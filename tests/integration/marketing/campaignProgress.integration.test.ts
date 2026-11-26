/**
 * D37 (25-nov-2026) — «Entregados» salía en 0 aunque los correos ya habían salido. Los números de la lista ahora salen de
 * contar los envíos de cada campaña con UN `groupBy`. Esta prueba fija, contra Postgres real, que ese conteo da lo mismo que
 * contar a mano, que no se cuelan envíos de la felicitación de cumpleaños (`campaignId` nulo) ni de otro negocio, y que el
 * estado avanza de «En cola» a «Enviando» a «Enviada».
 */
import '../../__helpers__/integration-setup'
import { CustomerCampaignDeliveryStatus as D, CustomerCampaignStatus as C } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { conAvanceReal } from '@/services/marketing/campaignProgress.service'

describe('avance real de las campañas de correo (integración)', () => {
  const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  let orgId: string | undefined
  let venueId: string | undefined
  let otroVenueId: string | undefined
  const campanas: Record<string, string> = {}

  async function envios(
    campaignId: string | null,
    estados: Partial<Record<D, number>>,
    opts: { venue?: string; automationId?: string } = {},
  ) {
    const venue = opts.venue ?? venueId!
    for (const [status, cuantos] of Object.entries(estados)) {
      for (let i = 0; i < (cuantos ?? 0); i++) {
        const cliente = await prisma.customer.create({ data: { venueId: venue, firstName: `c-${status}-${i}` } })
        await prisma.customerCampaignDelivery.create({
          data: {
            campaignId,
            automationId: opts.automationId ?? null,
            customerId: cliente.id,
            venueId: venue,
            dedupeKey: `${campaignId ?? opts.automationId}:${cliente.id}`,
            status: status as D,
          },
        })
      }
    }
  }

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: 'ITEST Campanas', email: `itest-camp-${sello}@test.com`, phone: '5550000000' } })
    ).id
    venueId = (await prisma.venue.create({ data: { name: `itest-camp-${sello}`, slug: `itest-camp-${sello}`, organizationId: orgId } })).id
    otroVenueId = (
      await prisma.venue.create({ data: { name: `itest-camp2-${sello}`, slug: `itest-camp2-${sello}`, organizationId: orgId } })
    ).id

    const campana = async (clave: string, status: C) => {
      campanas[clave] = (
        await prisma.customerCampaign.create({
          data: { venueId: venueId!, name: clave, subject: 'x', htmlBody: '<p>x</p>', textBody: 'x', status },
        })
      ).id
    }
    await campana('terminada', C.ENQUEUED)
    await campana('enCurso', C.ENQUEUED)
    await campana('enCola', C.ENQUEUED)
    await campana('cancelada', C.CANCELLED)
    await campana('borrador', C.DRAFT)

    await envios(campanas.terminada, { SENT: 5, FAILED: 1, DEAD: 1, SKIPPED: 2, UNKNOWN: 1 })
    await envios(campanas.enCurso, { SENT: 2, PENDING: 3, RETRYING: 1 })
    await envios(campanas.enCola, { PENDING: 4 })
    await envios(campanas.cancelada, { SENT: 1, SKIPPED: 3 })
    // 🔴 Lo que NO debe contar: un envío con el id de la campaña pero de OTRO negocio, y la felicitación de cumpleaños.
    await envios(campanas.terminada, { SENT: 7 }, { venue: otroVenueId })
    const cumple = await prisma.birthdayAutomation.create({ data: { venueId: venueId!, subject: 'x', htmlBody: 'x', textBody: 'x' } })
    await envios(null, { SENT: 9 }, { automationId: cumple.id })
  })

  afterAll(async () => {
    if (!orgId) return
    const venues = [venueId, otroVenueId].filter(Boolean) as string[]
    await prisma.customerCampaignDelivery.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.customerCampaign.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.birthdayAutomation.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.customer.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.venue.deleteMany({ where: { id: { in: venues } } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('cuenta igual que contar a mano y el estado avanza solo', async () => {
    const filas = await prisma.customerCampaign.findMany({
      where: { venueId },
      select: { id: true, name: true, status: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 20,
    })
    const porNombre = Object.fromEntries((await conAvanceReal(venueId!, filas)).map(c => [c.name, c]))

    expect(porNombre.terminada).toMatchObject({ status: C.SENT, sentCount: 5, failedCount: 2, skippedCount: 2 })
    expect(porNombre.enCurso).toMatchObject({ status: C.SENDING, sentCount: 2, failedCount: 0, skippedCount: 0 })
    expect(porNombre.enCola).toMatchObject({ status: C.ENQUEUED, sentCount: 0 })
    expect(porNombre.cancelada).toMatchObject({ status: C.CANCELLED, sentCount: 1, skippedCount: 3 })
    expect(porNombre.borrador).toMatchObject({ status: C.DRAFT, sentCount: 0, failedCount: 0, skippedCount: 0 })

    // Contar a mano, como referencia.
    const aMano = await prisma.customerCampaignDelivery.count({ where: { venueId, campaignId: campanas.terminada, status: D.SENT } })
    expect(porNombre.terminada.sentCount).toBe(aMano)
  })
})

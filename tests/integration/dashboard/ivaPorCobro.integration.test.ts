/** DINERO: lectura real de cargos, póliza balanceada, reintento y cierre; sólo DB de pruebas explícita. */
import prisma from '@/utils/prismaClient'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { sembrarCobro, limpiarVenue } from './sembrarCobroParaReembolso'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { closePeriod } from '@/services/fiscal/accountingPeriodLock.service'

jest.unmock('@/services/dashboard/activity-log.service')
jest.setTimeout(120000)

it('persiste IVA $16, conserva la póliza cerrada y rechaza otro posteo en ese periodo', async () => {
  const data = await setupTestData()
  const venueId = data.venue.id
  const organizationId = data.organization.id
  const staffId = data.staff[0].id
  const rfc = `ICO${Date.now().toString(36).toUpperCase().slice(-6)}XX0`
  try {
    await prisma.venue.update({ where: { id: venueId }, data: { rfc } })
    await prisma.payment.updateMany({ where: { venueId }, data: { type: 'TEST' } })
    await seedBaseChart(venueId, { staffId })
    await seedDefaultMappings(venueId, { staffId })
    const { order, pago, items } = await sembrarCobro({
      venueId,
      staffId,
      saleCents: 12760,
      items: [{ productId: data.products[0].id, productName: 'FULLTEST-IVA', quantity: 1, totalCents: 11600 }],
    })
    await prisma.orderServiceCharge.create({
      data: {
        orderId: order.id,
        name: 'FULLTEST-no gravable',
        type: 'FIXED_AMOUNT',
        value: 11.6,
        amount: 11.6,
        taxable: false,
      },
    })
    await prisma.order.update({ where: { id: order.id }, data: { serviceChargeAmount: 11.6 } })
    await prisma.payment.update({ where: { id: pago.id }, data: { method: 'CREDIT_CARD', createdAt: new Date('2026-06-15T18:00:00Z') } })
    expect(await generatePoliciesForVenue(venueId, { period: '2026-06', actorStaffId: staffId })).toMatchObject({ posted: 1 })
    const load = () =>
      prisma.journalEntry.findUniqueOrThrow({
        where: { organizationId_rfc_idempotencyKey: { organizationId, rfc, idempotencyKey: `pay:${pago.id}:v1` } },
        include: { lines: { orderBy: { id: 'asc' }, include: { ledgerAccount: true } } },
      })
    const before = await load()
    expect(before.totalDebitCents).toBe(12760)
    expect(before.totalCreditCents).toBe(12760)
    const taxAccount = await prisma.accountMapping.findFirstOrThrow({
      where: { organizationId, rfc, movementType: 'IVA_OUTPUT' },
      select: { ledgerAccountId: true },
    })
    expect(before.lines.find(l => l.ledgerAccountId === taxAccount.ledgerAccountId)?.creditCents).toBe(1600)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: before.id, action: 'JOURNAL_ENTRY_POSTED' } })).toBe(1)

    await closePeriod(venueId, '2026-06', { staffId }, 'FULLTEST-cierre')
    // Simula una lectura posterior con otro importe: la llave v1 ya posteada jamás se recalcula.
    await prisma.orderItem.update({ where: { id: items[0].id }, data: { total: 232 } })
    expect(await generatePoliciesForVenue(venueId, { period: '2026-06' })).toMatchObject({ posted: 0, alreadyPosted: 1 })
    expect(await load()).toEqual(before)

    await prisma.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: 116,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        type: 'REGULAR',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 116,
        processedById: staffId,
        createdAt: new Date('2026-06-16T18:00:00Z'),
      },
    })
    await expect(generatePoliciesForVenue(venueId, { period: '2026-06' })).rejects.toThrow(/cerrado/i)
    expect(await prisma.journalEntry.count({ where: { organizationId, rfc } })).toBe(1)
    expect(await load()).toEqual(before)
  } finally {
    await prisma.accountingPeriodLock.deleteMany({ where: { organizationId, rfc } })
    await prisma.journalEntry.deleteMany({ where: { organizationId, rfc } })
    await prisma.accountMapping.deleteMany({ where: { organizationId, rfc } })
    await prisma.ledgerAccount.deleteMany({ where: { organizationId, rfc } })
    await limpiarVenue(venueId)
    await teardownTestData()
  }
})

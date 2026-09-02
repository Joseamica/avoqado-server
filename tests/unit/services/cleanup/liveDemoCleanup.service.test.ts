/**
 * Live Demo Cleanup — cleanupExpiredLiveDemos / cleanupAllLiveDemos
 *
 * LiveDemoSession has onDelete: Cascade on venueId, so deleting the demo venue
 * (deleteVenueData) already removes the session row at the DB level. The
 * explicit session delete that follows must therefore be idempotent —
 * otherwise every cleanup throws P2025 ("No record was found for a delete"),
 * cleanedCount never increments and the cron logs a false error per session
 * (prod, 2026-07-03 03:00 UTC).
 */

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cleanupExpiredLiveDemos, cleanupAllLiveDemos } from '@/services/cleanup/liveDemoCleanup.service'
import { deleteOrRetainStaffWithH1ProvenanceTx } from '@/services/superadmin/staffDeletion.service'

jest.mock('@/services/superadmin/staffDeletion.service', () => ({
  deleteOrRetainStaffWithH1ProvenanceTx: jest.fn(),
  isH1ProvenanceConstraint: jest.fn().mockReturnValue(false),
}))

const prismaMock = prisma as any

function p2025(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('No record was found for a delete.', {
    code: 'P2025',
    clientVersion: '6.14.0',
  })
}

function makeSession(n = 1) {
  return {
    id: `lds-${n}`,
    sessionId: `session-uuid-${n}`,
    venueId: `venue-${n}`,
    staffId: `staff-${n}`,
    venue: { id: `venue-${n}`, name: `Live Demo ${n}`, status: 'LIVE_DEMO' },
    staff: { id: `staff-${n}`, email: `demo${n}@avoqado.io` },
  }
}

/**
 * Mocks the DB exactly as prod behaves after deleteVenueData ran:
 * the venue cascade already removed the LiveDemoSession row, so an exact
 * .delete() throws P2025 while .deleteMany() resolves with count 0.
 */
function mockCascadeAlreadyDeletedSession(status = 'LIVE_DEMO') {
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'venue-1', status, name: 'Live Demo 1' }])
  prismaMock.venue.findUnique.mockResolvedValue({ status, name: 'Live Demo 1' })
  prismaMock.venue.delete.mockResolvedValue({})
  prismaMock.staff.delete.mockResolvedValue({})
  ;(deleteOrRetainStaffWithH1ProvenanceTx as jest.Mock).mockResolvedValue({ staff: { email: 'demo@avoqado.io' }, retainedForAudit: false })
  prismaMock.liveDemoSession.delete.mockRejectedValue(p2025())
  prismaMock.liveDemoSession.deleteMany.mockResolvedValue({ count: 0 })
}

describe('cleanupExpiredLiveDemos — cascade-tolerant session delete', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('counts a session as cleaned even though the venue cascade already deleted the session row', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.venue.delete).toHaveBeenCalledWith({ where: { id: 'venue-1' } })
    expect(deleteOrRetainStaffWithH1ProvenanceTx).toHaveBeenCalledWith(prismaMock, 'staff-1')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    // Idempotent delete: tolerates the row being gone (cascade), never throws P2025
    expect(prismaMock.liveDemoSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'lds-1' } })
  })

  it('cleans the remaining sessions when one of them fails', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1), makeSession(2)])
    mockCascadeAlreadyDeletedSession()
    ;(deleteOrRetainStaffWithH1ProvenanceTx as jest.Mock)
      .mockRejectedValueOnce(new Error('transient DB error'))
      .mockResolvedValueOnce({ staff: { email: 'demo@avoqado.io' }, retainedForAudit: false })

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.venue.delete).toHaveBeenCalledTimes(1)
  })

  // REGRESSION: pre-existing behavior that must not change
  it('still returns 0 and deletes nothing when there are no expired sessions', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([])

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(0)
    expect(prismaMock.venue.delete).not.toHaveBeenCalled()
    expect(prismaMock.staff.delete).not.toHaveBeenCalled()
  })

  it('still refuses to delete a non-LIVE_DEMO venue and does not count the session', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession('ACTIVE')

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(0)
    expect(prismaMock.venue.delete).not.toHaveBeenCalled()
    expect(prismaMock.staff.delete).not.toHaveBeenCalled()
  })

  it('fails closed before venue deletion when demo Staff has immutable H1 provenance', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()
    ;(deleteOrRetainStaffWithH1ProvenanceTx as jest.Mock).mockResolvedValue({
      staff: { email: 'demo@avoqado.io' },
      retainedForAudit: true,
    })

    await expect(cleanupExpiredLiveDemos()).resolves.toBe(0)

    expect(prismaMock.venue.delete).not.toHaveBeenCalled()
    expect(prismaMock.liveDemoSession.deleteMany).not.toHaveBeenCalled()
  })
})

describe('cleanupExpiredLiveDemos — merchant account cleanup (no orphaned demo accounts)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('deletes the Stripe + Blumon demo MerchantAccounts referenced by the venue payment config', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()
    prismaMock.venuePaymentConfig.findUnique.mockResolvedValue({
      venueId: 'venue-1',
      primaryAccountId: 'merchant-blumon-1',
      secondaryAccountId: 'merchant-stripe-1',
      tertiaryAccountId: null,
    })
    prismaMock.merchantAccount.deleteMany.mockResolvedValue({ count: 2 })

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.venuePaymentConfig.findUnique).toHaveBeenCalledWith({ where: { venueId: 'venue-1' } })
    expect(prismaMock.merchantAccount.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['merchant-blumon-1', 'merchant-stripe-1'] } },
    })
  })

  it('does not call merchantAccount.deleteMany when the venue has no payment config', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()
    prismaMock.venuePaymentConfig.findUnique.mockResolvedValue(null)

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.merchantAccount.deleteMany).not.toHaveBeenCalled()
  })
})

describe('cleanupAllLiveDemos — cascade-tolerant session delete', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('counts a session as cleaned even though the venue cascade already deleted the session row', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    const cleaned = await cleanupAllLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.liveDemoSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'lds-1' } })
  })
})

/**
 * 🔴 Los productos se borran AL FINAL, después de todo lo que los referencia.
 *
 * Siete claves foráneas con RESTRICT / NO ACTION cuelgan de `Product`
 * (CreditPackItem, CreditItemBalance, PromotionOption, PurchaseOrderItem y las tres de
 * catálogo), y basta UNA para tumbar la transacción entera. Pasó en vivo: el job falló cada
 * hora durante días con `CreditPackItem_productId_fkey` y **ninguna demo se limpió** — cada
 * pasada reportaba «Cleaned 0 sessions» junto a un error que nadie leía.
 *
 * Esta prueba fija el ORDEN, no la existencia de las llamadas: quitar cualquiera de los
 * borradores previos, o moverlo después de los productos, la hace fallar.
 */
describe('deleteVenueData — nada que apunte a un producto sobrevive a su borrado', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  /** Los modelos que BLOQUEAN `product.deleteMany` si quedan filas. */
  const BLOQUEADORES = [
    'creditTransaction',
    'creditItemBalance',
    'creditPackPurchase',
    'creditPack',
    'orderPromotion',
    'promotion',
    'purchaseOrder',
    'catalogPublicationFieldDecision',
    'catalogPublicationLine',
    'catalogVenueOverride',
    'catalogVenueBinding',
    'catalogBindingLine',
  ] as const

  it.each(BLOQUEADORES)('borra %s ANTES que los productos', async modelo => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    await cleanupExpiredLiveDemos()

    const bloqueador = prismaMock[modelo].deleteMany
    expect(bloqueador).toHaveBeenCalled()
    // `invocationCallOrder` es un contador global de jest: comparar los dos primeros ticks
    // demuestra el orden real, no que ambas llamadas existan.
    expect(bloqueador.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.product.deleteMany.mock.invocationCallOrder[0])
  })

  it('🔴 el saldo de crédito se busca por las DOS vías: su producto y su paquete', () => {
    // Alcanzarlo sólo por una deja filas vivas que vuelven a bloquear el borrado.
    // (Se comprueba sobre el argumento, porque el mock no evalúa el `where`.)
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    return cleanupExpiredLiveDemos().then(() => {
      const where = prismaMock.creditItemBalance.deleteMany.mock.calls[0][0].where
      expect(where.OR).toHaveLength(2)
      expect(JSON.stringify(where.OR)).toContain('venueId')
    })
  })
})

describe('P3-1A1c-c live demo webhook evidence preservation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('deletes only unbound WebhookEvent rows and reports every preserved evidence source', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()
    prismaMock.webhookEvent.count.mockResolvedValue(3)
    prismaMock.webhookEvent.deleteMany.mockResolvedValue({ count: 2 })

    await expect(cleanupExpiredLiveDemos()).resolves.toBe(1)

    const evidenceFreeWhere = {
      venueId: 'venue-1',
      stripeObjectBindings: { none: {} },
      dispatchObservations: { none: {} },
      operationalAlerts: { none: {} },
      manualRetryResultOutboxes: { none: {} },
    }
    expect(prismaMock.webhookEvent.count).toHaveBeenCalledWith({
      where: {
        venueId: 'venue-1',
        OR: [
          { stripeObjectBindings: { some: {} } },
          { dispatchObservations: { some: {} } },
          { operationalAlerts: { some: {} } },
          { manualRetryResultOutboxes: { some: {} } },
        ],
      },
    })
    expect(prismaMock.webhookEvent.deleteMany).toHaveBeenCalledWith({ where: evidenceFreeWhere })
    expect(prismaMock.stripeObjectBinding.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.webhookDispatchObservation.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.webhookDispatchObservation.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.webhookOperationalAlert.deleteMany).not.toHaveBeenCalled()
  })
})

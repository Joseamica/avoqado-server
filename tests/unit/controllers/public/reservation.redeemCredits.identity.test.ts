import { redeemCreditsForReservation } from '@/controllers/public/reservation.public.controller'

/**
 * Fase 0.B — los créditos se canjean SÓLO de la cuenta que habla.
 *
 * Antes (reservation.public.controller.ts:2482) el canje buscaba al customer por el
 * `guestEmail/guestPhone` del body. Con sesión, un email ajeno en el body podía gastar
 * créditos de otra cuenta (si además se conocía un balanceId suyo). Ahora, con
 * `customerId` de sesión, el email/teléfono se ignoran para resolver al dueño.
 */
function mkTx(opts: { customerByContact?: any; customerById?: any; purchaseCustomerId: string }) {
  const tx: any = {
    customer: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.id) return opts.customerById ?? null
        return opts.customerByContact ?? null
      }),
    },
    $queryRaw: jest.fn(async () => [{ id: 'bal-1', remainingQuantity: 5, creditPackPurchaseId: 'pur-1', productId: 'prod-1' }]),
    creditPackPurchase: {
      findUnique: jest.fn(async () => ({ status: 'ACTIVE', expiresAt: null, customerId: opts.purchaseCustomerId })),
      update: jest.fn(async () => ({})),
    },
    creditItemBalance: {
      update: jest.fn(async () => ({})),
      findFirst: jest.fn(async () => ({ id: 'bal-2', remainingQuantity: 4 })), // queda saldo: no se cierra la compra
    },
    creditTransaction: { create: jest.fn(async () => ({})) },
    reservation: { update: jest.fn(async () => ({})) },
  }
  return tx
}

const base = {
  venueId: 'v1',
  reservationId: 'res-1',
  confirmationCode: 'RES-ABC123',
  balanceIds: ['bal-1'],
  creditsPerBalance: 1,
  expectedProductIds: ['prod-1'],
}

describe('redeemCreditsForReservation — identidad', () => {
  it('con customerId de sesión: resuelve por id, IGNORA customerEmail del body', async () => {
    const tx = mkTx({
      customerById: { id: 'c_sesion', venueId: 'v1' },
      customerByContact: { id: 'c_ajeno', venueId: 'v1' },
      purchaseCustomerId: 'c_sesion',
    })

    const r = await redeemCreditsForReservation(tx, { ...base, customerId: 'c_sesion', customerEmail: 'ajeno@x.com' })

    expect(r.redeemed).toBe(true)
    expect(tx.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'c_sesion', venueId: 'v1' }) }),
    )
    // nunca buscó por el email del body
    const contactLookups = tx.customer.findFirst.mock.calls.filter((c: any) => c[0].where.OR)
    expect(contactLookups).toHaveLength(0)
  })

  it('🔴 regresión: con sesión, un balance de OTRA cuenta no se canjea aunque el email del body sea el del dueño', async () => {
    const tx = mkTx({
      customerById: { id: 'c_sesion', venueId: 'v1' },
      customerByContact: { id: 'c_dueno', venueId: 'v1' },
      purchaseCustomerId: 'c_dueno', // la compra es del dueño, no de la sesión
    })

    await expect(redeemCreditsForReservation(tx, { ...base, customerId: 'c_sesion', customerEmail: 'dueno@x.com' })).rejects.toThrow(
      /no valido para este cliente/i,
    )
    expect(tx.creditItemBalance.update).not.toHaveBeenCalled()
  })

  it('sin sesión (invitado): sigue resolviendo por email/teléfono como hoy', async () => {
    const tx = mkTx({ customerByContact: { id: 'c_inv', venueId: 'v1' }, purchaseCustomerId: 'c_inv' })

    const r = await redeemCreditsForReservation(tx, { ...base, customerEmail: 'inv@x.com' })

    expect(r.redeemed).toBe(true)
    expect(tx.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }),
    )
  })
})

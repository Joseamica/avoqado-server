/**
 * D649 · subida durable (Codex r3): si la sesión de vales estaba tomada al reabrir el saldo, el reembolso encola en SU transacción
 * un `SUBIR_VERSION_DE_VALES`. El trabajador de siempre lo corre: sube la versión de la sesión SIN tomar la cuenta (la jerarquía
 * es sesión → vales → cuenta), con la espera del candado acotada; una sesión OPEN, pagada o cancelada no se toca y el efecto termina
 * igual. Una falla de la base lanza: el trabajador lo reintenta hasta DEAD_LETTER.
 */
import { runClaimedPaymentEffect, type PaymentEffectClaim } from '@/services/tpv/paymentEffects.service'

const claim = (payload: object = { sessionId: 'ses-1' }): PaymentEffectClaim =>
  ({
    id: 'e1',
    venueId: 'v1',
    paymentId: 'refund-1',
    orderId: 'o1',
    kind: 'SUBIR_VERSION_DE_VALES',
    payload,
    dedupeKey: 'vales-version:refund-1:v1',
    claimToken: 'token1',
    leaseUntil: new Date(Date.now() + 120000),
    attempts: 1,
  }) as unknown as PaymentEffectClaim

function consumer(c: PaymentEffectClaim, cuenta: { count: number }[] = [{ count: 1 }]) {
  const row = { ...c, status: 'PROCESSING', lastError: null }
  const updateManySesion = jest.fn()
  for (const r of cuenta) updateManySesion.mockResolvedValueOnce(r)
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    areaTicketCheckoutSession: { updateMany: updateManySesion },
  }
  const db = {
    paymentEffect: {
      findFirst: jest.fn(async (a: any) =>
        a.where.claimToken === row.claimToken && a.where.status === row.status && (!a.where.kind || a.where.kind.in.includes(row.kind))
          ? row
          : null,
      ),
      updateMany: jest.fn(async (a: any) => {
        if (a.where.claimToken !== row.claimToken || a.where.status !== row.status) return { count: 0 }
        Object.assign(row, a.data)
        return { count: 1 }
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  }
  return { db, tx, row }
}

describe('SUBIR_VERSION_DE_VALES (D649 · subida durable)', () => {
  it('🔴 sube la versión de la sesión del efecto, sin tomar la cuenta y con la espera acotada, y termina como hecho', async () => {
    const { db, tx, row } = consumer(claim())

    expect(await runClaimedPaymentEffect(claim(), db as any)).toBe(true)

    expect(tx.areaTicketCheckoutSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'ses-1', venueId: 'v1', status: { in: ['PARTIALLY_PAID', 'PAYMENT_PENDING', 'RECONCILIATION_REQUIRED'] } },
      data: { version: { increment: 1 } },
    })
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringMatching(/SET LOCAL lock_timeout/))
    // Ni el candado de la cuenta ni ningún otro SQL: sesión → vales → cuenta.
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(row.status).toBe('DONE')
  })

  it('la sesión seguía MATERIALIZED: la pasa a PARTIALLY_PAID con su versión', async () => {
    const { db, tx } = consumer(claim(), [{ count: 0 }, { count: 1 }])

    expect(await runClaimedPaymentEffect(claim(), db as any)).toBe(true)

    expect(tx.areaTicketCheckoutSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'ses-1', venueId: 'v1', status: 'MATERIALIZED' },
      data: { version: { increment: 1 }, status: 'PARTIALLY_PAID' },
    })
  })

  it('la sesión ya está OPEN, pagada o cancelada: no toca nada y el efecto termina como hecho', async () => {
    const { db, tx, row } = consumer(claim(), [{ count: 0 }, { count: 0 }])

    expect(await runClaimedPaymentEffect(claim(), db as any)).toBe(true)

    expect(tx.areaTicketCheckoutSession.updateMany).toHaveBeenCalledTimes(2)
    expect(row.status).toBe('DONE')
  })

  it('una falla de la base (o el candado vencido) lanza: el trabajador lo reintenta y el efecto no queda hecho', async () => {
    const { db, tx, row } = consumer(claim(), [])
    tx.areaTicketCheckoutSession.updateMany.mockRejectedValueOnce(Object.assign(new Error('lock timeout'), { code: '55P03' }))

    await expect(runClaimedPaymentEffect(claim(), db as any)).rejects.toThrow('lock timeout')

    expect(row.status).toBe('PROCESSING')
  })

  it('un efecto sin sesión en su carga lanza en vez de terminar sin hacer nada', async () => {
    const c = claim({})
    const { db, tx } = consumer(c)

    await expect(runClaimedPaymentEffect(c, db as any)).rejects.toThrow('VALES_SESSION_REQUIRED')
    expect(tx.areaTicketCheckoutSession.updateMany).not.toHaveBeenCalled()
  })
})

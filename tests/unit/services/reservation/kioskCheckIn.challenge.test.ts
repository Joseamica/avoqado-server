import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

/**
 * Fase 5 · el reto de check-in ("no aparezco en la lista" / QR en la cara del cliente).
 *
 * La lista de nombres del kiosco resuelve el caso normal. Este carril resuelve los dos que
 * quedan fuera: quien NO aparece en la lista, y quien prefiere no tocar una pantalla
 * compartida. El aparato enseña un QR; la persona lo abre en SU teléfono, con SU sesión.
 *
 * 🔴 Lo que se protege aquí es la identidad de OTRO cliente. Un reto que se pueda adivinar,
 * reclamar dos veces por personas distintas, o que conteste distinto cuando el secreto es
 * casi correcto, convierte el kiosco en una forma de hacer check-in como alguien más.
 */
describe('Fase 5 · reto de check-in del kiosco', () => {
  const now = new Date('2026-08-24T18:00:00Z')
  const future = new Date('2026-08-24T18:05:00Z')

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  })

  describe('crearlo', () => {
    it('🔴 guarda el HASH del secreto, nunca el secreto', async () => {
      prismaMock.kioskCheckInChallenge.updateMany.mockResolvedValue({ count: 0 } as any)
      prismaMock.kioskCheckInChallenge.create.mockImplementation((async (a: any) => ({ id: 'ch-1', ...a.data })) as any)

      const { createKioskCheckInChallenge } = await import('@/services/reservation/kioskCheckIn.service')
      const out = await createKioskCheckInChallenge({
        venueId: 'venue-1',
        terminalId: 'term-1',
        stationKey: 'B',
        kioskSessionId: 'sess-1',
        now,
      })

      const written = prismaMock.kioskCheckInChallenge.create.mock.calls[0][0].data
      expect(out.secret).toEqual(expect.any(String))
      expect(out.secret.length).toBeGreaterThanOrEqual(32)
      expect(JSON.stringify(written)).not.toContain(out.secret)
      expect(written.nonceHash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('🔴 mata el reto anterior de esa cara: un solo QR vivo a la vez', async () => {
      prismaMock.kioskCheckInChallenge.updateMany.mockResolvedValue({ count: 1 } as any)
      prismaMock.kioskCheckInChallenge.create.mockImplementation((async (a: any) => ({ id: 'ch-2', ...a.data })) as any)

      const { createKioskCheckInChallenge } = await import('@/services/reservation/kioskCheckIn.service')
      await createKioskCheckInChallenge({ venueId: 'venue-1', terminalId: 'term-1', stationKey: 'B', kioskSessionId: 'sess-1', now })

      expect(prismaMock.kioskCheckInChallenge.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ terminalId: 'term-1', stationKey: 'B', status: 'PENDING' }) }),
      )
    })
  })

  describe('lo que ve el aparato mientras espera', () => {
    it('🔴 el sondeo NO devuelve NADA de la persona', async () => {
      prismaMock.kioskCheckInChallenge.findFirst.mockResolvedValue({
        id: 'ch-1',
        venueId: 'venue-1',
        status: 'CONSUMED',
        expiresAt: future,
        customerId: 'cust-1',
        reservationId: 'res-1',
        nonceHash: 'x'.repeat(64),
      } as any)

      const { getKioskCheckInChallengeStatus } = await import('@/services/reservation/kioskCheckIn.service')
      const out = await getKioskCheckInChallengeStatus({ venueId: 'venue-1', challengeId: 'ch-1', now })

      const body = JSON.stringify(out)
      expect(body).not.toContain('cust-1')
      expect(body).not.toContain('res-1')
      expect(body).not.toContain('nonceHash')
      expect(out.status).toBe('CONSUMED')
    })
  })

  describe('consumirlo', () => {
    const challenge = {
      id: 'ch-1',
      venueId: 'venue-1',
      status: 'PENDING',
      expiresAt: future,
      attempts: 0,
      maxAttempts: 5,
      customerId: null,
      reservationId: null,
      stationKey: 'B',
    }

    it('🔴 un secreto equivocado responde 404 GENÉRICO — nunca "casi"', async () => {
      prismaMock.kioskCheckInChallenge.findFirst.mockResolvedValue(null as any)
      prismaMock.kioskCheckInChallenge.updateMany.mockResolvedValue({ count: 1 } as any)

      const { consumeKioskCheckInChallenge } = await import('@/services/reservation/kioskCheckIn.service')
      await expect(
        consumeKioskCheckInChallenge({ venueId: 'venue-1', challengeId: 'ch-1', secret: 'no-es', customerId: 'cust-1', now }),
      ).rejects.toMatchObject({ statusCode: 404, code: 'CHECK_IN_NOT_FOUND' })
    })

    it('🔴 vencido responde 410, no 404: hay que poder decir "pide otro QR"', async () => {
      prismaMock.kioskCheckInChallenge.findFirst.mockResolvedValue({
        ...challenge,
        expiresAt: new Date('2026-08-24T17:59:00Z'),
      } as any)

      const { consumeKioskCheckInChallenge, __hashSecretForTest } = await import('@/services/reservation/kioskCheckIn.service')
      await expect(
        consumeKioskCheckInChallenge({ venueId: 'venue-1', challengeId: 'ch-1', secret: 'abc', customerId: 'cust-1', now }),
      ).rejects.toMatchObject({ statusCode: 410, code: 'CHECK_IN_CHALLENGE_EXPIRED' })
      expect(typeof __hashSecretForTest).toBe('function')
    })

    it('🔴 otra persona NO puede reclamar un reto ya consumido', async () => {
      prismaMock.kioskCheckInChallenge.findFirst.mockResolvedValue({
        ...challenge,
        status: 'CONSUMED',
        customerId: 'cust-1',
        reservationId: 'res-1',
      } as any)

      const { consumeKioskCheckInChallenge } = await import('@/services/reservation/kioskCheckIn.service')
      await expect(
        consumeKioskCheckInChallenge({ venueId: 'venue-1', challengeId: 'ch-1', secret: 'abc', customerId: 'OTRA', now }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CHECK_IN_ALREADY_CLAIMED' })
    })

    it('🔴 la MISMA persona repitiendo obtiene el mismo resultado, no un error', async () => {
      prismaMock.kioskCheckInChallenge.findFirst.mockResolvedValue({
        ...challenge,
        status: 'CONSUMED',
        customerId: 'cust-1',
        reservationId: 'res-1',
      } as any)
      prismaMock.reservation.findFirst.mockResolvedValue({ id: 'res-1', status: 'CHECKED_IN' } as any)

      const { consumeKioskCheckInChallenge } = await import('@/services/reservation/kioskCheckIn.service')
      const out = await consumeKioskCheckInChallenge({
        venueId: 'venue-1',
        challengeId: 'ch-1',
        secret: 'abc',
        customerId: 'cust-1',
        now,
      })
      expect(out.outcome).toBe('ALREADY_CHECKED_IN')
    })
  })

  describe('límite de intentos DURABLE', () => {
    it('🔴 el conteo vive en la BASE, no en memoria del proceso', async () => {
      prismaMock.kioskCheckInAttempt.upsert.mockResolvedValue({ count: 3 } as any)

      const { consumeDurableAttempt } = await import('@/services/reservation/kioskCheckIn.service')
      const out = await consumeDurableAttempt({ venueId: 'venue-1', scope: 'ip:1.2.3.4', now, max: 10 })

      expect(prismaMock.kioskCheckInAttempt.upsert).toHaveBeenCalled()
      expect(out.blocked).toBe(false)
      expect(out.count).toBe(3)
    })

    it('🔴 pasado el tope, bloquea con 429', async () => {
      prismaMock.kioskCheckInAttempt.upsert.mockResolvedValue({ count: 11 } as any)

      const { assertDurableRateLimit } = await import('@/services/reservation/kioskCheckIn.service')
      await expect(assertDurableRateLimit({ venueId: 'venue-1', scope: 'ip:1.2.3.4', now, max: 10 })).rejects.toMatchObject({
        statusCode: 429,
      })
    })
  })
})

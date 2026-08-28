import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))
const sendEmail = jest.fn().mockResolvedValue(true)
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmail: (...a: any[]) => sendEmail(...a) } }))

/**
 * Fase 9 · el aviso nocturno.
 *
 * Esto le escribe a clientes reales con el nombre del negocio. Un mensaje enviado no se
 * puede desenviar, así que los candados no son "validación": son la diferencia entre un
 * recordatorio útil y spam mandado en nombre de alguien que no lo pidió.
 */
describe('Fase 9 · candados del aviso nocturno', () => {
  const now = new Date('2026-08-24T06:00:00Z')

  beforeEach(() => {
    jest.clearAllMocks()
    sendEmail.mockResolvedValue(true)
    prismaMock.kioskOutreachOutbox.create.mockResolvedValue({ id: 'ob-1' } as any)
    prismaMock.kioskOutreachOutbox.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.kioskOutreachOutbox.update.mockResolvedValue({} as any)
    prismaMock.$queryRaw.mockResolvedValue([] as any)
  })

  it('🔴 el negocio que NO lo prendió no manda nada', async () => {
    prismaMock.venue.findMany.mockResolvedValue([] as any) // el filtro los deja fuera

    const { enqueueNightlyOutreach } = await import('@/services/reservation/kioskOutreach.service')
    const out = await enqueueNightlyOutreach({ now })

    expect(out.enqueued).toBe(0)
    expect(prismaMock.venue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ reservationSettings: { nightlyOutreachEnabled: true } }),
      }),
    )
  })

  it('🔴 el consentimiento se filtra en la CONSULTA, no en un if que se pueda saltar', async () => {
    prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-1', slug: 'mindform' }] as any)
    prismaMock.creditPackPurchase.findMany.mockResolvedValue([] as any)

    const { enqueueNightlyOutreach } = await import('@/services/reservation/kioskOutreach.service')
    await enqueueNightlyOutreach({ now })

    expect(prismaMock.creditPackPurchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customer: { marketingConsent: true } }),
      }),
    )
  })

  it('🔴 quien se dio de baja ENTRE el barrido y el envío ya no recibe', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'ob-1' }] as any)
    prismaMock.kioskOutreachOutbox.findMany.mockResolvedValue([
      {
        id: 'ob-1',
        dedupeKey: 'CREDITS_RUNNING_OUT:cust-1:2026-08-24',
        attempts: 1,
        event: 'CREDITS_RUNNING_OUT',
        paymentLinkUrl: 'https://x',
        payload: {},
        venue: { name: 'Mindform' },
        customer: { email: 'a@b.com', firstName: 'Ana', marketingConsent: false },
      },
    ] as any)

    const { sweepOnce } = await import('@/services/reservation/kioskOutreach.service')
    const out = await sweepOnce({ now })

    expect(sendEmail).not.toHaveBeenCalled()
    expect(out.sent).toBe(0)
    expect(prismaMock.kioskOutreachOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SKIPPED', lastError: 'MARKETING_CONSENT_REVOKED' }) }),
    )
  })

  it('🔴 con consentimiento vivo sí sale, y lleva el enlace para renovar', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'ob-2' }] as any)
    prismaMock.kioskOutreachOutbox.findMany.mockResolvedValue([
      {
        id: 'ob-2',
        dedupeKey: 'PACK_EXPIRING:cust-1:2026-08-24',
        attempts: 1,
        event: 'PACK_EXPIRING',
        paymentLinkUrl: 'https://book.avoqado.io/mindform?packs=1',
        payload: { packName: '10 clases' },
        venue: { name: 'Mindform' },
        customer: { email: 'a@b.com', firstName: 'Ana', marketingConsent: true },
      },
    ] as any)

    const { sweepOnce } = await import('@/services/reservation/kioskOutreach.service')
    const out = await sweepOnce({ now })

    expect(out.sent).toBe(1)
    const mail = sendEmail.mock.calls[0][0]
    expect(mail.to).toBe('a@b.com')
    expect(mail.html).toContain('https://book.avoqado.io/mindform?packs=1')
    expect(mail.idempotencyKey).toBe('PACK_EXPIRING:cust-1:2026-08-24')
  })

  it('reclama PENDING y FAILED de forma atómica con SKIP LOCKED', async () => {
    const { sweepOnce } = await import('@/services/reservation/kioskOutreach.service')

    await sweepOnce({ now })

    expect(prismaMock.kioskOutreachOutbox.updateMany).not.toHaveBeenCalled()
    const query = prismaMock.$queryRaw.mock.calls[0][0] as any
    const sql = (query.strings ?? []).join('?')
    expect(sql).toMatch(/status IN \('PENDING', 'FAILED'\)/)
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/)
    expect(sql).toMatch(/UPDATE "KioskOutreachOutbox"/)
  })

  it('vuelve a intentar una fila FAILED y conserva idempotencia ante un crash después del envío', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'ob-failed' }] as any)
    prismaMock.kioskOutreachOutbox.findMany.mockResolvedValue([
      {
        id: 'ob-failed',
        dedupeKey: 'CREDITS_RUNNING_OUT:cust-1:2026-08-24',
        attempts: 2,
        event: 'CREDITS_RUNNING_OUT',
        paymentLinkUrl: 'https://book.avoqado.io/mindform?packs=1',
        payload: { packName: '10 clases' },
        venue: { name: 'Mindform' },
        customer: { email: 'a@b.com', firstName: 'Ana', marketingConsent: true },
      },
    ] as any)

    const { sweepOnce } = await import('@/services/reservation/kioskOutreach.service')
    const out = await sweepOnce({ now })

    expect(out.sent).toBe(1)
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'CREDITS_RUNNING_OUT:cust-1:2026-08-24' }))
    expect(prismaMock.kioskOutreachOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'ob-failed', attempts: 2, leasedUntil: expect.any(Date) }),
        data: expect.objectContaining({ status: 'SENT' }),
      }),
    )
  })
})

/**
 * El tender de sistema «Crédito de cambio» (spec `docs/superpowers/specs/2026-10-20-cambio-de-producto-design.md` §6.2): uno por
 * negocio, oculto en el POS, forma SAT 17 (Compensación), que no entra al cajón y que sólo escribe la operación de Cambio. Ni la
 * cajera lo elige como medio de cobro (`resolveTenderForCharge`) ni el negocio lo edita o lo apaga (`updateTenderType`).
 */
import {
  EXCHANGE_CREDIT_TENDER_NAME,
  ensureExchangeCreditTender,
  resolveExchangeCreditTenderInTx,
} from '@/services/exchanges/exchangeCreditTender'
import { resolveTenderForCharge, updateTenderType } from '@/services/dashboard/tenderType.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

const VENUE = 'venue-1'
const STAFF = 'staff-1'

describe('exchangeCreditTender — the «Crédito de cambio» system tender', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venueTenderType.findFirst.mockReset()
    prismaMock.venueTenderType.create.mockReset()
    prismaMock.venueTenderType.updateMany.mockReset()
    prismaMock.venueTenderTypeRevision.findFirst.mockReset()
  })

  it('ensureExchangeCreditTender creates once with satFormaPago 17 and revision 1, and returns the same row on the second call', async () => {
    // Primera llamada: no existe y el nombre está libre ⇒ lo crea.
    prismaMock.venueTenderType.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    prismaMock.venueTenderType.create.mockResolvedValue({ id: 'tt-ec', revision: 1 })

    await expect(ensureExchangeCreditTender(prismaMock, VENUE)).resolves.toEqual({ id: 'tt-ec', revision: 1 })
    expect(prismaMock.venueTenderType.findFirst).toHaveBeenNthCalledWith(1, {
      where: { venueId: VENUE, systemKind: 'EXCHANGE_CREDIT' },
      select: { id: true, revision: true },
    })
    const data = prismaMock.venueTenderType.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      venueId: VENUE,
      name: EXCHANGE_CREDIT_TENDER_NAME,
      normalizedName: 'credito de cambio',
      baseMethod: 'OTHER',
      isSystem: true,
      systemKind: 'EXCHANGE_CREDIT',
      countsAsPhysicalCash: false,
      captureTip: false,
      showOnPos: false,
      posSection: 'MORE',
      displayOrder: 99,
      satFormaPago: '17',
      revision: 1,
    })
    expect(data.commissionPercent ?? null).toBeNull()
    // La revisión 1 nace en la MISMA escritura (nested create), con la misma semántica de dinero.
    expect(data.revisions.create).toEqual({
      revision: 1,
      name: 'Crédito de cambio',
      countsAsPhysicalCash: false,
      captureTip: false,
      commissionPercent: null,
      satFormaPago: '17',
      createdBy: null,
    })

    // Segunda llamada: ya existe ⇒ la misma fila, sin crear otra.
    prismaMock.venueTenderType.findFirst.mockResolvedValueOnce({ id: 'tt-ec', revision: 1 })
    await expect(ensureExchangeCreditTender(prismaMock, VENUE)).resolves.toEqual({ id: 'tt-ec', revision: 1 })
    expect(prismaMock.venueTenderType.create).toHaveBeenCalledTimes(1)
  })

  it('ensureExchangeCreditTender uses the alternate name when «Crédito de cambio» is taken', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'tt-own' })
    prismaMock.venueTenderType.create.mockResolvedValue({ id: 'tt-ec', revision: 1 })

    await ensureExchangeCreditTender(prismaMock, VENUE)
    expect(prismaMock.venueTenderType.findFirst).toHaveBeenNthCalledWith(2, {
      where: { venueId: VENUE, normalizedName: 'credito de cambio' },
      select: { id: true },
    })
    const data = prismaMock.venueTenderType.create.mock.calls[0][0].data
    expect(data).toMatchObject({ name: 'Crédito de cambio (Avoqado)', normalizedName: 'credito de cambio (avoqado)' })
    expect(data.revisions.create).toMatchObject({ name: 'Crédito de cambio (Avoqado)' })
  })

  it('ensureExchangeCreditTender returns the winner when a concurrent creation hits P2002, and rethrows anything else', async () => {
    prismaMock.venueTenderType.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'tt-winner', revision: 1 })
    prismaMock.venueTenderType.create.mockRejectedValueOnce({ code: 'P2002' })
    await expect(ensureExchangeCreditTender(prismaMock, VENUE)).resolves.toEqual({ id: 'tt-winner', revision: 1 })

    prismaMock.venueTenderType.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    prismaMock.venueTenderType.create.mockRejectedValueOnce({ code: 'P2028' })
    await expect(ensureExchangeCreditTender(prismaMock, VENUE)).rejects.toEqual({ code: 'P2028' })
  })

  it('recovers a concurrent tender creation inside the money transaction without leaving it aborted', async () => {
    prismaMock.$executeRaw.mockResolvedValue(0)
    prismaMock.venueTenderType.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => {
        const statements = prismaMock.$executeRaw.mock.calls.map((call: unknown[]) => String(call[0]))
        if (!statements.includes('ROLLBACK TO SAVEPOINT exchange_credit_tender')) throw new Error('25P02 transaction is aborted')
        return { id: 'tt-winner', revision: 1 }
      })
    prismaMock.venueTenderType.create.mockRejectedValueOnce({ code: 'P2002' })
    await expect(ensureExchangeCreditTender(prismaMock, VENUE, true)).resolves.toEqual({ id: 'tt-winner', revision: 1 })
    expect(prismaMock.$executeRaw.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
      'SAVEPOINT exchange_credit_tender',
      'ROLLBACK TO SAVEPOINT exchange_credit_tender',
      'RELEASE SAVEPOINT exchange_credit_tender',
    ])
  })

  it('resolveExchangeCreditTenderInTx returns method OTHER, fundsFlow EXTERNAL_RECORDED, tenderCountsAsCash false, tenderSatFormaPago 17', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValue({ id: 'tt-ec', baseMethod: 'OTHER', revision: 1 })
    prismaMock.venueTenderTypeRevision.findFirst.mockResolvedValue({
      revision: 1,
      name: 'Crédito de cambio',
      countsAsPhysicalCash: false,
      captureTip: false,
      satFormaPago: '17',
      commissionPercent: null,
    })

    await expect(resolveExchangeCreditTenderInTx(prismaMock, VENUE)).resolves.toEqual({
      tenderTypeId: 'tt-ec',
      tenderRevision: 1,
      method: 'OTHER',
      tenderLabel: 'Crédito de cambio',
      tenderCountsAsCash: false,
      tenderCaptureTip: false,
      tenderSatFormaPago: '17',
      tenderCommissionPercent: null,
      fundsFlow: 'EXTERNAL_RECORDED',
    })
    expect(prismaMock.venueTenderType.findFirst).toHaveBeenCalledWith({
      where: { venueId: VENUE, systemKind: 'EXCHANGE_CREDIT' },
      select: { id: true, baseMethod: true, revision: true },
    })
    expect(prismaMock.venueTenderTypeRevision.findFirst).toHaveBeenCalledWith({
      where: { tenderTypeId: 'tt-ec', venueId: VENUE, revision: 1 },
    })
  })

  it.each([
    ['without the tender', null, null],
    ['with the tender but without its frozen revision', { id: 'tt-ec', baseMethod: 'OTHER', revision: 1 }, null],
  ])('resolveExchangeCreditTenderInTx %s is 422 EXCHANGE_SETTLEMENT_UNAVAILABLE', async (_caso, tender, revision) => {
    prismaMock.venueTenderType.findFirst.mockResolvedValue(tender)
    prismaMock.venueTenderTypeRevision.findFirst.mockResolvedValue(revision)
    await expect(resolveExchangeCreditTenderInTx(prismaMock, VENUE)).rejects.toMatchObject({
      code: 'EXCHANGE_SETTLEMENT_UNAVAILABLE',
      statusCode: 422,
    })
  })

  it('resolveTenderForCharge rejects the EXCHANGE_CREDIT tender with code EXCHANGE_CREDIT_TENDER_NOT_ALLOWED; GIFT_CARD keeps GIFT_CARD_TENDER_NOT_ALLOWED', async () => {
    const tender = (systemKind: string) => ({ id: 'tt-sys', baseMethod: 'OTHER', active: true, revision: 1, name: 'Sistema', systemKind })
    for (const mode of ['online', 'replay'] as const) {
      prismaMock.venueTenderType.findFirst.mockResolvedValueOnce(tender('EXCHANGE_CREDIT'))
      await expect(resolveTenderForCharge(VENUE, 'tt-sys', 1, prismaMock, mode)).rejects.toMatchObject({
        code: 'EXCHANGE_CREDIT_TENDER_NOT_ALLOWED',
        statusCode: 400,
        message: 'El crédito de cambio sólo lo aplica la operación de Cambio.',
      })

      prismaMock.venueTenderType.findFirst.mockResolvedValueOnce(tender('GIFT_CARD'))
      await expect(resolveTenderForCharge(VENUE, 'tt-sys', 1, prismaMock, mode)).rejects.toMatchObject({
        code: 'GIFT_CARD_TENDER_NOT_ALLOWED',
        statusCode: 400,
      })
    }
    expect(prismaMock.venueTenderTypeRevision.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    ['active', { active: false }],
    ['showOnPos', { showOnPos: true }],
    ['name', { name: 'Mi crédito' }],
    ['satFormaPago', { satFormaPago: '01' }],
  ])(
    'updateTenderType refuses to edit the EXCHANGE_CREDIT tender with code EXCHANGE_CREDIT_TENDER_NOT_ALLOWED (%s)',
    async (_campo, cambio) => {
      prismaMock.venueTenderType.findFirst.mockResolvedValue({
        id: 'tt-ec',
        venueId: VENUE,
        isSystem: true,
        systemKind: 'EXCHANGE_CREDIT',
        revision: 1,
        name: 'Crédito de cambio',
      })

      await expect(updateTenderType(VENUE, 'tt-ec', 1, cambio as any, STAFF)).rejects.toMatchObject({
        code: 'EXCHANGE_CREDIT_TENDER_NOT_ALLOWED',
        statusCode: 400,
        message: 'El tipo de pago «Crédito de cambio» lo administra Avoqado: no se puede editar ni apagar.',
      })
      expect(prismaMock.venueTenderType.updateMany).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    },
  )
})

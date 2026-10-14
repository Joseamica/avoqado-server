import { Prisma } from '@prisma/client'
import {
  NOMBRE_TENDER_DE_REGALO,
  NOMBRE_TENDER_DE_REGALO_ALTERNO,
  ensureGiftCardTender,
  isGiftCardTenderKind,
  resolveGiftCardTenderForChargeInTx,
} from '@/services/giftCards/giftCardTender'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

describe('giftCardTender — el tender de sistema «Tarjeta de regalo»', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venueTenderType.findFirst.mockReset()
    prismaMock.venueTenderType.create.mockReset()
    prismaMock.venueTenderTypeRevision.findFirst.mockReset()
  })

  it('si ya existe, lo devuelve sin crear nada', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValueOnce({ id: 'tt-gift', revision: 1 })

    await expect(ensureGiftCardTender(prismaMock, VENUE)).resolves.toEqual({ id: 'tt-gift', revision: 1 })
    expect(prismaMock.venueTenderType.findFirst).toHaveBeenCalledWith({
      where: { venueId: VENUE, systemKind: 'GIFT_CARD' },
      select: { id: true, revision: true },
    })
    expect(prismaMock.venueTenderType.create).not.toHaveBeenCalled()
  })

  it('lo crea oculto en el POS, forma 01, sin cajón, con propina y su revisión 1 en la MISMA escritura', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    prismaMock.venueTenderType.create.mockResolvedValue({ id: 'tt-gift', revision: 1 })

    await expect(ensureGiftCardTender(prismaMock, VENUE)).resolves.toEqual({ id: 'tt-gift', revision: 1 })
    const data = prismaMock.venueTenderType.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      venueId: VENUE,
      name: NOMBRE_TENDER_DE_REGALO,
      normalizedName: 'tarjeta de regalo',
      baseMethod: 'OTHER',
      isSystem: true,
      systemKind: 'GIFT_CARD',
      countsAsPhysicalCash: false,
      captureTip: true,
      showOnPos: false,
      satFormaPago: '01',
      revision: 1,
    })
    expect(data.revisions.create).toMatchObject({
      revision: 1,
      name: NOMBRE_TENDER_DE_REGALO,
      countsAsPhysicalCash: false,
      captureTip: true,
      commissionPercent: null,
      satFormaPago: '01',
    })
  })

  it('si el negocio ya tiene un tender PROPIO llamado «Tarjeta de regalo», el de sistema usa el nombre alterno', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'tt-propio' })
    prismaMock.venueTenderType.create.mockResolvedValue({ id: 'tt-gift', revision: 1 })

    await ensureGiftCardTender(prismaMock, VENUE)
    expect(prismaMock.venueTenderType.create.mock.calls[0][0].data).toMatchObject({
      name: NOMBRE_TENDER_DE_REGALO_ALTERNO,
      normalizedName: 'tarjeta de regalo (avoqado)',
    })
  })

  it('dos que lo crean a la vez: el perdedor (P2002) devuelve el del ganador, nunca un 500', async () => {
    prismaMock.venueTenderType.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'tt-ganador', revision: 1 })
    prismaMock.venueTenderType.create.mockRejectedValue({ code: 'P2002' })

    await expect(ensureGiftCardTender(prismaMock, VENUE)).resolves.toEqual({ id: 'tt-ganador', revision: 1 })
  })

  it('resuelve el cobro con la revisión VIGENTE del tender de regalo: OTHER, fuera del cajón, forma 01', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValue({ id: 'tt-gift', baseMethod: 'OTHER', revision: 2 })
    prismaMock.venueTenderTypeRevision.findFirst.mockResolvedValue({
      revision: 2,
      name: 'Tarjeta de regalo',
      countsAsPhysicalCash: false,
      captureTip: true,
      satFormaPago: '01',
      commissionPercent: null,
    })

    await expect(resolveGiftCardTenderForChargeInTx(prismaMock, VENUE)).resolves.toEqual({
      tenderTypeId: 'tt-gift',
      tenderRevision: 2,
      method: 'OTHER',
      tenderLabel: 'Tarjeta de regalo',
      tenderCountsAsCash: false,
      tenderCaptureTip: true,
      tenderSatFormaPago: '01',
      tenderCommissionPercent: null,
      fundsFlow: 'EXTERNAL_RECORDED',
    })
    expect(prismaMock.venueTenderTypeRevision.findFirst).toHaveBeenCalledWith({
      where: { tenderTypeId: 'tt-gift', venueId: VENUE, revision: 2 },
    })
  })

  it('sin tender de regalo en el negocio: GIFT_CARDS_DISABLED, no un cobro con un tender inventado', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValue(null)
    await expect(resolveGiftCardTenderForChargeInTx(prismaMock, VENUE)).rejects.toMatchObject({
      code: 'GIFT_CARDS_DISABLED',
      statusCode: 409,
    })
  })

  it('isGiftCardTenderKind sólo reconoce GIFT_CARD', () => {
    expect(isGiftCardTenderKind('GIFT_CARD')).toBe(true)
    expect(isGiftCardTenderKind(null)).toBe(false)
    expect(isGiftCardTenderKind(undefined)).toBe(false)
    expect(isGiftCardTenderKind('OTHER')).toBe(false)
  })

  it('regresión: la comisión de la revisión pasa tal cual (Decimal), igual que resolveTenderForCharge', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValue({ id: 'tt-gift', baseMethod: 'OTHER', revision: 1 })
    prismaMock.venueTenderTypeRevision.findFirst.mockResolvedValue({
      revision: 1,
      name: 'Tarjeta de regalo',
      countsAsPhysicalCash: false,
      captureTip: true,
      satFormaPago: '01',
      commissionPercent: new Prisma.Decimal('0.00'),
    })
    const r = await resolveGiftCardTenderForChargeInTx(prismaMock, VENUE)
    expect(r.tenderCommissionPercent?.toFixed(2)).toBe('0.00')
  })
})

/**
 * El tender de sistema «Saldo a favor» (spec `docs/superpowers/specs/2026-10-30-saldo-a-favor-design.md` §5.1 y §5.3): uno por
 * sucursal, oculto en el POS, forma SAT 17 (Compensación), fuera del cajón y del banco (`EXTERNAL_RECORDED`). Se crea con el cliente
 * GLOBAL y ANTES de abrir la transacción de dinero (su alta lleva una revisión anidada: un P2002 dentro de la transacción la
 * abortaría entera). `storeCreditAvailable` = las dos llaves de las tarjetas de regalo.
 */
import {
  NOMBRE_TENDER_SALDO_A_FAVOR,
  NOMBRE_TENDER_SALDO_A_FAVOR_ALTERNO,
  ensureStoreCreditTender,
  prepararMediosDeSaldoAFavor,
  resolveStoreCreditTenderInTx,
  storeCreditAvailable,
} from '@/services/storeCredit/storeCreditTender'
import { resolveTenderForCharge, updateTenderType } from '@/services/dashboard/tenderType.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

const VENUE = 'venue-1'
const STAFF = 'staff-1'
const LLAVE = 'a'.repeat(64)

describe('storeCreditTender — el medio de sistema «Saldo a favor»', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venueTenderType.findFirst.mockReset()
    prismaMock.venueTenderType.create.mockReset()
    prismaMock.venueTenderType.updateMany.mockReset()
    prismaMock.venueTenderTypeRevision.findFirst.mockReset()
  })

  it('crea el medio con forma 17 y oculto, con su revisión 1 en la MISMA escritura', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    prismaMock.venueTenderType.create.mockResolvedValue({ id: 'tt-sc', revision: 1 })

    await expect(ensureStoreCreditTender(VENUE)).resolves.toEqual({ id: 'tt-sc', revision: 1 })
    expect(prismaMock.venueTenderType.findFirst).toHaveBeenNthCalledWith(1, {
      where: { venueId: VENUE, systemKind: 'STORE_CREDIT' },
      select: { id: true, revision: true },
    })
    const data = prismaMock.venueTenderType.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      venueId: VENUE,
      name: NOMBRE_TENDER_SALDO_A_FAVOR,
      normalizedName: 'saldo a favor',
      baseMethod: 'OTHER',
      isSystem: true,
      systemKind: 'STORE_CREDIT',
      countsAsPhysicalCash: false,
      captureTip: false,
      showOnPos: false,
      posSection: 'MORE',
      displayOrder: 99,
      satFormaPago: '17',
      revision: 1,
    })
    expect(NOMBRE_TENDER_SALDO_A_FAVOR).toBe('Saldo a favor')
    expect(data.commissionPercent ?? null).toBeNull()
    expect(data.revisions.create).toEqual({
      revision: 1,
      name: 'Saldo a favor',
      countsAsPhysicalCash: false,
      captureTip: false,
      commissionPercent: null,
      satFormaPago: '17',
      createdBy: null,
    })
  })

  it('la segunda llamada regresa el mismo, sin crear otro', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValueOnce({ id: 'tt-sc', revision: 1 })

    await expect(ensureStoreCreditTender(VENUE)).resolves.toEqual({ id: 'tt-sc', revision: 1 })
    expect(prismaMock.venueTenderType.create).not.toHaveBeenCalled()
  })

  it('si el negocio ya tiene un medio PROPIO llamado «Saldo a favor», el de sistema usa el nombre alterno', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'tt-propio' })
    prismaMock.venueTenderType.create.mockResolvedValue({ id: 'tt-sc', revision: 1 })

    await ensureStoreCreditTender(VENUE)
    expect(prismaMock.venueTenderType.findFirst).toHaveBeenNthCalledWith(2, {
      where: { venueId: VENUE, normalizedName: 'saldo a favor' },
      select: { id: true },
    })
    const data = prismaMock.venueTenderType.create.mock.calls[0][0].data
    expect(NOMBRE_TENDER_SALDO_A_FAVOR_ALTERNO).toBe('Saldo a favor (Avoqado)')
    expect(data).toMatchObject({ name: 'Saldo a favor (Avoqado)', normalizedName: 'saldo a favor (avoqado)' })
    expect(data.revisions.create).toMatchObject({ name: 'Saldo a favor (Avoqado)' })
  })

  it('dos llamadas a la vez dejan uno solo: el perdedor (P2002) devuelve el del ganador, nunca un 500', async () => {
    // Una base de mentira con la carrera real: las dos lecturas ven «no existe» antes de que cualquiera escriba, el primer create
    // gana y el segundo choca con el índice único (@@unique([venueId, systemKind])).
    const filas: Array<{ id: string; revision: number }> = []
    prismaMock.venueTenderType.findFirst.mockImplementation(async (args: { where: { systemKind?: string } }) => {
      await new Promise(resolve => setImmediate(resolve))
      return args.where.systemKind === 'STORE_CREDIT' ? (filas[0] ?? null) : null
    })
    prismaMock.venueTenderType.create.mockImplementation(async () => {
      await new Promise(resolve => setImmediate(resolve))
      if (filas.length > 0) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      filas.push({ id: `tt-sc-${filas.length + 1}`, revision: 1 })
      return filas[0]
    })

    const [a, b] = await Promise.all([ensureStoreCreditTender(VENUE), ensureStoreCreditTender(VENUE)])

    expect(prismaMock.venueTenderType.create).toHaveBeenCalledTimes(2) // las dos llegaron a escribir…
    expect(filas).toHaveLength(1) // …pero quedó UNA fila
    expect(a).toEqual(b)
    expect(a.id).toBe(filas[0].id)
  })

  it('un error distinto de P2002 se relanza tal cual', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValue(null)
    prismaMock.venueTenderType.create.mockRejectedValueOnce({ code: 'P2028' })
    await expect(ensureStoreCreditTender(VENUE)).rejects.toEqual({ code: 'P2028' })
  })

  describe('storeCreditAvailable (las dos llaves de las tarjetas de regalo)', () => {
    const guardadas = { code: process.env.GIFT_CARD_CODE_KEY, hmac: process.env.GIFT_CARD_HMAC_KEY }
    afterEach(() => {
      if (guardadas.code === undefined) delete process.env.GIFT_CARD_CODE_KEY
      else process.env.GIFT_CARD_CODE_KEY = guardadas.code
      if (guardadas.hmac === undefined) delete process.env.GIFT_CARD_HMAC_KEY
      else process.env.GIFT_CARD_HMAC_KEY = guardadas.hmac
    })

    it('es falso sin GIFT_CARD_HMAC_KEY', () => {
      process.env.GIFT_CARD_CODE_KEY = LLAVE
      delete process.env.GIFT_CARD_HMAC_KEY
      expect(storeCreditAvailable()).toBe(false)
    })

    it('es falso sin GIFT_CARD_CODE_KEY', () => {
      delete process.env.GIFT_CARD_CODE_KEY
      process.env.GIFT_CARD_HMAC_KEY = LLAVE
      expect(storeCreditAvailable()).toBe(false)
    })

    it('es falso con una llave mal formada', () => {
      process.env.GIFT_CARD_CODE_KEY = LLAVE
      process.env.GIFT_CARD_HMAC_KEY = 'no-es-hex'
      expect(storeCreditAvailable()).toBe(false)
    })

    it('es verdadero con las dos llaves', () => {
      process.env.GIFT_CARD_CODE_KEY = LLAVE
      process.env.GIFT_CARD_HMAC_KEY = LLAVE
      expect(storeCreditAvailable()).toBe(true)
    })
  })

  it('prepararMediosDeSaldoAFavor crea los dos medios (GIFT_CARD y STORE_CREDIT) con el cliente global, y una segunda vez no crea nada', async () => {
    const filas = new Map<string, { id: string; revision: number }>()
    prismaMock.venueTenderType.findFirst.mockImplementation(async (args: { where: { systemKind?: string } }) =>
      args.where.systemKind ? (filas.get(args.where.systemKind) ?? null) : null,
    )
    prismaMock.venueTenderType.create.mockImplementation(async (args: { data: { systemKind: string } }) => {
      const fila = { id: `tt-${args.data.systemKind}`, revision: 1 }
      filas.set(args.data.systemKind, fila)
      return fila
    })

    await prepararMediosDeSaldoAFavor(VENUE)
    expect([...filas.keys()].sort()).toEqual(['GIFT_CARD', 'STORE_CREDIT'])
    expect(prismaMock.venueTenderType.create).toHaveBeenCalledTimes(2)

    await prepararMediosDeSaldoAFavor(VENUE)
    expect(prismaMock.venueTenderType.create).toHaveBeenCalledTimes(2)
  })

  it('resolveStoreCreditTenderInTx regresa método OTHER, EXTERNAL_RECORDED, sin cajón y forma 17 con la revisión VIGENTE', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValue({ id: 'tt-sc', baseMethod: 'OTHER', revision: 2 })
    prismaMock.venueTenderTypeRevision.findFirst.mockResolvedValue({
      revision: 2,
      name: 'Saldo a favor',
      countsAsPhysicalCash: false,
      captureTip: false,
      satFormaPago: '17',
      commissionPercent: null,
    })

    await expect(resolveStoreCreditTenderInTx(prismaMock, VENUE)).resolves.toEqual({
      tenderTypeId: 'tt-sc',
      tenderRevision: 2,
      method: 'OTHER',
      tenderLabel: 'Saldo a favor',
      tenderCountsAsCash: false,
      tenderCaptureTip: false,
      tenderSatFormaPago: '17',
      tenderCommissionPercent: null,
      fundsFlow: 'EXTERNAL_RECORDED',
    })
    expect(prismaMock.venueTenderType.findFirst).toHaveBeenCalledWith({
      where: { venueId: VENUE, systemKind: 'STORE_CREDIT' },
      select: { id: true, baseMethod: true, revision: true },
    })
    expect(prismaMock.venueTenderTypeRevision.findFirst).toHaveBeenCalledWith({
      where: { tenderTypeId: 'tt-sc', venueId: VENUE, revision: 2 },
    })
  })

  it.each([
    ['sin el medio', null, null],
    ['con el medio pero sin su revisión congelada', { id: 'tt-sc', baseMethod: 'OTHER', revision: 1 }, null],
  ])('resolveStoreCreditTenderInTx %s lanza 422 STORE_CREDIT_TENDER_MISSING', async (_caso, tender, revision) => {
    prismaMock.venueTenderType.findFirst.mockResolvedValue(tender)
    prismaMock.venueTenderTypeRevision.findFirst.mockResolvedValue(revision)
    await expect(resolveStoreCreditTenderInTx(prismaMock, VENUE)).rejects.toMatchObject({
      code: 'STORE_CREDIT_TENDER_MISSING',
      statusCode: 422,
    })
  })

  it('una app no lo puede mandar a mano: como medio de cobro se rechaza, y el negocio no lo edita ni lo apaga', async () => {
    const tender = { id: 'tt-sc', baseMethod: 'OTHER', active: true, revision: 1, name: 'Saldo a favor', systemKind: 'STORE_CREDIT' }
    for (const mode of ['online', 'replay'] as const) {
      prismaMock.venueTenderType.findFirst.mockResolvedValueOnce(tender)
      await expect(resolveTenderForCharge(VENUE, 'tt-sc', 1, prismaMock, mode)).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(prismaMock.venueTenderTypeRevision.findFirst).not.toHaveBeenCalled()

    prismaMock.venueTenderType.findFirst.mockResolvedValue({ ...tender, venueId: VENUE, isSystem: true })
    await expect(updateTenderType(VENUE, 'tt-sc', 1, { active: false } as never, STAFF)).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.venueTenderType.updateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
})

/**
 * Piezas de superficie de las tarjetas de regalo: bitácora fuera de la tx, el estado de VENTA (por qué el botón está apagado
 * y cómo prenderlo) y la envoltura con transacción de las operaciones de gerente (el reintento lo dice la libreta, F9).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/giftCards/giftCardLedger', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardLedger'),
  operarSobreDeGerenteEnTx: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardSettings.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardSettings.service'),
  assertGiftCardsSellable: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardLimits', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardLimits'),
  topePorOperacion: jest.fn(),
}))

import { logAction } from '@/services/dashboard/activity-log.service'
import { operarSobreDeGerenteEnTx } from '@/services/giftCards/giftCardLedger'
import { assertGiftCardsSellable } from '@/services/giftCards/giftCardSettings.service'
import { topePorOperacion } from '@/services/giftCards/giftCardLimits'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import {
  auditarTarjetas,
  CAPACIDADES_DEL_POS,
  estadoDeVentaDeTarjetas,
  negocioHaActivadoTarjetas,
  negocioTieneTarjetas,
  operarSobreDeGerente,
} from '@/services/giftCards/giftCardSurface.service'

const m = (f: unknown) => f as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  m(topePorOperacion).mockReturnValue(new Prisma.Decimal('70000'))
})

describe('bitácora', () => {
  it('auditarTarjetas escribe con logAction (fuera de la tx, sin esperar)', () => {
    auditarTarjetas({
      venueId: 'v1',
      staffId: 's1',
      action: 'GIFT_CARD_BLOCKED',
      entity: 'GiftCard',
      entityId: 'gc1',
      data: { reason: 'LOST_CARD' },
      ipAddress: '1.2.3.4',
      userAgent: 'POS',
    })
    expect(logAction).toHaveBeenCalledWith({
      venueId: 'v1',
      staffId: 's1',
      action: 'GIFT_CARD_BLOCKED',
      entity: 'GiftCard',
      entityId: 'gc1',
      data: { reason: 'LOST_CARD' },
      ipAddress: '1.2.3.4',
      userAgent: 'POS',
    })
  })
})

describe('¿el negocio tiene tarjetas? (decisión 1 del coordinador)', () => {
  it('UNA consulta EXISTS sobre GiftCard del negocio, de cualquier estado', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ existe: true }])
    await expect(negocioTieneTarjetas('v1')).resolves.toBe(true)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')
    expect(sql).toMatch(/SELECT EXISTS \(SELECT 1 FROM "GiftCard" WHERE "venueId" = \?\) AS existe/)
    expect(prismaMock.$queryRaw.mock.calls[0][1]).toBe('v1')
    prismaMock.$queryRaw.mockResolvedValueOnce([{ existe: false }])
    await expect(negocioTieneTarjetas('v1')).resolves.toBe(false)
  })
})

describe('¿el negocio ya ACTIVÓ alguna tarjeta? (1b S1: `tieneTarjetas` de los ajustes del POS)', () => {
  it('UNA consulta EXISTS acotada al negocio y a activatedAt no nulo: una tarjeta sólo PENDING no cuenta', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ existe: false }])
    await expect(negocioHaActivadoTarjetas('v1')).resolves.toBe(false)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')
    expect(sql).toMatch(/SELECT EXISTS \(SELECT 1 FROM "GiftCard" WHERE "venueId" = \? AND "activatedAt" IS NOT NULL\) AS existe/)
    expect(prismaMock.$queryRaw.mock.calls[0][1]).toBe('v1')
    prismaMock.$queryRaw.mockResolvedValueOnce([{ existe: true }])
    await expect(negocioHaActivadoTarjetas('v1')).resolves.toBe(true)
  })

  it('las capacidades que este servidor anuncia al POS', () => {
    expect(CAPACIDADES_DEL_POS).toEqual(['ENTREGA', 'PAGE_TOKEN', 'TELEFONO'])
  })
})

describe('estado de venta', () => {
  it('vendible: sin código ni mensaje, con el tope de hoy en pesos', async () => {
    m(assertGiftCardsSellable).mockResolvedValueOnce(undefined)
    await expect(estadoDeVentaDeTarjetas('v1')).resolves.toEqual({
      sellable: true,
      code: null,
      message: null,
      howToEnable: null,
      operationLimit: 70000,
    })
  })

  it.each([
    ['GIFT_CARDS_DISABLED', 'DASHBOARD_SETTINGS'],
    ['GIFT_CARDS_NOT_IN_PLAN', 'PLAN'],
    ['GIFT_CARD_KEYS_MISSING', 'CONTACT_AVOQADO'],
  ])('%s se explica con su salida (%s)', async (code, como) => {
    m(assertGiftCardsSellable).mockRejectedValueOnce(new GiftCardError(code as never, `mensaje de ${code}`, 403))
    await expect(estadoDeVentaDeTarjetas('v1')).resolves.toEqual({
      sellable: false,
      code,
      message: `mensaje de ${code}`,
      howToEnable: como,
      operationLimit: 70000,
    })
  })

  it('si la tabla de UMA no cubre hoy, el tope sale null y no tumba los ajustes', async () => {
    m(topePorOperacion).mockImplementationOnce(() => {
      throw new Error('la tabla de UMA no cubre 2027-02-01')
    })
    m(assertGiftCardsSellable).mockResolvedValueOnce(undefined)
    await expect(estadoDeVentaDeTarjetas('v1')).resolves.toMatchObject({ sellable: true, operationLimit: null })
  })

  it('un error que no es de tarjetas se propaga (no se disfraza de «apagado»)', async () => {
    m(assertGiftCardsSellable).mockRejectedValueOnce(new Error('base caída'))
    await expect(estadoDeVentaDeTarjetas('v1')).rejects.toThrow('base caída')
  })
})

describe('operaciones de gerente', () => {
  it('abren su transacción con el presupuesto de espera de candados y llegan a la libreta con su forma', async () => {
    m(operarSobreDeGerenteEnTx).mockResolvedValueOnce({ activityIds: ['a9'], replay: false })
    const r = await operarSobreDeGerente('v1', 'gc1', 's1', {
      operationKey: 'llave-ajuste-1',
      tipo: 'AJUSTE',
      direccion: 'DECREMENT',
      amount: new Prisma.Decimal('50.25'),
      reason: 'CASHIER_ERROR',
      note: 'se cobró de más',
    })
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000, maxWait: 5_000 })
    expect(operarSobreDeGerenteEnTx).toHaveBeenCalledWith(prismaMock, {
      venueId: 'v1',
      giftCardId: 'gc1',
      staffId: 's1',
      operationKey: 'llave-ajuste-1',
      op: { tipo: 'AJUSTE', direccion: 'DECREMENT', amount: new Prisma.Decimal('50.25'), reason: 'CASHIER_ERROR', note: 'se cobró de más' },
    })
    expect(r).toEqual({ activityIds: ['a9'], replayed: false })
    // F9 (auditoría r1 C-2): nada de prelecturas de la llave fuera del candado de la libreta.
    expect(prismaMock.giftCardActivity.findUnique).not.toHaveBeenCalled()
  })

  it('reponer el código: sólo por tarjeta perdida y con el folio de su venta; el código nuevo regresa para dárselo al cliente', async () => {
    prismaMock.orderItem.findFirst.mockResolvedValueOnce({ order: { orderNumber: 'ORD-1729' } })
    m(operarSobreDeGerenteEnTx).mockResolvedValueOnce({
      activityIds: ['a10'],
      nuevoCodigo: { display: 'AB12-CD34-EF56-GH78-J', last4: 'GH78' },
      replay: false,
    })
    const r = await operarSobreDeGerente('v1', 'gc1', 's1', {
      operationKey: 'llave-repone-1',
      tipo: 'REEMPLAZAR_CODIGO',
      reason: 'LOST_CARD',
      folio: ' ord-1729 ',
    })
    expect(prismaMock.orderItem.findFirst).toHaveBeenCalledWith({
      where: { giftCardId: 'gc1', order: { venueId: 'v1' } },
      select: { order: { select: { orderNumber: true } } },
    })
    expect(m(operarSobreDeGerenteEnTx).mock.calls[0][1].op).toEqual({ tipo: 'REEMPLAZAR_CODIGO', reason: 'LOST_CARD' })
    expect(r).toEqual({ activityIds: ['a10'], nuevoCodigo: { display: 'AB12-CD34-EF56-GH78-J', last4: 'GH78' }, replayed: false })
  })

  it('🔴 reponer con un folio que no es el de la venta: 422 GIFT_CARD_FOLIO_MISMATCH y la libreta no se toca', async () => {
    prismaMock.orderItem.findFirst.mockResolvedValueOnce({ order: { orderNumber: 'ORD-1729' } })
    await expect(
      operarSobreDeGerente('v1', 'gc1', 's1', {
        operationKey: 'llave-repone-2',
        tipo: 'REEMPLAZAR_CODIGO',
        reason: 'LOST_CARD',
        folio: 'ORD-9999',
      }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_FOLIO_MISMATCH', statusCode: 422 })
    expect(operarSobreDeGerenteEnTx).not.toHaveBeenCalled()
  })

  it('🔴 F9: el reintento lo decide la libreta BAJO el candado del sobre (`replay`), no una lectura previa', async () => {
    m(operarSobreDeGerenteEnTx).mockResolvedValueOnce({ activityIds: ['a9'], replay: true })
    prismaMock.giftCard.findFirst.mockResolvedValueOnce({ status: 'BLOCKED' }) // el estado de hoy: sigue como la dejó
    const r = await operarSobreDeGerente('v1', 'gc1', 's1', {
      operationKey: 'llave-bloq-1',
      tipo: 'BLOQUEAR',
      reason: 'SUSPICIOUS_ACTIVITY',
    })
    expect(r.replayed).toBe(true)
    expect(m(operarSobreDeGerenteEnTx).mock.calls[0][1].op).toEqual({ tipo: 'BLOQUEAR', reason: 'SUSPICIOUS_ACTIVITY' })
    expect(prismaMock.giftCardActivity.findUnique).not.toHaveBeenCalled()
  })

  it('🔴 F9: dos peticiones con la misma llave (la segunda espera el candado): sólo la primera sale como nueva', async () => {
    m(operarSobreDeGerenteEnTx)
      .mockResolvedValueOnce({ activityIds: ['a11'], replay: false })
      .mockResolvedValueOnce({ activityIds: ['a11'], replay: true })
    prismaMock.giftCard.findFirst.mockResolvedValue({ status: 'BLOCKED' })
    const cuerpo = { operationKey: 'llave-bloq-2', tipo: 'BLOQUEAR' as const, reason: 'LOST_CARD' as const }
    const [a, b] = await Promise.all([operarSobreDeGerente('v1', 'gc1', 's1', cuerpo), operarSobreDeGerente('v1', 'gc1', 's1', cuerpo)])
    expect([a.replayed, b.replayed].sort()).toEqual([false, true])
  })

  it('⭐ (D4, estado de HOY) repetir un bloqueo o un desbloqueo cuyo estado se movió ⇒ 409 GIFT_CARD_STATE_CHANGED (r1 M2: code propio); lo nuevo no relee', async () => {
    m(operarSobreDeGerenteEnTx).mockResolvedValueOnce({ activityIds: ['a12'], replay: true })
    prismaMock.giftCard.findFirst.mockResolvedValueOnce({ status: 'ACTIVE' })
    await expect(
      operarSobreDeGerente('v1', 'gc1', 's1', { operationKey: 'llave-bloq-3', tipo: 'BLOQUEAR', reason: 'SUSPICIOUS_ACTIVITY' }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_STATE_CHANGED', statusCode: 409 })
    expect(prismaMock.giftCard.findFirst).toHaveBeenLastCalledWith({ where: { id: 'gc1', venueId: 'v1' }, select: { status: true } })

    m(operarSobreDeGerenteEnTx).mockResolvedValueOnce({ activityIds: ['a13'], replay: true })
    prismaMock.giftCard.findFirst.mockResolvedValueOnce({ status: 'BLOCKED' })
    await expect(
      operarSobreDeGerente('v1', 'gc1', 's1', { operationKey: 'llave-desb-1', tipo: 'DESBLOQUEAR', reason: 'CUSTOMER_REQUEST' }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_STATE_CHANGED', statusCode: 409 })

    prismaMock.giftCard.findFirst.mockClear()
    m(operarSobreDeGerenteEnTx).mockResolvedValueOnce({ activityIds: ['a14'], replay: false })
    await operarSobreDeGerente('v1', 'gc1', 's1', { operationKey: 'llave-bloq-4', tipo: 'BLOQUEAR', reason: 'SUSPICIOUS_ACTIVITY' })
    expect(prismaMock.giftCard.findFirst).not.toHaveBeenCalled()
  })
})

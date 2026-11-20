/**
 * Máquina de efectivo 1a · A6 (R1#7, R2#13) y R4-7 #4: devolver en efectivo una venta de la máquina SALE DEL CAJÓN.
 *
 * La venta de la QuickPay es `CASH` + `EXTERNAL_RECORDED`: el billete se quedó en la máquina. Su devolución heredaba ese
 * `EXTERNAL_RECORDED`, el escritor del cajón se saltaba el `PAY_OUT` y la caja seguía mostrando un dinero que ya se había ido
 * en la mano del cliente: el arqueo le inventaba al cajero un faltante del tamaño de la devolución.
 *
 * La regla es UNA (`devuelveEfectivoDeLaMaquina`, en `terminalRefundTarget.ts`): con `refundMethod` ausente (el `null` del POS,
 * que su controlador convierte en ausente) o `CASH`, la fila es `CASH_DRAWER` y lleva UN `PAY_OUT` en la caja abierta, escrito en
 * la MISMA transacción que el reembolso y en la caja que se bloqueó para autorizarlo. Sin caja abierta: 409 «Abre la caja para
 * devolver en efectivo» y no se confirma nada. Aquí, el riel del POS y del panel (`issueRefund` → `writeRefundInTx`); la TPV va
 * en `devolucionDeLaMaquina.tpv.test.ts`.
 */
import { PaymentType, TransactionStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueueRefundPaymentEffectsInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/rawMaterial.service', () => ({ adjustStock: jest.fn() }))
jest.mock('@/services/wallet/stampLedger.service', () => ({ reverseStampForOrder: jest.fn().mockResolvedValue({ reversed: true }) }))

import { ConflictError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { issueRefund, writeRefundInTx } from '@/services/dashboard/refund.dashboard.service'
import { resolveChainRefund } from '@/services/exchanges/exchangeChainRefund'
import { modesForExchangeCreditRoot, payoutModesFor } from '@/services/exchanges/exchangeRules'
import { EXCHANGE_REFUND_ROLE } from '@/services/exchanges/exchangeMarks'
import { devolverConEfectivo, devuelveEfectivoDeLaMaquina, type CobroParaDevolver } from '@/services/tpv/terminalRefundTarget'
import { prismaMock } from '../../../__helpers__/setup'

const FOLIO = 'AQ0000000000AB'

describe('la regla única (pura)', () => {
  const cobro = (over: Partial<CobroParaDevolver> = {}): CobroParaDevolver => ({
    method: 'CASH',
    source: 'POS',
    externalSource: null,
    tenderSatFormaPago: '01',
    fundsFlow: 'EXTERNAL_RECORDED',
    tenderTypeId: null,
    tenderCountsAsCash: false,
    cashMachineRef: FOLIO,
    ...over,
  })

  it.each([
    ['sin escoger (el null del POS)', undefined],
    ['null explícito', null],
    ['CASH', 'CASH' as const],
  ])('venta de la máquina + %s ⇒ efectivo del CAJÓN', (_n, metodo) => {
    expect(devuelveEfectivoDeLaMaquina(cobro(), metodo)).toBe(true)
    expect(devolverConEfectivo(cobro(), metodo ?? undefined)).toBe('CASH')
  })

  it('venta de la máquina + transferencia ⇒ transferencia, no toca el cajón', () => {
    expect(devuelveEfectivoDeLaMaquina(cobro(), 'BANK_TRANSFER')).toBe(false)
    expect(devolverConEfectivo(cobro(), 'BANK_TRANSFER')).toBe('BANK_TRANSFER')
  })

  it('control — efectivo del cajón (sin folio) ⇒ «por el mismo medio», como hoy', () => {
    const delCajon = cobro({ fundsFlow: 'CASH_DRAWER', cashMachineRef: null, tenderSatFormaPago: null, tenderCountsAsCash: null })
    expect(devuelveEfectivoDeLaMaquina(delCajon, undefined)).toBe(false)
    expect(devolverConEfectivo(delCajon, undefined)).toBeUndefined()
    expect(devolverConEfectivo(delCajon, 'CASH')).toBeUndefined()
  })
})

describe('Codex r1 #2: el Cambio de una venta de la máquina (reglas puras)', () => {
  const raiz = {
    id: 'payment-raiz',
    method: 'CASH',
    source: 'POS',
    externalSource: null,
    fundsFlow: 'EXTERNAL_RECORDED',
    tenderTypeId: null,
    tenderCountsAsCash: false,
    tenderSatFormaPago: '01',
    tenderSystemKind: null,
    tenderType: null,
    merchantAccountId: null,
    ecommerceMerchantId: null,
    cashMachineRef: FOLIO,
  }

  it('🔴 lo que sale de una raíz de la máquina es efectivo DE LA GAVETA (no hereda «fuera del cajón»)', () => {
    const r = resolveChainRefund({ exchangeId: 'cambio-1' } as any, raiz as any)
    expect(r).toMatchObject({
      kind: 'INHERIT',
      money: { method: 'CASH', fundsFlow: 'CASH_DRAWER', tenderLabel: null, tenderSatFormaPago: null, salidaDeGaveta: true },
    })
  })

  it('🔴 el segundo Cambio sí ofrece efectivo para esa raíz, como «Devolver con» (decisión c: refund-to-cash), igual que el primero', () => {
    expect(modesForExchangeCreditRoot(raiz)).toEqual({ CASH: 'CHOSEN' })
    expect(payoutModesFor(raiz).CASH).toBe('CHOSEN')
  })

  it('control — una raíz de efectivo del cajón sigue como hoy', () => {
    const delCajon = { ...raiz, fundsFlow: 'CASH_DRAWER', cashMachineRef: null, tenderSatFormaPago: null, tenderCountsAsCash: null }
    expect(modesForExchangeCreditRoot(delCajon)).toEqual({ CASH: 'SAME' })
    const r = resolveChainRefund({ exchangeId: 'cambio-1' } as any, delCajon as any)
    expect(r).toMatchObject({ money: { fundsFlow: 'CASH_DRAWER' } })
    expect((r as any).money.salidaDeGaveta).toBeUndefined()
  })
})

describe('riel del POS y del panel (issueRefund)', () => {
  /** La venta de la máquina tal como la escribe `snapshotDeLaMaquina`, leída bajo candado. */
  const ventaDeLaMaquina = (over: Record<string, unknown> = {}) => ({
    id: 'payment-original',
    venueId: 'venue-1',
    status: TransactionStatus.COMPLETED,
    type: PaymentType.REGULAR,
    method: 'CASH',
    source: 'POS',
    amount: 150,
    tipAmount: 0,
    orderId: 'order-1',
    shiftId: null,
    merchantAccountId: null,
    processorData: {},
    processorId: null,
    cardBrand: null,
    fundsFlow: 'EXTERNAL_RECORDED',
    externalSource: null,
    tenderTypeId: null,
    tenderCountsAsCash: false,
    tenderRevision: null,
    tenderLabel: 'Efectivo · máquina',
    tenderCaptureTip: null,
    tenderSatFormaPago: '01',
    tenderCommissionPercent: null,
    cashMachineRef: FOLIO,
    ...over,
  })

  let cajaAbierta: { id: string } | null
  /** El orden en que la transacción toma la caja y el turno (Order → Payment → caja → turno, como el cierre de caja). */
  let orden: string[]
  /**
   * Los movimientos de caja de la transacción DEL REEMBOLSO (la primera que se abre): distintos del cliente global, para saber dónde
   * se escribió el PAY_OUT. Las transacciones que abre después el enganche post-commit del cajón usan el global, como en la base.
   */
  let eventosEnTx: { create: jest.Mock; createMany: jest.Mock }
  /** El nombre de la cajera para el PAY_OUT, leído con el cliente de la transacción (Codex r1 #18). */
  let staffEnTx: { findUnique: jest.Mock }
  let transacciones: number

  const reembolsar = (over: Record<string, unknown> = {}) =>
    issueRefund({ venueId: 'venue-1', paymentId: 'payment-original', amount: 15000, reason: 'RETURNED_GOODS', staffId: 'staff-9', ...over })
  const filaDelReembolso = () => prismaMock.payment.create.mock.calls[0][0].data

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$queryRaw.mockReset()
    prismaMock.orderItem.findMany.mockReset()
    prismaMock.orderItem.findMany.mockResolvedValue([])
    cajaAbierta = { id: 'caja-1' }
    orden = []
    eventosEnTx = { create: jest.fn().mockResolvedValue({ id: 'evento-1' }), createMany: jest.fn() }
    staffEnTx = { findUnique: jest.fn().mockResolvedValue({ firstName: 'Ana', lastName: 'López' }) }
    transacciones = 0
    prismaMock.order.findUnique.mockResolvedValue({ discountAmount: new Decimal(0), contratoDePrecio: null, originSystem: null })
    prismaMock.payment.findFirst.mockResolvedValue({
      orderId: 'order-1',
      order: { updatedAt: new Date('2026-11-20T09:00:00.000Z') },
    } as any)
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      const queryRaw = jest.fn(async (...args: any[]) => {
        const q = args[0]
        const sql = Array.isArray(q)
          ? q.join('?')
          : Array.isArray(q?.strings)
            ? q.strings.join('?')
            : Array.isArray(q?.sql)
              ? q.sql.join('?')
              : String(q)
        if (sql.includes('FROM "Order"')) return [{ id: 'order-1' }]
        if (sql.includes('FROM "OrderDiscount"')) return []
        if (sql.includes('FROM "CashDrawerSession"')) {
          orden.push('caja')
          expect(sql).toMatch(/status = 'OPEN'/)
          expect(sql).toMatch(/FOR UPDATE/)
          return cajaAbierta ? [cajaAbierta] : []
        }
        if (sql.includes("jsonb_build_object('refundedItems'")) return []
        return (prismaMock.$queryRaw as any)(...args)
      })
      transacciones += 1
      return callback({
        ...(prismaMock as any),
        $queryRaw: queryRaw,
        ...(transacciones === 1 ? { cashDrawerEvent: eventosEnTx, staff: staffEnTx } : {}),
      })
    })
    prismaMock.shift.findFirst.mockImplementation((async () => {
      orden.push('turno')
      return null
    }) as any)
    ;(prismaMock.activityLog.findFirst as jest.Mock).mockResolvedValue(null)
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
    prismaMock.venueTransaction.findUnique.mockResolvedValue(null)
    prismaMock.payment.update.mockResolvedValue({ id: 'payment-original' })
    prismaMock.payment.create.mockResolvedValue({ id: 'refund-maquina-1' })
    prismaMock.staff.findUnique.mockResolvedValue({ firstName: 'Ana', lastName: 'López' } as any)
    // El enganche post-commit de siempre (global, fuera de la transacción): con la caja abierta, escribiría un SEGUNDO PAY_OUT.
    prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'caja-1' } as any)
    prismaMock.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.cashDrawerEvent.createMany.mockResolvedValue({ count: 1 } as any)
  })

  const unSoloPayOutEnLaCaja = (montoPesos: number) => {
    expect(eventosEnTx.create).toHaveBeenCalledTimes(1)
    const evento = eventosEnTx.create.mock.calls[0][0].data
    expect(evento).toMatchObject({
      sessionId: 'caja-1',
      venueId: 'venue-1',
      type: 'PAY_OUT',
      staffId: 'staff-9',
      orderId: 'order-1',
      localId: 'srv-refund:refund-maquina-1',
    })
    expect(Number(evento.amount)).toBe(montoPesos)
    expect(evento.note).toMatch(/^Reembolso:/)
    // Ni el enganche post-commit ni nadie más escribe otro.
    expect(prismaMock.cashDrawerEvent.createMany).not.toHaveBeenCalled()
    expect(prismaMock.cashDrawerEvent.create).not.toHaveBeenCalled()
  }

  it.each([
    ['sin refundMethod (el null del POS)', {}],
    ['refundMethod CASH', { refundMethod: 'CASH' as const }],
  ])('🔴 devolución TOTAL por importe, %s ⇒ CASH_DRAWER y UN PAY_OUT en la caja abierta', async (_n, over) => {
    prismaMock.$queryRaw.mockResolvedValueOnce([ventaDeLaMaquina()]).mockResolvedValueOnce([])

    const r = await reembolsar(over)

    expect(r.amount).toBe(150)
    expect(filaDelReembolso()).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
    // No hereda la etiqueta de la máquina: el dinero salió de la GAVETA.
    expect(filaDelReembolso().tenderLabel).toBeUndefined()
    unSoloPayOutEnLaCaja(150)
    // La caja se toma ANTES del turno: el mismo orden que el cierre de caja (caja → turno).
    expect(orden).toEqual(['caja', 'turno'])
  })

  it('🔴 Codex r1 #18: el nombre de la cajera del PAY_OUT se lee con la MISMA transacción (no pide otra conexión con la caja tomada)', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([ventaDeLaMaquina()]).mockResolvedValueOnce([])
    await reembolsar()
    expect(staffEnTx.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'staff-9' } }))
    expect(prismaMock.staff.findUnique).not.toHaveBeenCalled()
    expect(eventosEnTx.create.mock.calls[0][0].data.staffName).toBe('Ana López')
  })

  it('🔴 Codex r1 #2: devolver el REEMPLAZO de un cambio de una venta de la máquina saca billetes de la gaveta: caja → turno, CASH_DRAWER y un PAY_OUT', async () => {
    // El reemplazo se pagó con el crédito del cambio; su dinero sale de la raíz (la venta de la máquina).
    const reemplazo = ventaDeLaMaquina({
      id: 'payment-reemplazo',
      method: 'OTHER',
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderLabel: 'Crédito de cambio',
      tenderSatFormaPago: null,
      cashMachineRef: null,
    })
    const cadena = resolveChainRefund(
      { exchangeId: 'cambio-1' } as any,
      { ...ventaDeLaMaquina({ id: 'payment-raiz' }), tenderType: null } as any,
    )
    if (cadena.kind !== 'INHERIT') throw new Error('la cadena debía heredarse')
    prismaMock.$queryRaw.mockResolvedValueOnce([reemplazo]).mockResolvedValueOnce([])
    await prismaMock.$transaction((tx: any) =>
      writeRefundInTx(tx, {
        originalPaymentId: 'payment-reemplazo',
        venueId: 'venue-1',
        salesRefundCents: 15000,
        tipRefundCents: 0,
        refundedItems: [],
        reason: 'RETURNED_GOODS',
        staffId: 'staff-9',
        tenderCommission: 'NONE',
        shift: 'CLAIM_LIVE',
        moneyAs: cadena.money,
        exchangeMark: { exchangeId: 'cambio-1', role: EXCHANGE_REFUND_ROLE.CHAIN, rootPaymentId: 'payment-raiz' },
      }),
    )
    expect(filaDelReembolso()).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
    expect(orden).toEqual(['caja', 'turno'])
    unSoloPayOutEnLaCaja(150)
  })

  it('devolución PARCIAL por importe ($50 de $150) ⇒ PAY_OUT de $50', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([ventaDeLaMaquina()]).mockResolvedValueOnce([])

    await reembolsar({ amount: 5000 })

    expect(filaDelReembolso()).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
    unSoloPayOutEnLaCaja(50)
  })

  it.each([
    ['sin refundMethod', {}],
    ['refundMethod CASH', { refundMethod: 'CASH' as const }],
  ])('devolución POR ARTÍCULO, %s ⇒ PAY_OUT por lo cobrado del artículo', async (_n, over) => {
    prismaMock.$queryRaw.mockResolvedValueOnce([ventaDeLaMaquina()]).mockResolvedValueOnce([])
    const lineas = [
      { id: 'oi-1', productId: 'p-1', productName: 'Galleta', quantity: 1, total: new Decimal(100), orderPromotionId: null },
      { id: 'oi-2', productId: 'p-2', productName: 'Café', quantity: 1, total: new Decimal(50), orderPromotionId: null },
    ]
    prismaMock.orderItem.findMany
      .mockResolvedValueOnce([lineas[0]] as any)
      .mockResolvedValueOnce(lineas.map(l => ({ id: l.id, orderPromotionId: null, total: l.total })) as any)

    const r = await issueRefund({
      venueId: 'venue-1',
      paymentId: 'payment-original',
      items: [{ orderItemId: 'oi-1', quantity: 1 }],
      reason: 'RETURNED_GOODS',
      staffId: 'staff-9',
      ...over,
    })

    expect(r.amount).toBe(100)
    expect(filaDelReembolso()).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
    unSoloPayOutEnLaCaja(100)
  })

  it('🔴 sin caja abierta ⇒ 409 «Abre la caja para devolver en efectivo», ANTES de confirmar nada', async () => {
    cajaAbierta = null
    prismaMock.$queryRaw.mockResolvedValueOnce([ventaDeLaMaquina()]).mockResolvedValueOnce([])

    const error = await reembolsar().catch(e => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.statusCode).toBe(409)
    expect(error.message).toBe('Abre la caja para devolver en efectivo')
    expect(error.code).toBe('CASH_DRAWER_NOT_OPEN')
    // Ni turno, ni fila, ni acumulado del cobro, ni movimiento de caja, ni bitácora.
    expect(orden).toEqual(['caja'])
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.payment.update).not.toHaveBeenCalled()
    expect(eventosEnTx.create).not.toHaveBeenCalled()
    expect(prismaMock.cashDrawerEvent.createMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'REFUND_CREATED' }))
  })

  it('🔴 si falla escribir la salida de caja, la devolución NO se confirma (misma transacción: el error la revierte)', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([ventaDeLaMaquina()]).mockResolvedValueOnce([])
    eventosEnTx.create.mockRejectedValueOnce(new Error('se cayó la base entre la fila y la caja'))

    await expect(reembolsar()).rejects.toThrow('se cayó la base entre la fila y la caja')

    // La fila se intentó DENTRO de la transacción que lanzó: Postgres la revierte con ella. Nada post-commit corre.
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.cashDrawerEvent.createMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'REFUND_CREATED' }))
  })

  it('venta de la máquina devuelta por TRANSFERENCIA ⇒ BANK_TRANSFER/EXTERNAL_RECORDED, sin caja (como hoy)', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([ventaDeLaMaquina()]).mockResolvedValueOnce([])

    await reembolsar({ refundMethod: 'BANK_TRANSFER' })

    expect(filaDelReembolso()).toMatchObject({ method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED' })
    expect(orden).toEqual(['turno'])
    expect(eventosEnTx.create).not.toHaveBeenCalled()
    expect(prismaMock.cashDrawerEvent.createMany).not.toHaveBeenCalled()
  })

  describe('control — lo que NO es de la máquina se queda exactamente como hoy', () => {
    const efectivoDelCajon = () =>
      ventaDeLaMaquina({
        source: 'APP',
        fundsFlow: 'CASH_DRAWER',
        tenderLabel: null,
        tenderSatFormaPago: null,
        tenderCountsAsCash: null,
        cashMachineRef: null,
      })

    it('efectivo del cajón: sin candado de caja en la transacción; el PAY_OUT lo escribe el enganche post-commit', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([efectivoDelCajon()]).mockResolvedValueOnce([])

      await reembolsar()

      expect(filaDelReembolso()).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
      expect(orden).toEqual(['turno'])
      expect(eventosEnTx.create).not.toHaveBeenCalled()
      expect(prismaMock.cashDrawerEvent.createMany).toHaveBeenCalledTimes(1)
      expect(prismaMock.cashDrawerEvent.createMany.mock.calls[0][0].data[0]).toMatchObject({
        type: 'PAY_OUT',
        localId: 'srv-refund:refund-maquina-1',
      })
    })

    it('efectivo del cajón SIN caja abierta: la devolución se emite igual (fail-open de siempre)', async () => {
      cajaAbierta = null
      prismaMock.cashDrawerSession.findFirst.mockResolvedValue(null)
      prismaMock.$queryRaw.mockResolvedValueOnce([efectivoDelCajon()]).mockResolvedValueOnce([])

      const r = await reembolsar({ refundMethod: 'CASH' })

      expect(r.status).toBe('COMPLETED')
      expect(prismaMock.cashDrawerEvent.createMany).not.toHaveBeenCalled()
    })
  })
})

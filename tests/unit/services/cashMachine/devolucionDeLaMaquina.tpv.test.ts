/**
 * Máquina de efectivo 1a · R4-7 #4: la regla de A6 también en la devolución por la TPV (`refund.tpv.service.ts`).
 *
 * La TPV nunca manda con qué devolver (`refundMethod` ausente), así que una venta de la máquina devuelta desde la terminal es efectivo
 * del CAJÓN: la fila sale `CASH_DRAWER` y lleva UN `PAY_OUT` en la caja abierta, escrito en la MISMA transacción y en la caja que se
 * bloqueó para autorizarla (antes del turno). Sin caja abierta, 409 y nada se registra. Lo que no es de la máquina, como hoy: el
 * PAY_OUT lo escribe el enganche post-commit (`refund.cashDrawer.test.ts`).
 *
 * Mismo doble de Prisma que `refund.cashDrawer.test.ts`, sin simular `cashDrawerPosting`: corre el escritor real.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import { ConflictError } from '@/errors/AppError'
import * as refundService from '@/services/tpv/refund.tpv.service'
import { prismaMock } from '../../../__helpers__/setup'
import * as destinoDelReembolso from '@/services/shared/destinoDelReembolso'
import type { OrigenDelDinero } from '@/services/shared/destinoDelReembolso'
import { MATRIZ_DEL_SALDO, MEDIOS, celda } from '../../../__helpers__/matrizDelReembolso'

const VENUE = 'venue-1'

let cajaAbierta: { id: string } | null
let orden: string[]
let eventosEnTx: { create: jest.Mock; createMany: jest.Mock }
let eventosGlobales: { create: jest.Mock; createMany: jest.Mock }
let transacciones: number

function armar(over: Record<string, unknown> = {}) {
  const original = {
    id: 'pay-orig',
    venueId: VENUE,
    orderId: 'order-1',
    method: 'CASH',
    fundsFlow: 'EXTERNAL_RECORDED',
    amount: 150,
    tipAmount: 10,
    status: 'COMPLETED',
    type: 'REGULAR',
    processorData: {},
    source: 'POS',
    terminalId: null,
    merchantAccountId: null,
    tenderTypeId: null,
    tenderLabel: 'Efectivo · máquina',
    tenderCountsAsCash: false,
    tenderSatFormaPago: '01',
    cashMachineRef: 'AQ0000000000AB',
    processedById: 'staff-1',
    ...over,
  }
  ;(prismaMock as any).payment = {
    findUnique: jest.fn().mockResolvedValue(original),
    findFirst: jest.fn().mockResolvedValue(original),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'pay-refund', ...a.data })),
    update: jest.fn().mockResolvedValue(original),
    findUniqueOrThrow: jest.fn().mockResolvedValue({ ...original, id: 'pay-refund' }),
  }
  ;(prismaMock as any).order = {
    findUnique: jest.fn().mockResolvedValue({ id: 'order-1', venueId: VENUE }),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
  }
  ;(prismaMock as any).shift = {
    findFirst: jest.fn(async () => {
      orden.push('turno')
      return null
    }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  }
  ;(prismaMock as any).staff = { findUnique: jest.fn().mockResolvedValue({ firstName: 'Ana', lastName: 'López' }) }
  eventosGlobales = { create: jest.fn(), createMany: jest.fn().mockResolvedValue({ count: 1 }) }
  ;(prismaMock as any).cashDrawerEvent = eventosGlobales
  ;(prismaMock as any).cashDrawerSession = {
    findFirst: jest.fn().mockResolvedValue({ id: 'caja-1' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  const queryRaw = jest.fn(async (sql: unknown) => {
    const texto = Array.isArray(sql) ? sql.join('?') : Array.isArray((sql as any)?.strings) ? (sql as any).strings.join('?') : String(sql)
    if (texto.includes('ancestors(id) AS')) return [{ id: original.orderId }]
    if (texto.includes('FROM "CashDrawerSession"')) {
      orden.push('caja')
      expect(texto).toMatch(/FOR UPDATE/)
      return cajaAbierta ? [cajaAbierta] : []
    }
    return [original]
  })
  ;(prismaMock as any).$queryRaw = queryRaw
  // La PRIMERA transacción es la del reembolso: ahí los movimientos de caja van a `eventosEnTx`. Las que abra después el enganche
  // post-commit del cajón usan el cliente global, como en la base.
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => {
    transacciones += 1
    return fn(transacciones === 1 ? { ...(prismaMock as any), cashDrawerEvent: eventosEnTx } : prismaMock)
  })
  return original
}

const cuerpo = (amount: number) => ({
  venueId: VENUE,
  originalPaymentId: 'pay-orig',
  amount,
  reason: 'cliente',
  staffId: 'staff-1',
  authorizationNumber: '',
  referenceNumber: '',
  isPartialRefund: amount < 16000,
  currency: 'MXN',
})

beforeEach(() => {
  jest.clearAllMocks()
  cajaAbierta = { id: 'caja-1' }
  orden = []
  transacciones = 0
  eventosEnTx = { create: jest.fn().mockResolvedValue({ id: 'evento-1' }), createMany: jest.fn() }
})

describe('devolución de una venta de la máquina por la TPV', () => {
  it.each([
    ['TOTAL (venta + propina)', 16000, 160],
    ['PARCIAL', 5000, 50],
  ])('🔴 %s ⇒ CASH_DRAWER y UN PAY_OUT en la caja que la autorizó', async (_n, centavos, pesos) => {
    armar()

    await refundService.recordRefund(VENUE, cuerpo(centavos) as any, 'staff-1')

    const fila = (prismaMock as any).payment.create.mock.calls[0][0].data
    expect(fila).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
    expect(fila.tenderLabel).toBeUndefined()
    expect(eventosEnTx.create).toHaveBeenCalledTimes(1)
    const evento = eventosEnTx.create.mock.calls[0][0].data
    expect(evento).toMatchObject({
      sessionId: 'caja-1',
      venueId: VENUE,
      type: 'PAY_OUT',
      staffId: 'staff-1',
      localId: 'srv-refund:pay-refund',
    })
    expect(Number(evento.amount)).toBe(pesos)
    // Un solo PAY_OUT: el enganche post-commit no escribe otro.
    expect(eventosGlobales.createMany).not.toHaveBeenCalled()
    expect(eventosGlobales.create).not.toHaveBeenCalled()
    expect(orden).toEqual(['caja', 'turno'])
  })

  it('🔴 Codex r2 (familia B): la TPV decide con LA función de destino; con el permiso concedido sin la gaveta, 403 y no registra nada', async () => {
    armar()
    const espia = jest.spyOn(destinoDelReembolso, 'decidirDestinoDelReembolso')
    await expect(refundService.recordRefund(VENUE, cuerpo(16000) as any, 'staff-1', undefined, 'payments:refund')).rejects.toMatchObject({
      statusCode: 403,
      code: 'REFUND_NEEDS_REFUND_TO_CASH',
    })
    expect(espia).toHaveBeenCalledWith({ entrada: 'TPV', origen: 'MAQUINA', medio: undefined, esCreditoDeCambio: false, esSaldo: false })
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
    espia.mockRestore()
  })

  it('🔴 sin caja abierta ⇒ 409 «Abre la caja para devolver en efectivo» y no registra nada', async () => {
    armar()
    cajaAbierta = null

    const error = await refundService.recordRefund(VENUE, cuerpo(16000) as any, 'staff-1').catch(e => e)

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.statusCode).toBe(409)
    expect(error.message).toBe('Abre la caja para devolver en efectivo')
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
    expect((prismaMock as any).payment.update).not.toHaveBeenCalled()
    expect(orden).toEqual(['caja'])
    expect(eventosEnTx.create).not.toHaveBeenCalled()
    expect(eventosGlobales.createMany).not.toHaveBeenCalled()
  })

  it('🔴 si falla escribir la salida de caja, la devolución NO se confirma (misma transacción)', async () => {
    armar()
    eventosEnTx.create.mockRejectedValueOnce(new Error('se cayó la base entre la fila y la caja'))

    await expect(refundService.recordRefund(VENUE, cuerpo(16000) as any, 'staff-1')).rejects.toThrow(
      'se cayó la base entre la fila y la caja',
    )
    expect(eventosGlobales.createMany).not.toHaveBeenCalled()
  })

  it('control — efectivo del cajón (sin folio): como hoy, sin candado de caja y el PAY_OUT lo escribe el post-commit', async () => {
    armar({ fundsFlow: 'CASH_DRAWER', cashMachineRef: null, tenderLabel: null, tenderCountsAsCash: null, tenderSatFormaPago: null })

    await refundService.recordRefund(VENUE, cuerpo(16000) as any, 'staff-1')

    expect((prismaMock as any).payment.create.mock.calls[0][0].data).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
    expect(orden).toEqual(['turno'])
    expect(eventosEnTx.create).not.toHaveBeenCalled()
    expect(eventosGlobales.createMany).toHaveBeenCalledTimes(1)
  })
})

describe('🔴 D5 (r3 #12): la TPV escribe lo que dice la matriz, celda por celda', () => {
  /** Lo pagado con el crédito de un Cambio (la TPV no resuelve su raíz: con crédito de Cambio, la respuesta no depende de ella). */
  const credito = { method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', cashMachineRef: null, tenderLabel: 'Crédito de cambio' }
  const delCajon = { fundsFlow: 'CASH_DRAWER', cashMachineRef: null, tenderLabel: null, tenderCountsAsCash: null, tenderSatFormaPago: null }

  it.each([
    ['MAQUINA', false],
    ['ORDINARIO', false],
    ['ORDINARIO', true],
    ['CADENA_DE_MAQUINA', true],
  ] as Array<[OrigenDelDinero, boolean]>)(
    '%s · crédito de Cambio %s: la TPV no escoge medio, así que las 5 celdas dicen lo mismo',
    (o, c) => {
      const primera = celda(o, c, 'TPV', '—')
      for (const medio of MEDIOS) expect(celda(o, c, 'TPV', medio)).toEqual(primera)
    },
  )

  it.each(['ORDINARIO', 'CADENA_DE_MAQUINA'] as OrigenDelDinero[])(
    '🔴 r3 #12 · el reemplazo de un Cambio (raíz %s): 400 NO_ADMITIDO_EN_ESTA_ENTRADA con «POS o panel», antes de tocar nada',
    async origen => {
      const esperado = celda(origen, true, 'TPV', '—')
      if (esperado.admitido) throw new Error('la matriz debía rechazarla')
      armar({ ...credito, tenderType: { systemKind: 'EXCHANGE_CREDIT' } })

      await expect(refundService.recordRefund(VENUE, cuerpo(16000) as any, 'staff-1', undefined, 'payments:refund')).rejects.toMatchObject({
        statusCode: 400,
        code: esperado.codigo,
        message: esperado.mensaje,
        details: { dondeIr: esperado.dondeIr },
      })
      expect(transacciones).toBe(0)
      expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
    },
  )

  it('la venta de la máquina: con el permiso que pide la matriz, sale de la gaveta (CASH_DRAWER y su PAY_OUT en la transacción)', async () => {
    const esperado = celda('MAQUINA', false, 'TPV', '—')
    if (!esperado.admitido) throw new Error('la matriz debía admitirla')
    expect(esperado.destinoEfectivo).toBe('GAVETA')
    armar()
    await refundService.recordRefund(VENUE, cuerpo(16000) as any, 'staff-1', undefined, esperado.permisoRequerido)
    expect((prismaMock as any).payment.create.mock.calls[0][0].data).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
    expect(eventosEnTx.create).toHaveBeenCalledTimes(1)
  })

  it('una venta ordinaria: por el mismo medio con payments:refund, sin tocar la gaveta en la transacción', async () => {
    const esperado = celda('ORDINARIO', false, 'TPV', '—')
    expect(esperado).toEqual({ admitido: true, destinoEfectivo: 'MISMO_MEDIO', permisoRequerido: 'payments:refund' })
    armar(delCajon)
    await refundService.recordRefund(VENUE, cuerpo(16000) as any, 'staff-1', undefined, 'payments:refund')
    expect((prismaMock as any).payment.create.mock.calls[0][0].data).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
    expect(eventosEnTx.create).not.toHaveBeenCalled()
  })
})

describe('🔴 H7 (Codex servidor r5): lo pagado con saldo en la TPV — la matriz y el escritor dicen lo mismo (no se admite)', () => {
  const esperado = MATRIZ_DEL_SALDO.find(([e, m]) => e === 'TPV' && m === '—')![2]
  const saldo = {
    method: 'OTHER',
    fundsFlow: 'EXTERNAL_RECORDED',
    cashMachineRef: null,
    tenderLabel: 'Saldo a favor',
    tenderSatFormaPago: null,
  }

  it('la matriz lo manda al POS o al panel, en las 5 celdas', () => {
    if (esperado.admitido) throw new Error('la matriz debía rechazarla')
    expect(esperado.dondeIr).toEqual(['POS', 'PANEL'])
    for (const [, , d] of MATRIZ_DEL_SALDO.filter(([e]) => e === 'TPV')) expect(d).toEqual(esperado)
  })

  it('saldo a favor: el escritor contesta el MISMO 400 de la matriz, antes de tocar nada', async () => {
    if (esperado.admitido) throw new Error('la matriz debía rechazarla')
    armar({ ...saldo, tenderType: { systemKind: 'STORE_CREDIT' } })
    await expect(refundService.recordRefund(VENUE, cuerpo(16000) as any, 'staff-1', undefined, 'payments:refund')).rejects.toMatchObject({
      statusCode: 400,
      code: esperado.codigo,
      message: esperado.mensaje,
      details: { dondeIr: esperado.dondeIr },
    })
    expect(transacciones).toBe(0)
  })

  it('tarjeta de regalo: el escritor tampoco la admite (con su código de siempre, que conoce la terminal)', async () => {
    armar({ ...saldo, tenderType: { systemKind: 'GIFT_CARD' } })
    await expect(refundService.recordRefund(VENUE, cuerpo(16000) as any, 'staff-1', undefined, 'payments:refund')).rejects.toMatchObject({
      statusCode: 400,
      code: 'GIFT_CARD_REFUND_TO_BALANCE_ONLY',
    })
    expect(transacciones).toBe(0)
  })
})

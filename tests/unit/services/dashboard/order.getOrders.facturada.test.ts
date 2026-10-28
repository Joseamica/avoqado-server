/**
 * «Nueva factura» (Facturas del dashboard, 28-oct-2026): el listado de ventas dice qué ventas ya tienen su factura, para que el buscador
 * las marque antes de que alguien llene el formulario. La regla es la del candado de emisión (`facturaDeLaVenta.ts`); el candado sigue
 * siendo del servidor y esto sólo avisa antes.
 *
 * 🔴 Opt-in: sólo con `conFactura` (el controlador lo deja pasar con el tope de 100 por página). Sin él, la fila y la consulta quedan
 * como siempre: el listado legado (hasta 10,000) y los demás llamadores no pagan la consulta extra (Codex plan r1 #3).
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { getOrders } from '@/services/dashboard/order.dashboard.service'
import {
  CAMPOS_DE_LA_REGLA,
  estadoDeFacturaDeLaVenta,
  facturaDeLaVenta,
  FACTURAS_QUE_CUENTAN_DE_LA_VENTA,
} from '@/services/fiscal/facturaDeLaVenta'

const VENUE = 'venue-1'

function fila(over: Record<string, unknown> = {}) {
  return { id: 'order-1', venueId: VENUE, orderNumber: 'ORD-1', status: 'COMPLETED', total: 100, payments: [], ...over }
}

beforeEach(() => {
  ;(prismaMock.order.findMany as jest.Mock).mockReset()
  ;(prismaMock.order.count as jest.Mock).mockReset()
  // `getOrders` usa la forma de arreglo de $transaction (listado + conteo); el mock global sólo trae la de callback.
  ;(prismaMock.$transaction as jest.Mock).mockImplementation((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prismaMock)))
})

afterAll(() => {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation((callback: any) => callback(prismaMock))
})

describe('facturaDeLaVenta — la regla del candado de emisión (`issueCfdiForOrder`)', () => {
  const f = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    replacesCfdiId: null,
    status: 'STAMPED',
    cancelStatus: null,
    ...over,
  })

  it('timbrada sin cancelación pedida (o con la cancelación rechazada) = VIGENTE', () => {
    expect(estadoDeFacturaDeLaVenta([f('a')])).toBe('VIGENTE')
    expect(estadoDeFacturaDeLaVenta([f('a', { cancelStatus: 'REJECTED' })])).toBe('VIGENTE')
  })

  it('con la cancelación pedida = EN_CANCELACION: sólo el servidor, con el PAC, sabe si ya se puede volver a facturar', () => {
    expect(estadoDeFacturaDeLaVenta([f('a', { cancelStatus: 'REQUESTED' })])).toBe('EN_CANCELACION')
    expect(estadoDeFacturaDeLaVenta([f('a', { status: 'CANCEL_REQUESTED' })])).toBe('EN_CANCELACION')
  })

  it('sustitución: la original se cancela y la sustituta sigue timbrada ⇒ VIGENTE con la SUSTITUTA', () => {
    const r = facturaDeLaVenta([f('A', { cancelStatus: 'REQUESTED' }), f('B', { replacesCfdiId: 'A' })])
    expect(r).toEqual({ estado: 'VIGENTE', factura: expect.objectContaining({ id: 'B' }) })
  })

  it('🔴 Codex código r1 #1: el SAT rechazó cancelar la original y las dos siguen timbradas ⇒ manda la SUSTITUTA, no la primera', () => {
    const r = facturaDeLaVenta([f('A', { cancelStatus: 'REJECTED' }), f('B', { replacesCfdiId: 'A' })])
    expect(r).toEqual({ estado: 'VIGENTE', factura: expect.objectContaining({ id: 'B' }) })
  })

  it('se cancela la sustituta y la original sigue en pie ⇒ la venta está facturada con la ORIGINAL (como el candado)', () => {
    const r = facturaDeLaVenta([f('A'), f('B', { replacesCfdiId: 'A', cancelStatus: 'REQUESTED' })])
    expect(r).toEqual({ estado: 'VIGENTE', factura: expect.objectContaining({ id: 'A' }) })
  })

  it('las dos en cancelación ⇒ EN_CANCELACION: el candado le pregunta al PAC por las dos antes de decidir', () => {
    const r = facturaDeLaVenta([f('A', { cancelStatus: 'REQUESTED' }), f('B', { replacesCfdiId: 'A', cancelStatus: 'REQUESTED' })])
    expect(r?.estado).toBe('EN_CANCELACION')
  })

  it('sin facturas que cuenten = null (cancelada, fallida o ninguna)', () => {
    expect(facturaDeLaVenta([])).toBeNull()
    expect(facturaDeLaVenta(undefined)).toBeNull()
    expect(facturaDeLaVenta([f('a', { status: 'CANCELLED', cancelStatus: 'ACCEPTED' })])).toBeNull()
    expect(facturaDeLaVenta([f('a', { status: 'STAMP_FAILED' })])).toBeNull()
  })

  it('sólo cuentan las individuales de ingreso, timbradas o en cancelación, y se piden los campos de la regla', () => {
    expect(FACTURAS_QUE_CUENTAN_DE_LA_VENTA).toEqual({
      isGlobal: false,
      type: 'INGRESO',
      status: { in: ['STAMPED', 'CANCEL_REQUESTED'] },
    })
    expect(CAMPOS_DE_LA_REGLA).toEqual({ id: true, replacesCfdiId: true, status: true, cancelStatus: true })
  })
})

describe('getOrders · conFactura', () => {
  it('con `conFactura` pide las facturas que cuentan y marca cada venta', async () => {
    ;(prismaMock.order.findMany as jest.Mock).mockResolvedValue([
      fila({ id: 'vigente', cfdis: [{ id: 'c1', replacesCfdiId: null, status: 'STAMPED', cancelStatus: null }] }),
      fila({ id: 'cancelando', cfdis: [{ id: 'c2', replacesCfdiId: null, status: 'STAMPED', cancelStatus: 'REQUESTED' }] }),
      fila({ id: 'sin-factura', cfdis: [] }),
    ])
    ;(prismaMock.order.count as jest.Mock).mockResolvedValue(3)

    const res = await getOrders(VENUE, 1, 20, undefined, { conFactura: true })

    const args = (prismaMock.order.findMany as jest.Mock).mock.calls[0][0]
    expect(args.include.cfdis).toEqual({ where: FACTURAS_QUE_CUENTAN_DE_LA_VENTA, select: CAMPOS_DE_LA_REGLA })
    expect(res.data.map((o: any) => [o.id, o.facturada, o.facturaEnCancelacion])).toEqual([
      ['vigente', true, false],
      ['cancelando', false, true],
      ['sin-factura', false, false],
    ])
    expect(res.data[0]).not.toHaveProperty('cfdis')
    expect(res.data[0]).not.toHaveProperty('payments')
  })

  // Regresión: sin pedirlo, todo queda como antes.
  it('sin `conFactura` no lee facturas ni agrega campos', async () => {
    ;(prismaMock.order.findMany as jest.Mock).mockResolvedValue([fila()])
    ;(prismaMock.order.count as jest.Mock).mockResolvedValue(1)

    const res = await getOrders(VENUE, 1, 20)

    const args = (prismaMock.order.findMany as jest.Mock).mock.calls[0][0]
    expect(args.include).not.toHaveProperty('cfdis')
    expect(res.data[0]).not.toHaveProperty('facturada')
    expect(res.data[0]).not.toHaveProperty('facturaEnCancelacion')
  })

  it('sigue calculando el reembolso, la página y el total como siempre', async () => {
    ;(prismaMock.order.findMany as jest.Mock).mockResolvedValue([fila({ payments: [] })])
    ;(prismaMock.order.count as jest.Mock).mockResolvedValue(41)

    const res = await getOrders(VENUE, 2, 20, undefined, { conFactura: true })

    expect(res.data[0]).toMatchObject({ refundState: 'NONE', refundedAmount: 0 })
    expect(res.meta).toEqual({ total: 41, page: 2, pageSize: 20, pageCount: 3 })
    const args = (prismaMock.order.findMany as jest.Mock).mock.calls[0][0]
    expect(args.skip).toBe(20)
    expect(args.take).toBe(20)
    expect(args.where.venueId).toBe(VENUE)
    expect(args.include.payments).toEqual({ where: { status: 'COMPLETED' }, select: { amount: true, tipAmount: true, type: true } })
  })
})

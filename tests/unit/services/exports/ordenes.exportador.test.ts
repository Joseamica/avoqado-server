jest.mock('@/services/dashboard/order.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/order.dashboard.service'),
  fetchOrdersExportPage: jest.fn(async () => []),
}))

import { fetchOrdersExportPage } from '@/services/dashboard/order.dashboard.service'
import { ordenes, ORDENES_COLUMNAS } from '@/services/exports/exportadores/ordenes.exportador'
import { KINDS_EXPORTE, obtenerExportador } from '@/services/exports/exportadores/registry'

const fila = {
  id: 'cord00000000000000000001',
  createdAt: new Date('2026-10-15T18:00:00Z'),
  orderNumber: 'ORD-1',
  type: 'DINE_IN',
  status: 'COMPLETED',
  servedBy: null,
  createdBy: { firstName: 'Ana', lastName: 'Ruiz' },
  table: { number: '7' },
  _count: { items: 3 },
  tipAmount: '10.50',
  total: '110.5',
  customerName: null,
}
const v = (id: string, f: object = fila) => ORDENES_COLUMNAS.find(c => c.id === id)!.value(f as never)

describe('exportador ordenes', () => {
  it('las 11 columnas del exporte de hoy, en el mismo orden', () => {
    expect(ORDENES_COLUMNAS.map(c => c.id)).toEqual([
      'createdAt',
      'orderId',
      'orderNumber',
      'type',
      'customerName',
      'tableName',
      'waiterName',
      'status',
      'productsCount',
      'tipAmount',
      'total',
    ])
    expect(ORDENES_COLUMNAS.map(c => c.label)).toEqual([
      'Fecha',
      'ID',
      'Folio',
      'Tipo',
      'Cliente',
      'Mesa',
      'Mesero',
      'Estatus',
      'Productos',
      'Propina',
      'Total',
    ])
    expect(ordenes).toMatchObject({ kind: 'ordenes', titulo: 'Órdenes', nombreArchivo: 'orders', permiso: 'orders:read' })
  })
  it('valores', () => {
    expect(v('waiterName')).toBe('Ana Ruiz')
    expect(v('tableName')).toBe('7')
    expect(v('productsCount')).toBe(3)
    expect(v('tipAmount')).toBe(10.5)
    expect(v('total')).toBe(110.5)
    expect(v('customerName')).toBe('')
    expect(v('waiterName', { ...fila, servedBy: { firstName: 'Luis', lastName: null } })).toBe('Luis')
  })
  it('parsearFiltros acepta CSV y arreglos, y su propia salida; no exige fechas', () => {
    const f = ordenes.parsearFiltros({
      statuses: 'COMPLETED,PENDING',
      types: ['FAST'],
      search: '  mesa 4 ',
      startDate: '2026-10-01T06:00:00.000Z',
    })
    expect(f).toEqual({
      statuses: ['COMPLETED', 'PENDING'],
      types: ['FAST'],
      tableIds: undefined,
      staffIds: undefined,
      search: 'mesa 4',
      startDate: '2026-10-01T06:00:00.000Z',
      endDate: undefined,
    })
    expect(ordenes.parsearFiltros(f)).toEqual(f)
    expect(() => ordenes.parsearFiltros({ startDate: 'no' })).toThrow(/startDate must be a valid ISO date/)
  })
  it('autorizar: hoy no hay función de plan para órdenes', async () => {
    expect(await ordenes.autorizar({ venueId: 'v1', staffId: 's1', esSuperadmin: false }, {})).toBeNull()
  })
  it('pagina pide por keyset con corte', async () => {
    const corte = new Date()
    const t = new Date('2026-10-05T00:00:00.000Z')
    await ordenes.pagina('v1', {}, corte, { createdAt: t.toISOString(), id: 'c2' }, 500)
    expect(fetchOrdersExportPage).toHaveBeenCalledWith(
      'v1',
      {},
      corte,
      { OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: 'c2' } }] },
      500,
    )
  })
  it('está registrado', () => {
    expect(obtenerExportador('ordenes')).toBe(ordenes)
    expect(KINDS_EXPORTE).toContain('ordenes')
  })
})

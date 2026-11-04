jest.mock('@/services/dashboard/payment.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/payment.dashboard.service'),
  fetchPaymentsExportPage: jest.fn(async () => []),
}))

import { fetchPaymentsExportPage, PAYMENTS_EXPORT_SELECT } from '@/services/dashboard/payment.dashboard.service'
import { construirWhereKeyset } from '@/services/exports/exportadores/comun'
import { cobros, COBROS_COLUMNAS } from '@/services/exports/exportadores/cobros.exportador'
import { obtenerExportador } from '@/services/exports/exportadores/registry'

/** Deja de una fila sólo las llaves que pide el select (un nivel de relaciones), como haría Prisma. */
function proyectar(fila: Record<string, any>, select: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(select).map(([k, v]) => [k, v === true ? fila[k] : fila[k] == null ? fila[k] : proyectar(fila[k], v.select)]),
  )
}

// Una fila como la devuelve el GET viejo (`include`): TODAS las columnas del cobro + relaciones + la orden.
const filaCompleta = {
  id: 'cpay00000000000000000001',
  venueId: 'v1',
  orderId: 'o1',
  createdAt: new Date('2026-10-15T18:00:00Z'),
  updatedAt: new Date(),
  method: 'CREDIT_CARD',
  source: 'TPV',
  cardBrand: 'VISA',
  maskedPan: '411111******4242',
  processorData: { isInternational: 'true' },
  amount: '150.00',
  tipAmount: '15.00',
  status: 'COMPLETED',
  referenceNumber: 'R1',
  authorizationNumber: 'A1',
  feeAmount: '3.1',
  processedBy: { firstName: 'Ana', lastName: 'López' },
  merchantAccount: null,
  ecommerceMerchant: { channelName: 'Tienda en línea' },
  order: { id: 'o1', table: { number: '7' } },
}

describe('exportador cobros', () => {
  it('las 13 columnas del exporte de hoy, en el mismo orden', () => {
    expect(COBROS_COLUMNAS.map(c => c.id)).toEqual([
      'createdAt',
      'paymentId',
      'waiterName',
      'merchantAccount',
      'method',
      'source',
      'international',
      'cardBrand',
      'last4',
      'amount',
      'tipAmount',
      'totalAmount',
      'status',
    ])
    expect(cobros).toMatchObject({ kind: 'cobros', titulo: 'Pagos', nombreArchivo: 'payments', permiso: 'payments:read' })
  })
  it('🔴 paridad: la fila angosta del exporte nuevo da los MISMOS valores que la fila completa del GET viejo', () => {
    const angosta = proyectar(filaCompleta, PAYMENTS_EXPORT_SELECT as any)
    for (const c of COBROS_COLUMNAS) expect([c.id, c.value(angosta as never)]).toEqual([c.id, c.value(filaCompleta as never)])
  })
  it('valores: comercio en línea de respaldo, internacional en true o "true", total y últimos 4', () => {
    const v = (id: string) => COBROS_COLUMNAS.find(c => c.id === id)!.value(filaCompleta as never)
    expect(v('merchantAccount')).toBe('Tienda en línea')
    expect(v('international')).toBe('Sí')
    expect(v('totalAmount')).toBe(165)
    expect(v('last4')).toBe('4242')
    expect(v('waiterName')).toBe('Ana López')
  })
  it('parsearFiltros acepta CSV (del DASHBOARD) y arreglos, y su propia salida; no exige fechas (como hoy)', () => {
    const f = cobros.parsearFiltros({
      merchantAccountIds: 'a,b',
      methods: ['CASH'],
      sources: 'TPV',
      staffIds: '',
      search: ' 1234 ',
      startDate: '2026-10-01T06:00:00.000Z',
    })
    expect(f).toEqual({
      merchantAccountIds: ['a', 'b'],
      methods: ['CASH'],
      sources: ['TPV'],
      staffIds: undefined,
      search: '1234',
      startDate: '2026-10-01T06:00:00.000Z',
      endDate: undefined,
    })
    expect(() => cobros.parsearFiltros({ endDate: 'ayer' })).toThrow(/endDate must be a valid ISO date/)
    expect(cobros.parsearFiltros(f)).toEqual(f)
    expect(cobros.parsearFiltros(undefined)).toEqual(expect.objectContaining({ startDate: undefined }))
  })
  it('autorizar: hoy no hay función de plan para cobros', async () => {
    expect(await cobros.autorizar({ venueId: 'v1', staffId: 's1', esSuperadmin: false }, {})).toBeNull()
  })
  it('pagina pide por keyset', async () => {
    const corte = new Date()
    const cursor = { createdAt: '2026-10-15T18:00:00.000Z', id: 'cpay2' }
    await cobros.pagina('v1', {}, corte, cursor, 500)
    expect(fetchPaymentsExportPage).toHaveBeenCalledWith('v1', {}, corte, construirWhereKeyset(cursor), 500)
  })
  it('está registrado', () => {
    expect(obtenerExportador('cobros')?.kind).toBe('cobros')
  })
})

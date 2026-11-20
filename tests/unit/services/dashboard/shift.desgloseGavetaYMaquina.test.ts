/**
 * Máquina de efectivo 1a · R5 #11 (y R4-7 #12): en el detalle del turno, el renglón Efectivo parte sus VENTAS en dos hijos,
 * «Gaveta» (el efectivo que está en el cajón, según `tenderSemantics`) y «Efectivo · máquina» (lo que cobró la QuickPay). La
 * propina va en su columna y los vales siguen bajo su método. La cabecera de Efectivo es la suma exacta de sus hijos.
 *
 * Se prueba la RESPUESTA real de `getShiftById`, con la consulta que hace y las filas que devuelve Prisma.
 *
 * 🔴 Decisión: los hijos de Efectivo sólo aparecen si el turno tiene al menos una venta de la máquina. Un turno sin máquina
 * responde exactamente lo de hoy (sin un «Gaveta» solitario que cambiaría la vista de todos los turnos viejos).
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { getShiftById } from '@/services/dashboard/shift.dashboard.service'

const CAJERA = { id: 'staff-1', firstName: 'Ana', lastName: 'López' }

const cobro = (id: string, over: Record<string, unknown>) => ({
  id,
  amount: 0,
  tipAmount: 0,
  method: 'CASH',
  fundsFlow: 'CASH_DRAWER',
  tenderTypeId: null,
  tenderCountsAsCash: null,
  cashMachineRef: null,
  tenderLabel: null,
  externalSource: null,
  cardBrand: null,
  maskedPan: null,
  processorData: null,
  processedById: CAJERA.id,
  processedBy: CAJERA,
  orderId: `orden-${id}`,
  createdAt: new Date('2026-11-20T16:00:00.000Z'),
  order: { items: [] },
  type: 'REGULAR',
  ...over,
})

/** $100 en la gaveta + $10 de propina (también en la gaveta). */
const enLaGaveta = cobro('gaveta', { amount: 100, tipAmount: 10 })
/** $150 que cobró la QuickPay: `snapshotDeLaMaquina`. */
const enLaMaquina = cobro('maquina', {
  amount: 150,
  fundsFlow: 'EXTERNAL_RECORDED',
  tenderCountsAsCash: false,
  tenderLabel: 'Efectivo · máquina',
  cashMachineRef: 'AQ0000000000AB',
})
/** Un vale de despensa que cuenta como efectivo físico: sigue bajo SU método. */
const unVale = cobro('vale', {
  amount: 80,
  method: 'OTHER',
  tenderTypeId: 'tender-vale',
  tenderCountsAsCash: true,
  tenderLabel: 'Vale de despensa',
})

const turno = (payments: unknown[]) => ({
  id: 'shift-1',
  venueId: 'venue-1',
  staffId: CAJERA.id,
  status: 'CLOSED',
  startTime: new Date('2026-11-20T14:00:00.000Z'),
  endTime: new Date('2026-11-20T22:00:00.000Z'),
  startingCash: 0,
  endingCash: 0,
  totalSales: 330,
  totalTips: 10,
  staff: { ...CAJERA, email: 'ana@example.test' },
  venue: { id: 'venue-1', name: 'Venue', timezone: 'America/Mexico_City' },
  payments,
  orders: [],
})

const renglon = (detalle: any, method: string) => detalle.paymentMethodBreakdown.find((r: { method: string }) => r.method === method)

describe('detalle del turno · Efectivo = Gaveta + Efectivo · máquina (R5 #11)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.order.findMany.mockResolvedValue([])
  })

  it('🔴 $100 en gaveta + $10 de propina + $150 en la máquina + un vale ⇒ Efectivo $250 = Gaveta $100 + máquina $150', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(turno([enLaGaveta, enLaMaquina, unVale]) as any)

    const detalle = await getShiftById('venue-1', 'shift-1')

    const efectivo = renglon(detalle, 'CASH')
    expect(efectivo).toMatchObject({ total: 250, tips: 10, count: 2 })
    expect(efectivo.children).toEqual([
      { label: 'Efectivo · máquina', total: 150, tips: 0, count: 1 },
      { label: 'Gaveta', total: 100, tips: 10, count: 1 },
    ])
    // La cabecera es la suma exacta de sus hijos; la propina no se mezcla con las ventas.
    expect(efectivo.children.reduce((s: number, h: { total: number }) => s + h.total, 0)).toBe(efectivo.total)
    // El vale sigue bajo su método, no bajo Efectivo.
    expect(renglon(detalle, 'OTHER')).toMatchObject({ total: 80, children: [{ label: 'Vale de despensa', total: 80, tips: 0, count: 1 }] })

    // La consulta pide lo que la partición necesita (la autoridad del cajón y el folio de la máquina).
    const pedidas = (prismaMock.shift.findFirst.mock.calls[0][0] as any).include.payments.select
    expect(pedidas).toMatchObject({ method: true, fundsFlow: true, tenderTypeId: true, tenderCountsAsCash: true, cashMachineRef: true })
  })

  it('la devolución de una venta de la máquina sale de la GAVETA (CASH_DRAWER, sin folio) y la baja', async () => {
    const devolucion = cobro('devolucion', { amount: -150, type: 'REFUND' })
    prismaMock.shift.findFirst.mockResolvedValue(turno([enLaGaveta, enLaMaquina, devolucion]) as any)

    const detalle = await getShiftById('venue-1', 'shift-1')

    const efectivo = renglon(detalle, 'CASH')
    expect(efectivo.total).toBe(100)
    expect(efectivo.children).toEqual([
      { label: 'Efectivo · máquina', total: 150, tips: 0, count: 1 },
      { label: 'Gaveta', total: -50, tips: 10, count: 2 },
    ])
  })

  it('control — un turno SIN ventas de la máquina responde como hoy: Efectivo sin hijos', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(turno([enLaGaveta, unVale]) as any)

    const detalle = await getShiftById('venue-1', 'shift-1')

    const efectivo = renglon(detalle, 'CASH')
    expect(efectivo).toMatchObject({ total: 100, tips: 10, count: 1 })
    expect('children' in efectivo).toBe(false)
  })
})

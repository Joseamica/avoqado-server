/**
 * Máquina de efectivo 1a · R5 #11 (y R4-7 #12): en el detalle del turno, el renglón Efectivo parte sus VENTAS en dos hijos,
 * «Gaveta» (el efectivo que está en el cajón, según `tenderSemantics`) y «Efectivo · máquina» (lo que cobró la QuickPay). La
 * propina va en su columna y los vales siguen bajo su método. La cabecera de Efectivo es la suma exacta de sus hijos.
 *
 * Se prueba la RESPUESTA real de `getShiftById`, con la consulta que hace y las filas que devuelve Prisma. Codex r2 #12: los hijos se
 * suman en Postgres por destino (`aggregate` + `groupBy`), nunca recorriendo los pagos cargados del turno.
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

/** Lo que suma Postgres: la máquina (`aggregate`) y el resto del efectivo por cómo entró (`groupBy`). */
const sumaDeLaMaquina = (amount: number, count: number) => ({ _sum: { amount, tipAmount: 0 }, _count: { _all: count } })
const grupo = (over: Record<string, unknown>, amount: number, tipAmount: number, count: number) => ({
  fundsFlow: 'CASH_DRAWER',
  tenderTypeId: null,
  tenderCountsAsCash: null,
  tenderLabel: null,
  externalSource: null,
  ...over,
  _sum: { amount, tipAmount },
  _count: { _all: count },
})

const renglon = (detalle: any, method: string) => detalle.paymentMethodBreakdown.find((r: { method: string }) => r.method === method)

describe('detalle del turno · Efectivo = Gaveta + Efectivo · máquina (R5 #11)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.order.findMany.mockResolvedValue([])
  })

  it('🔴 $100 en gaveta + $10 de propina + $150 en la máquina + un vale ⇒ Efectivo $250 = Gaveta $100 + máquina $150', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(turno([enLaGaveta, enLaMaquina, unVale]) as any)
    prismaMock.payment.aggregate.mockResolvedValue(sumaDeLaMaquina(150, 1) as any)
    prismaMock.payment.groupBy.mockResolvedValue([grupo({}, 100, 10, 1)] as any)

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

    // Codex r2 #12: la partición la suma Postgres, con el MISMO filtro que la carga del turno (sólo CASH completados del turno).
    const filtro = { venueId: 'venue-1', shiftId: 'shift-1', status: 'COMPLETED', method: 'CASH' }
    expect(prismaMock.payment.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...filtro, cashMachineRef: { not: null } }, _sum: { amount: true, tipAmount: true } }),
    )
    expect(prismaMock.payment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: expect.arrayContaining(['fundsFlow', 'tenderTypeId', 'tenderCountsAsCash']),
        where: { ...filtro, cashMachineRef: null },
      }),
    )
  })

  it('🔴 Codex r2 #12: los hijos NO salen de recorrer los pagos cargados (la carga ni siquiera pide el folio)', async () => {
    // Aunque la fila cargada traiga folio, sin ventas de la máquina en Postgres no hay hijos: el desglose no se calcula en memoria.
    prismaMock.shift.findFirst.mockResolvedValue(turno([enLaGaveta, { ...enLaMaquina, tenderLabel: null }]) as any)
    prismaMock.payment.aggregate.mockResolvedValue(sumaDeLaMaquina(0, 0) as any)
    prismaMock.payment.groupBy.mockResolvedValue([grupo({}, 100, 10, 1)] as any)

    const detalle = await getShiftById('venue-1', 'shift-1')

    expect('children' in renglon(detalle, 'CASH')).toBe(false)
    const pedidas = (prismaMock.shift.findFirst.mock.calls[0][0] as any).include.payments.select
    expect(pedidas.cashMachineRef).toBeUndefined()
  })

  it('la devolución de una venta de la máquina sale de la GAVETA (CASH_DRAWER, sin folio) y la baja', async () => {
    const devolucion = cobro('devolucion', { amount: -150, type: 'REFUND' })
    prismaMock.shift.findFirst.mockResolvedValue(turno([enLaGaveta, enLaMaquina, devolucion]) as any)
    prismaMock.payment.aggregate.mockResolvedValue(sumaDeLaMaquina(150, 1) as any)
    prismaMock.payment.groupBy.mockResolvedValue([grupo({}, -50, 10, 2)] as any)

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
    prismaMock.payment.aggregate.mockResolvedValue(sumaDeLaMaquina(0, 0) as any)
    prismaMock.payment.groupBy.mockResolvedValue([grupo({}, 100, 10, 1)] as any)

    const detalle = await getShiftById('venue-1', 'shift-1')

    const efectivo = renglon(detalle, 'CASH')
    expect(efectivo).toMatchObject({ total: 100, tips: 10, count: 1 })
    expect('children' in efectivo).toBe(false)
  })

  it('🔴 r3 #8 / D6 / r6-8: los movimientos y el desglose salen de la MISMA foto (RepeatableRead, el mismo cliente de transacción)', async () => {
    // La foto ve sólo los $100 de la gaveta. Fuera de ella (el cliente global) ya entró la venta de $150 de la máquina: antes, la cabecera
    // salía de la foto vieja y los hijos de la nueva y la pantalla decía «Efectivo $100 · Gaveta $100 · máquina $150».
    const enLaFoto: any = {
      shift: { findFirst: jest.fn().mockResolvedValue(turno([enLaGaveta])) },
      // F11: las cuentas de los cobros del turno también se leen en la foto.
      order: { findMany: jest.fn().mockResolvedValue([]) },
      payment: {
        aggregate: jest.fn().mockResolvedValue(sumaDeLaMaquina(0, 0)),
        groupBy: jest.fn().mockResolvedValue([grupo({}, 100, 10, 1)]),
      },
    }
    prismaMock.shift.findFirst.mockResolvedValue(turno([enLaGaveta, enLaMaquina]) as any)
    prismaMock.payment.aggregate.mockResolvedValue(sumaDeLaMaquina(150, 1) as any)
    prismaMock.payment.groupBy.mockResolvedValue([grupo({}, 100, 10, 1)] as any)
    prismaMock.$transaction.mockImplementationOnce(async (cb: any) => cb(enLaFoto))

    const detalle = await getShiftById('venue-1', 'shift-1')

    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'RepeatableRead' }),
    )
    const efectivo = renglon(detalle, 'CASH')
    expect(efectivo).toMatchObject({ total: 100, tips: 10, count: 1 })
    expect('children' in efectivo).toBe(false)
    expect(prismaMock.payment.aggregate).not.toHaveBeenCalled()
    expect(enLaFoto.payment.aggregate).toHaveBeenCalled()
    // Los campos que leen las apps viejas siguen ahí.
    expect(detalle).toEqual(expect.objectContaining({ paymentMethodBreakdown: expect.any(Array), cardBrandBreakdown: expect.any(Array) }))
  })

  it('🔴 F11 (Codex servidor r4): el total de respaldo de un turno abierto y vacío sale de la MISMA foto: nunca $150 con cero pagos', async () => {
    // La foto ve el turno abierto sin cobros. Fuera de ella ya entró una venta de $150 de la máquina: antes el respaldo
    // (`ventasDelTurnoSinTarjetas`) la leía con el cliente global y el detalle decía totalSales=150 con stats.totalPayments=0.
    const abiertoYVacio = { ...turno([]), status: 'OPEN', endTime: null, totalSales: 0, totalTips: 0 }
    const enLaFoto: any = {
      shift: { findFirst: jest.fn().mockResolvedValue(abiertoYVacio) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
      payment: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 }, _count: { _all: 0 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    }
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: 150, tipAmount: 0 }, _count: { _all: 1 } } as any)
    prismaMock.$transaction.mockImplementationOnce(async (cb: any) => cb(enLaFoto))

    const detalle = await getShiftById('venue-1', 'shift-1')

    expect(detalle).toMatchObject({ totalSales: 0, payments: [], stats: expect.objectContaining({ totalPayments: 0 }) })
    expect(prismaMock.payment.aggregate).not.toHaveBeenCalled()
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })
})

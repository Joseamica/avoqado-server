/**
 * Máquina de efectivo 1a · «Cobros en duda» (R4-4, R5#5, R5#6, R5#7, R5#8). La PC perdió el mensaje de cierre: sube la duda (ESPERANDO)
 * con su carrito congelado y un GERENTE la resuelve con SU sesión, tecleando lo que ve en la máquina. La resolución registra la venta o
 * el cierre con el MISMO núcleo que la venta de la máquina (`resolvedBy GERENTE`), marca la duda RESUELTO en la misma transacción y,
 * sin la hora del comprobante, deja hora y turno «por conciliar».
 *
 * Corre el núcleo real contra el doble de Prisma, como `ventaDeLaMaquina.test.ts`.
 */
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  ...jest.requireActual('@/services/kds/kitchenDisplayStations'),
  debeMarcarCocina: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutForPayment: jest.fn().mockResolvedValue(null),
  finalizeAreaTicketPaymentInTransaction: jest.fn().mockResolvedValue({ areaTicketOrder: false }),
}))
jest.mock('@/services/shared/paymentShiftClaim', () => ({
  ...jest.requireActual('@/services/shared/paymentShiftClaim'),
  resolvePaymentShiftReconciliationEnabled: jest.fn().mockResolvedValue(false),
}))

import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  consultarDudaDeLaMaquina,
  listarDudasDeLaMaquina,
  resolverDudaDeLaMaquina,
  revisarIncidenciaDeLaMaquina,
  subirDudaDeLaMaquina,
  type DudaDeLaMaquina,
  type ResolucionDelGerente,
} from '@/services/cashMachine/dudasDeLaMaquina'
import * as decision from '@/services/cashMachine/decisionDelFolio'
import { consultarVentaDeLaMaquina, registrarVentaDeLaMaquina, type AutorDeLaMaquina } from '@/services/cashMachine/ventaDeLaMaquina'
import type { CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const D = (v: number) => new Prisma.Decimal(v)
const REF = 'AQ0123456789AB'
const PC: AutorDeLaMaquina = { userId: 'staff-cajera', deviceUid: 'pc-uid-1', credencial: 'credencial-de-la-pc' }
const GERENTE = 'staff-gerente'
const HASH_DE_LA_PC = createHash('sha256').update('credencial-de-la-pc').digest('hex')
const sqlDe = (a: any): string => (Array.isArray(a) ? a.join('?') : String(a?.sql ?? a?.strings?.join('?') ?? ''))

const carrito = { items: [{ name: 'Pastel', quantity: 1, unitPrice: 18750 }], orderType: 'TAKEOUT', source: 'AVOQADO_ANDROID' }
const pedidoArmado = (over: Partial<CreateOrderInput> = {}): CreateOrderInput =>
  ({ ...carrito, staffId: 'staff-cajera', ...over }) as unknown as CreateOrderInput
/** Lo que hace el controlador con el carrito congelado (leer + autoridad); aquí, un doble que registra con qué lo llamaron. */
const armarPedido = jest.fn(async (_pedido: Record<string, unknown>, _subidoPor: string) => pedidoArmado())

const duda = (over: Partial<DudaDeLaMaquina> = {}): DudaDeLaMaquina => ({
  referenceCC: REF,
  dueCents: 18750,
  saleCents: 18750,
  tipCents: 0,
  pedido: carrito,
  startedAt: '2026-11-20T17:58:00.000Z',
  lastSeen: [{ event: 'updateCredit', credit: '200.00' }],
  saleShiftId: 'shift-A',
  ...over,
})

const resolucion = (over: Partial<ResolucionDelGerente> = {}): ResolucionDelGerente => ({
  outcome: 'PAGADO',
  creditCents: 20000,
  changeDispensedCents: 1250,
  occurredAt: '2026-11-20T18:00:00.000Z',
  evidence: 'El comprobante dice Pago Completado $187.50, crédito $200, cambio $12.50',
  ...over,
})

let subtotalDelServidor: number
let turnoA: { id: string; status: string; endTime: Date | null; startTime: Date } | null
let cierres: any[]
/** La tabla de incidencias en memoria: las ESPERANDO (Prisma) y las durables del núcleo (SQL), por `kind`. */
let incidencias: Map<string, any>
let binding: { active: boolean; revokedAt?: Date } | null
let enTx: boolean
/** Las veces que se marcó la duda resuelta, y si fue dentro de la transacción. */
let marcas: Array<{ enTx: boolean; values: unknown[] }>

beforeEach(() => {
  jest.clearAllMocks()
  subtotalDelServidor = 187.5
  turnoA = { id: 'shift-A', status: 'OPEN', endTime: null, startTime: new Date('2026-11-20T14:00:00.000Z') }
  cierres = []
  incidencias = new Map()
  binding = { active: true }
  enTx = false
  marcas = []
  prismaMock.$transaction.mockImplementation(async (cb: any) => {
    enTx = true
    try {
      return await cb(prismaMock)
    } finally {
      enTx = false
    }
  })
  prismaMock.$queryRaw.mockImplementation(async (plantilla: any, ...resto: unknown[]) => {
    const sql = sqlDe(plantilla)
    if (sql.includes('CashMachineIncident')) {
      const values = Array.isArray(plantilla) ? resto : ((plantilla?.values ?? []) as unknown[])
      const kind = String(values.find(v => ['CONFLICTO', 'IMPOSIBLE', 'NO_SE_PUDO_REGISTRAR', 'TRAS_REVOCAR'].includes(String(v))))
      const crudo = values.find(v => typeof v === 'string' && v.startsWith('{"eventos"')) as string
      const previa = incidencias.get(kind)
      // El servicio acumula la evidencia bajo el candado (`acumularEvento`) y escribe el payload ENTERO y el estado.
      const estado = values.find(v => v === 'ABIERTO' || v === 'RESUELTO')
      if (previa) Object.assign(previa, { payload: JSON.parse(crudo), ...(estado ? { status: estado } : {}) })
      else
        incidencias.set(kind, {
          id: `inc-${kind}`,
          kind,
          status: 'ABIERTO',
          values,
          payload: JSON.parse(crudo),
          deviceId: values[values.indexOf(crudo) + 1],
        })
      return [{ id: `inc-${kind}` }]
    }
    if (sql.includes('hashtextextended')) return [{ pg_advisory_xact_lock: '' }]
    if (sql.includes('clock_timestamp')) return [{ ms: BigInt(Date.parse('2026-11-20T18:05:00.000Z')) }]
    return [{ id: 'order-1' }]
  })
  // Marcar la duda RESUELTO: un UPDATE con la resolución mezclada en el payload.
  prismaMock.$executeRaw.mockImplementation(async (plantilla: any, ...values: unknown[]) => {
    const sql = sqlDe(plantilla)
    if (sql.includes('CashMachineIncident') && sql.includes("'revisiones'")) {
      // La revisión de una incidencia (r2 #8): por id, sólo si sigue abierta.
      const fila = [...incidencias.values()].find(f => values.includes(f.id))
      if (!fila || fila.status !== 'ABIERTO') return 0
      const revision = JSON.parse(values.find(v => typeof v === 'string' && v.startsWith('{"nota"')) as string)
      fila.status = 'RESUELTO'
      fila.payload = { ...fila.payload, revision, revisiones: [...(fila.payload.revisiones ?? []), revision] }
      return 1
    }
    if (sql.includes('CashMachineIncident') && sql.includes('RESUELTO')) {
      marcas.push({ enTx, values })
      const fila = incidencias.get('ESPERANDO')
      // Codex r2 #4: sólo la duda de ESA PC (el UPDATE lleva el aparato).
      if (fila && fila.status === 'ABIERTO' && values.includes(fila.deviceId)) {
        const staff = values.find(v => v === GERENTE) ?? null
        const json = values.find(v => typeof v === 'string' && v.startsWith('{')) as string | undefined
        Object.assign(fila, {
          status: 'RESUELTO',
          resolvedByStaffId: staff,
          resolvedAt: new Date(),
          payload: { ...fila.payload, ...(json ? { resolucion: JSON.parse(json) } : {}) },
        })
        return 1
      }
      return 0
    }
    return 0
  })
  prismaMock.cashMachineIncident.findUnique.mockImplementation(async (a: any) => {
    const k = a?.where?.venueId_referenceCC_kind
    return k && k.referenceCC === REF ? (incidencias.get(k.kind) ?? null) : null
  })
  prismaMock.cashMachineIncident.findMany.mockImplementation(async (a: any) =>
    [...incidencias.values()].filter(f => !a?.where?.kind?.in || a.where.kind.in.includes(f.kind)),
  )
  prismaMock.cashMachineIncident.create.mockImplementation(async ({ data }: any) => {
    const fila = { id: 'duda-1', createdAt: new Date('2026-11-20T18:01:00.000Z'), resolvedByStaffId: null, resolvedAt: null, ...data }
    incidencias.set(data.kind, fila)
    return fila
  })
  prismaMock.staffVenue.findFirst.mockImplementation(async (a: any) => ({
    id: 'sv',
    staffId: a?.where?.staffId,
    venueId: 'venue-1',
    active: true,
  }))
  prismaMock.terminal.findFirst.mockResolvedValue({ id: 'terminal-pc' })
  prismaMock.cashMachineBinding.findFirst.mockImplementation(async (a: any) =>
    a?.where?.deviceId === 'terminal-pc' && a?.where?.credentialHash === HASH_DE_LA_PC ? binding : null,
  )
  prismaMock.shift.findFirst.mockImplementation(async (a: any) => {
    const where = a?.where ?? {}
    if (where.id) return turnoA && where.id === turnoA.id ? turnoA : null
    if (where.status?.in || where.status === 'OPEN') return { id: 'shift-A', status: 'OPEN' } // el turno vivo es A
    return null
  })
  prismaMock.shift.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.findFirst.mockResolvedValue({ shiftId: null })
  prismaMock.order.findUnique.mockImplementation(async (a: any) =>
    a?.where?.venueId_externalId
      ? null
      : {
          id: 'order-1',
          orderNumber: 'ORD-1',
          paymentStatus: 'PENDING',
          subtotal: D(subtotalDelServidor),
          discountAmount: D(0),
          serviceChargeAmount: D(0),
          status: 'CONFIRMED',
          contratoDePrecio: 'IVA_INCLUIDO',
          taxAmount: D(0),
          originSystem: 'AVOQADO',
          version: 1,
          areaTicketCode: null,
          tableId: null,
          total: D(subtotalDelServidor),
          paidAmount: D(0),
          remainingBalance: D(subtotalDelServidor),
        },
  )
  prismaMock.order.create.mockImplementation(async ({ data }: any) => ({ id: 'order-1', ...data, items: [], promotions: [] }))
  prismaMock.order.update.mockImplementation(async ({ data }: any) => ({
    id: 'order-1',
    orderNumber: 'ORD-1',
    ...data,
    items: [],
    promotions: [],
  }))
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.orderItem.findFirst.mockResolvedValue(null)
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => ({ id: 'payment-1', createdAt: new Date(), ...data }))
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'caja-abierta' })
  prismaMock.cashMachineClose.findUnique.mockImplementation(async () => cierres[0] ?? null)
  prismaMock.cashMachineClose.create.mockImplementation(async ({ data }: any) => {
    const fila = { id: 'close-1', createdAt: new Date(), ...data }
    cierres.push(fila)
    return fila
  })
})

const pagoCreado = () => prismaMock.payment.create.mock.calls[0]?.[0]?.data
const cierreCreado = () => prismaMock.cashMachineClose.create.mock.calls[0]?.[0]?.data
const subir = (over: Partial<DudaDeLaMaquina> = {}, autor = PC) => subirDudaDeLaMaquina('venue-1', autor, duda(over))
const resolver = (over: Partial<ResolucionDelGerente> = {}) =>
  resolverDudaDeLaMaquina('venue-1', GERENTE, REF, resolucion(over), armarPedido)

describe('subirDudaDeLaMaquina (la PC no sabe cómo terminó)', () => {
  it('🔴 la PC emparejada sube la duda: ESPERANDO ABIERTO con el carrito congelado, y la bitácora lo anota', async () => {
    await expect(subir()).resolves.toEqual({ status: 'ABIERTO', referenceCC: REF, incidentId: 'duda-1' })
    expect(prismaMock.cashMachineIncident.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.cashMachineIncident.create.mock.calls[0][0].data).toMatchObject({
      venueId: 'venue-1',
      referenceCC: REF,
      kind: 'ESPERANDO',
      status: 'ABIERTO',
      deviceId: 'terminal-pc',
      payload: {
        dueCents: 18750,
        saleCents: 18750,
        tipCents: 0,
        pedido: carrito,
        startedAt: '2026-11-20T17:58:00.000Z',
        lastSeen: [{ event: 'updateCredit', credit: '200.00' }],
        saleShiftId: 'shift-A',
        subidoPor: 'staff-cajera',
      },
    })
    // Bajo el candado del folio: el mismo que la venta de la máquina y su cierre.
    expect(prismaMock.$queryRaw.mock.calls.some((c: unknown[]) => sqlDe(c[0]).includes('hashtextextended'))).toBe(true)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CASH_MACHINE_DOUBT_OPENED', venueId: 'venue-1', staffId: 'staff-cajera' }),
    )
  })

  it('repetir la misma duda es idempotente: una sola fila y la misma respuesta, sin otro renglón en la bitácora', async () => {
    const primera = await subir()
    jest.mocked(logAction).mockClear()
    await expect(subir({ lastSeen: [{ event: 'pong' }] })).resolves.toEqual(primera)
    expect(prismaMock.cashMachineIncident.create).toHaveBeenCalledTimes(1)
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 la misma duda con otro adeudo es 409: los importes de la duda los fija la primera', async () => {
    await subir()
    await expect(subir({ dueCents: 19000, saleCents: 19000 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_DOUBT_CONFLICT',
    })
    expect(prismaMock.cashMachineIncident.create).toHaveBeenCalledTimes(1)
  })

  it('🔴 el folio ya tiene su cierre: responde esa evidencia (ya resuelto) y no abre una duda', async () => {
    await registrarVentaDeLaMaquina('venue-1', PC, {
      referenceCC: REF,
      cierre: {
        outcome: 'PAGADO',
        dueCents: 18750,
        saleCents: 18750,
        tipCents: 0,
        creditCents: 20000,
        changeDispensedCents: 1250,
        occurredAtKnown: true,
        occurredAt: '2026-11-20T18:00:00.000Z',
        saleShiftId: 'shift-A',
      },
      pedido: pedidoArmado(),
    })
    const r = await subir()
    expect(r).toMatchObject({ status: 'RESUELTO', referenceCC: REF, outcome: 'PAGADO', resolvedBy: 'MAQUINA', paymentId: 'payment-1' })
    expect(prismaMock.cashMachineIncident.create).not.toHaveBeenCalled()
  })

  it('🔴 otra caja sin la credencial: 403 y no escribe nada', async () => {
    await expect(subir({}, { ...PC, credencial: null })).rejects.toMatchObject({ statusCode: 403, code: 'CASH_MACHINE_NOT_PAIRED' })
    await expect(subir({}, { ...PC, credencial: 'otra' })).rejects.toMatchObject({ statusCode: 403 })
    expect(prismaMock.cashMachineIncident.create).not.toHaveBeenCalled()
  })

  it('🔴 la PC revocada re-envía SU duda: misma respuesta, sin otra fila ni incidencia', async () => {
    const primera = await subir()
    binding = { active: false }
    await expect(subir()).resolves.toEqual(primera)
    expect(prismaMock.cashMachineIncident.create).toHaveBeenCalledTimes(1)
    expect(incidencias.has('TRAS_REVOCAR')).toBe(false)
  })

  it('🔴 Codex r1 #5 (decisión d): la PC revocada entrega una duda NUEVA (cobró sin red antes del relevo): se guarda y queda TRAS_REVOCAR', async () => {
    binding = { active: false }
    await expect(subir()).resolves.toEqual({ status: 'ABIERTO', referenceCC: REF, incidentId: 'duda-1' })
    expect(incidencias.get('ESPERANDO')).toMatchObject({ status: 'ABIERTO', deviceId: 'terminal-pc' })
    expect(incidencias.has('TRAS_REVOCAR')).toBe(true)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_MACHINE_FOLIO_AFTER_UNPAIR' }))
  })

  it('🔴 R5#2: la PC revocada todavía sube el cierre real de SU duda (y la duda se cierra)', async () => {
    await subir()
    binding = { active: false }
    const r = await registrarVentaDeLaMaquina('venue-1', PC, {
      referenceCC: REF,
      cierre: {
        outcome: 'GUARDADO',
        cancelMode: '2',
        dueCents: 18750,
        saleCents: 18750,
        tipCents: 0,
        creditCents: 5000,
        changeDispensedCents: 0,
        occurredAtKnown: false,
      },
    })
    expect(r).toMatchObject({ status: 200, body: { outcome: 'GUARDADO', resolvedBy: 'MAQUINA' } })
    expect(incidencias.get('ESPERANDO')).toMatchObject({ status: 'RESUELTO' })
  })

  it('un adeudo que no es venta + propina es 400 y no escribe', async () => {
    await expect(subir({ dueCents: 19000 })).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.cashMachineIncident.create).not.toHaveBeenCalled()
  })
})

describe('consultarDudaDeLaMaquina (la PC pregunta cada 60 s, R5#6)', () => {
  it('abierta → { status: ABIERTO }; sin duda ni cierre → 404', async () => {
    await expect(consultarDudaDeLaMaquina('venue-1', REF)).rejects.toMatchObject({ statusCode: 404 })
    await subir()
    await expect(consultarDudaDeLaMaquina('venue-1', REF)).resolves.toEqual({ status: 'ABIERTO', referenceCC: REF, incidentId: 'duda-1' })
  })

  it('🔴 ida y vuelta: después de que el gerente resuelve, la consulta trae la MISMA evidencia que la venta', async () => {
    await subir()
    const r = await resolver()
    await expect(consultarDudaDeLaMaquina('venue-1', REF)).resolves.toEqual({ status: 'RESUELTO', ...r.body })
  })
})

describe('listarDudasDeLaMaquina (acotada, R4-4)', () => {
  const fila = (i: number) => ({
    id: `duda-${String(i).padStart(3, '0')}`,
    referenceCC: REF,
    kind: 'ESPERANDO',
    status: 'ABIERTO',
    deviceId: 'terminal-pc',
    createdAt: new Date(Date.UTC(2026, 10, 20, 18, 0, 0) - i * 1000),
    resolvedByStaffId: null,
    resolvedAt: null,
    payload: { dueCents: 18750, saleCents: 18750, tipCents: 0, pedido: carrito, startedAt: 'x', lastSeen: null, saleShiftId: 'shift-A' },
  })

  it('🔴 un límite hostil se recorta a 100; por omisión 50; orden estable y el total con el MISMO filtro', async () => {
    prismaMock.cashMachineIncident.count.mockResolvedValue(3)
    prismaMock.cashMachineIncident.findMany.mockResolvedValue([fila(1), fila(2), fila(3)])
    const r = await listarDudasDeLaMaquina('venue-1', { limit: 100000 })
    const consulta = prismaMock.cashMachineIncident.findMany.mock.calls[0][0]
    expect(consulta.take).toBe(101)
    expect(consulta.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    // Codex r1 #7: todas las incidencias abiertas, no sólo las dudas.
    const filtro = { venueId: 'venue-1', status: 'ABIERTO' }
    expect(consulta.where).toEqual(filtro)
    expect(prismaMock.cashMachineIncident.count.mock.calls[0][0].where).toEqual(filtro)
    expect(r).toMatchObject({ total: 3, nextCursor: null })
    expect(r.data[0]).toMatchObject({ id: 'duda-001', referenceCC: REF, dueCents: 18750, pedido: carrito, saleShiftId: 'shift-A' })
    await listarDudasDeLaMaquina('venue-1', {})
    expect(prismaMock.cashMachineIncident.findMany.mock.calls[1][0].take).toBe(51)
  })

  it('hay más: nextCursor; con él, la siguiente página empieza DESPUÉS de la última leída (sin saltar ni repetir)', async () => {
    prismaMock.cashMachineIncident.count.mockResolvedValue(3)
    prismaMock.cashMachineIncident.findMany.mockResolvedValueOnce([fila(1), fila(2), fila(3)])
    const r = await listarDudasDeLaMaquina('venue-1', { limit: 2, status: 'RESUELTO' })
    expect(r.data.map(d => d.id)).toEqual(['duda-001', 'duda-002'])
    expect(r.nextCursor).toEqual(expect.any(String))
    prismaMock.cashMachineIncident.findMany.mockResolvedValueOnce([fila(3)])
    const r2 = await listarDudasDeLaMaquina('venue-1', { limit: 2, status: 'RESUELTO', cursor: r.nextCursor! })
    const where = prismaMock.cashMachineIncident.findMany.mock.calls[1][0].where
    expect(where.AND[0]).toEqual({ venueId: 'venue-1', status: 'RESUELTO' })
    expect(where.AND[1]).toEqual({
      OR: [{ createdAt: { lt: fila(2).createdAt } }, { createdAt: fila(2).createdAt, id: { lt: 'duda-002' } }],
    })
    expect(r2).toMatchObject({ total: 3, nextCursor: null })
  })

  it('un cursor que no es nuestro es 400', async () => {
    await expect(listarDudasDeLaMaquina('venue-1', { cursor: 'no-es-un-cursor' })).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('resolverDudaDeLaMaquina (el gerente, con su sesión)', () => {
  beforeEach(async () => {
    await subir()
    jest.mocked(logAction).mockClear()
  })

  it('🔴 PAGADO: la venta nace con el carrito CONGELADO, en pesos, resuelta por el GERENTE del token', async () => {
    const r = await resolver({ changeDispensedCents: 1000 })
    expect(r).toEqual({
      status: 200,
      body: {
        referenceCC: REF,
        outcome: 'PAGADO',
        resolvedBy: 'GERENTE',
        owedKind: 'CAMBIO',
        orderId: 'order-1',
        paymentId: 'payment-1',
        dueCents: 18750,
        saleCents: 18750,
        tipCents: 0,
        appliedCents: 18750,
        excedenteCents: 0,
        creditCents: 20000,
        changeDispensedCents: 1000,
        owedCents: 250,
        shiftStatus: 'EN_TURNO',
      },
    })
    expect(armarPedido).toHaveBeenCalledWith(carrito, 'staff-cajera')
    expect(pagoCreado()).toMatchObject({
      amount: 187.5,
      method: 'CASH',
      fundsFlow: 'EXTERNAL_RECORDED',
      cashMachineRef: REF,
      idempotencyKey: `maquina-${REF}`,
      processedById: GERENTE,
    })
    expect(cierreCreado()).toMatchObject({
      resolvedBy: 'GERENTE',
      resolvedByStaffId: GERENTE,
      evidence: resolucion().evidence,
      deviceId: 'terminal-pc',
      occurredAtKnown: true,
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CASH_MACHINE_DOUBT_RESOLVED', venueId: 'venue-1', staffId: GERENTE }),
    )
  })

  it('🔴 la duda queda RESUELTO en la MISMA transacción que el cierre, con el gerente', async () => {
    await resolver()
    expect(marcas).toHaveLength(1)
    expect(marcas[0].enTx).toBe(true)
    expect(incidencias.get('ESPERANDO')).toMatchObject({ status: 'RESUELTO', resolvedByStaffId: GERENTE })
  })

  it('🔴 R5#8: sin la hora del comprobante → hora y turno POR CONCILIAR; nunca la hora de inicio ni la de resolución', async () => {
    const r = await resolver({ occurredAt: undefined })
    expect(r.body).toMatchObject({ shiftStatus: 'POR_CONCILIAR' })
    expect(cierreCreado()).toMatchObject({ occurredAt: null, occurredAtKnown: false })
    expect(pagoCreado().shiftId).toBeNull()
    expect(prismaMock.order.create.mock.calls[0][0].data.shiftId).toBeNull()
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
  })

  it('con la hora del comprobante, el cierre guarda ESA hora', async () => {
    await resolver({ occurredAt: '2026-11-20T18:00:00.000Z' })
    expect(cierreCreado().occurredAt).toEqual(new Date('2026-11-20T18:00:00.000Z'))
  })

  it('CANCELADO con devolución incompleta: cierre sin pago, NO_DEVUELTO, sin pedir el carrito', async () => {
    const r = await resolver({ outcome: 'CANCELADO', cancelMode: '1', creditCents: 5000, changeDispensedCents: 3000 })
    expect(r.body).toMatchObject({ outcome: 'CANCELADO', resolvedBy: 'GERENTE', owedKind: 'NO_DEVUELTO', owedCents: 2000, paymentId: null })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(armarPedido).not.toHaveBeenCalled()
    expect(marcas[0].enTx).toBe(true)
  })

  it.each([
    ['CANCELADO con el crédito completo', { outcome: 'CANCELADO', creditCents: 18750, changeDispensedCents: 0 }],
    ['GUARDADO con el crédito completo', { outcome: 'GUARDADO', creditCents: 20000, changeDispensedCents: 0 }],
    ['GUARDADO que devolvió algo', { outcome: 'GUARDADO', creditCents: 5000, changeDispensedCents: 100 }],
    ['PAGADO con cambio mayor que crédito − adeudo', { changeDispensedCents: 1300 }],
  ] as const)('🔴 R5#5 · %s → 422 con las MISMAS reglas que la máquina, sin pago y la duda sigue abierta', async (_n, over) => {
    await expect(resolver(over as Partial<ResolucionDelGerente>)).rejects.toMatchObject({
      statusCode: 422,
      code: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.cashMachineClose.create).not.toHaveBeenCalled()
    expect(incidencias.get('ESPERANDO')).toMatchObject({ status: 'ABIERTO' })
  })

  it('🔴 resolver otra vez con lo mismo devuelve la MISMA evidencia y un solo pago; con otros datos, 409 con lo registrado', async () => {
    const primera = await resolver()
    await expect(resolver({ evidence: 'otra persona lo leyó igual' })).resolves.toEqual(primera)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    await expect(resolver({ outcome: 'GUARDADO', cancelMode: '2', creditCents: 5000, changeDispensedCents: 0 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_CLOSE_CONFLICT',
      details: { registrado: primera.body },
    })
  })

  it('una duda que no existe es 404', async () => {
    incidencias.clear()
    await expect(resolver()).rejects.toMatchObject({ statusCode: 404, code: 'CASH_MACHINE_DOUBT_NOT_FOUND' })
  })

  it('🔴 la venta ya no se arma (producto borrado): 202 con el dinero en una incidencia, la duda se cierra y la PC lo ve', async () => {
    prismaMock.product.findMany.mockResolvedValue([])
    armarPedido.mockResolvedValueOnce(pedidoArmado({ items: [{ productId: 'prod-borrado', quantity: 1 }] as any }))
    const r = await resolver()
    expect(r).toEqual({
      status: 202,
      body: {
        referenceCC: REF,
        incident: 'NO_SE_PUDO_REGISTRAR',
        incidentId: 'inc-NO_SE_PUDO_REGISTRAR',
        motivo: 'VENTA_RECHAZADA',
        outcome: 'PAGADO',
        resolvedBy: 'GERENTE',
        dueCents: 18750,
        saleCents: 18750,
        tipCents: 0,
        creditCents: 20000,
        changeDispensedCents: 1250,
      },
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(incidencias.get('NO_SE_PUDO_REGISTRAR')).toBeDefined()
    expect(incidencias.get('ESPERANDO')).toMatchObject({ status: 'RESUELTO', resolvedByStaffId: GERENTE })
    await expect(consultarDudaDeLaMaquina('venue-1', REF)).resolves.toEqual({ status: 'RESUELTO', ...r.body })
    // La misma resolución otra vez: lo mismo, sin volver a armar la venta; otra, 409 con la declaración nueva guardada (r2 #9).
    await expect(resolver()).resolves.toEqual(r)
    await expect(resolver({ outcome: 'CANCELADO', cancelMode: '1', creditCents: 5000, changeDispensedCents: 0 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_CLOSE_CONFLICT',
    })
    expect(armarPedido).toHaveBeenCalledTimes(1)
    expect(incidencias.get('CONFLICTO').payload.eventos[0]).toMatchObject({
      cierre: { outcome: 'CANCELADO', creditCents: 5000 },
      resolvedBy: 'GERENTE',
      evidence: resolucion().evidence,
    })
  })

  it('🔴 si la PC sube después el cierre real, la duda se cierra sola (MAQUINA) en la misma transacción', async () => {
    await registrarVentaDeLaMaquina('venue-1', PC, {
      referenceCC: REF,
      cierre: {
        outcome: 'GUARDADO',
        cancelMode: '2',
        dueCents: 18750,
        saleCents: 18750,
        tipCents: 0,
        creditCents: 5000,
        changeDispensedCents: 0,
        occurredAtKnown: false,
      },
    })
    expect(marcas).toHaveLength(1)
    expect(marcas[0].enTx).toBe(true)
    expect(incidencias.get('ESPERANDO')).toMatchObject({ status: 'RESUELTO', resolvedByStaffId: null })
  })
})

describe('Codex r1 #3, #4, #6, #7 y #12 en las dudas', () => {
  const PC_B: AutorDeLaMaquina = { userId: 'staff-B', deviceUid: 'pc-uid-2', credencial: 'credencial-de-la-pc' }
  const cierrePagado = {
    outcome: 'PAGADO' as const,
    dueCents: 18750,
    saleCents: 18750,
    tipCents: 0,
    creditCents: 20000,
    changeDispensedCents: 1250,
    occurredAtKnown: true,
    occurredAt: '2026-11-20T18:00:00.000Z',
    saleShiftId: 'shift-A',
  }

  it('🔴 #3: el folio ya quedó «no se pudo registrar» (202): una duda tardía recibe ESE desenlace estable y no abre otra', async () => {
    const r = await registrarVentaDeLaMaquina('venue-1', PC, {
      referenceCC: REF,
      cierre: cierrePagado,
      pedido: pedidoArmado({ discount: 500 }),
    })
    expect(r.status).toBe(202)
    await expect(subir()).resolves.toEqual({ status: 'RESUELTO', ...r.body })
    expect(prismaMock.cashMachineIncident.create).not.toHaveBeenCalled()
    await expect(consultarDudaDeLaMaquina('venue-1', REF)).resolves.toEqual({ status: 'RESUELTO', ...r.body })
  })

  it('🔴 #10 (decisión a): una duda con cortesía NO se vuelve venta con los permisos del gerente que confirma el dinero: 202 DESCUENTO', async () => {
    await subir()
    armarPedido.mockResolvedValueOnce(
      pedidoArmado({
        items: [{ name: 'Pastel', quantity: 1, unitPrice: 18750, isCortesia: true, cortesiaReason: 'x' }] as any,
        canCompItems: true,
        performedBy: GERENTE,
      }),
    )
    const r = await resolver()
    expect(r).toMatchObject({ status: 202, body: { motivo: 'DESCUENTO', resolvedBy: 'GERENTE', creditCents: 20000 } })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(incidencias.get('ESPERANDO')).toMatchObject({ status: 'RESUELTO' })
  })

  it('🔴 #4: la duda la subió la PC A; la PC B (otra máquina) con el mismo folio recibe 409 con incidencia, nunca la duda de A', async () => {
    await subir()
    prismaMock.terminal.findFirst.mockResolvedValue({ id: 'terminal-B' })
    prismaMock.cashMachineBinding.findFirst.mockResolvedValue({ active: true })
    await expect(subir({}, PC_B)).rejects.toMatchObject({ statusCode: 409, code: 'CASH_MACHINE_DOUBT_CONFLICT' })
    expect(incidencias.get('CONFLICTO')).toBeDefined()
    expect(incidencias.get('ESPERANDO')).toMatchObject({ deviceId: 'terminal-pc', status: 'ABIERTO' })
  })

  it('🔴 #4: el cierre lo guardó A: la duda de B no recibe la evidencia de A (409)', async () => {
    await registrarVentaDeLaMaquina('venue-1', PC, { referenceCC: REF, cierre: cierrePagado, pedido: pedidoArmado() })
    prismaMock.terminal.findFirst.mockResolvedValue({ id: 'terminal-B' })
    prismaMock.cashMachineBinding.findFirst.mockResolvedValue({ active: true })
    await expect(subir({}, PC_B)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('🔴 #6: la duda ya está RESUELTO y el cierre todavía no se ve en la primera lectura: nunca fabrica «no se pudo registrar»', async () => {
    await subir()
    incidencias.get('ESPERANDO').status = 'RESUELTO'
    const r = await consultarDudaDeLaMaquina('venue-1', REF)
    expect(r).not.toMatchObject({ incident: 'NO_SE_PUDO_REGISTRAR' })
    expect(r).toEqual({ status: 'ABIERTO', referenceCC: REF, incidentId: 'duda-1' })
    // Con el cierre ya visible, la evidencia real.
    cierres.push({ id: 'close-1', referenceCC: REF, outcome: 'PAGADO', resolvedBy: 'GERENTE', deviceId: 'terminal-pc' })
    await expect(consultarDudaDeLaMaquina('venue-1', REF)).resolves.toMatchObject({ status: 'RESUELTO', outcome: 'PAGADO' })
  })

  it('🔴 #6: la duda se lee ANTES que el cierre', async () => {
    const orden: string[] = []
    prismaMock.cashMachineIncident.findUnique.mockImplementation(async () => (orden.push('duda'), null) as any)
    prismaMock.cashMachineClose.findUnique.mockImplementation(async () => (orden.push('cierre'), null) as any)
    await consultarDudaDeLaMaquina('venue-1', REF).catch(() => undefined)
    expect(orden.slice(0, 2)).toEqual(['duda', 'cierre'])
  })

  it('🔴 #7: una segunda duda con otros importes guarda la versión nueva (CONFLICTO) antes del 409', async () => {
    await subir()
    await expect(subir({ dueCents: 19000, saleCents: 19000 })).rejects.toMatchObject({ statusCode: 409 })
    const conflicto = incidencias.get('CONFLICTO')
    expect(conflicto.payload.eventos[0]).toMatchObject({ duda: { dueCents: 19000 }, registrada: { dueCents: 18750 } })
  })

  it('🔴 #12 (decisión h): una duda con adeudo de $187.35 o de $0 es 422 con incidencia, no una duda', async () => {
    await expect(subir({ dueCents: 18735, saleCents: 18735 })).rejects.toMatchObject({
      statusCode: 422,
      code: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
    })
    await expect(subir({ dueCents: 0, saleCents: 0 })).rejects.toMatchObject({ statusCode: 422 })
    expect(prismaMock.cashMachineIncident.create).not.toHaveBeenCalled()
    expect(incidencias.get('IMPOSIBLE')).toBeDefined()
  })
})

describe('Codex r1 #7: la bandeja trae todas las incidencias y el gerente revisa las que no son duda', () => {
  it('🔴 la lista trae el IMPOSIBLE de un 422 con su tipo, cuántas veces llegó y su evidencia', async () => {
    prismaMock.cashMachineIncident.count.mockResolvedValue(1)
    prismaMock.cashMachineIncident.findMany.mockResolvedValue([
      {
        id: 'inc-1',
        referenceCC: REF,
        kind: 'IMPOSIBLE',
        status: 'ABIERTO',
        deviceId: 'terminal-pc',
        createdAt: new Date('2026-11-20T18:00:00.000Z'),
        resolvedByStaffId: null,
        resolvedAt: null,
        payload: { eventos: [{ cierre: { outcome: 'CANCELADO', creditCents: 18750 } }, { cierre: { outcome: 'CANCELADO' } }], veces: 2 },
      },
    ] as any)
    const r = await listarDudasDeLaMaquina('venue-1', { kind: 'IMPOSIBLE', folio: 'aq0123' })
    expect(prismaMock.cashMachineIncident.findMany.mock.calls[0][0].where).toEqual({
      venueId: 'venue-1',
      status: 'ABIERTO',
      kind: 'IMPOSIBLE',
      referenceCC: { contains: 'AQ0123' },
    })
    expect(r.data[0]).toMatchObject({
      kind: 'IMPOSIBLE',
      veces: 2,
      primerEvento: { cierre: { outcome: 'CANCELADO', creditCents: 18750 } },
      ultimoEvento: { cierre: { outcome: 'CANCELADO' } },
    })
  })

  it('🔴 revisar: queda RESUELTO con el gerente y su nota, en la bitácora; repetirlo no hace nada', async () => {
    prismaMock.cashMachineIncident.findFirst.mockResolvedValue({
      id: 'inc-1',
      referenceCC: REF,
      kind: 'IMPOSIBLE',
      status: 'ABIERTO',
    } as any)
    prismaMock.$executeRaw.mockResolvedValue(1)
    await expect(revisarIncidenciaDeLaMaquina('venue-1', GERENTE, 'inc-1', 'La máquina devolvió todo', 1)).resolves.toEqual({
      id: 'inc-1',
      referenceCC: REF,
      kind: 'IMPOSIBLE',
      status: 'RESUELTO',
      version: 1,
    })
    const update = prismaMock.$executeRaw.mock.calls[0]
    expect(sqlDe(update[0])).toContain('"status" = \'ABIERTO\'')
    expect(update.slice(1)).toEqual(expect.arrayContaining([GERENTE, 'inc-1', 'venue-1']))
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_MACHINE_INCIDENT_REVIEWED', staffId: GERENTE }))
    prismaMock.cashMachineIncident.findFirst.mockResolvedValue({
      id: 'inc-1',
      referenceCC: REF,
      kind: 'IMPOSIBLE',
      status: 'RESUELTO',
    } as any)
    jest.mocked(logAction).mockClear()
    await revisarIncidenciaDeLaMaquina('venue-1', GERENTE, 'inc-1', 'otra vez', 1)
    expect(logAction).not.toHaveBeenCalled()
  })

  it('una duda (ESPERANDO) no se revisa: se resuelve (409); otra sucursal o un id inventado: 404', async () => {
    prismaMock.cashMachineIncident.findFirst.mockResolvedValue({
      id: 'd',
      referenceCC: REF,
      kind: 'ESPERANDO',
      status: 'ABIERTO',
    } as any)
    await expect(revisarIncidenciaDeLaMaquina('venue-1', GERENTE, 'd', 'x', 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_DOUBT_NEEDS_RESOLUTION',
    })
    prismaMock.cashMachineIncident.findFirst.mockResolvedValueOnce(null)
    await expect(revisarIncidenciaDeLaMaquina('venue-1', GERENTE, 'otro', 'x', 1)).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.cashMachineIncident.findFirst.mock.calls.at(-1)![0].where).toEqual({ id: 'otro', venueId: 'venue-1' })
  })
})

describe('Codex servidor r2 #1: la PC revocada conserva su revokedAt aunque exista SU duda', () => {
  const REVOCADA_EN = new Date('2026-11-20T18:30:00.000Z')
  const pagado = (occurredAt: string | null) => ({
    referenceCC: REF,
    cierre: {
      outcome: 'PAGADO' as const,
      dueCents: 18750,
      saleCents: 18750,
      tipCents: 0,
      creditCents: 20000,
      changeDispensedCents: 1250,
      occurredAtKnown: occurredAt !== null,
      occurredAt,
      saleShiftId: 'shift-A',
    },
    pedido: pedidoArmado(),
  })
  beforeEach(async () => {
    await subir() // la duda la subió la PC cuando todavía estaba emparejada
    binding = { active: false, revokedAt: REVOCADA_EN }
  })

  it('🔴 cobrado DESPUÉS de la revocación (o sin hora): 202 PC_REVOCADA con TRAS_REVOCAR, sin venta; su duda se cierra', async () => {
    for (const hora of ['2026-11-20T19:00:00.000Z', null]) {
      incidencias.delete('NO_SE_PUDO_REGISTRAR')
      incidencias.delete('TRAS_REVOCAR')
      incidencias.get('ESPERANDO').status = 'ABIERTO'
      const r = await registrarVentaDeLaMaquina('venue-1', PC, pagado(hora))
      expect(r).toMatchObject({ status: 202, body: { motivo: 'PC_REVOCADA', creditCents: 20000 } })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(incidencias.has('TRAS_REVOCAR')).toBe(true)
      expect(incidencias.get('ESPERANDO')).toMatchObject({ status: 'RESUELTO' })
    }
  })

  it('🔴 cobrado ANTES de la revocación: se registra la venta y queda TRAS_REVOCAR; la repetición exacta sí se permite', async () => {
    const r = await registrarVentaDeLaMaquina('venue-1', PC, pagado('2026-11-20T18:00:00.000Z'))
    expect(r.status).toBe(200)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(incidencias.get('TRAS_REVOCAR').payload.eventos[0]).toMatchObject({ registrable: true })
    await expect(registrarVentaDeLaMaquina('venue-1', PC, pagado('2026-11-20T18:00:00.000Z'))).resolves.toEqual(r)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('el gerente no está revocado: él declara lo que ve en la máquina y la venta se registra', async () => {
    await expect(resolver({ occurredAt: '2026-11-20T19:00:00.000Z' })).resolves.toMatchObject({ status: 200 })
  })
})

describe('Codex servidor r2 #4: un 202 de OTRA PC nunca cierra la duda de la dueña', () => {
  const PC_B: AutorDeLaMaquina = { userId: 'staff-B', deviceUid: 'pc-uid-2', credencial: 'credencial-de-la-pc' }

  it('🔴 B sube un PAGADO no registrable (con descuento) del folio de A: 409 OTRA_PC guardado, sin 202, y la duda de A sigue abierta', async () => {
    await subir()
    prismaMock.terminal.findFirst.mockResolvedValue({ id: 'terminal-B' })
    prismaMock.cashMachineBinding.findFirst.mockResolvedValue({ active: true })
    await expect(
      registrarVentaDeLaMaquina('venue-1', PC_B, {
        referenceCC: REF,
        cierre: {
          outcome: 'PAGADO',
          dueCents: 18750,
          saleCents: 18750,
          tipCents: 0,
          creditCents: 20000,
          changeDispensedCents: 1250,
          occurredAtKnown: true,
          occurredAt: '2026-11-20T18:00:00.000Z',
        },
        pedido: pedidoArmado({ discount: 500 }),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CASH_MACHINE_CLOSE_CONFLICT', details: { motivo: 'OTRA_PC', registrado: null } })
    expect(incidencias.has('NO_SE_PUDO_REGISTRAR')).toBe(false)
    expect(incidencias.get('CONFLICTO').payload.eventos[0]).toMatchObject({ motivo: 'OTRA_PC', deviceId: 'terminal-B' })
    expect(incidencias.get('ESPERANDO')).toMatchObject({ status: 'ABIERTO', deviceId: 'terminal-pc' })
    expect(marcas).toHaveLength(0)
  })

  it('🔴 el UPDATE que cierra la duda lleva el aparato: el 202 de la dueña sí la cierra', async () => {
    await subir()
    const r = await registrarVentaDeLaMaquina('venue-1', PC, {
      referenceCC: REF,
      cierre: {
        outcome: 'PAGADO',
        dueCents: 18750,
        saleCents: 18750,
        tipCents: 0,
        creditCents: 20000,
        changeDispensedCents: 1250,
        occurredAtKnown: true,
        occurredAt: '2026-11-20T18:00:00.000Z',
      },
      pedido: pedidoArmado({ discount: 500 }),
    })
    expect(r.status).toBe(202)
    expect(sqlDe(prismaMock.$executeRaw.mock.calls[0][0])).toContain('"deviceId" IS NOT DISTINCT FROM')
    expect(marcas[0].values).toContain('terminal-pc')
    expect(incidencias.get('ESPERANDO')).toMatchObject({ status: 'RESUELTO' })
  })
})

describe('Codex servidor r2 #10: el gerente declara el modo físico de un CANCELADO o GUARDADO', () => {
  beforeEach(async () => {
    await subir()
  })

  it.each([
    ['CANCELADO sin modo ($50 entraron, $0 regresaron: puede ser guardado o devolución fallida)', { outcome: 'CANCELADO' as const }],
    ['GUARDADO sin modo', { outcome: 'GUARDADO' as const }],
    ['GUARDADO con el modo de devolver', { outcome: 'GUARDADO' as const, cancelMode: '1' as const }],
    ['CANCELADO con el modo de guardar', { outcome: 'CANCELADO' as const, cancelMode: '2' as const }],
  ])('🔴 %s → 422 con el MISMO validador que la PC; no se escribe desenlace y la duda sigue abierta', async (_n, over) => {
    await expect(resolver({ creditCents: 5000, changeDispensedCents: 0, ...over })).rejects.toMatchObject({
      statusCode: 422,
      code: 'CASH_MACHINE_CLOSE_IMPOSSIBLE',
    })
    expect(prismaMock.cashMachineClose.create).not.toHaveBeenCalled()
    expect(incidencias.has('NO_SE_PUDO_REGISTRAR')).toBe(false)
    expect(incidencias.get('ESPERANDO')).toMatchObject({ status: 'ABIERTO' })
  })

  it('con el modo que vio (GUARDADO + «2»): cierre sin pago, GUARDADO, y la bitácora guarda el modo', async () => {
    const r = await resolver({ outcome: 'GUARDADO', cancelMode: '2', creditCents: 5000, changeDispensedCents: 0 })
    expect(r.body).toMatchObject({ outcome: 'GUARDADO', owedKind: 'GUARDADO', owedCents: 5000 })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CASH_MACHINE_DOUBT_RESOLVED', data: expect.objectContaining({ cancelMode: '2' }) }),
    )
  })
})

describe('Codex servidor r2 #11 (familia C): la resolución también excluye el premio pendiente', () => {
  it('🔴 la duda con premio de sellos (el lector lo conserva): el gerente confirma el dinero → 202 PREMIO_PENDIENTE, sin venta', async () => {
    await subir()
    armarPedido.mockResolvedValueOnce(pedidoArmado({ stampRewardId: 'premio-1' }))
    const r = await resolver()
    expect(r).toMatchObject({ status: 202, body: { motivo: 'PREMIO_PENDIENTE', resolvedBy: 'GERENTE' } })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })
})

describe('Codex servidor r2 #8: la revisión confirma la versión que vio el gerente', () => {
  const revisar = (version: number, nota = 'Revisé la máquina') =>
    revisarIncidenciaDeLaMaquina('venue-1', GERENTE, 'inc-IMPOSIBLE', nota, version)
  const imposible = (dueCents: number) => subir({ dueCents, saleCents: dueCents }).catch(e => e)

  beforeEach(() => {
    prismaMock.cashMachineIncident.findFirst.mockImplementation(
      async (a: any) => ([...incidencias.values()].find(f => f.id === a?.where?.id) ?? null) as any,
    )
  })

  it('🔴 evidencia nueva mientras revisaba: 409 CASH_MACHINE_INCIDENT_CHANGED y no se da por revisada; con la versión actual, sí', async () => {
    await imposible(18735)
    await imposible(18736)
    expect(incidencias.get('IMPOSIBLE').payload).toMatchObject({ version: 2, veces: 2, repetidas: 0 })
    await expect(revisar(1)).rejects.toMatchObject({ statusCode: 409, code: 'CASH_MACHINE_INCIDENT_CHANGED', details: { version: 2 } })
    expect(incidencias.get('IMPOSIBLE').status).toBe('ABIERTO')
    await expect(revisar(2)).resolves.toMatchObject({ status: 'RESUELTO', version: 2 })
    expect(incidencias.get('IMPOSIBLE').status).toBe('RESUELTO')
  })

  it('🔴 una repetición IDÉNTICA no es evidencia nueva: no reabre la revisada ni sube la versión', async () => {
    await imposible(18735)
    await revisar(1)
    await imposible(18735) // la PC reintenta el mismo 422
    expect(incidencias.get('IMPOSIBLE')).toMatchObject({ status: 'RESUELTO', payload: { version: 1, veces: 2, repetidas: 1 } })
  })

  it('🔴 evidencia distinta la reabre SIN borrar la revisión anterior; el último evento es el último real', async () => {
    await imposible(18735)
    await revisar(1, 'primera revisión')
    await imposible(18736)
    const fila = incidencias.get('IMPOSIBLE')
    expect(fila.status).toBe('ABIERTO')
    expect(fila.payload.revision).toMatchObject({ nota: 'primera revisión', version: 1 })
    expect(fila.payload.revisiones).toHaveLength(1)
    expect(fila.payload.eventos.at(-1)).toMatchObject({ duda: { dueCents: 18736 } })
    await revisar(2, 'segunda revisión')
    expect(incidencias.get('IMPOSIBLE').payload.revisiones.map((r: { nota: string }) => r.nota)).toEqual([
      'primera revisión',
      'segunda revisión',
    ])
  })
})

describe('Codex servidor r2 familia A: TODAS las entradas pasan por decidirEscrituraDelFolio', () => {
  let espia: jest.SpyInstance
  beforeEach(() => {
    espia = jest.spyOn(decision, 'decidirEscrituraDelFolio')
  })
  afterEach(() => espia.mockRestore())
  const ques = () => espia.mock.calls.map(c => (c[1] as { que: string }).que)
  const ventaPagada = {
    referenceCC: REF,
    cierre: {
      outcome: 'PAGADO' as const,
      dueCents: 18750,
      saleCents: 18750,
      tipCents: 0,
      creditCents: 20000,
      changeDispensedCents: 1250,
      occurredAtKnown: true,
      occurredAt: '2026-11-20T18:00:00.000Z',
      saleShiftId: 'shift-A',
    },
    pedido: pedidoArmado(),
  }

  it('la duda de la PC (POST) y su consulta (GET)', async () => {
    await subir()
    expect(ques()).toEqual(['DUDA'])
    await consultarDudaDeLaMaquina('venue-1', REF)
    expect(ques()).toEqual(['DUDA', 'CONSULTA'])
  })

  it('la venta de la PC (POST): la decisión bajo el candado y otra vez dentro de la transacción que escribe; su repetición y el GET', async () => {
    await registrarVentaDeLaMaquina('venue-1', PC, ventaPagada)
    expect(ques()).toEqual(['CIERRE', 'CIERRE'])
    espia.mockClear()
    await registrarVentaDeLaMaquina('venue-1', PC, ventaPagada)
    expect(espia.mock.results.map(r => r.value)).toEqual([{ accion: 'REPETIR', de: 'CIERRE' }])
    espia.mockClear()
    await consultarVentaDeLaMaquina('venue-1', REF)
    expect(ques()).toEqual(['CONSULTA'])
  })

  it('la carrera P2002: el perdedor vuelve a decidir y recibe la respuesta de la ganadora', async () => {
    const primera = await registrarVentaDeLaMaquina('venue-1', PC, ventaPagada)
    const ganadora = cierres[0]
    prismaMock.cashMachineClose.findUnique.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(ganadora)
    prismaMock.cashMachineClose.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: {} }),
    )
    espia.mockClear()
    await expect(registrarVentaDeLaMaquina('venue-1', PC, ventaPagada)).resolves.toEqual(primera)
    expect(ques()).toEqual(['CIERRE', 'CIERRE', 'CIERRE'])
    expect(espia.mock.results.at(-1)!.value).toEqual({ accion: 'REPETIR', de: 'CIERRE' })
  })

  it('la resolución del gerente (la misma del POS y del panel) decide como GERENTE sobre la duda de la PC', async () => {
    await subir()
    espia.mockClear()
    await resolver()
    expect(espia.mock.calls[0][1]).toMatchObject({ que: 'CIERRE', quien: { tipo: 'GERENTE', deviceId: 'terminal-pc' } })
  })

  it('la revisión de una incidencia', async () => {
    await subir({ dueCents: 18735, saleCents: 18735 }).catch(() => undefined)
    prismaMock.cashMachineIncident.findFirst.mockImplementation(
      async (a: any) => ([...incidencias.values()].find(f => f.id === a?.where?.id) ?? null) as any,
    )
    espia.mockClear()
    await revisarIncidenciaDeLaMaquina('venue-1', GERENTE, 'inc-IMPOSIBLE', 'ok', 1)
    expect(espia.mock.calls[0][1]).toMatchObject({ que: 'REVISION', kind: 'IMPOSIBLE', versionVista: 1, versionActual: 1 })
  })
})

describe('contrato con el POS: POST doubts trae el incidentId cuando la evidencia quedó guardada', () => {
  it('🔴 409 (otra versión de la duda): details.incidentId del CONFLICTO', async () => {
    await subir()
    await expect(subir({ dueCents: 19000, saleCents: 19000 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CASH_MACHINE_DOUBT_CONFLICT',
      details: { incidentId: 'inc-CONFLICTO' },
    })
  })

  it('🔴 422 (adeudo que la máquina no cobra): details.incidentId del IMPOSIBLE', async () => {
    await expect(subir({ dueCents: 18735, saleCents: 18735 })).rejects.toMatchObject({
      statusCode: 422,
      details: { incidentId: 'inc-IMPOSIBLE' },
    })
  })

  it('🔴 la duda tardía de un folio que ya quedó 202 recibe ESE comprobante con su incidentId', async () => {
    const r = await registrarVentaDeLaMaquina('venue-1', PC, {
      referenceCC: REF,
      cierre: {
        outcome: 'PAGADO',
        dueCents: 18750,
        saleCents: 18750,
        tipCents: 0,
        creditCents: 20000,
        changeDispensedCents: 1250,
        occurredAtKnown: true,
        occurredAt: '2026-11-20T18:00:00.000Z',
      },
      pedido: pedidoArmado({ discount: 500 }),
    })
    expect(r.body).toMatchObject({ incidentId: 'inc-NO_SE_PUDO_REGISTRAR' })
    await expect(subir()).resolves.toMatchObject({ status: 'RESUELTO', incidentId: 'inc-NO_SE_PUDO_REGISTRAR' })
  })
})

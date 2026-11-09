/**
 * La venta del celular (App de campo, bloque 0, Tarea 4): cada rechazo y cada fila del mapa de caídas y cruces, con los
 * servicios de abajo mockeados. La ficha `VentaDeCampo` vive en una tabla falsa en memoria que respeta sus dos únicos
 * (`venueId + llave` y `serializedItemId`) y los `where` condicionados, para que las carreras se prueben de verdad.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import AppError from '@/errors/AppError'
import { SimCustodyError } from '@/lib/sim-custody-error-codes'
import { logAction } from '@/services/dashboard/activity-log.service'
import { cancelarCuentaSinCobrar } from '@/services/dashboard/order.dashboard.service'
import { serializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'
import { sellSerializedItem } from '@/services/tpv/order.tpv.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { createPendingSaleVerification } from '@/services/tpv/sale-verification.service'
import { registrarVentaDeCampo } from '@/services/tpv/campo/ventaDeCampo.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { ventaDeCampo: {}, payment: {}, serializedItem: {}, orderItem: {}, saleVerification: {} },
}))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  serializedInventoryService: { scan: jest.fn(), ensureSellable: jest.fn(), markAsSold: jest.fn() },
}))
jest.mock('@/services/tpv/order.tpv.service', () => ({ sellSerializedItem: jest.fn() }))
jest.mock('@/services/tpv/payment.tpv.service', () => ({ recordOrderPayment: jest.fn() }))
jest.mock('@/services/tpv/sale-verification.service', () => ({ createPendingSaleVerification: jest.fn() }))
jest.mock('@/services/dashboard/order.dashboard.service', () => ({ cancelarCuentaSinCobrar: jest.fn() }))

const V = 'cvenue0000000000000000001' // el cobro valida el venue como cuid
const ctx = { venueId: V, orgId: 'org1', staffId: 'staff1' }
const LLAVE = '6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f'
const SIM = '8952140012345678901'
const D = (n: number | string) => new Prisma.Decimal(n)
const venta = (extra: Record<string, unknown> = {}) => ({ llave: LLAVE, serialNumber: SIM, precioVisto: 100, ...extra }) as any

// ── La tabla falsa de fichas ────────────────────────────────────────────────────────────────────────────────────────
type Fila = Record<string, any>
let filas: Fila[]
const cumple = (f: Fila, w: Record<string, any>): boolean =>
  Object.entries(w).every(([k, v]) => {
    if (k === 'OR') return (v as Record<string, any>[]).some(o => cumple(f, o))
    if (v && typeof v === 'object' && 'lt' in v) return f[k] != null && f[k] < v.lt
    return (f[k] ?? null) === v
  })
const p2002 = (target: string[]) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target } })
const tabla = {
  findUnique: jest.fn(async ({ where }: any) => {
    const f = filas.find(x => cumple(x, where.venueId_llave ?? where))
    return f ? { ...f } : null
  }),
  findUniqueOrThrow: jest.fn(async ({ where }: any) => {
    const f = filas.find(x => cumple(x, where))
    if (!f) throw new Error('no existe')
    return { ...f }
  }),
  create: jest.fn(async ({ data }: any) => {
    if (filas.some(f => f.venueId === data.venueId && f.llave === data.llave)) throw p2002(['venueId', 'llave'])
    if (data.serializedItemId && filas.some(f => f.serializedItemId === data.serializedItemId)) throw p2002(['serializedItemId'])
    const f = { id: `f${filas.length + 1}`, estado: 'EN_CURSO', orderId: null, paymentId: null, saleVerificationId: null, ...data }
    filas.push(f)
    return { ...f }
  }),
  updateMany: jest.fn(async ({ where, data }: any) => {
    const hits = filas.filter(f => cumple(f, where))
    hits.forEach(f => Object.assign(f, data))
    return { count: hits.length }
  }),
  deleteMany: jest.fn(async ({ where }: any) => {
    const antes = filas.length
    filas = filas.filter(f => !cumple(f, where))
    return { count: antes - filas.length }
  }),
}
const sembrar = (extra: Fila = {}) => {
  const f = {
    id: 'f0',
    venueId: V,
    staffId: 'staff1',
    llave: LLAVE,
    serialNumber: SIM,
    serializedItemId: 'sim1',
    precio: D(100),
    ocurrioAt: new Date('2026-11-07T18:00:00.000Z'),
    origenHora: 'RELOJ_DEL_CELULAR',
    estado: 'EN_CURSO',
    orderId: null,
    paymentId: null,
    saleVerificationId: null,
    ocupacion: null,
    ocupadaHasta: null,
    ...extra,
  }
  filas.push(f)
  return f
}
const ficha = () => filas.find(f => f.llave === LLAVE)

// ── Los servicios de abajo ──────────────────────────────────────────────────────────────────────────────────────────
const db = prisma as any
const scan = serializedInventoryService.scan as jest.Mock
const ensureSellable = serializedInventoryService.ensureSellable as jest.Mock
const markAsSold = serializedInventoryService.markAsSold as jest.Mock
const vender = sellSerializedItem as jest.Mock
const cobrar = recordOrderPayment as jest.Mock
const evidencia = createPendingSaleVerification as jest.Mock
const cancelar = cancelarCuentaSinCobrar as jest.Mock

const simDisponible = (suggestedPrice: Prisma.Decimal | null = D(100)) => ({
  status: 'available',
  found: true,
  item: { id: 'sim1', serialNumber: SIM, category: { suggestedPrice } },
})
const pagoDe = (extra: Record<string, unknown> = {}) => ({
  id: 'p1',
  orderId: 'o1',
  venueId: V,
  amount: D(100),
  status: 'COMPLETED',
  ...extra,
})
/** El gancho corre como en `sellSerializedItem`: dentro de la transacción, tras crear la orden. */
const ventaReal = (orderId = 'o1') =>
  vender.mockImplementation(async (_v: string, _i: unknown, _s: string, op: any) => {
    await op.enLaTransaccion({ ventaDeCampo: tabla }, { id: orderId })
    return { id: orderId, items: [{ id: 'oi1' }] }
  })
const rechazo = (statusCode: number, code: string) => expect.objectContaining({ statusCode, code })

beforeEach(() => {
  jest.clearAllMocks()
  filas = []
  Object.assign(db.ventaDeCampo, tabla)
  db.payment.findUnique = jest.fn().mockResolvedValue(null)
  db.payment.count = jest.fn().mockResolvedValue(0)
  db.serializedItem.findUniqueOrThrow = jest.fn().mockResolvedValue({ id: 'sim1', serialNumber: SIM, status: 'SOLD', orderItemId: 'oi1' })
  db.orderItem.findFirstOrThrow = jest.fn().mockResolvedValue({ id: 'oi1' })
  db.saleVerification.findUnique = jest.fn().mockResolvedValue(null)
  scan.mockResolvedValue(simDisponible())
  ensureSellable.mockResolvedValue({ deprecationWarning: null })
  markAsSold.mockResolvedValue({})
  ventaReal()
  cobrar.mockResolvedValue(pagoDe())
  evidencia.mockResolvedValue({ id: 'sv1' })
  cancelar.mockResolvedValue(undefined)
})

describe('venta nueva', () => {
  it('orquesta venta → cobro → SIM → evidencia, cierra la ficha y devuelve las ids con la hora del celular', async () => {
    const hora = new Date(Date.now() - 60 * 60 * 1000)
    const r = await registrarVentaDeCampo(ctx, venta({ ocurrioAt: hora.toISOString(), origenHora: 'RELOJ_ANCLADO', isPortabilidad: true }))

    expect(r).toEqual({
      orderId: 'o1',
      paymentId: 'p1',
      saleVerificationId: 'sv1',
      repetida: false,
      precio: '100.00',
      hora: hora.toISOString(),
    })
    expect(vender).toHaveBeenCalledWith(
      V,
      { serialNumber: SIM, price: 100, notes: undefined, isPortabilidad: true, terminalId: null },
      'staff1',
      expect.objectContaining({ enLaTransaccion: expect.any(Function) }),
    )
    expect(evidencia).toHaveBeenCalledWith({
      venueId: V,
      paymentId: 'p1',
      staffId: 'staff1',
      isPortabilidad: true,
      serialNumbers: [SIM],
      scannedProducts: [],
      createdAt: hora,
    })
    expect(ficha()).toMatchObject({
      estado: 'COMPLETA',
      orderId: 'o1',
      paymentId: 'p1',
      saleVerificationId: 'sv1',
      serializedItemId: 'sim1',
      ocurrioAt: hora,
      origenHora: 'RELOJ_ANCLADO',
      ocupacion: null,
      ocupadaHasta: null,
    })
    expect(ficha()!.precio.equals(D(100))).toBe(true)
    expect(ensureSellable).toHaveBeenCalledWith(V, SIM, { staffId: 'staff1' })
  })

  it('cobra por la ruta de la terminal en centavos ($100.00 → 10000), con la llave y los defaults de su esquema', async () => {
    await registrarVentaDeCampo(ctx, venta())
    expect(cobrar).toHaveBeenCalledTimes(1)
    const [venueId, orderId, datos, staffId, orgId] = cobrar.mock.calls[0]
    expect([venueId, orderId, staffId, orgId]).toEqual([V, 'o1', 'staff1', 'org1'])
    expect(datos).toMatchObject({
      venueId: V,
      amount: 10000,
      tip: 0,
      status: 'COMPLETED',
      method: 'CASH',
      splitType: 'FULLPAYMENT',
      staffId: 'staff1',
      idempotencyKey: LLAVE,
      serialNumbers: [SIM],
      source: 'TPV',
      currency: 'MXN',
      isInternational: false,
      paidProductsId: [],
      authenticatedTerminalSerial: null,
    })
  })

  it('un precio con centavos no pierde nada en el cobro ($49.99 → 4999)', async () => {
    scan.mockResolvedValue(simDisponible(D('49.99')))
    cobrar.mockResolvedValue(pagoDe({ amount: D('49.99') }))
    const r = await registrarVentaDeCampo(ctx, venta({ precioVisto: 49.99 }))
    expect(cobrar.mock.calls[0][2].amount).toBe(4999)
    expect(r.precio).toBe('49.99')
  })

  it('«de caja» en $0 cobra amount 0', async () => {
    scan.mockResolvedValue(simDisponible(D(0)))
    cobrar.mockResolvedValue(pagoDe({ amount: D(0) }))
    const r = await registrarVentaDeCampo(ctx, venta({ precioVisto: 0 }))
    expect(cobrar.mock.calls[0][2].amount).toBe(0)
    expect(vender.mock.calls[0][1].price).toBe(0)
    expect(r.precio).toBe('0.00')
  })

  it('sin precio sugerido en la categoría se usa el que vio el celular', async () => {
    scan.mockResolvedValue(simDisponible(null))
    cobrar.mockResolvedValue(pagoDe({ amount: D(75) }))
    const r = await registrarVentaDeCampo(ctx, venta({ precioVisto: 75 }))
    expect(r.precio).toBe('75.00')
    expect(cobrar.mock.calls[0][2].amount).toBe(7500)
  })

  it('una hora del celular fuera de rango usa la del servidor', async () => {
    const antes = Date.now()
    const r = await registrarVentaDeCampo(ctx, venta({ ocurrioAt: new Date(antes + 60 * 60 * 1000).toISOString() }))
    expect(new Date(r.hora).getTime()).toBeGreaterThanOrEqual(antes)
    expect(ficha()!.origenHora).toBe('SERVIDOR')
  })
})

describe('rechazos definitivos', () => {
  it('la misma llave con otra SIM → 409 LLAVE_REUSADA, sin tocar nada', async () => {
    sembrar({ serialNumber: '8952000000000000001', estado: 'COMPLETA' })
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toEqual(rechazo(409, 'LLAVE_REUSADA'))
    expect(vender).not.toHaveBeenCalled()
    expect(cobrar).not.toHaveBeenCalled()
  })

  it('la misma llave de otra persona → 409 LLAVE_REUSADA', async () => {
    sembrar({ staffId: 'otra-persona', estado: 'COMPLETA' })
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toEqual(rechazo(409, 'LLAVE_REUSADA'))
  })

  it('llave ya usada por un cobro de otra ruta → 409 LLAVE_REUSADA antes de crear nada', async () => {
    db.payment.findUnique.mockResolvedValue({ id: 'p-ajeno' })
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toEqual(rechazo(409, 'LLAVE_REUSADA'))
    expect(db.payment.findUnique).toHaveBeenCalledWith({
      where: { venueId_idempotencyKey: { venueId: V, idempotencyKey: LLAVE } },
      select: { id: true },
    })
    expect(filas).toHaveLength(0)
    expect(scan).not.toHaveBeenCalled()
    expect(vender).not.toHaveBeenCalled()
  })

  it('SIM no registrada → 409 SIM_NO_REGISTRADA y ninguna ficha', async () => {
    scan.mockResolvedValue({ status: 'not_registered', found: false, item: null })
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toEqual(rechazo(409, 'SIM_NO_REGISTRADA'))
    expect(filas).toHaveLength(0)
  })

  it('SIM ya vendida → 409 SIM_YA_VENDIDA y ninguna ficha', async () => {
    scan.mockResolvedValue({ status: 'already_sold', found: true, item: { id: 'sim1', category: {} } })
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toEqual(rechazo(409, 'SIM_YA_VENDIDA'))
    expect(filas).toHaveLength(0)
  })

  it('SIM de otra persona (custodia de hoy) → 409 SIM_NOT_ACCEPTED con el mensaje de la custodia, y ninguna ficha', async () => {
    ensureSellable.mockRejectedValue(new SimCustodyError('SIM_NOT_ACCEPTED'))
    const error = await registrarVentaDeCampo(ctx, venta()).catch(e => e)
    expect(error).toEqual(rechazo(409, 'SIM_NOT_ACCEPTED'))
    expect(error.message).toBe(new SimCustodyError('SIM_NOT_ACCEPTED').message)
    expect(filas).toHaveLength(0)
    expect(vender).not.toHaveBeenCalled()
  })

  it('precio distinto al de HOY → 422 PRECIO_CAMBIO con precioActual en texto, y ninguna ficha', async () => {
    scan.mockResolvedValue(simDisponible(D(120)))
    const error = await registrarVentaDeCampo(ctx, venta({ precioVisto: 100 })).catch(e => e)
    expect(error).toEqual(rechazo(422, 'PRECIO_CAMBIO'))
    expect(error.details).toEqual({ precioActual: '120.00' })
    expect(filas).toHaveLength(0)
  })

  it('módulo apagado → el mismo 400 que sale hoy de sellSerializedItem', async () => {
    scan.mockResolvedValue({ status: 'module_disabled', found: false, item: null })
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toMatchObject({
      statusCode: 400,
      message: 'Serialized inventory module is not enabled for this venue',
    })
    expect(filas).toHaveLength(0)
  })

  it('un rechazo de validación relee la ficha: si la otra petición con la misma llave ya vendió, devuelve la suya (Codex r3 #4)', async () => {
    scan.mockImplementation(async () => {
      sembrar({ estado: 'COMPLETA', orderId: 'o1', paymentId: 'p1', saleVerificationId: 'sv1' })
      return { status: 'already_sold', found: true, item: { id: 'sim1', category: {} } }
    })
    const r = await registrarVentaDeCampo(ctx, venta())
    expect(r).toMatchObject({ orderId: 'o1', paymentId: 'p1', saleVerificationId: 'sv1', repetida: true })
    expect(vender).not.toHaveBeenCalled()
  })

  it('los rechazos de sellSerializedItem salen tal cual y la ficha se borra (libera la SIM)', async () => {
    const apagadas = new AppError('La sucursal "X" no está habilitada para registrar ventas', 403, true, 'VENUE_SALES_DISABLED')
    vender.mockRejectedValue(apagadas)
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toBe(apagadas)
    expect(filas).toHaveLength(0)
    expect(cobrar).not.toHaveBeenCalled()
  })
})

describe('mapa de caídas y cruces', () => {
  it('ficha COMPLETA → repetida, sin llamar a nada', async () => {
    sembrar({ estado: 'COMPLETA', orderId: 'o1', paymentId: 'p1', saleVerificationId: 'sv1' })
    const r = await registrarVentaDeCampo(ctx, venta({ precioVisto: 999 }))
    expect(r).toEqual({
      orderId: 'o1',
      paymentId: 'p1',
      saleVerificationId: 'sv1',
      repetida: true,
      precio: '100.00',
      hora: '2026-11-07T18:00:00.000Z',
    })
    for (const f of [scan, ensureSellable, vender, cobrar, markAsSold, evidencia, db.payment.findUnique]) expect(f).not.toHaveBeenCalled()
  })

  it('caída antes de crear la ficha: no queda nada y el reintento empieza de cero', async () => {
    scan.mockRejectedValueOnce(new Error('se cayó la base'))
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toThrow('se cayó la base')
    expect(filas).toHaveLength(0)
    const r = await registrarVentaDeCampo(ctx, venta())
    expect(r.repetida).toBe(false)
    expect(vender).toHaveBeenCalledTimes(1)
  })

  it('ficha creada, antes de la venta (o la venta se revirtió dentro): el reintento la ocupa al vencer y crea la venta', async () => {
    sembrar({ ocupacion: 'muerta', ocupadaHasta: new Date(Date.now() - 1000) })
    const r = await registrarVentaDeCampo(ctx, venta())
    expect(r).toMatchObject({ orderId: 'o1', repetida: false })
    expect(vender).toHaveBeenCalledTimes(1)
    expect(scan).not.toHaveBeenCalled() // sigue con lo que la ficha ya revisó
    expect(ficha()).toMatchObject({ estado: 'COMPLETA', ocupacion: null })
  })

  it('ficha de otra petición todavía vigente → 409 VENTA_EN_PROCESO (reintentable), sin tocarla', async () => {
    sembrar({ ocupacion: 'viva', ocupadaHasta: new Date(Date.now() + 30_000) })
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toEqual(rechazo(409, 'VENTA_EN_PROCESO'))
    expect(ficha()).toMatchObject({ ocupacion: 'viva' })
    expect(vender).not.toHaveBeenCalled()
  })

  it('venta confirmada, antes del cobro: el reintento cobra ESA orden con la misma llave', async () => {
    sembrar({ orderId: 'o9', ocupadaHasta: new Date(Date.now() - 1) })
    cobrar.mockResolvedValue(pagoDe({ orderId: 'o9' }))
    await registrarVentaDeCampo(ctx, venta())
    expect(vender).not.toHaveBeenCalled()
    expect(cobrar.mock.calls[0][1]).toBe('o9')
    expect(cobrar.mock.calls[0][2].idempotencyKey).toBe(LLAVE)
    expect(ficha()).toMatchObject({ estado: 'COMPLETA', orderId: 'o9', paymentId: 'p1' })
  })

  it('cobro confirmado, antes de marcar la SIM: el cobro devuelve el suyo y el paso 7 marca la SIM sin revisar custodia', async () => {
    sembrar({ orderId: 'o1' })
    db.serializedItem.findUniqueOrThrow.mockResolvedValue({ id: 'sim1', serialNumber: SIM, status: 'AVAILABLE', orderItemId: null })
    await registrarVentaDeCampo(ctx, venta())
    expect(db.orderItem.findFirstOrThrow).toHaveBeenCalledWith({ where: { orderId: 'o1' }, select: { id: true } })
    expect(markAsSold).toHaveBeenCalledWith(V, SIM, 'oi1', undefined, { staffId: 'staff1', skipCustodyCheck: true })
    expect(ficha()).toMatchObject({ estado: 'COMPLETA', paymentId: 'p1' })
  })

  it('SIM marcada, antes de la evidencia: no cobra otra vez, no la vuelve a marcar y crea la evidencia con la hora de la ficha', async () => {
    sembrar({ orderId: 'o1', paymentId: 'p1' })
    const r = await registrarVentaDeCampo(ctx, venta({ ocurrioAt: new Date().toISOString() }))
    expect(cobrar).not.toHaveBeenCalled()
    expect(markAsSold).not.toHaveBeenCalled()
    expect(evidencia).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'p1', createdAt: new Date('2026-11-07T18:00:00.000Z') }))
    expect(r).toMatchObject({ saleVerificationId: 'sv1', hora: '2026-11-07T18:00:00.000Z' })
  })

  it('evidencia creada, antes de cerrar la ficha: el paso 8 la toma y cierra', async () => {
    sembrar({ orderId: 'o1', paymentId: 'p1' })
    db.saleVerification.findUnique.mockResolvedValue({ id: 'sv7' })
    const r = await registrarVentaDeCampo(ctx, venta())
    expect(db.saleVerification.findUnique).toHaveBeenCalledWith({ where: { paymentId: 'p1' }, select: { id: true } })
    expect(evidencia).not.toHaveBeenCalled()
    expect(r.saleVerificationId).toBe('sv7')
    expect(ficha()).toMatchObject({ estado: 'COMPLETA', saleVerificationId: 'sv7', ocupacion: null })
  })

  it('A dormida dentro de la venta, la ficha vence y B la toma: el gancho de A lanza (su orden se revierte) y A no escribe', async () => {
    vender.mockImplementation(async (_v: string, _i: unknown, _s: string, op: any) => {
      Object.assign(ficha()!, { ocupacion: 'B', ocupadaHasta: new Date(Date.now() + 60_000) }) // B la tomó mientras A dormía
      await op.enLaTransaccion({ ventaDeCampo: tabla }, { id: 'oA' })
      return { id: 'oA' }
    })
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toEqual(rechazo(409, 'VENTA_EN_PROCESO'))
    expect(ficha()).toMatchObject({ ocupacion: 'B', orderId: null })
    expect(cobrar).not.toHaveBeenCalled()
  })

  it('A dormida en el cobro, B toma la ficha: A no puede guardar su paymentId y sale VENTA_EN_PROCESO', async () => {
    cobrar.mockImplementation(async () => {
      Object.assign(ficha()!, { ocupacion: 'B', ocupadaHasta: new Date(Date.now() + 60_000) })
      return pagoDe()
    })
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toEqual(rechazo(409, 'VENTA_EN_PROCESO'))
    expect(ficha()).toMatchObject({ ocupacion: 'B', paymentId: null })
    expect(markAsSold).not.toHaveBeenCalled()
  })

  it('dos peticiones a la vez con la misma llave: una gana la ficha, la otra VENTA_EN_PROCESO y luego repetida', async () => {
    let soltarVenta!: () => void
    const espera = new Promise<void>(r => (soltarVenta = r))
    vender.mockImplementation(async (_v: string, _i: unknown, _s: string, op: any) => {
      await op.enLaTransaccion({ ventaDeCampo: tabla }, { id: 'o1' })
      await espera
      return { id: 'o1' }
    })
    const ambas = Promise.allSettled([registrarVentaDeCampo(ctx, venta()), registrarVentaDeCampo(ctx, venta())])
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    expect(vender).toHaveBeenCalledTimes(1) // la perdedora ya salió mientras la ganadora sigue dentro de la venta
    soltarVenta()
    const resultados = await ambas
    expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const perdida = resultados.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect(perdida.reason).toEqual(rechazo(409, 'VENTA_EN_PROCESO'))
    expect(vender).toHaveBeenCalledTimes(1)
    expect(cobrar).toHaveBeenCalledTimes(1)
    expect(filas).toHaveLength(1)

    const reintento = await registrarVentaDeCampo(ctx, venta())
    expect(reintento).toMatchObject({ orderId: 'o1', paymentId: 'p1', repetida: true })
  })

  // Postgres reporta el primer índice que choca (el de la SIM se creó antes): con la misma llave, los dos llevan al paso 2.
  it.each([[['venueId', 'llave']], [['serializedItemId']]])(
    'el choque al crear la ficha (%j) con la misma llave vuelve al paso 2',
    async target => {
      tabla.create.mockImplementationOnce(async () => {
        sembrar({ estado: 'COMPLETA', orderId: 'o1', paymentId: 'p1', saleVerificationId: 'sv1' })
        throw p2002(target)
      })
      const r = await registrarVentaDeCampo(ctx, venta())
      expect(r.repetida).toBe(true)
      expect(vender).not.toHaveBeenCalled()
    },
  )

  it('dos llaves con la misma SIM (también entre sucursales): la segunda → 409 SIM_EN_OTRA_VENTA', async () => {
    sembrar({ id: 'f-otra', venueId: 'cotravenue000000000000001', llave: 'otra-llave', ocupadaHasta: new Date(Date.now() + 30_000) })
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toEqual(rechazo(409, 'SIM_EN_OTRA_VENTA'))
    expect(filas).toHaveLength(1)
    expect(vender).not.toHaveBeenCalled()
  })

  it('ventas deshabilitadas entre la venta y el cobro: cancela la orden, borra la ficha y sale el rechazo', async () => {
    const apagadas = new AppError('La sucursal "X" no está habilitada para registrar ventas', 403, true, 'VENUE_SALES_DISABLED')
    cobrar.mockRejectedValue(apagadas)
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toBe(apagadas)
    expect(db.payment.count).toHaveBeenCalledWith({ where: { venueId: V, orderId: 'o1' } })
    expect(cancelar).toHaveBeenCalledWith(V, 'o1', 'Venta del celular rechazada: VENUE_SALES_DISABLED', 'staff1')
    expect(filas).toHaveLength(0)
  })

  it('rechazo del cobro con algún cobro ya en la orden: no cancela, sólo desocupa', async () => {
    db.payment.count.mockResolvedValue(1)
    const apagadas = new AppError('no', 403, true, 'VENUE_SALES_DISABLED')
    cobrar.mockRejectedValue(apagadas)
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toBe(apagadas)
    expect(cancelar).not.toHaveBeenCalled()
    expect(ficha()).toMatchObject({ orderId: 'o1', ocupacion: null, ocupadaHasta: null })
  })

  it('si la cancelación falla, sólo desocupa y propaga el rechazo; el reintento sigue desde ahí', async () => {
    const apagadas = new AppError('no', 403, true, 'VENUE_SALES_DISABLED')
    cobrar.mockRejectedValueOnce(apagadas)
    cancelar.mockRejectedValue(new Error('candado'))
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toBe(apagadas)
    expect(ficha()).toMatchObject({ orderId: 'o1', ocupacion: null })

    const r = await registrarVentaDeCampo(ctx, venta())
    expect(r).toMatchObject({ orderId: 'o1', paymentId: 'p1', repetida: false })
    expect(vender).toHaveBeenCalledTimes(1)
  })

  it('un 5xx del cobro sólo desocupa (sin cancelar) y el reintento cobra ESA orden', async () => {
    cobrar.mockRejectedValueOnce(new Error('timeout'))
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toThrow('timeout')
    expect(cancelar).not.toHaveBeenCalled()
    expect(ficha()).toMatchObject({ orderId: 'o1', paymentId: null, ocupacion: null })

    await registrarVentaDeCampo(ctx, venta())
    expect(vender).toHaveBeenCalledTimes(1)
    expect(cobrar.mock.calls.map(c => c[1])).toEqual(['o1', 'o1'])
  })

  it('el cobro devuelto es de otra orden → 409 LLAVE_REUSADA y la orden propia cancelada', async () => {
    cobrar.mockResolvedValue(pagoDe({ id: 'p-ajeno', orderId: 'o-ajena' }))
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toEqual(rechazo(409, 'LLAVE_REUSADA'))
    expect(cancelar).toHaveBeenCalledWith(V, 'o1', 'Venta del celular rechazada: LLAVE_REUSADA', 'staff1')
    expect(filas).toHaveLength(0)
  })

  it.each([
    ['de otra sucursal', { venueId: 'cotravenue000000000000001' }],
    ['de otro importe', { amount: D(50) }],
    ['no completado', { status: 'PENDING' }],
  ])('el cobro devuelto %s → 409 LLAVE_REUSADA', async (_n, extra) => {
    cobrar.mockResolvedValue(pagoDe(extra))
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toEqual(rechazo(409, 'LLAVE_REUSADA'))
  })

  it('SIM vendida por OTRO renglón (carrera ajena con la PAX): no se toca, logger.error + logAction, y la venta cierra', async () => {
    db.serializedItem.findUniqueOrThrow.mockResolvedValue({ id: 'sim1', serialNumber: SIM, status: 'SOLD', orderItemId: 'oi-pax' })
    const r = await registrarVentaDeCampo(ctx, venta())
    expect(markAsSold).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff1',
        venueId: V,
        entity: 'VentaDeCampo',
        data: expect.objectContaining({ orderId: 'o1', orderItemId: 'oi1', otroOrderItemId: 'oi-pax', serialNumber: SIM }),
      }),
    )
    expect(r.repetida).toBe(false)
    expect(ficha()!.estado).toBe('COMPLETA')
  })

  it.each([
    ['marcar la SIM', () => (db.serializedItem.findUniqueOrThrow as jest.Mock).mockRejectedValue(new Error('falló el paso 7'))],
    ['la evidencia', () => evidencia.mockRejectedValue(new Error('falló el paso 8'))],
  ])('si falla %s, sólo desocupa (la ficha guarda el cobro) y propaga', async (_n, romper) => {
    romper()
    await expect(registrarVentaDeCampo(ctx, venta())).rejects.toThrow(/falló el paso/)
    expect(ficha()).toMatchObject({ estado: 'EN_CURSO', orderId: 'o1', paymentId: 'p1', ocupacion: null })
    expect(cancelar).not.toHaveBeenCalled()
  })
})

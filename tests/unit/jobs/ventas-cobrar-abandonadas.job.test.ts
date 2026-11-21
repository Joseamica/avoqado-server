/**
 * hz:e82938e1:D36, decisión del founder «A con ensayo» (20-nov): la limpieza del SERVIDOR que, tras 24 h, ANULA (nunca borra) las
 * ventas de Cobrar abandonadas que dejaron las TPV viejas — y las 106 que ya existen. Por omisión corre en ENSAYO: no escribe NADA,
 * sólo deja en el log, por negocio, cuántas anularía. Sólo con `LIMPIEZA_VENTAS_COBRAR=ACTIVO` (decisión del founder) anula.
 * La regla contra Postgres real: tests/integration/jobs/ventas-cobrar-abandonadas.integration.test.ts.
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { getContext } from '@/observability/executionContext'
import {
  CAMINO_LIMPIEZA_COBRAR,
  LLAVE_DE_COBRAR,
  modoDeLaLimpiezaDeCobrar,
  VentasCobrarAbandonadasJob,
  type Candidata,
} from '@/jobs/ventas-cobrar-abandonadas.job'

const { logAction } = require('@/services/dashboard/activity-log.service')

const sqlDe = (query: unknown) => (Array.isArray(query) ? query.join(' ') : String((query as any)?.strings?.join(' ') ?? query))
/** La plantilla y sus pedazos anidados (`Prisma.sql`) que el doble recibe como valores. */
const sqlCompleto = (llamada: unknown[]) =>
  llamada.map(p => (Array.isArray(p) ? p.join(' ') : p && typeof p === 'object' && 'sql' in (p as any) ? (p as any).sql : '')).join(' ')

describe('modoDeLaLimpiezaDeCobrar — el interruptor', () => {
  it.each([
    [undefined, 'ENSAYO'],
    ['', 'ENSAYO'],
    ['ensayo', 'ENSAYO'],
    ['cualquier cosa', 'ENSAYO'],
    ['ACTIVO', 'ACTIVO'],
    [' activo ', 'ACTIVO'],
    ['APAGADO', 'APAGADO'],
  ])('%j ⇒ %s (por omisión, y ante la duda, ENSAYO: nunca anula sin que alguien lo pida)', (valor, modo) => {
    expect(modoDeLaLimpiezaDeCobrar(valor as string | undefined)).toBe(modo)
  })
})

describe('LLAVE_DE_COBRAR — sólo la llave de Cobrar (Codex r3 #2)', () => {
  const llave = new RegExp(LLAVE_DE_COBRAR, 'i')
  it.each([
    ['9b2f6a3e-1c4d-4e8f-a1b2-3c4d5e6f7a8b', true],
    ['9B2F6A3E-1C4D-4E8F-A1B2-3C4D5E6F7A8B', true],
    ['local_9b2f6a3e-1c4d-4e8f-a1b2-3c4d5e6f7a8b', false], // la libreta legacy de «Órdenes»
    ['giftcard:9b2f6a3e-1c4d-4e8f-a1b2-3c4d5e6f7a8b', false],
    ['exchange:abc', false],
    ['pay-later:abc', false],
    ['9b2f6a3e-1c4d-4e8f-a1b2-3c4d5e6f7a8b-x', false],
  ])('%s ⇒ %s', (valor, esDeCobrar) => {
    expect(llave.test(valor)).toBe(esDeCobrar)
  })
})

describe('VentasCobrarAbandonadasJob', () => {
  const resumen = [
    {
      venueId: 'venue-1',
      venueName: 'Cafetería Uno',
      cuantas: 3,
      masVieja: new Date('2026-09-01T10:00:00Z'),
      masNueva: new Date('2026-11-18T10:00:00Z'),
      folioMasViejo: 'ORD-1',
      folioMasNuevo: 'ORD-3',
      total: '450.00',
      ventasEnTotal: 3,
      negociosEnTotal: 1,
    },
  ]
  let candidatas: Candidata[]

  beforeEach(() => {
    jest.clearAllMocks()
    candidatas = [
      { id: 'order-1', venueId: 'venue-1', orderNumber: 'ORD-1', version: 1, createdAt: new Date('2026-09-01T10:00:00Z') },
      { id: 'order-2', venueId: 'venue-1', orderNumber: 'ORD-2', version: 4, createdAt: new Date('2026-09-02T10:00:00Z') },
    ]
    prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = sqlDe(query)
      if (sql.includes('GROUP BY')) return resumen
      if (sql.includes('LIMIT')) return candidatas
      return []
    })
  })

  it('🔴 ENSAYO no escribe NADA: ni transacción, ni anulación, ni bitácora; sólo lee y lo dice en el log por negocio', async () => {
    const job = new VentasCobrarAbandonadasJob({ modo: 'ENSAYO' })
    const r = await job.correrAhora()

    expect(r).toMatchObject({ modo: 'ENSAYO', anularia: 3, anuladas: 0, negocios: [{ venueId: 'venue-1', cuantas: 3 }] })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
    // Una línea por negocio, que se lee en Better Stack: «anularía N (la más vieja, la más nueva)».
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[LIMPIEZA COBRAR · ENSAYO] anularía 3'),
      expect.objectContaining({ modo: 'ENSAYO', anularia: 3, masVieja: expect.objectContaining({ folio: 'ORD-1' }) }),
    )
  })

  it('ENSAYO: la línea de cada negocio lleva su `venueName` de la misma consulta, aunque la caché de nombres no haya cargado', async () => {
    const nombres: Array<string | undefined> = []
    ;(logger.info as jest.Mock).mockImplementation((mensaje: string) => {
      if (String(mensaje).includes('ENSAYO] anularía')) nombres.push(getContext()?.venueName)
    })
    await new VentasCobrarAbandonadasJob({ modo: 'ENSAYO' }).correrAhora()
    expect(nombres).toEqual(['Cafetería Uno'])
  })

  it('🔴 ENSAYO: el total es de TODOS los negocios y, si el log recorta, lo dice (Codex r3 #5)', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ ...resumen[0], ventasEnTotal: 900, negociosEnTotal: 600 }])
    const r = await new VentasCobrarAbandonadasJob({ modo: 'ENSAYO' }).correrAhora()

    expect(r.anularia).toBe(900)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/en total anularía 900 en 600 negocio\(s\) \(en el log van los 1 con más; faltan 599\)/),
      expect.objectContaining({ anularia: 900, negocios: 600, negociosEnElLog: 1 }),
    )
    const sql = sqlCompleto(prismaMock.$queryRaw.mock.calls[0] as unknown[])
    expect(sql).toContain('sum(count(*)) OVER ()')
    expect(sql).toContain('count(*) OVER ()')
  })

  it('APAGADO no lee ni escribe', async () => {
    const r = await new VentasCobrarAbandonadasJob({ modo: 'APAGADO' }).correrAhora()
    expect(r).toMatchObject({ modo: 'APAGADO', anuladas: 0 })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('ACTIVO: cada candidata pasa por la anulación de siempre, en su propia transacción, con su camino propio', async () => {
    const anular = jest.fn().mockResolvedValue('anulada')
    const job = new VentasCobrarAbandonadasJob({ modo: 'ACTIVO', anular })
    const r = await job.correrAhora()

    expect(anular).toHaveBeenCalledTimes(2)
    expect(anular).toHaveBeenCalledWith(expect.objectContaining({ id: 'order-1', version: 1 }), expect.any(Date))
    expect(r).toMatchObject({ modo: 'ACTIVO', anuladas: 2, seQuedan: 0, fallaron: 0 })
    expect(CAMINO_LIMPIEZA_COBRAR).toBe('LIMPIEZA_VENTA_COBRAR_ABANDONADA')
  })

  it('🔴 ACTIVO: la PRIMERA falla y las demás siguen; una que cambió bajo el candado se queda (Codex r3)', async () => {
    candidatas.push({ id: 'order-3', venueId: 'venue-1', orderNumber: 'ORD-3', version: 2, createdAt: new Date('2026-09-03T10:00:00Z') })
    const anular = jest
      .fn()
      .mockRejectedValueOnce(new Error('la base se cayó'))
      .mockResolvedValueOnce('seQueda')
      .mockResolvedValueOnce('anulada')
    const r = await new VentasCobrarAbandonadasJob({ modo: 'ACTIVO', anular }).correrAhora()

    expect(anular.mock.calls.map(([c]) => c.id)).toEqual(['order-1', 'order-2', 'order-3'])
    expect(r).toMatchObject({ anuladas: 1, seQuedan: 1, fallaron: 1 })
  })

  it('🔴 ACTIVO: con el lote lleno, la siguiente vuelta sigue DESPUÉS de la última (las que se quedan no tapan a las de atrás)', async () => {
    candidatas = Array.from({ length: 100 }, (_, i) => ({
      id: `order-${i}`,
      venueId: 'venue-1',
      orderNumber: `ORD-${i}`,
      version: 1,
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
    }))
    const anular = jest.fn().mockResolvedValue('seQueda')
    const job = new VentasCobrarAbandonadasJob({ modo: 'ACTIVO', anular })

    await job.correrAhora()
    expect(sqlCompleto(prismaMock.$queryRaw.mock.calls[0] as unknown[])).not.toContain('(o."createdAt", o.id) >')
    candidatas = candidatas.slice(0, 3)
    await job.correrAhora()
    const segunda = prismaMock.$queryRaw.mock.calls[1] as unknown[]
    expect(sqlCompleto(segunda)).toContain('(o."createdAt", o.id) >')
    expect(segunda.flatMap(p => (p && typeof p === 'object' && 'values' in (p as any) ? (p as any).values : []))).toContain('order-99')
    // Lote incompleto: llegó al final y la siguiente vuelve a empezar.
    await job.correrAhora()
    expect(sqlCompleto(prismaMock.$queryRaw.mock.calls[2] as unknown[])).not.toContain('(o."createdAt", o.id) >')
  })

  it('🔴 una vuelta que sigue corriendo no se encima con la siguiente', async () => {
    let soltar!: () => void
    const anular = jest.fn().mockImplementation(() => new Promise(resolve => (soltar = () => resolve('anulada'))))
    const job = new VentasCobrarAbandonadasJob({ modo: 'ACTIVO', anular })

    const primera = job.correrAhora()
    await new Promise(resolve => setImmediate(resolve))
    const segunda = await job.correrAhora()
    expect(segunda).toMatchObject({ saltada: true, anuladas: 0 })
    soltar()
    await new Promise(resolve => setImmediate(resolve))
    soltar()
    expect(await primera).toMatchObject({ anuladas: 2 })
    expect(anular).toHaveBeenCalledTimes(2)
  })

  it('la lectura de entrada se reintenta ante un corte de conexión (cron-jobs.md) y si sigue fallando la vuelta no truena', async () => {
    prismaMock.$queryRaw.mockReset()
    prismaMock.$queryRaw.mockRejectedValue(Object.assign(new Error("Can't reach database server"), { code: 'P1001' }))
    const r = await new VentasCobrarAbandonadasJob({ modo: 'ENSAYO', esperaDeReintentoMs: 1 }).correrAhora()

    expect(r.fallaron).toBe(1)
    expect(prismaMock.$queryRaw.mock.calls.length).toBeGreaterThan(1)
  })

  it('🔴 la regla de selección: TPV, para llevar, sin mesa ni reserva, llave de Cobrar, pendiente, con productos, SIN cliente, sin cobros ni solicitudes, 24 h', async () => {
    await new VentasCobrarAbandonadasJob({ modo: 'ENSAYO' }).correrAhora()
    const sql = sqlCompleto(prismaMock.$queryRaw.mock.calls[0] as unknown[])
    for (const pieza of [
      `o.source = 'TPV'`,
      `o.type = 'TAKEOUT'`,
      `o."tableId" IS NULL`,
      `o."reservationId" IS NULL`,
      `o."externalId" IS NULL OR o."externalId" ~*`,
      `o.status = 'PENDING'`,
      `o."paymentStatus" = 'PENDING'`,
      `o."customerId" IS NULL`,
      `"OrderCustomer"`,
      `o."payLater" IS DISTINCT FROM true`,
      `EXISTS (SELECT 1 FROM "OrderItem"`,
      `NOT EXISTS (SELECT 1 FROM "Payment"`,
      `NOT EXISTS (SELECT 1 FROM "PaymentAllocation"`,
      `NOT EXISTS (SELECT 1 FROM "TerminalPaymentRequest"`,
      `"OnlineOrder"`,
      `o."createdAt" <`,
      `o."updatedAt" <`,
    ]) {
      expect({ pieza, presente: sql.includes(pieza) }).toEqual({ pieza, presente: true })
    }
    // Ninguna solicitud del POS, ni siquiera la rechazada (Codex r3 #4): sin excepción de lápidas.
    expect(sql).not.toContain('REJECTED_')
  })
})

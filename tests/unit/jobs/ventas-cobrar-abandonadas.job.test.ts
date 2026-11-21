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
import { CAMINO_LIMPIEZA_COBRAR, modoDeLaLimpiezaDeCobrar, VentasCobrarAbandonadasJob } from '@/jobs/ventas-cobrar-abandonadas.job'

const { logAction } = require('@/services/dashboard/activity-log.service')

const sqlDe = (query: unknown) => (Array.isArray(query) ? query.join(' ') : String((query as any)?.strings?.join(' ') ?? query))

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

describe('VentasCobrarAbandonadasJob', () => {
  const resumen = [
    {
      venueId: 'venue-1',
      cuantas: 3,
      masVieja: new Date('2026-09-01T10:00:00Z'),
      masNueva: new Date('2026-11-18T10:00:00Z'),
      folioMasViejo: 'ORD-1',
      folioMasNuevo: 'ORD-3',
      total: '450.00',
    },
  ]
  const candidatas = [
    { id: 'order-1', venueId: 'venue-1', orderNumber: 'ORD-1', version: 1 },
    { id: 'order-2', venueId: 'venue-1', orderNumber: 'ORD-2', version: 4 },
  ]

  beforeEach(() => {
    jest.clearAllMocks()
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

    expect(r).toMatchObject({ modo: 'ENSAYO', anularia: 3, anuladas: 0 })
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

  it('ACTIVO: una que cambió bajo el candado se queda, y una que falla no frena a las demás ni tumba la vuelta', async () => {
    const anular = jest.fn().mockResolvedValueOnce('seQueda').mockRejectedValueOnce(new Error('la base se cayó'))
    const r = await new VentasCobrarAbandonadasJob({ modo: 'ACTIVO', anular }).correrAhora()

    expect(anular).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ anuladas: 0, seQuedan: 1, fallaron: 1 })
  })

  it('la lectura de entrada se reintenta ante un corte de conexión (cron-jobs.md) y si sigue fallando la vuelta no truena', async () => {
    prismaMock.$queryRaw.mockReset()
    prismaMock.$queryRaw.mockRejectedValue(Object.assign(new Error("Can't reach database server"), { code: 'P1001' }))
    const r = await new VentasCobrarAbandonadasJob({ modo: 'ENSAYO', esperaDeReintentoMs: 1 }).correrAhora()

    expect(r.fallaron).toBe(1)
    expect(prismaMock.$queryRaw.mock.calls.length).toBeGreaterThan(1)
  })

  it('🔴 la regla de selección: TPV, para llevar, sin mesa, pendiente, con productos, SIN cliente, sin cobros ni solicitudes, 24 h', async () => {
    await new VentasCobrarAbandonadasJob({ modo: 'ENSAYO' }).correrAhora()
    // La plantilla y sus pedazos anidados (`Prisma.sql`) que el doble recibe como valores.
    const sql = (prismaMock.$queryRaw.mock.calls[0] as unknown[])
      .map(p => (Array.isArray(p) ? p.join(' ') : p && typeof p === 'object' && 'sql' in (p as any) ? (p as any).sql : ''))
      .join(' ')
    for (const pieza of [
      `o.source = 'TPV'`,
      `o.type = 'TAKEOUT'`,
      `o."tableId" IS NULL`,
      `o.status = 'PENDING'`,
      `o."paymentStatus" = 'PENDING'`,
      `o."customerId" IS NULL`,
      `"OrderCustomer"`,
      `o."payLater" IS DISTINCT FROM true`,
      `EXISTS (SELECT 1 FROM "OrderItem"`,
      `NOT EXISTS (SELECT 1 FROM "Payment"`,
      `NOT EXISTS (SELECT 1 FROM "PaymentAllocation"`,
      `"TerminalPaymentRequest"`,
      `'REJECTED_'`,
      `"OnlineOrder"`,
      `o."createdAt" <`,
      `o."updatedAt" <`,
    ]) {
      expect({ pieza, presente: sql.includes(pieza) }).toEqual({ pieza, presente: true })
    }
  })
})

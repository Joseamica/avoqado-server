import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '@tests/__helpers__/setup'
import { tablaDeUnaVenta, type FilaDeLealtad } from '@tests/__helpers__/ordenConMarcasDeLealtad'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'

/** La marca de fila que deja la liga tardía al reabrir (`reabrirLealtadSiAplica`). Texto EXACTO del ruling. */
const MARCA = 'REABIERTA: cliente ligado después del cobro'

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    venueId: 'venue-1',
    total: new Decimal(90),
    customer: { id: 'cust-legacy', firstName: 'Ana', lastName: 'Ruiz' },
    loyaltyStaffId: 'staff-1',
    loyaltyEligibleAt: new Date('2026-09-01T20:00:00.000Z'),
    loyaltyProcessingAt: null,
    loyaltyAttempts: 0,
    ...overrides,
  }
}

function setup() {
  const order = {
    findMany: jest.fn().mockResolvedValue([candidate()]),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  const cron = { start: jest.fn(), stop: jest.fn() }
  const award = jest.fn().mockResolvedValue({ complete: true, errors: [] })
  const now = () => new Date('2026-09-01T21:00:00.000Z')
  const job = new LoyaltyReconciliationJob({ prisma: { order } as any, cron, award, now })
  return { job, order, cron, award }
}

describe('LoyaltyReconciliationJob', () => {
  it('scans a small, stable batch of only pending eligible orders', async () => {
    const { job, order } = setup()

    await job.runNow()

    expect(order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ loyaltyEligibleAt: { not: null }, loyaltyProcessedAt: null, loyaltyAttempts: { lt: 15 } }),
        orderBy: [{ loyaltyEligibleAt: 'asc' }, { id: 'asc' }],
        take: 25,
      }),
    )
  })

  it('claims with a lease, retries loyalty, and marks the order processed', async () => {
    const { job, order, award } = setup()

    const result = await job.runNow()

    expect(award).toHaveBeenCalledWith({
      venueId: 'venue-1',
      orderId: 'order-1',
      orderTotal: 90,
      staffId: 'staff-1',
      legacyCustomer: { id: 'cust-legacy', firstName: 'Ana', lastName: 'Ruiz' },
    })
    expect(order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'order-1', loyaltyProcessedAt: null }),
        data: expect.objectContaining({ loyaltyProcessedAt: expect.any(Date), loyaltyProcessingAt: null, loyaltyLastError: null }),
      }),
    )
    expect(result).toEqual(expect.objectContaining({ scanned: 1, applied: 1, failed: 0 }))
  })

  it('🔴 H5: the claim pins the loyaltyStaffId it read, so the award uses the CURRENT actor (a late link may have changed it)', async () => {
    const { job, order } = setup()
    await job.runNow()
    expect(order.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'order-1', loyaltyStaffId: 'staff-1' },
      data: { loyaltyProcessingAt: expect.any(Date), loyaltyAttempts: { increment: 1 } },
    })
  })

  it('recovery awards the same net-of-tip amount as immediate settlement', async () => {
    const { job, order, award } = setup()
    order.findMany.mockResolvedValue([candidate({ total: new Decimal(110), tipAmount: new Decimal(20) })])
    await job.runNow()
    expect(award).toHaveBeenCalledWith(expect.objectContaining({ orderTotal: 90 }))
  })

  it('keeps a failed order pending and releases the lease for a later retry', async () => {
    const { job, order, award } = setup()
    award.mockResolvedValue({ complete: false, errors: ['loyalty:cust-legacy'] })

    const result = await job.runNow()

    expect(order.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          id: 'order-1',
          loyaltyProcessedAt: null,
          loyaltyProcessingAt: new Date('2026-09-01T21:00:00.000Z'),
          // H2: el error no pisa la marca de una liga tardía.
          OR: [{ loyaltyLastError: null }, { loyaltyLastError: { not: MARCA } }],
        },
        data: { loyaltyProcessingAt: null, loyaltyLastError: 'loyalty:cust-legacy' },
      }),
    )
    expect(result).toEqual(expect.objectContaining({ scanned: 1, applied: 0, failed: 1 }))
  })

  // ── H2 (auditoría de Codex del código + revisión final Minor 3, 15-oct-2026) ───────────────────────────────────────────
  describe('🔴 H2: la escritura de FALLO suelta el reclamo pero conserva la marca REABIERTA', () => {
    const AHORA = new Date('2026-10-14T18:00:00.000Z')
    const cron = () => ({ start: jest.fn(), stop: jest.fn() })
    function reabierta(over: Partial<FilaDeLealtad> = {}): FilaDeLealtad {
      // La liga tardía reabrió la venta (marca) y su intento inmediato no llegó: el reconciliador la toma.
      return {
        id: 'order-1',
        venueId: 'venue-1',
        total: new Decimal(90),
        tipAmount: new Decimal(10),
        loyaltyEligibleAt: new Date('2026-10-14T17:30:00.000Z'),
        loyaltyProcessedAt: null,
        loyaltyProcessingAt: null,
        loyaltyLastError: MARCA,
        loyaltyAttempts: 0,
        loyaltyStaffId: null,
        customer: null,
        clientes: 1,
        ...over,
      }
    }

    it.each<[string, jest.Mock]>([
      ['la lealtad termina incompleta', jest.fn().mockResolvedValue({ complete: false, errors: ['loyalty:cust-1'] })],
      ['la lealtad LANZA', jest.fn().mockRejectedValue(new Error('P1001'))],
    ])('%s: la marca se queda, el reclamo se suelta y la siguiente vuelta la vuelve a tomar', async (_n, award) => {
      const fila = reabierta()
      const tabla = tablaDeUnaVenta(fila)
      const job = new LoyaltyReconciliationJob({ prisma: { order: tabla } as never, cron: cron(), award, now: () => AHORA })

      expect(await job.runNow()).toMatchObject({ scanned: 1, applied: 0, failed: 1 })

      expect(fila.loyaltyLastError).toBe(MARCA)
      expect(fila.loyaltyProcessingAt).toBeNull()
      expect(fila.loyaltyProcessedAt).toBeNull()
      expect(fila.loyaltyAttempts).toBe(1)
      // La siguiente vuelta la encuentra (nada la dejó colgada en un reclamo de 10 minutos).
      const ok = jest.fn().mockResolvedValue({ complete: true, errors: [] })
      const despues = new Date(AHORA.getTime() + 5 * 60_000)
      const siguiente = new LoyaltyReconciliationJob({ prisma: { order: tabla } as never, cron: cron(), award: ok, now: () => despues })
      expect(await siguiente.runNow()).toMatchObject({ scanned: 1, applied: 1 })
      expect(fila.loyaltyLastError).toBeNull()
    })

    it('regresión: sin marca, el error SÍ queda escrito y el reclamo se suelta', async () => {
      const fila = reabierta({ loyaltyLastError: null })
      const tabla = tablaDeUnaVenta(fila)
      const award = jest.fn().mockResolvedValue({ complete: false, errors: ['loyalty:cust-1'] })
      await new LoyaltyReconciliationJob({ prisma: { order: tabla } as never, cron: cron(), award, now: () => AHORA }).runNow()
      expect(fila.loyaltyLastError).toBe('loyalty:cust-1')
      expect(fila.loyaltyProcessingAt).toBeNull()
    })
  })

  it('does not overlap two sweeps in the same process', async () => {
    const { job, order } = setup()
    let release!: () => void
    order.findMany.mockReturnValue(new Promise(resolve => (release = () => resolve([candidate()]))))

    const first = job.runNow()
    const second = await job.runNow()
    release()
    await first

    expect(second).toEqual({ scanned: 0, applied: 0, failed: 0, skipped: 1 })
    expect(order.findMany).toHaveBeenCalledTimes(1)
  })

  it('🔴 B1: the success close applies only to ITS OWN claim — a customer link that reopened the order invalidated it', async () => {
    const { job, order } = setup()

    await job.runNow()

    expect(order.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'order-1', loyaltyProcessedAt: null, loyaltyProcessingAt: new Date('2026-09-01T21:00:00.000Z') },
      data: { loyaltyProcessedAt: new Date('2026-09-01T21:00:00.000Z'), loyaltyProcessingAt: null, loyaltyLastError: null },
    })
  })
})

/**
 * 🔴 B1 de punta a punta, con la lealtad REAL (`awardLoyaltyForPaidOrder`) y el envoltorio de reembolsos que el
 * reconciliador usa por defecto (B2). Codex, ronda B: «detener la ejecución vieja después de leer "sin cliente", ligar,
 * liberarla y hacer fallar el intento nuevo. La venta debe seguir recuperable».
 */
describe('🔴 B1: una vuelta del reconciliador que leyó «sin cliente» no borra la reapertura de una liga tardía', () => {
  const AHORA = new Date('2026-10-14T18:00:00.000Z')
  const cron = () => ({ start: jest.fn(), stop: jest.fn() })

  function ventaPendienteSinCliente(): FilaDeLealtad {
    // El intento del cobro falló (P1001): la venta quedó pendiente y el reconciliador la toma.
    return {
      id: 'order-1',
      venueId: 'venue-1',
      total: new Decimal(90),
      tipAmount: new Decimal(10),
      loyaltyEligibleAt: new Date('2026-10-14T17:30:00.000Z'),
      loyaltyProcessedAt: null,
      loyaltyProcessingAt: null,
      loyaltyLastError: 'query:P1001',
      loyaltyAttempts: 0,
      loyaltyStaffId: null,
      customer: null,
      clientes: 0,
    }
  }

  beforeEach(() => {
    prismaMock.payment.count.mockResolvedValue(0) // sin reembolsos: el envoltorio deja pasar a la lealtad
  })

  it('lee «sin cliente» → la liga crea el OrderCustomer y REABRE → la vuelta termina ⇒ la venta sigue pendiente', async () => {
    const fila = ventaPendienteSinCliente()
    const tabla = tablaDeUnaVenta(fila)
    prismaMock.order.updateMany.mockImplementation(tabla.updateMany) // el cierre propio de la lealtad
    prismaMock.orderCustomer.findMany.mockImplementation(async () => {
      // Justo después de esta lectura, el barista liga a Dany: el OrderCustomer nace y la MISMA transacción reabre
      // la lealtad (`reabrirLealtadSiAplica`: processedAt/processingAt en null y la MARCA de fila en lastError).
      fila.clientes = 1
      Object.assign(fila, {
        loyaltyProcessedAt: null,
        loyaltyProcessingAt: null,
        loyaltyLastError: 'REABIERTA: cliente ligado después del cobro',
      })
      return []
    })

    const job = new LoyaltyReconciliationJob({ prisma: { order: tabla } as never, cron: cron(), now: () => AHORA })
    await job.runNow()

    // Ni el cierre de la lealtad (guarda «sin clientes») ni el del reconciliador (su reclamo quedó invalidado) cerraron.
    expect(fila.loyaltyProcessedAt).toBeNull()

    // Y la siguiente vuelta SÍ la encuentra: ahora con su cliente.
    const despues = new Date(AHORA.getTime() + 5 * 60_000)
    const siguiente = new LoyaltyReconciliationJob({
      prisma: { order: tabla } as never,
      cron: cron(),
      award: jest.fn().mockResolvedValue({ complete: true, errors: [] }),
      now: () => despues,
    })
    expect(await siguiente.runNow()).toMatchObject({ scanned: 1, applied: 1 })
    expect(fila.loyaltyProcessedAt).toEqual(despues)
  })

  it('control: sin liga de por medio, la venta sin cliente se cierra como hoy', async () => {
    const fila = ventaPendienteSinCliente()
    const tabla = tablaDeUnaVenta(fila)
    prismaMock.order.updateMany.mockImplementation(tabla.updateMany)
    prismaMock.orderCustomer.findMany.mockResolvedValue([])

    const job = new LoyaltyReconciliationJob({ prisma: { order: tabla } as never, cron: cron(), now: () => AHORA })
    expect(await job.runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })

    expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date)
  })

  it('🔴 B2: por defecto el reconciliador pasa por el envoltorio — una venta ya reembolsada se cierra SIN otorgar', async () => {
    const fila = ventaPendienteSinCliente()
    const tabla = tablaDeUnaVenta(fila)
    prismaMock.order.updateMany.mockImplementation(tabla.updateMany)
    prismaMock.payment.count.mockResolvedValue(1)

    const job = new LoyaltyReconciliationJob({ prisma: { order: tabla } as never, cron: cron(), now: () => AHORA })
    expect(await job.runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })

    expect(prismaMock.orderCustomer.findMany).not.toHaveBeenCalled() // la lealtad ni siquiera corrió
    expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date)
  })
})

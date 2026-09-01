// tests/unit/services/marketing/emailQuota.service.test.ts
/**
 * 🔴 DINERO/CUOTA. Este ledger es lo único que impide que un negocio mande más correos
 * de campaña de los que su plan permite. Tiene que ser correcto bajo CONCURRENCIA: dos
 * encolados simultáneos no pueden pasar el chequeo por separado — por eso la mitad de
 * estas pruebas fija la FORMA del `updateMany` (un solo UPDATE condicional), no sólo el
 * resultado que el mock decide devolver.
 */
import { Prisma } from '@prisma/client'
import { periodoDeEnvio, reservarCuota, devolverCuota } from '@/services/marketing/emailQuota.service'
import { BadRequestError } from '@/errors/AppError'

function crearTxMock() {
  return {
    emailQuotaLedger: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
  } as unknown as Prisma.TransactionClient & {
    emailQuotaLedger: { upsert: jest.Mock; updateMany: jest.Mock }
  }
}

describe('periodoDeEnvio', () => {
  it('🔴 usa el calendario CIVIL de la zona del venue, no UTC — la trampa de siempre', () => {
    // 04:00 UTC del 1-sep es 22:00 del 31-ago en México (UTC-6): todavía es agosto allá.
    expect(periodoDeEnvio(new Date('2026-09-01T04:00:00.000Z'), 'America/Mexico_City')).toBe('2026-08')
  })

  it('a mediodía UTC del mismo 1-sep, en México ya es septiembre', () => {
    // 12:00 UTC − 6h = 06:00 local del 1-sep: ya cruzó la medianoche mexicana.
    expect(periodoDeEnvio(new Date('2026-09-01T12:00:00.000Z'), 'America/Mexico_City')).toBe('2026-09')
  })
})

describe('reservarCuota', () => {
  let tx: ReturnType<typeof crearTxMock>

  beforeEach(() => {
    tx = crearTxMock()
    tx.emailQuotaLedger.upsert.mockResolvedValue({ id: 'l1', venueId: 'v1', period: '2026-09', reserved: 0 })
  })

  it('crea la fila EN CERO sólo si no existe (upsert no pisa un contador vivo)', async () => {
    tx.emailQuotaLedger.updateMany.mockResolvedValue({ count: 1 })

    await reservarCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 3, topeMensual: 500 })

    expect(tx.emailQuotaLedger.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_period: { venueId: 'v1', period: '2026-09' } },
        create: { venueId: 'v1', period: '2026-09', reserved: 0 },
        update: {},
      }),
    )
  })

  it('🔴 la atomicidad ES un solo updateMany condicional — fija la FORMA del where', async () => {
    tx.emailQuotaLedger.updateMany.mockResolvedValue({ count: 1 })

    await reservarCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 3, topeMensual: 500 })

    expect(tx.emailQuotaLedger.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.emailQuotaLedger.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: 'v1', period: '2026-09', reserved: { lte: 500 - 3 } }),
        data: expect.objectContaining({ reserved: { increment: 3 } }),
      }),
    )
  })

  it('🔴 count 0 (tope excedido) lanza BadRequestError en español que dice el tope', async () => {
    tx.emailQuotaLedger.updateMany.mockResolvedValue({ count: 0 })

    const promesa = reservarCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 10, topeMensual: 500 })

    await expect(promesa).rejects.toBeInstanceOf(BadRequestError)
    await expect(promesa).rejects.toThrow(/500/)
  })

  it('count 1 (cupo disponible) resuelve sin lanzar', async () => {
    tx.emailQuotaLedger.updateMany.mockResolvedValue({ count: 1 })

    await expect(reservarCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 1, topeMensual: 500 })).resolves.toBeUndefined()
  })
})

describe('devolverCuota', () => {
  it('🔴 fija la FORMA del guard: gte cantidad en el where, decrement cantidad en data', async () => {
    const tx = crearTxMock()
    tx.emailQuotaLedger.updateMany.mockResolvedValue({ count: 1 })

    await devolverCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 4 })

    expect(tx.emailQuotaLedger.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.emailQuotaLedger.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: 'v1', period: '2026-09', reserved: { gte: 4 } }),
        data: expect.objectContaining({ reserved: { decrement: 4 } }),
      }),
    )
  })

  it('nunca lanza cuando el guard no encuentra fila que cumpla (devolución tardía/duplicada)', async () => {
    const tx = crearTxMock()
    tx.emailQuotaLedger.updateMany.mockResolvedValue({ count: 0 })

    await expect(devolverCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 4 })).resolves.toBeUndefined()
  })

  it('🔴 IDEMPOTENTE de punta a punta: dos devoluciones seguidas de la MISMA cantidad dejan reserved en 0, nunca negativo', async () => {
    // Réplica MÍNIMA de la semántica condicional de Postgres para esta única columna:
    // el UPDATE sólo aplica si `reserved >= cantidad` en el momento de ejecutarse — es
    // justo la garantía que el `where: { reserved: { gte } }` real le pide a la base.
    // No es un mock que "decide" el resultado a mano: el estado se deriva de la MISMA
    // llamada que el servicio hace, dos veces seguidas.
    const estado = { reserved: 5 }
    const tx = {
      emailQuotaLedger: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          const guard = where?.reserved?.gte
          if (typeof guard === 'number' && estado.reserved < guard) {
            return { count: 0 }
          }
          const decremento = data?.reserved?.decrement
          if (typeof decremento === 'number') {
            estado.reserved -= decremento
          }
          return { count: 1 }
        }),
      },
    } as unknown as Prisma.TransactionClient

    await devolverCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 5 })
    expect(estado.reserved).toBe(0)

    // Segunda devolución IDÉNTICA (reintento, doble entrega del job): no debe tronar
    // ni bajar de 0 — el guard `gte 5` ya no encuentra fila (reserved quedó en 0).
    await expect(devolverCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 5 })).resolves.toBeUndefined()
    expect(estado.reserved).toBe(0)
  })
})

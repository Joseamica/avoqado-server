// tests/unit/services/marketing/emailQuota.service.test.ts
/**
 * 🔴 DINERO/CUOTA. Este ledger es lo único que impide que un negocio mande más correos
 * de campaña de los que su plan permite. Tiene que ser correcto bajo CONCURRENCIA: dos
 * encolados simultáneos no pueden pasar el chequeo por separado — por eso la mitad de
 * estas pruebas fija la FORMA de las llamadas a Prisma (un solo UPDATE condicional,
 * createMany+skipDuplicates para la creación), no sólo el resultado que el mock decide
 * devolver.
 */
import { Prisma } from '@prisma/client'
import { periodoDeEnvio, reservarCuota, devolverCuota } from '@/services/marketing/emailQuota.service'
import { BadRequestError } from '@/errors/AppError'

function crearTxMock() {
  return {
    emailQuotaLedger: {
      // 🔴 Fix loop 1 / Hallazgo 1: el `upsert` se sustituyó por `createMany` +
      // `skipDuplicates` (el `upsert` de Prisma NO es atómico bajo concurrencia — hace
      // SELECT y luego INSERT/UPDATE). Se conserva `upsert` en el mock, jamás usado por
      // el servicio ya arreglado, para que el sabotaje (volver a `upsert`) no truene con
      // un TypeError y en cambio haga fallar limpio la prueba de FORMA.
      upsert: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
    },
  } as unknown as Prisma.TransactionClient & {
    emailQuotaLedger: { upsert: jest.Mock; createMany: jest.Mock; updateMany: jest.Mock }
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

  // 🔴 Fix loop 1 / Hallazgo 3: una zona nula o inválida NO cae a nada en silencio
  // (`'Invalid DateTime'` guardado como `period` sería una fila de cuota basura) —
  // REVIENTA, como manda la regla del workspace ya aplicada en la alerta de asistencia.
  describe('zona inválida — REVIENTA, nunca cae a nada en silencio', () => {
    it.each(['Not/AZone', ''])('🔴 zona "%s" lanza con la zona en el mensaje', zona => {
      expect(() => periodoDeEnvio(new Date('2026-09-01T04:00:00.000Z'), zona)).toThrow(
        `Zona horaria inválida para calcular el período de envío: "${zona}"`,
      )
    })

    it('regresión: America/Mexico_City sigue dando el período correcto', () => {
      expect(periodoDeEnvio(new Date('2026-09-01T04:00:00.000Z'), 'America/Mexico_City')).toBe('2026-08')
    })
  })
})

describe('reservarCuota', () => {
  let tx: ReturnType<typeof crearTxMock>

  beforeEach(() => {
    tx = crearTxMock()
    tx.emailQuotaLedger.createMany.mockResolvedValue({ count: 1 })
  })

  // 🔴 Fix loop 1 / Hallazgo 1: dos `$transaction` concurrentes haciendo `upsert` sobre
  // un (venueId, period) que NO existía — uno pasa, el otro revienta con P2002. Dentro
  // de una transacción de Postgres esa violación de unique ABORTA la transacción
  // entera, así que ni siquiera vale atrapar el P2002 con try/catch (el `updateMany`
  // siguiente fallaría con 25P02). `createMany({ skipDuplicates: true })` emite
  // `INSERT … ON CONFLICT DO NOTHING` y nunca lanza — mismo patrón que
  // `referralQualification.service.ts:229-245`.
  it('🔴 crea la fila EN CERO por createMany+skipDuplicates — el upsert de Prisma NO es atómico bajo concurrencia', async () => {
    tx.emailQuotaLedger.updateMany.mockResolvedValue({ count: 1 })

    await reservarCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 3, topeMensual: 500 })

    expect(tx.emailQuotaLedger.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [expect.objectContaining({ venueId: 'v1', period: '2026-09', reserved: 0 })],
      }),
    )
    expect(tx.emailQuotaLedger.upsert).not.toHaveBeenCalled()
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

  it('🔴 count 0 (tope excedido) lanza BadRequestError en español que dice el tope y lo pedido', async () => {
    tx.emailQuotaLedger.updateMany.mockResolvedValue({ count: 0 })

    const promesa = reservarCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 10, topeMensual: 500 })

    await expect(promesa).rejects.toBeInstanceOf(BadRequestError)
    await expect(promesa).rejects.toThrow(/500/)
    await expect(promesa).rejects.toThrow(/10/)
  })

  it('count 1 (cupo disponible) resuelve sin lanzar', async () => {
    tx.emailQuotaLedger.updateMany.mockResolvedValue({ count: 1 })

    await expect(reservarCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 1, topeMensual: 500 })).resolves.toBeUndefined()
  })

  // 🔴 Fix loop 1 / Hallazgo 2: `cantidad: -1000000` hacía que el `lte` pasara SIEMPRE
  // (un `reserved <= topeMensual - (-1000000)` es un número enorme) y el `increment`
  // negativo dejaba `reserved` muy negativo — cuota infinita regalada. Se valida ANTES
  // de tocar la base: ninguna de las dos llamadas a Prisma debe ocurrir.
  describe('validación de cantidad — nunca toca la base', () => {
    it.each([
      ['negativa', -1000000],
      ['cero', 0],
      ['no entera', 2.5],
    ])('🔴 cantidad %s lanza BadRequestError y NO llama a createMany ni updateMany', async (_desc, cantidad) => {
      await expect(reservarCuota(tx, { venueId: 'v1', period: '2026-09', cantidad, topeMensual: 500 })).rejects.toBeInstanceOf(
        BadRequestError,
      )
      expect(tx.emailQuotaLedger.createMany).not.toHaveBeenCalled()
      expect(tx.emailQuotaLedger.updateMany).not.toHaveBeenCalled()
    })
  })

  describe('validación de topeMensual — nunca toca la base', () => {
    it.each([
      ['negativo', -1],
      ['no entero', 2.5],
    ])('🔴 topeMensual %s lanza BadRequestError y NO llama a createMany ni updateMany', async (_desc, topeMensual) => {
      await expect(reservarCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 1, topeMensual })).rejects.toBeInstanceOf(
        BadRequestError,
      )
      expect(tx.emailQuotaLedger.createMany).not.toHaveBeenCalled()
      expect(tx.emailQuotaLedger.updateMany).not.toHaveBeenCalled()
    })

    it('topeMensual = 0 es legítimo (rechaza TODO el envío) — no lo bloquea la validación, lo bloquea el tope', async () => {
      tx.emailQuotaLedger.updateMany.mockResolvedValue({ count: 0 })

      const promesa = reservarCuota(tx, { venueId: 'v1', period: '2026-09', cantidad: 1, topeMensual: 0 })

      await expect(promesa).rejects.toThrow(/tope de 0/)
      // Sí llegó a tocar la base — la validación de forma no lo cortó antes de tiempo.
      expect(tx.emailQuotaLedger.createMany).toHaveBeenCalled()
    })
  })

  // `period` es una cadena libre en la firma: el ledger no puede saber si el llamador pasó
  // por `periodoDeEnvio` o pegó lo que fuera. Un período con otra forma no rompe la
  // concurrencia — crea un cubo HUÉRFANO que ningún reporte mensual va a reconocer, y se
  // descubre meses después contra datos reales. Se valida en la frontera, como `cantidad`.
  describe('validación de period — nunca toca la base', () => {
    it.each([
      ['mes sin cero', '2026-9'],
      ['mes 13', '2026-13'],
      ['la cadena que Luxon devuelve sin isValid', 'Invalid DateTime'],
      ['con día', '2026-09-01'],
      ['vacío', ''],
    ])('🔴 period "%s" (%s) lanza BadRequestError y NO llama a createMany ni updateMany', async (_desc, period) => {
      await expect(reservarCuota(tx, { venueId: 'v1', period, cantidad: 1, topeMensual: 500 })).rejects.toBeInstanceOf(BadRequestError)
      expect(tx.emailQuotaLedger.createMany).not.toHaveBeenCalled()
      expect(tx.emailQuotaLedger.updateMany).not.toHaveBeenCalled()
    })
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

  // 🔴 Fix loop 1 / Hallazgo 2: `devolverCuota(cantidad: -5)` INCREMENTA en vez de
  // devolver (`decrement: -5` === `increment: 5`). Se valida ANTES de tocar la base.
  describe('validación de cantidad — nunca toca la base', () => {
    it.each([
      ['negativa', -5],
      ['cero', 0],
      ['no entera', 2.5],
    ])('🔴 cantidad %s lanza BadRequestError y NO llama a updateMany', async (_desc, cantidad) => {
      const tx = crearTxMock()

      await expect(devolverCuota(tx, { venueId: 'v1', period: '2026-09', cantidad })).rejects.toBeInstanceOf(BadRequestError)
      expect(tx.emailQuotaLedger.updateMany).not.toHaveBeenCalled()
    })
  })

  describe('validación de period — nunca toca la base', () => {
    it.each([
      ['mes 13', '2026-13'],
      ['la cadena que Luxon devuelve sin isValid', 'Invalid DateTime'],
    ])('🔴 period "%s" (%s) lanza BadRequestError y NO llama a updateMany', async (_desc, period) => {
      const tx = crearTxMock()

      await expect(devolverCuota(tx, { venueId: 'v1', period, cantidad: 1 })).rejects.toBeInstanceOf(BadRequestError)
      expect(tx.emailQuotaLedger.updateMany).not.toHaveBeenCalled()
    })
  })
})

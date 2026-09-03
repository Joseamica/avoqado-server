/**
 * Fase 4 de la unificación de caja: INTEGRIDAD del cajón.
 *
 * Dos huecos de concurrencia que la auditoría del 27-ago marcó como P0:
 *   · doble apertura: `openSession` hacía check-then-create sin índice único; dos requests
 *     simultáneos abrían DOS cajas y las lecturas posteriores elegían una al azar. Se cierra
 *     con un índice único PARCIAL en la base (migración) — aquí se prueba que el servicio
 *     traduce el choque del índice al mismo ConflictError que ya conocen las apps.
 *   · cierre sin candado: `closeSession` leía eventos, calculaba y actualizaba en tres pasos
 *     sueltos. Una venta que entrara entre "leer" y "escribir" dejaba el `overShort` obsoleto;
 *     dos cierres a la vez se pisaban y creaban dos eventos CLOSE. Ahora el cierre es una
 *     transacción con CAS (`updateMany where status='OPEN'`): quien pierde la carrera recibe
 *     el mismo NotFoundError que "no hay caja abierta", y el cálculo se hace DENTRO de la
 *     transacción sobre los eventos que ella ve.
 *
 * 🔴 Ningún contrato de respuesta cambia: mismos errores, misma forma de sesión.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { Prisma } from '@prisma/client'
import { closeSession, openSession } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const evt = (type: string, amount: number) => ({ id: `e-${type}-${amount}`, sessionId: 's-1', type, amount, createdAt: new Date() })
const abierta = () => ({
  id: 's-1',
  venueId: VENUE,
  status: 'OPEN',
  deviceName: 'Caja 1',
  openedByStaffId: 'staff-1',
  openedByName: 'Ana',
  openedAt: new Date('2026-08-27T08:00:00Z'),
  startingAmount: 100,
  closedAt: null,
  actualAmount: null,
  overShort: null,
  closingNote: null,
  events: [evt('OPEN', 100), evt('CASH_SALE', 250)],
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
})

/**
 * 🔴 Desde la Fase 2 (3-sep-2026) esta ruta abre EL TURNO DE CAJA DEL NEGOCIO: por dentro llama a
 * `abrirTurnoDeCaja`, que resuelve turno + cajón en una transacción. Hay que sembrar venue, staff y
 * turno además de la caja — y el P2002 se prueba con la forma REAL que da Postgres.
 */
function sembrarAperturaUnificada() {
  ;(prismaMock as any).venue.findUnique = jest.fn().mockResolvedValue({
    id: VENUE,
    name: 'Venue de prueba',
    timezone: 'America/Mexico_City',
    posType: null,
    posStatus: 'NOT_INTEGRATED',
  })
  ;(prismaMock as any).staffVenue = {
    findFirst: jest.fn().mockResolvedValue({
      staffId: 'staff-2',
      venueId: VENUE,
      posStaffId: null,
      staff: { id: 'staff-2', firstName: 'Luis', lastName: null },
    }),
  }
  ;(prismaMock as any).shift = {
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'turno-nuevo' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
}

/**
 * La forma REAL del choque, medida contra Postgres el 3-sep-2026: `meta.target` trae la lista de
 * COLUMNAS del índice parcial, no su nombre, y `meta.constraint` no viene.
 */
const p2002DelIndiceDeAbiertas = () =>
  new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x', meta: { target: ['venueId'] } } as never)

describe('fase 4 · doble apertura', () => {
  it('🔴 si dos aperturas chocan en el índice único, la segunda recibe el ConflictError de siempre (no un 500)', async () => {
    sembrarAperturaUnificada()
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null), // el check pasó (carrera)
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockRejectedValue(p2002DelIndiceDeAbiertas()),
    }
    await expect(openSession({ venueId: VENUE, staffId: 'staff-2', staffName: 'Luis', startingAmount: 50 })).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  /**
   * 🔴 Cambio DECLARADO de la Fase 2: un P2002 sin descriptor ya NO se traduce a 409. Antes esta
   * ruta convertía cualquier P2002 en «ya existe una caja abierta», y `CashDrawerSession` tiene un
   * segundo único (`shiftId`) además del `localId` de sus eventos: traducirlos todos mandaba al
   * cajero a cerrar una caja que no existe. Sin saber QUÉ chocó no se adivina — y un 500 honesto es
   * preferible, sobre todo porque el 409 lo tratan las apps como rechazo PERMANENTE.
   */
  it('🔴 un P2002 SIN descriptor no se disfraza de «ya hay una caja abierta»', async () => {
    sembrarAperturaUnificada()
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' })),
    }
    // 🔴 `not.toMatchObject({statusCode: 409})` lo satisface CUALQUIER rechazo —incluido un
    // `TypeError` sin relación—, así que se afirma que sube el error CRUDO de Prisma: es lo único
    // que distingue «no se disfrazó» de «se rompió por otra cosa».
    await expect(openSession({ venueId: VENUE, staffId: 'staff-2', staffName: 'Luis', startingAmount: 50 })).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    )
    await expect(openSession({ venueId: VENUE, staffId: 'staff-2', staffName: 'Luis', startingAmount: 50 })).rejects.toMatchObject({
      code: 'P2002',
    })
  })
})

describe('fase 4 · cierre con candado', () => {
  it('🔴 P1 Codex: el CAS a CLOSED se toma ANTES de leer los eventos, y el overShort se firma con lo leído bajo el candado', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 })
    const findMany = jest.fn().mockResolvedValue([evt('OPEN', 100), evt('CASH_SALE', 250)])
    const update = jest.fn().mockResolvedValue({})
    ;(prismaMock as any).cashDrawerSession = {
      findFirst: jest.fn().mockResolvedValue(abierta()),
      updateMany,
      update,
      findUnique: jest.fn().mockResolvedValue({ ...abierta(), status: 'CLOSED', actualAmount: 340, overShort: -10 }),
    }
    ;(prismaMock as any).cashDrawerEvent = { findMany, create: jest.fn().mockResolvedValue({}) }
    await closeSession({ venueId: VENUE, staffId: 'staff-1', staffName: 'Ana', actualAmount: 340 })
    // el candado (UPDATE … WHERE status='OPEN') va PRIMERO; después se leen los eventos
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(findMany.mock.invocationCallOrder[0])
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ id: 's-1', status: 'OPEN' })
    // y la diferencia se escribe DESPUÉS con lo que se leyó bajo el candado: 340 − (100 + 250) = −10
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 's-1' }, data: expect.objectContaining({ overShort: expect.anything() }) }),
    )
    expect(Number(update.mock.calls[0][0].data.overShort)).toBe(-10)
  })

  it('🔴 el cierre es un CAS: si otro cierre ganó la carrera, éste recibe "no hay caja abierta" y NO escribe un segundo CLOSE', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 }) // perdió la carrera
    ;(prismaMock as any).cashDrawerSession = {
      findFirst: jest.fn().mockResolvedValue(abierta()),
      updateMany,
      update: jest.fn(),
      findUnique: jest.fn(),
    }
    ;(prismaMock as any).cashDrawerEvent = { create: jest.fn(), findMany: jest.fn().mockResolvedValue(abierta().events) }
    await expect(closeSession({ venueId: VENUE, staffId: 'staff-1', staffName: 'Ana', actualAmount: 350 })).rejects.toMatchObject({
      statusCode: 404,
    })
    expect((prismaMock as any).cashDrawerEvent.create).not.toHaveBeenCalled()
  })

  it('🔴 el esperado se calcula DENTRO de la transacción sobre los eventos que ella ve: una venta que entró tarde cuenta', async () => {
    // fuera de la tx la sesión tenía 100+250; dentro ya hay otra venta de 80 ⇒ esperado 430
    ;(prismaMock as any).cashDrawerSession = {
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(abierta()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({
        ...abierta(),
        status: 'CLOSED',
        actualAmount: 400,
        overShort: -30,
        events: [...abierta().events, evt('CASH_SALE', 80)],
      }),
    }
    ;(prismaMock as any).cashDrawerEvent = {
      findMany: jest.fn().mockResolvedValue([...abierta().events, evt('CASH_SALE', 80)]),
      create: jest.fn().mockResolvedValue({}),
    }
    const r = await closeSession({ venueId: VENUE, staffId: 'staff-1', staffName: 'Ana', actualAmount: 400 })
    // desde el arreglo del P1 (27-ago) el overShort se escribe en el `update` posterior al candado
    const data = (prismaMock as any).cashDrawerSession.update.mock.calls[0][0].data
    expect(Number(data.overShort)).toBe(-30) // 400 contado − 430 esperado
    expect((prismaMock as any).cashDrawerSession.updateMany.mock.calls[0][0].where).toMatchObject({
      id: 's-1',
      venueId: VENUE,
      status: 'OPEN',
    })
    expect(r.status).toBe('CLOSED')
  })
})

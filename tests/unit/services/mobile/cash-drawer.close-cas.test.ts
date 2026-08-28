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

describe('fase 4 · doble apertura', () => {
  it('🔴 si dos aperturas chocan en el índice único, la segunda recibe el ConflictError de siempre (no un 500)', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      findFirst: jest.fn().mockResolvedValue(null), // el check pasó (carrera)
      create: jest.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' })),
    }
    await expect(openSession({ venueId: VENUE, staffId: 'staff-2', staffName: 'Luis', startingAmount: 50 })).rejects.toMatchObject({
      statusCode: 409,
    })
  })
})

describe('fase 4 · cierre con candado', () => {
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
    const data = (prismaMock as any).cashDrawerSession.updateMany.mock.calls[0][0].data
    expect(Number(data.overShort)).toBe(-30) // 400 contado − 430 esperado
    expect((prismaMock as any).cashDrawerSession.updateMany.mock.calls[0][0].where).toMatchObject({
      id: 's-1',
      venueId: VENUE,
      status: 'OPEN',
    })
    expect(r.status).toBe('CLOSED')
  })
})

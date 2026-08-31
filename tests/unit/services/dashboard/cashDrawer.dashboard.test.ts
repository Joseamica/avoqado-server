/**
 * Fase 1 de la unificación de caja: EL DUEÑO VE EL ARQUEO DE ANDROID.
 *
 * El cajón (`CashDrawerSession` + `CashDrawerEvent`) lo escribe el POS de Android y, desde
 * el 16-ago, también la TPV al cobrar en efectivo. Calcula el esperado y el sobrante/faltante
 * en cada cierre — y hasta hoy NADIE podía leerlo: sólo tenía rutas /mobile, ninguna del
 * dashboard, ninguna tool MCP. El dueño veía "Turnos" (Shift, la PAX) y creía que eso era
 * la caja.
 *
 * Esta capa es SÓLO LECTURA sobre el servicio mobile existente. No toca Android, ni la TPV,
 * ni el modelo, ni `cashDrawerPosting`, ni `Shift`. Se apaga quitando la ruta.
 *
 * Lo que estas pruebas protegen (auditoría Codex 27-ago, §7 fase 1):
 *   1. el esperado se calcula igual que en el cierre real (inicial + ventas + entradas − salidas);
 *   2. 🔴 una sesión SIN conteo se declara como tal — nunca se disfraza de "cuadró";
 *   3. 🔴 dos sesiones OPEN en el mismo venue (carrera al abrir) NO se esconden: el
 *      estado avisa la anomalía en vez de elegir una al azar;
 *   4. el historial trae TODAS las sesiones, no sólo las cerradas, para que una abierta
 *      olvidada hace semanas aparezca;
 *   5. el filtro por venue es inamovible (multi-tenant).
 */

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { getDrawerStatus, getDrawerSessions } from '@/services/dashboard/cashDrawer.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

const evt = (type: string, amount: number) => ({
  id: `evt-${type}-${amount}`,
  sessionId: 'session-1',
  type,
  amount,
  note: null,
  staffId: 'staff-1',
  staffName: 'Cajero',
  orderId: null,
  localId: null,
  createdAt: new Date('2026-08-16T10:00:00.000Z'),
})

const sesion = (over: Record<string, unknown> = {}) => ({
  id: 'session-1',
  venueId: VENUE,
  deviceName: 'Caja 1',
  status: 'OPEN',
  openedByStaffId: 'staff-1',
  openedByName: 'Ana',
  openedAt: new Date('2026-08-16T08:00:00.000Z'),
  startingAmount: 100,
  closedByStaffId: null,
  closedByName: null,
  closedAt: null,
  actualAmount: null,
  overShort: null,
  closingNote: null,
  events: [evt('OPEN', 100), evt('CASH_SALE', 250), evt('PAY_IN', 50), evt('PAY_OUT', 80)],
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe('getDrawerStatus — la caja de ahora', () => {
  it('el esperado es inicial + ventas + entradas − salidas: 100 + 250 + 50 − 80 = 320', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([sesion()]),
    }

    const status = await getDrawerStatus(VENUE, true) // pide el esperado: esta prueba mide la FÓRMULA

    expect(status.open).not.toBeNull()
    expect(status.open?.expectedAmount).toBe(320)
    expect(status.open?.startingAmount).toBe(100)
    expect(status.open?.cashSales).toBe(250)
    expect(status.open?.payIns).toBe(50)
    expect(status.open?.payOuts).toBe(80)
    expect(status.anomalies).toEqual([])
  })

  it('sin caja abierta: open es null y no hay anomalías', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    }

    const status = await getDrawerStatus(VENUE)

    expect(status.open).toBeNull()
    expect(status.anomalies).toEqual([])
  })

  it('🔴 dos cajas OPEN en el mismo venue NO se esconden: se reporta la anomalía', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest
        .fn()
        .mockResolvedValue([sesion({ id: 'session-2', openedAt: new Date('2026-08-16T09:00:00.000Z') }), sesion({ id: 'session-1' })]),
    }

    const status = await getDrawerStatus(VENUE)

    expect(status.anomalies).toContainEqual(
      expect.objectContaining({ code: 'MULTIPLE_OPEN_SESSIONS', sessionIds: expect.arrayContaining(['session-1', 'session-2']) }),
    )
  })

  it('filtra SIEMPRE por el venue pedido', async () => {
    const findMany = jest.fn().mockResolvedValue([])
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findMany,
    }

    await getDrawerStatus(VENUE)

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE, status: 'OPEN' }) }))
  })
})

describe('getDrawerSessions — el historial que el dueño no podía ver', () => {
  it('🔴 una sesión cerrada SIN conteo se declara counted=false y overShort=null — nunca "cuadró"', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([
        sesion({
          status: 'CLOSED',
          closedAt: new Date('2026-08-16T18:00:00.000Z'),
          closedByName: 'Ana',
          actualAmount: null,
          overShort: null,
        }),
      ]),
      count: jest.fn().mockResolvedValue(1),
    }

    const { sessions } = await getDrawerSessions(VENUE, { page: 1, pageSize: 20 })

    expect(sessions[0].counted).toBe(false)
    expect(sessions[0].overShort).toBeNull()
    expect(sessions[0].expectedAmount).toBe(320)
  })

  it('una sesión cerrada CON conteo trae el faltante real: contó 300 contra 320 esperados = −20', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest
        .fn()
        .mockResolvedValue([
          sesion({ status: 'CLOSED', closedAt: new Date('2026-08-16T18:00:00.000Z'), actualAmount: 300, overShort: -20 }),
        ]),
      count: jest.fn().mockResolvedValue(1),
    }

    const { sessions } = await getDrawerSessions(VENUE, { page: 1, pageSize: 20 })

    expect(sessions[0].counted).toBe(true)
    expect(sessions[0].actualAmount).toBe(300)
    expect(sessions[0].overShort).toBe(-20)
  })

  it('🔴 el historial trae TODAS las sesiones (también las OPEN olvidadas), no sólo las cerradas', async () => {
    const findMany = jest.fn().mockResolvedValue([])
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findMany,
      count: jest.fn().mockResolvedValue(0),
    }

    await getDrawerSessions(VENUE, { page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.venueId).toBe(VENUE)
    expect(where.status).toBeUndefined()
  })

  it('pagina y reporta el total', async () => {
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([sesion()]),
      count: jest.fn().mockResolvedValue(43),
    }

    const res = await getDrawerSessions(VENUE, { page: 3, pageSize: 20 })

    expect(res.pagination).toEqual({ page: 3, pageSize: 20, total: 43, totalPages: 3 })
    expect((prismaMock as any).cashDrawerSession.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 40, take: 20 }))
  })

  // ===== CONTEO CIEGO A NIVEL DE API =====
  //
  // 🔴 El conteo ciego se construyó SÓLO en la pantalla del POS: el permiso
  // `cash-drawer:view-expected` existía en el catálogo y no lo comprobaba nadie, así que
  // este endpoint le servía el efectivo esperado a cualquiera con `shifts:read` — que
  // CASHIER y WAITER tienen por defecto. Un cajero podía pedirlo con su propio token,
  // teclear esa cifra en el cierre y dejar el faltante en cero.
  //
  // Ocultar sólo el total no basta: `startingAmount + cashSales + payIns − payOuts` ES el
  // esperado, así que los sumandos se van con él. Y sólo MIENTRAS la caja está ABIERTA:
  // una vez cerrada el resultado ya está firmado y revelarlo es justo el diseño.
  describe('conteo ciego: el esperado no se sirve a quien no puede verlo', () => {
    it('🔴 caja ABIERTA sin permiso: ni el esperado ni los sumandos que lo reconstruyen', async () => {
      ;(prismaMock as any).cashDrawerSession.findMany = jest.fn().mockResolvedValue([sesion({ events: [evt('CASH_SALE', 500)] })])
      const r = await getDrawerStatus(VENUE, false)
      const abierta: any = r.open
      expect(abierta.expectedAmount).toBeUndefined()
      expect(abierta.startingAmount).toBeUndefined()
      expect(abierta.cashSales).toBeUndefined()
      expect(abierta.payIns).toBeUndefined()
      expect(abierta.payOuts).toBeUndefined()
      // lo que sí sigue viéndose: de quién es la caja y desde cuándo
      expect(abierta.id).toBe('session-1')
      expect(abierta.status).toBe('OPEN')
      expect(abierta.openedByName).toBeDefined()
    })

    it('🔴 caja ABIERTA con permiso: se ve todo, como siempre', async () => {
      ;(prismaMock as any).cashDrawerSession.findMany = jest.fn().mockResolvedValue([sesion({ events: [evt('CASH_SALE', 500)] })])
      const r = await getDrawerStatus(VENUE, true)
      const abierta: any = r.open
      expect(typeof abierta.expectedAmount).toBe('number')
      expect(typeof abierta.startingAmount).toBe('number')
      expect(typeof abierta.cashSales).toBe('number')
    })

    it('🔴 el DEFAULT es ocultar: quien olvide pasar el permiso no filtra el dato', async () => {
      ;(prismaMock as any).cashDrawerSession.findMany = jest.fn().mockResolvedValue([sesion({ events: [] })])
      const r = await getDrawerStatus(VENUE)
      expect((r.open as any)?.expectedAmount).toBeUndefined()
    })

    it('una vez CERRADA, el resultado se revela aunque no tenga el permiso', async () => {
      const cerrada = sesion({
        status: 'CLOSED',
        actualAmount: 1500,
        overShort: 0,
        closedAt: new Date('2026-08-16T20:00:00.000Z'),
        events: [],
      })
      ;(prismaMock as any).cashDrawerSession.findMany = jest.fn().mockResolvedValue([cerrada])
      ;(prismaMock as any).cashDrawerSession.count = jest.fn().mockResolvedValue(1)
      const r: any = await getDrawerSessions(VENUE, { page: 1, pageSize: 20 }, false)
      expect(typeof r.sessions[0].expectedAmount).toBe('number')
      expect(r.sessions[0].actualAmount).toBe(1500)
    })
  })
})

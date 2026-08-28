/**
 * 🔴 EL SERVIDOR TIENE LA LLAVE Y NO LA MANDA — por eso los clientes fusionan por INFERENCIA.
 *
 * `CashDrawerEvent.localId` (`@@unique([venueId, localId])`) ya se guarda: el POS lo manda al
 * sincronizar y el servidor lo deriva del `paymentId` para lo que escribe él
 * (`srv-cash-sale:` / `srv-refund:`). Pero `formatEvent` NUNCA lo devolvía, así que el cliente
 * recibía el evento del servidor sin forma de reconocer que ERA EL SUYO — y lo insertaba al
 * lado del que ya tenía en su base local.
 *
 * Consecuencia MEDIDA en Android (defecto A): un PAY_IN de $100 que ya estaba en Room antes de
 * actualizar la app queda DOS veces —`local-ev-payin` y `srv-ev-payin`— porque la limpieza por
 * tipo (`SERVER_OWNED_EVENT_TYPES`) excluye PAY_IN/PAY_OUT a propósito (un retiro sin red debe
 * sobrevivir) y `promoteEvent` sólo corre al ESCRIBIR, no alcanza filas que ya estaban. El
 * número del cajero pasa de **523000 centavos ($5,230.00) a 533000 ($5,330.00): +$100**, el
 * tamaño exacto del movimiento heredado. Con un PAY_OUT heredado el error va al otro lado
 * (faltante inventado). Es PERMANENTE: ninguna sincronización posterior lo corrige.
 *
 * Este archivo prueba las DOS mitades del contrato nuevo:
 *   1. la forma — el payload de la API trae `localId` (null cuando no hay), sin quitar ni
 *      renombrar ningún campo existente (contrato /mobile: las apps viejas siguen igual);
 *   2. el DINERO — alimentando la regla de fusión con lo que el servidor devuelve DE VERDAD,
 *      el arqueo da 523000 centavos. Sin el campo (el contrato viejo) la misma regla no puede
 *      emparejar y da 533000. La llave es lo que separa esos dos números.
 */

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { getCurrentSession, syncEvents } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

/** Fila tal como vive en Postgres (todos los escalares, incluido `localId`). */
const row = (over: Partial<Record<string, any>> & { id: string; type: string; amount: number }) => ({
  sessionId: 'session-1',
  note: null,
  staffId: 'staff-1',
  staffName: 'Cajero',
  orderId: null,
  localId: null,
  createdAt: new Date('2026-08-16T10:00:00.000Z'),
  ...over,
})

/**
 * La caja del cajero, con un PAY_IN de $100 que el aparato ya tenía en su base local ANTES
 * de actualizar la app (`local-ev-payin`) y que el servidor confirma como `srv-ev-payin`.
 *
 *   inicial 1,000.00 + venta 4,200.00 + entrada 100.00 − retiro 70.00 = 5,230.00
 */
const SESSION_ROW = {
  id: 'session-1',
  venueId: VENUE,
  deviceName: 'Tablet Caja 1',
  status: 'OPEN',
  openedByStaffId: 'staff-1',
  openedByName: 'Cajero',
  openedAt: new Date('2026-08-16T08:00:00.000Z'),
  startingAmount: 1000,
  closedByStaffId: null,
  closedByName: null,
  closedAt: null,
  actualAmount: null,
  overShort: null,
  closingNote: null,
  events: [
    row({ id: 'srv-ev-open', type: 'OPEN', amount: 1000 }),
    // Lo escribe el SERVIDOR al cobrar: su llave se deriva del paymentId.
    row({ id: 'srv-ev-sale', type: 'CASH_SALE', amount: 4200, localId: 'srv-cash-sale:pay-1' }),
    // El heredado: nació en el POS con UUID local, el servidor lo guardó con ESA llave.
    row({ id: 'srv-ev-payin', type: 'PAY_IN', amount: 100, localId: 'local-ev-payin' }),
    row({ id: 'srv-ev-payout', type: 'PAY_OUT', amount: 70, localId: 'local-ev-payout' }),
  ],
}

const CENTS_CORRECTO = 523000 // $5,230.00 — lo que el cajero debe contar
const CENTS_CON_EL_DEFECTO = 533000 // $5,330.00 — el PAY_IN heredado contado dos veces

// ============================================================================
// La regla de fusión del cliente, espejada aquí como REFERENCIA
// ============================================================================
//
// Es el mismo contrato que Android e iOS implementan (`adoptServerSession`). Vive en el test
// para poder alimentarlo con el payload REAL de la API y medir el número del cajero: lo que se
// prueba no es el cliente, es que lo que el servidor manda ALCANCE para que la fusión acierte.

type ClientRow = { id: string; type: string; amountCents: number }
type ServerEvent = { id: string; type: string; amount: number; localId?: string | null }

const SERVER_OWNED_EVENT_TYPES = ['OPEN', 'CASH_SALE']

function mergeServerSession(localRows: ClientRow[], serverEvents: ServerEvent[]): ClientRow[] {
  const merged = [...localRows]

  for (const ev of serverEvents) {
    // (1) El servidor confirma un evento MÍO: la fila local adopta el id del servidor.
    const mine = ev.localId ? merged.findIndex(r => r.id === ev.localId) : -1
    if (mine >= 0) {
      merged[mine] = { ...merged[mine], id: ev.id }
      continue
    }
    // (2) De otro aparato, o lo escribió el servidor: entra por su id del servidor.
    if (!merged.some(r => r.id === ev.id)) {
      merged.push({ id: ev.id, type: ev.type, amountCents: Math.round(ev.amount * 100) })
    }
  }

  // (3) Copia provisional de un tipo que el servidor escribe por su cuenta y que NO confirmó.
  const confirmados = new Set(serverEvents.map(e => e.id))
  return merged.filter(r => !(SERVER_OWNED_EVENT_TYPES.includes(r.type) && !confirmados.has(r.id)))
}

function arqueoEnCentavos(rows: ClientRow[], startingCents: number): number {
  return rows.reduce((acc, r) => {
    if (r.type === 'PAY_IN' || r.type === 'CASH_SALE') return acc + r.amountCents
    if (r.type === 'PAY_OUT') return acc - r.amountCents
    return acc
  }, startingCents)
}

describe('contrato `localId` del cajón — el servidor manda la llave que ya tiene guardada', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock as any).cashDrawerSession = { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue(SESSION_ROW) }
  })

  // --------------------------------------------------------------------------
  // 1. LA FORMA
  // --------------------------------------------------------------------------

  it('🔴 cada evento de la sesión viaja con su `localId` guardado', async () => {
    const session = await getCurrentSession(VENUE, true)

    const porId = Object.fromEntries((session!.events as any[]).map(e => [e.id, e]))
    expect(porId['srv-ev-payin'].localId).toBe('local-ev-payin')
    expect(porId['srv-ev-payout'].localId).toBe('local-ev-payout')
    expect(porId['srv-ev-sale'].localId).toBe('srv-cash-sale:pay-1')
  })

  it('un evento sin `localId` responde null, no rompe ni omite el campo', async () => {
    const session = await getCurrentSession(VENUE, true)

    const open = (session!.events as any[]).find(e => e.id === 'srv-ev-open')
    expect(open).toHaveProperty('localId')
    expect(open.localId).toBeNull()
  })

  it('el eco de /sync también trae el `localId` (es el que marca el outbox del POS)', async () => {
    ;(prismaMock as any).cashDrawerEvent = {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([row({ id: 'srv-ev-payin', type: 'PAY_IN', amount: 100, localId: 'local-ev-payin' })]),
      create: jest.fn(),
    }

    const res = await syncEvents(VENUE, [
      { type: 'PAY_IN', amount: 100, staffId: 'staff-1', staffName: 'Cajero', localId: 'local-ev-payin' },
    ] as any)

    expect(res.events[0]).toMatchObject({ id: 'srv-ev-payin', localId: 'local-ev-payin' })
  })

  // --------------------------------------------------------------------------
  // 2. EL DINERO — el número que el cajero ve al cerrar
  // --------------------------------------------------------------------------

  it('🔴 con la llave, el arqueo del POS da 523000 centavos ($5,230.00) — el movimiento heredado NO se duplica', async () => {
    // Lo que el aparato ya tenía en Room antes de actualizar la app.
    const room: ClientRow[] = [{ id: 'local-ev-payin', type: 'PAY_IN', amountCents: 10000 }]

    const session = await getCurrentSession(VENUE, true)
    const fusionado = mergeServerSession(room, session!.events as any)

    expect(arqueoEnCentavos(fusionado, 100000)).toBe(CENTS_CORRECTO)
    // Y una sola fila del PAY_IN, no dos.
    expect(fusionado.filter(r => r.type === 'PAY_IN')).toHaveLength(1)
  })

  it('🔴 SIN la llave (contrato viejo) la MISMA fusión da 533000: +$100 inventados y permanentes', async () => {
    const room: ClientRow[] = [{ id: 'local-ev-payin', type: 'PAY_IN', amountCents: 10000 }]

    const session = await getCurrentSession(VENUE, true)
    // Ablación: el payload del servidor ANTES de este cambio — mismos eventos, sin `localId`.
    const contratoViejo = (session!.events as any[]).map(({ localId: _omitido, ...resto }) => resto)
    const fusionado = mergeServerSession(room, contratoViejo)

    expect(arqueoEnCentavos(fusionado, 100000)).toBe(CENTS_CON_EL_DEFECTO)
    expect(CENTS_CON_EL_DEFECTO - CENTS_CORRECTO).toBe(10000) // exactamente el PAY_IN heredado
  })

  it('🔴 con un PAY_OUT heredado el error va al otro lado: faltante inventado de $70', async () => {
    const room: ClientRow[] = [{ id: 'local-ev-payout', type: 'PAY_OUT', amountCents: 7000 }]

    const session = await getCurrentSession(VENUE, true)
    const conLlave = mergeServerSession(room, session!.events as any)
    const sinLlave = mergeServerSession(
      room,
      (session!.events as any[]).map(({ localId: _omitido, ...resto }) => resto),
    )

    expect(arqueoEnCentavos(conLlave, 100000)).toBe(CENTS_CORRECTO)
    expect(arqueoEnCentavos(sinLlave, 100000)).toBe(CENTS_CORRECTO - 7000) // 516000
  })

  it('un payload SIN eventos no autoriza a borrar nada del cliente', async () => {
    const room: ClientRow[] = [
      { id: 'local-ev-payin', type: 'PAY_IN', amountCents: 10000 },
      { id: 'local-ev-payout', type: 'PAY_OUT', amountCents: 7000 },
    ]

    const fusionado = mergeServerSession(room, [])

    expect(fusionado).toHaveLength(2)
    expect(arqueoEnCentavos(fusionado, 100000)).toBe(103000)
  })

  // --------------------------------------------------------------------------
  // 3. REGRESIÓN — el campo es ADITIVO, no se quitó ni se renombró nada
  // --------------------------------------------------------------------------

  it('el payload conserva EXACTAMENTE los campos que ya tenía (una app vieja lee igual)', async () => {
    const session = await getCurrentSession(VENUE, true)
    const evento = (session!.events as any[]).find(e => e.id === 'srv-ev-payin')

    expect(Object.keys(evento).sort()).toEqual(
      ['amount', 'createdAt', 'id', 'localId', 'note', 'orderId', 'sessionId', 'staffId', 'staffName', 'type'].sort(),
    )
    expect(evento).toMatchObject({
      id: 'srv-ev-payin',
      sessionId: 'session-1',
      type: 'PAY_IN',
      amount: 100,
      note: null,
      staffId: 'staff-1',
      staffName: 'Cajero',
      orderId: null,
      createdAt: '2026-08-16T10:00:00.000Z',
    })
  })

  it('el `expectedAmount` que calcula el servidor no cambió: 5230.00', async () => {
    const session = await getCurrentSession(VENUE, true)

    expect(session!.expectedAmount).toBe(5230)
    expect(Math.round(session!.expectedAmount * 100)).toBe(CENTS_CORRECTO)
  })
})

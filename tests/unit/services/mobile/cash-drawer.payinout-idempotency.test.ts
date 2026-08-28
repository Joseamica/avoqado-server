/**
 * 🔴 LA TUBERÍA ESTABA PUESTA Y EL AGUA NO PASABA: `localId` NUNCA SE GUARDABA
 * PARA UN INGRESO O UN RETIRO.
 *
 * El repo ya tenía las tres piezas de la idempotencia del cajón:
 *   · la columna `CashDrawerEvent.localId` con `@@unique([venueId, localId])`;
 *   · `formatEvent` devolviéndola (commit `e86661d7`);
 *   · el server derivando la suya del `paymentId` (`srv-cash-sale:` / `srv-refund:`).
 *
 * Pero se verificó a mano (2026-08-16) que SÓLO tres sitios escriben la columna:
 * `toRow` de `/cash-drawer/sync`, y los dos del helper `cashDrawerPosting`. Y el único
 * tipo que las apps mandan a `/sync` es `CASH_SALE`… que `syncEvents` DESCARTA a
 * propósito. O sea: **ningún `localId` escrito por un cliente llegaba jamás a Postgres**,
 * porque `payIn`/`payOut` —los dos endpoints por los que el POS sí manda movimientos
 * propios— ni siquiera aceptaban el campo.
 *
 * Consecuencia real, la que este archivo mide: el push del POS es fire-and-forget. Si la
 * respuesta se pierde (WiFi del local, 502 del proxy, la app que se reinicia), el cajero
 * reintenta el MISMO ingreso y el server crea una SEGUNDA fila. El arqueo la da por buena
 * y el número que el cajero tiene que contar sube por dinero que no existe.
 *
 * Los números son los del defecto medido en Android: fondo $5,000.00 + venta en efectivo
 * $280.00 − reembolso $150.00 + ingreso $100.00 = **$5,230.00 (523000 centavos)**. Con el
 * reintento duplicado da **533000: +$100 inventados**, el tamaño exacto del movimiento.
 * Con un RETIRO el error va al otro lado (faltante inventado).
 */

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { getCurrentSession, payIn, payOut, syncEvents } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const OTRO_VENUE = 'venue-2'

// ============================================================================
// Un Postgres de juguete que SÍ respeta `@@unique([venueId, localId])`
// ============================================================================
//
// Un mock que sólo cuenta llamadas no sirve aquí: lo que se prueba es el NÚMERO
// QUE VE EL CAJERO, y ese número sale de las filas que quedaron en la tabla. Este
// fake guarda filas de verdad, aplica el índice único y se las devuelve al
// `getCurrentSession` que calcula el arqueo — así el test mide el arqueo, no la
// forma de la llamada.

interface FilaCajon {
  id: string
  sessionId: string
  venueId: string
  type: string
  amount: any
  note: string | null
  staffId: string
  staffName: string
  orderId: string | null
  localId: string | null
  createdAt: Date
}

let filas: FilaCajon[] = []
let secuencia = 0

/** Fondo inicial de cada caja, en pesos. */
const FONDO: Record<string, number> = { [VENUE]: 5000, [OTRO_VENUE]: 5000 }
const SESION_DE: Record<string, string> = { [VENUE]: 'session-1', [OTRO_VENUE]: 'session-2' }

const chocaConElIndice = (venueId: string, localId: string | null | undefined) =>
  localId != null && filas.some(f => f.venueId === venueId && f.localId === localId)

const insertar = (data: any): FilaCajon => {
  const fila: FilaCajon = {
    note: null,
    orderId: null,
    localId: null,
    createdAt: new Date(Date.UTC(2026, 7, 16, 10, 0, ++secuencia)),
    ...data,
    id: `evt-db-${secuencia}`,
  }
  filas.push(fila)
  return fila
}

const montarBaseDeDatos = () => {
  ;(prismaMock as any).cashDrawerSession = { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}),
    findFirst: jest.fn(async ({ where }: any) => {
      const venueId = where.venueId
      if (!SESION_DE[venueId]) return null
      return {
        id: SESION_DE[venueId],
        venueId,
        deviceName: 'Tablet Caja 1',
        status: 'OPEN',
        openedByStaffId: 'staff-1',
        openedByName: 'Cajero',
        openedAt: new Date('2026-08-16T08:00:00.000Z'),
        startingAmount: FONDO[venueId],
        closedByStaffId: null,
        closedByName: null,
        closedAt: null,
        actualAmount: null,
        overShort: null,
        closingNote: null,
        events: filas.filter(f => f.venueId === venueId),
      }
    }),
  }
  ;(prismaMock as any).cashDrawerEvent = {
    createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
      const lote = Array.isArray(data) ? data : [data]
      let count = 0
      for (const d of lote) {
        if (chocaConElIndice(d.venueId, d.localId)) {
          // Postgres: con `skipDuplicates` lo salta; sin él revienta con P2002.
          if (skipDuplicates) continue
          throw new Error('P2002: Unique constraint failed on (venueId, localId)')
        }
        insertar(d)
        count++
      }
      return { count }
    }),
    create: jest.fn(async ({ data }: any) => {
      if (chocaConElIndice(data.venueId, data.localId)) {
        throw new Error('P2002: Unique constraint failed on (venueId, localId)')
      }
      return insertar(data)
    }),
    findFirst: jest.fn(async ({ where }: any) => filas.find(f => f.venueId === where.venueId && f.localId === where.localId) ?? null),
    findMany: jest.fn(async ({ where }: any) =>
      filas.filter(f => f.venueId === where.venueId && where.localId?.in?.includes(f.localId as string)),
    ),
  }
}

/** El arqueo tal como lo ve el cajero, en CENTAVOS. */
const arqueoEnCentavos = async (venueId = VENUE) => {
  const session = await getCurrentSession(venueId)
  return Math.round((session as any).expectedAmount * 100)
}

const ingreso = (over: Record<string, any> = {}) =>
  ({ venueId: VENUE, staffId: 'staff-1', staffName: 'Cajero', amount: 100, ...over }) as any

const retiro = (over: Record<string, any> = {}) => ({ venueId: VENUE, staffId: 'staff-1', staffName: 'Cajero', amount: 80, ...over }) as any

/** El movimiento que el POS acaba de teclear, con la llave que ya tiene en Room. */
const LLAVE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

const CENTS_CORRECTO = 523000 // $5,230.00 — fondo 5000 + venta 280 − reembolso 150 + ingreso 100
const CENTS_CON_EL_DEFECTO = 533000 // $5,330.00 — el ingreso reintentado contado dos veces

beforeEach(() => {
  jest.clearAllMocks()
  filas = []
  secuencia = 0
  montarBaseDeDatos()
  // Lo que ya había en la caja antes de que el cajero teclee su ingreso: una venta
  // en efectivo y un reembolso, ambos escritos por el SERVIDOR con su propia llave.
  insertar({
    sessionId: 'session-1',
    venueId: VENUE,
    type: 'CASH_SALE',
    amount: 280,
    staffId: 'staff-1',
    staffName: 'Cajero',
    localId: 'srv-cash-sale:pay-1',
  })
  insertar({
    sessionId: 'session-1',
    venueId: VENUE,
    type: 'PAY_OUT',
    amount: 150,
    staffId: 'staff-1',
    staffName: 'Cajero',
    localId: 'srv-refund:ref-1',
    note: 'Reembolso: cliente se arrepintió',
  })
})

// ============================================================================
// 1. LA LLAVE SE GUARDA
// ============================================================================

describe('payIn / payOut — la llave del POS se PERSISTE (antes se tiraba)', () => {
  it('🔴 un ingreso con `localId` guarda la llave en la fila', async () => {
    await payIn(ingreso({ localId: LLAVE, note: 'Fondo extra' }))

    const guardada = filas.find(f => f.type === 'PAY_IN')
    expect(guardada?.localId).toBe(LLAVE)
  })

  it('🔴 la respuesta devuelve la llave, para que el POS reconozca su propio movimiento', async () => {
    const { event } = await payIn(ingreso({ localId: LLAVE }))

    expect(event.localId).toBe(LLAVE)
    expect(event.type).toBe('PAY_IN')
    expect(event.amount).toBe(100)
  })

  it('🔴 un retiro con `localId` guarda y devuelve la llave igual', async () => {
    const { event } = await payOut(retiro({ localId: LLAVE }))

    expect(filas.find(f => f.type === 'PAY_OUT' && f.localId === LLAVE)).toBeDefined()
    expect(event.localId).toBe(LLAVE)
  })
})

// ============================================================================
// 2. EL DINERO: EL REINTENTO NO MUEVE EL NÚMERO DEL CAJERO
// ============================================================================

describe('🔴 el reintento del MISMO movimiento no inventa efectivo', () => {
  it('el mismo `localId` dos veces deja UNA sola fila y el arqueo sigue en 523000 centavos', async () => {
    await payIn(ingreso({ localId: LLAVE }))
    const despuesDelPrimero = await arqueoEnCentavos()

    // La respuesta se perdió y el POS reintenta el MISMO ingreso.
    await payIn(ingreso({ localId: LLAVE }))
    const despuesDelReintento = await arqueoEnCentavos()

    // Primero el número que el cajero tiene que contar: es el que duele si falla.
    expect(despuesDelPrimero).toBe(CENTS_CORRECTO)
    expect(despuesDelReintento).toBe(CENTS_CORRECTO)
    expect(despuesDelReintento).not.toBe(CENTS_CON_EL_DEFECTO)
    expect(filas.filter(f => f.type === 'PAY_IN')).toHaveLength(1)
  })

  it('el reintento devuelve LA FILA QUE YA ESTABA (mismo id), no una nueva', async () => {
    const primero = await payIn(ingreso({ localId: LLAVE }))
    const reintento = await payIn(ingreso({ localId: LLAVE }))

    expect(reintento.event.id).toBe(primero.event.id)
    expect(reintento.event.amount).toBe(primero.event.amount)
  })

  it('🔴 distingue crear de reencontrar: `created` es true la primera vez y false en el reintento', async () => {
    // Es la señal con la que el controlador elige 201 (creado) vs 200 (ya estaba).
    const primero = await payIn(ingreso({ localId: LLAVE }))
    const reintento = await payIn(ingreso({ localId: LLAVE }))

    expect(primero.created).toBe(true)
    expect(reintento.created).toBe(false)
  })

  it('🔴 el reintento NO revienta con 500: el índice único se salta, no explota', async () => {
    await payIn(ingreso({ localId: LLAVE }))

    await expect(payIn(ingreso({ localId: LLAVE }))).resolves.toBeDefined()
  })

  it('🔴 un reintento con OTRO monto respeta lo que ya se guardó (gana la primera escritura)', async () => {
    // Un cliente confundido que reenvía la misma llave con $999 no puede reescribir
    // el movimiento: si pudiera, la idempotencia sería una puerta para mover dinero.
    await payIn(ingreso({ localId: LLAVE, amount: 100 }))
    const { event } = await payIn(ingreso({ localId: LLAVE, amount: 999 }))

    expect(event.amount).toBe(100)
    expect(await arqueoEnCentavos()).toBe(CENTS_CORRECTO)
  })

  it('🔴 con un RETIRO el error va al otro lado: sin la llave se inventaría un faltante de $80', async () => {
    await payOut(retiro({ localId: LLAVE }))
    const conLlave = await arqueoEnCentavos()

    await payOut(retiro({ localId: LLAVE }))
    const trasElReintento = await arqueoEnCentavos()

    // 5000 + 280 − 150 − 80 = 5050.00. Con el retiro duplicado daría 497000: −$80 que el
    // cajero no puede explicar y que el cierre le cobra a él.
    expect(conLlave).toBe(505000)
    expect(trasElReintento).toBe(505000)
    expect(trasElReintento).not.toBe(497000)
    expect(filas.filter(f => f.type === 'PAY_OUT' && f.localId === LLAVE)).toHaveLength(1)
  })

  it('dos movimientos DISTINTOS del mismo cajero sí entran los dos', async () => {
    await payIn(ingreso({ localId: 'llave-uno', amount: 100 }))
    await payIn(ingreso({ localId: 'llave-dos', amount: 40 }))

    expect(filas.filter(f => f.type === 'PAY_IN')).toHaveLength(2)
    expect(await arqueoEnCentavos()).toBe(527000) // 5000 + 280 − 150 + 100 + 40
  })
})

// ============================================================================
// 3. AISLAMIENTO POR NEGOCIO
// ============================================================================

describe('la llave es POR VENUE — dos negocios pueden usar la misma sin chocar', () => {
  it('🔴 el mismo `localId` en dos venues crea DOS filas, una en cada caja', async () => {
    const uno = await payIn(ingreso({ venueId: VENUE, localId: LLAVE }))
    const dos = await payIn(ingreso({ venueId: OTRO_VENUE, localId: LLAVE }))

    expect(uno.created).toBe(true)
    expect(dos.created).toBe(true)
    expect(uno.event.id).not.toBe(dos.event.id)
    expect(filas.filter(f => f.localId === LLAVE)).toHaveLength(2)
  })

  it('el arqueo de cada negocio sólo cuenta lo suyo', async () => {
    await payIn(ingreso({ venueId: VENUE, localId: LLAVE }))
    await payIn(ingreso({ venueId: OTRO_VENUE, localId: LLAVE }))

    expect(await arqueoEnCentavos(VENUE)).toBe(CENTS_CORRECTO) // 5000 + 280 − 150 + 100
    expect(await arqueoEnCentavos(OTRO_VENUE)).toBe(510000) // 5000 + 100, sin la venta ni el reembolso
  })
})

// ============================================================================
// 4. VALIDACIÓN: UN CLIENTE NO PUEDE ENVENENAR EL ÍNDICE ÚNICO
// ============================================================================

describe('validación del `localId` — 400, nunca 500 ni basura en el índice', () => {
  const esperar400 = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (error: any) {
      return error
    }
    throw new Error('se esperaba un rechazo y no hubo ninguno')
  }

  it('🔴 `localId` vacío se rechaza con 400', async () => {
    const error = await esperar400(() => payIn(ingreso({ localId: '' })))

    expect(error.statusCode).toBe(400)
    expect(filas.filter(f => f.type === 'PAY_IN')).toHaveLength(0)
  })

  it('🔴 `localId` de puros espacios se rechaza con 400', async () => {
    const error = await esperar400(() => payIn(ingreso({ localId: '   ' })))

    expect(error.statusCode).toBe(400)
    expect(filas.filter(f => f.type === 'PAY_IN')).toHaveLength(0)
  })

  it('🔴 `localId` absurdamente largo se rechaza con 400, no llega al índice', async () => {
    const error = await esperar400(() => payIn(ingreso({ localId: 'x'.repeat(5000) })))

    expect(error.statusCode).toBe(400)
    expect(filas.filter(f => f.type === 'PAY_IN')).toHaveLength(0)
  })

  it('un `localId` que no es texto se rechaza con 400', async () => {
    const error = await esperar400(() => payIn(ingreso({ localId: 12345 })))

    expect(error.statusCode).toBe(400)
  })

  it('un UUID normal (36 caracteres) pasa sin problema', async () => {
    const { event } = await payIn(ingreso({ localId: LLAVE }))

    expect(LLAVE).toHaveLength(36)
    expect(event.localId).toBe(LLAVE)
  })

  it('la llave más larga que genera el propio servidor cabe (srv-cash-sale: + cuid)', async () => {
    const llaveDelServidor = `srv-cash-sale:${'c'.repeat(25)}`
    const { event } = await payIn(ingreso({ localId: llaveDelServidor }))

    expect(llaveDelServidor.length).toBeLessThanOrEqual(64)
    expect(event.localId).toBe(llaveDelServidor)
  })

  it('el retiro valida igual que el ingreso', async () => {
    const error = await esperar400(() => payOut(retiro({ localId: '' })))

    expect(error.statusCode).toBe(400)
  })

  it('🔴 `/sync` valida la MISMA llave (es la otra puerta al índice único)', async () => {
    const error = await esperar400(() =>
      syncEvents(VENUE, [{ type: 'PAY_IN', amount: 50, staffId: 'staff-1', staffName: 'Cajero', localId: 'x'.repeat(5000) }] as any),
    )

    expect(error.statusCode).toBe(400)
  })
})

// ============================================================================
// 5. REGRESIÓN — una app vieja sin `localId` se comporta EXACTAMENTE igual
// ============================================================================

describe('regresión: la app que no manda `localId` sigue funcionando idéntico', () => {
  it('🔴 un ingreso sin llave se inserta con `localId: null` y responde created', async () => {
    const { event, created } = await payIn(ingreso())

    expect(created).toBe(true)
    expect(event.localId).toBeNull()
    expect(filas.filter(f => f.type === 'PAY_IN')).toHaveLength(1)
    expect(await arqueoEnCentavos()).toBe(CENTS_CORRECTO)
  })

  it('sin llave NO hay dedupe posible: dos veces son dos filas (el comportamiento de siempre)', async () => {
    // Postgres permite varios NULL en un índice único. Es exactamente la protección
    // que la app vieja NO gana — y por eso el cliente debe empezar a mandar la llave.
    await payIn(ingreso())
    await payIn(ingreso())

    expect(filas.filter(f => f.type === 'PAY_IN')).toHaveLength(2)
    expect(await arqueoEnCentavos()).toBe(CENTS_CON_EL_DEFECTO)
  })

  it('un retiro sin llave sigue restando igual', async () => {
    const { event, created } = await payOut(retiro())

    expect(created).toBe(true)
    expect(event.localId).toBeNull()
    expect(await arqueoEnCentavos()).toBe(505000) // 5000 + 280 − 150 − 80
  })

  it('el payload del evento conserva EXACTAMENTE los campos que ya tenía', async () => {
    const { event } = await payIn(ingreso({ localId: LLAVE, note: 'Fondo extra' }))

    expect(Object.keys(event).sort()).toEqual(
      ['amount', 'createdAt', 'id', 'localId', 'note', 'orderId', 'sessionId', 'staffId', 'staffName', 'type'].sort(),
    )
    expect(event).toMatchObject({
      sessionId: 'session-1',
      type: 'PAY_IN',
      amount: 100,
      note: 'Fondo extra',
      staffId: 'staff-1',
      staffName: 'Cajero',
      orderId: null,
    })
  })

  it('un monto en cero o negativo sigue rechazándose antes de tocar la base', async () => {
    await expect(payIn(ingreso({ amount: 0, localId: LLAVE }))).rejects.toThrow()
    await expect(payOut(retiro({ amount: -5, localId: LLAVE }))).rejects.toThrow()

    expect(filas.filter(f => f.type === 'PAY_IN')).toHaveLength(0)
  })

  it('sin caja abierta sigue siendo 404, con llave o sin ella', async () => {
    const error = await payIn(ingreso({ venueId: 'venue-sin-caja', localId: LLAVE })).catch(e => e)

    expect(error.statusCode).toBe(404)
  })
})

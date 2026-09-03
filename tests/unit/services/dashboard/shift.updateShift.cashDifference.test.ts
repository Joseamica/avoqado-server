/**
 * 🔴 DINERO — Fase 2, Task 5h: UNA EDICIÓN DESDE EL DASHBOARD NO PUEDE DESHACER EL CIERRE.
 *
 * La Task 5 hizo que el esperado del turno saliera de la GAVETA (fondo + cada venta + cada
 * ingreso − cada retiro) en vez de `startingCash + ventas en efectivo`, que es ciega a los
 * retiros y al refondeo a media jornada. `updateShift` se quedó recalculando `cashDifference`
 * con la fórmula CIEGA, y lo hace en CADA edición — también cuando el dueño sólo corrige
 * `totalSales`, que es lo único que el dashboard manda hoy
 * (`avoqado-web-dashboard/src/pages/Shift/ShiftId.tsx:682`).
 *
 * ⇒ El turno que el cierre firmó en `0.00` volvía a firmarse en **−2,500.00**, y el dueño veía
 * un faltante de $2,500 que nadie tuvo, con su propia edición como autor.
 *
 * Dos mitades, las dos medidas contra la base local:
 *
 *  1. **El esperado.** Escenario del relevo de mostrador (el mismo sembrado en
 *     `shift.cierreUnificado.test.ts`): fondo 2,000 + cobros 1,800 ⇒ esperado viejo 3,800;
 *     la gaveta de la tarde dice 1,300 y el cajero contó 1,300. Ciega: −2,500. Buena: 0.00.
 *
 *  2. **El conteo.** `updateShift` tomaba `endingCash` como si fuera el conteo, y NO lo es: en
 *     un cierre legacy vale `startingCash + lo declarado`, así que el fondo se cuenta DOS veces
 *     y sale un sobrante fantasma del tamaño del fondo. Medido: dos turnos en la base local
 *     (`corte E2E desktop`, Restaurante El Atole y Chilanguita) con `cashDifference` NULL que
 *     al editarlos recibían **+500.00** — exactamente su fondo. El conteo es `cashDeclared`.
 */

import { prismaMock } from '../../../__helpers__/setup'
import { updateShift } from '@/services/dashboard/shift.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const VENUE = 'venue-1'
const TURNO = 'turno-1'
const CAJA = 'caja-1'
const AUTOR = 'staff-dueno'

const INICIO = new Date('2026-09-03T14:00:00.000Z')
const FIN = new Date('2026-09-04T02:00:00.000Z')

/** El turno del relevo de mostrador, ya cerrado y firmado por el cierre con la gaveta. */
function turnoCerrado(over: Record<string, unknown> = {}) {
  return {
    id: TURNO,
    venueId: VENUE,
    staffId: 'staff-1',
    startTime: INICIO,
    endTime: FIN,
    status: 'CLOSED',
    startingCash: '2000.00',
    // Lo que el cierre firmó: contó 1,300 contra el esperado de la GAVETA (1,300) ⇒ cuadró.
    endingCash: '1300.00',
    cashDeclared: '1300.00',
    cashDifference: '0',
    totalCashPayments: '1800.00',
    totalCashTips: '0',
    totalSales: '1800.00',
    totalTips: '0',
    totalOrders: 10,
    ...over,
  }
}

/** La gaveta de la tarde: refondeada en $500 y con $800 de ventas ⇒ esperado 1,300. */
const GAVETA_DE_LA_TARDE = {
  id: CAJA,
  startingAmount: '500.00',
  events: [{ type: 'CASH_SALE', amount: '800.00' }],
}

/** Lo que `prisma.shift.update` acabó escribiendo, para poder afirmar sobre el dinero. */
let escrito: any

function mundo(opciones: { turno?: Record<string, unknown>; gaveta?: any | null } = {}) {
  const turno = turnoCerrado(opciones.turno)
  escrito = undefined
  prismaMock.shift.findFirst.mockResolvedValue(turno)
  prismaMock.shift.update.mockImplementation(async (args: any) => {
    escrito = args.data
    return { ...turno, ...args.data, staff: null, venue: { id: VENUE, name: 'Testarudo Cafe' } }
  })
  // La gaveta LIGADA por `CashDrawerSession.shiftId` (columna de esta fase).
  const gaveta = opciones.gaveta === undefined ? GAVETA_DE_LA_TARDE : opciones.gaveta
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue(gaveta)
  return turno
}

beforeEach(() => {
  mundo()
})

// ============================================================================
// EL ESPERADO
// ============================================================================

describe('el esperado de una edición sale de la GAVETA, igual que el del cierre', () => {
  it('🔴 corregir `totalSales` NO reescribe el 0.00 del cierre como −2,500.00', async () => {
    await updateShift(VENUE, TURNO, { totalSales: 1900 }, AUTOR)

    // Con la fórmula ciega: 1300 − (2000 + 1800) = −2500.
    expect(escrito.cashDifference).toBe(0)
  })

  it('un faltante REAL sigue saliendo como faltante contra el esperado de la gaveta', async () => {
    mundo({ turno: { cashDeclared: '1250.00', endingCash: '1250.00', cashDifference: '-50' } })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, AUTOR)

    expect(escrito.cashDifference).toBe(-50)
  })

  it('🔴 un esperado de CERO es un esperado, no la ausencia de uno', async () => {
    // La gaveta se vació entera (fondo 0, sin eventos). Con una comprobación por verdad/falsedad
    // en vez de `!= null`, el 0 se lee como "no hay gaveta" y vuelve a mandar la fórmula ciega:
    // saldría 1300 − 3800 = −2500 en vez del sobrante real de +1,300.
    mundo({ gaveta: { id: CAJA, startingAmount: '0.00', events: [] } })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, AUTOR)

    expect(escrito.cashDifference).toBe(1300)
  })

  it('sin gaveta, la fórmula de siempre queda BYTE A BYTE (el venue sin módulo de caja)', async () => {
    mundo({ gaveta: null, turno: { cashDeclared: '3800.00', endingCash: '3800.00' } })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, AUTOR)

    // 3800 − (2000 + 1800) = 0
    expect(escrito.cashDifference).toBe(0)
  })
})

// ============================================================================
// LA DECISIÓN: QUÉ GANA CUANDO EL DUEÑO TECLEA
// ============================================================================

describe('qué gana cuando el número tecleado contradice a la gaveta', () => {
  it('🔴 un `startingCash` tecleado NO desplaza al esperado de la gaveta', async () => {
    // El esperado de la gaveta es un LIBRO (fondo + cada movimiento, cada uno con autor y hora);
    // `startingCash` es un escalar que no puede describir el día. Un escalar tecleado después no
    // manda sobre el libro: eso es exactamente el defecto que la Task 5 mató.
    await updateShift(VENUE, TURNO, { startingCash: 9999 }, AUTOR)

    expect(escrito.startingCash).toBe(9999) // la columna SÍ se guarda…
    expect(escrito.cashDifference).toBe(0) // …pero no reescribe el descuadre
  })

  it('un `endingCash` tecleado SÍ manda: es el conteo, y la corrección más nueva gana', async () => {
    await updateShift(VENUE, TURNO, { endingCash: 1350 }, AUTOR)

    expect(escrito.cashDifference).toBe(50)
  })

  it('un `endingCash` puesto en null borra el conteo, y sin conteo no hay descuadre que escribir', async () => {
    await updateShift(VENUE, TURNO, { endingCash: null }, AUTOR)

    expect(escrito).not.toHaveProperty('cashDifference')
  })
})

// ============================================================================
// EL CONTEO
// ============================================================================

describe('el conteo es `cashDeclared`, nunca `endingCash`', () => {
  it('🔴 el corte legacy de Desktop deja de inventar un sobrante del tamaño del fondo', async () => {
    // Fila real de la base local: fondo 500, declarado 649, `endingCash` = 500 + 649 = 1149,
    // ventas en efectivo 149, y el cierre dejó `cashDifference` en NULL a propósito.
    // Tomando `endingCash` como conteo: 1149 − (500 + 149) = +500 — el fondo, contado dos veces.
    mundo({
      gaveta: null,
      turno: {
        startingCash: '500.00',
        endingCash: '1149.00',
        cashDeclared: '649.00',
        cashDifference: null,
        totalCashPayments: '149.00',
        totalCashTips: '0',
      },
    })

    await updateShift(VENUE, TURNO, { totalSales: 149 }, AUTOR)

    // 649 − (500 + 149) = 0. Cuadró, que es la verdad.
    expect(escrito.cashDifference).toBe(0)
  })

  it('🔴 sin conteo NO se inventa un descuadre: el campo ni se toca', async () => {
    mundo({ gaveta: null, turno: { cashDeclared: null, endingCash: '1800.00', cashDifference: null } })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, AUTOR)

    expect(escrito).not.toHaveProperty('cashDifference')
    expect(escrito.totalSales).toBe(1900)
  })
})

// ============================================================================
// LA GAVETA: CÓMO SE RESUELVE
// ============================================================================

describe('la gaveta se resuelve como la resuelve el cierre', () => {
  it('la ligada por `shiftId` manda, y se acota al venue', async () => {
    await updateShift(VENUE, TURNO, { totalSales: 1900 }, AUTOR)

    expect(prismaMock.cashDrawerSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ shiftId: TURNO, venueId: VENUE }) }),
    )
  })

  it('🔴 la ventana con la que se busca es la GUARDADA, no la que se está editando', async () => {
    // Qué gaveta operó es un hecho histórico. Si la búsqueda usara el `endTime` del cuerpo,
    // corregir la hora de cierre podría cambiar la gaveta y con ella el descuadre firmado.
    //
    // 🔴 Sin gaveta ligada A PROPÓSITO: es el único camino que resuelve por FECHA, o sea el
    // único donde la fecha del cuerpo podría colarse. Con la ligada, esta prueba pasaría sin
    // ejercitar nada — y antes del arreglo pasaba justo así, porque no se consultaba ninguna
    // gaveta y comparar sobre cero llamadas siempre da verde.
    mundo({ gaveta: null })

    await updateShift(VENUE, TURNO, { endTime: new Date('2026-09-10T02:00:00.000Z') }, AUTOR)

    const consultas = prismaMock.cashDrawerSession.findFirst.mock.calls
    expect(consultas.length).toBeGreaterThan(1) // la ligada + al menos una por ventana
    const ventanas = consultas.map((c: any[]) => JSON.stringify(c[0]?.where ?? {})).join(' ')
    expect(ventanas).toContain('2026-09-04') // el `endTime` GUARDADO
    expect(ventanas).not.toContain('2026-09-10') // nunca el del cuerpo
  })

  it('🔴 si la gaveta no se puede leer, el descuadre NO se toca — pero la edición sí se guarda', async () => {
    mundo()
    prismaMock.cashDrawerSession.findFirst.mockRejectedValue(new Error('db down'))

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, AUTOR)

    expect(escrito).not.toHaveProperty('cashDifference')
    expect(escrito.totalSales).toBe(1900)
  })
})

// ============================================================================
// LA BITÁCORA
// ============================================================================

describe('la bitácora dice de dónde salió el número', () => {
  it('registra autor, importes en PESOS y la autoridad del esperado', async () => {
    await updateShift(VENUE, TURNO, { totalSales: 1900 }, AUTOR)

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE,
        action: 'SHIFT_UPDATED',
        entity: 'Shift',
        entityId: TURNO,
        staffId: AUTOR,
        data: expect.objectContaining({
          expectedSource: 'CAJON',
          cashDrawerSessionId: CAJA,
          expectedCash: '1300.00',
          countedCash: '1300.00',
          cashDifference: '0.00',
        }),
      }),
    )
  })

  it('sin gaveta la bitácora lo dice, en vez de dejar creer que el número vino del cajón', async () => {
    mundo({ gaveta: null, turno: { cashDeclared: '3800.00', endingCash: '3800.00' } })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, AUTOR)

    const registro = (logAction as jest.Mock).mock.calls.at(-1)![0]
    expect(registro.data.expectedSource).toBe('TURNO')
    expect(registro.data.expectedCash).toBe('3800.00')
    expect(registro.data).not.toHaveProperty('cashDrawerSessionId')
  })
})

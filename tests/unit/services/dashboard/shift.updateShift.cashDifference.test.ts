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

/** El dueño editando, con permiso para ver el esperado (MANAGER+ lo trae por default). */
const DUENO = { performedBy: AUTOR, puedeVerEsperado: true }

function mundo(opciones: { turno?: Record<string, unknown>; gaveta?: any | null; porVentana?: any | null } = {}) {
  const turno = turnoCerrado(opciones.turno)
  escrito = undefined
  prismaMock.shift.findFirst.mockResolvedValue(turno)
  prismaMock.shift.update.mockImplementation(async (args: any) => {
    escrito = args.data
    return { ...turno, ...args.data, staff: null, venue: { id: VENUE, name: 'Testarudo Cafe' } }
  })
  // Dos caminos distintos: la gaveta LIGADA por `CashDrawerSession.shiftId` (columna de esta
  // fase, con `shiftId` en el `where`) y el respaldo por VENTANA de tiempo, que es el único
  // que corre hoy en producción porque allá ninguna gaveta está ligada todavía.
  const ligada = opciones.gaveta === undefined ? GAVETA_DE_LA_TARDE : opciones.gaveta
  prismaMock.cashDrawerSession.findFirst.mockImplementation(async (args: any) =>
    args?.where?.shiftId !== undefined ? ligada : (opciones.porVentana ?? null),
  )
  return turno
}

/** Las consultas que se hicieron por VENTANA de tiempo (el respaldo), no por liga. */
function consultasPorVentana() {
  return prismaMock.cashDrawerSession.findFirst.mock.calls.map((c: any[]) => c[0]?.where ?? {}).filter((w: any) => w.shiftId === undefined)
}

beforeEach(() => {
  mundo()
})

// ============================================================================
// EL ESPERADO
// ============================================================================

describe('el esperado de una edición sale de la GAVETA, igual que el del cierre', () => {
  it('🔴 corregir `totalSales` NO reescribe el 0.00 del cierre como −2,500.00', async () => {
    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

    // Con la fórmula ciega: 1300 − (2000 + 1800) = −2500.
    expect(escrito.cashDifference).toBe(0)
  })

  it('un faltante REAL sigue saliendo como faltante contra el esperado de la gaveta', async () => {
    mundo({ turno: { cashDeclared: '1250.00', endingCash: '1250.00', cashDifference: '-50' } })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

    expect(escrito.cashDifference).toBe(-50)
  })

  it('🔴 un esperado de CERO es un esperado, no la ausencia de uno', async () => {
    // La gaveta se vació entera (fondo 0, sin eventos). Con una comprobación por verdad/falsedad
    // en vez de `!= null`, el 0 se lee como "no hay gaveta" y vuelve a mandar la fórmula ciega:
    // saldría 1300 − 3800 = −2500 en vez del sobrante real de +1,300.
    mundo({ gaveta: { id: CAJA, startingAmount: '0.00', events: [] } })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

    expect(escrito.cashDifference).toBe(1300)
  })

  it('sin gaveta, la fórmula de siempre queda BYTE A BYTE (el venue sin módulo de caja)', async () => {
    mundo({ gaveta: null, turno: { cashDeclared: '3800.00', endingCash: '3800.00' } })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

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
    await updateShift(VENUE, TURNO, { startingCash: 9999 }, DUENO)

    expect(escrito.startingCash).toBe(9999) // la columna SÍ se guarda…
    expect(escrito.cashDifference).toBe(0) // …pero no reescribe el descuadre
  })

  it('un `endingCash` tecleado persiste el mismo conteo y su descuadre', async () => {
    await updateShift(VENUE, TURNO, { endingCash: 1350 }, DUENO)

    expect(escrito).toMatchObject({ endingCash: 1350, cashDeclared: 1350, cashDifference: 50 })
  })

  it('una edición posterior deriva del conteo corregido que quedó persistido', async () => {
    const turno = mundo()

    await updateShift(VENUE, TURNO, { endingCash: 1350 }, DUENO)
    Object.assign(turno, escrito)

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

    expect(escrito).toMatchObject({ totalSales: 1900, cashDifference: 50 })
  })

  it('un `endingCash` puesto en null borra el conteo y el descuadre anterior', async () => {
    await updateShift(VENUE, TURNO, { endingCash: null }, DUENO)

    expect(escrito).toMatchObject({ endingCash: null, cashDeclared: null, cashDifference: null })
  })

  it('un conteo explícito de cero se persiste y se calcula como un conteo real', async () => {
    await updateShift(VENUE, TURNO, { endingCash: 0 }, DUENO)

    expect(escrito).toMatchObject({ endingCash: 0, cashDeclared: 0, cashDifference: -1300 })
  })

  it('una edición sin `endingCash` no reescribe el conteo persistido', async () => {
    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

    expect(escrito).not.toHaveProperty('cashDeclared')
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

    await updateShift(VENUE, TURNO, { totalSales: 149 }, DUENO)

    // 649 − (500 + 149) = 0. Cuadró, que es la verdad.
    expect(escrito.cashDifference).toBe(0)
  })

  it('🔴 sin conteo NO se inventa un descuadre: el campo ni se toca', async () => {
    mundo({ gaveta: null, turno: { cashDeclared: null, endingCash: '1800.00', cashDifference: null } })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

    expect(escrito).not.toHaveProperty('cashDifference')
    expect(escrito.totalSales).toBe(1900)
  })
})

// ============================================================================
// LA GAVETA: CÓMO SE RESUELVE
// ============================================================================

describe('la gaveta se resuelve como la resuelve el cierre', () => {
  it('la ligada por `shiftId` manda, y se acota al venue', async () => {
    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

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

    await updateShift(VENUE, TURNO, { endTime: new Date('2026-09-10T02:00:00.000Z') }, DUENO)

    const ventanas = consultasPorVentana()
    expect(ventanas.length).toBeGreaterThan(0)
    const texto = ventanas.map((w: any) => JSON.stringify(w)).join(' ')
    expect(texto).toContain('2026-09-04') // el `endTime` GUARDADO
    expect(texto).not.toContain('2026-09-10') // nunca el del cuerpo
  })

  it('🔴 el respaldo por VENTANA también se acota al turno: no le arranca la gaveta a otro', async () => {
    // El espejo de `gavetaCerrable` (`turnoDeCaja.ts`), cuyo comentario lo dice con todas sus
    // letras. Y NO es un caso de borde: hoy en producción ninguna gaveta está ligada, así que
    // este respaldo es el ÚNICO camino que corre. Turno A 07:00–15:00 con su gaveta cerrando a
    // las 15:00 y la de relevo B abriendo 14:55: las dos caen dentro de la ventana, y
    // `openedAt desc` elige B — el descuadre de A se firmaría contra el libro de B.
    mundo({ gaveta: null })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

    const ventanas = consultasPorVentana()
    expect(ventanas.length).toBeGreaterThan(0)
    for (const donde of ventanas) {
      // La gaveta de este turno, o una sin ligar (todo lo anterior a la migración).
      expect(JSON.stringify(donde)).toContain(JSON.stringify([{ shiftId: TURNO }, { shiftId: null }]))
    }
  })

  it('🔴 si la gaveta no se puede leer, el descuadre NO se toca — pero la edición sí se guarda', async () => {
    mundo()
    prismaMock.cashDrawerSession.findFirst.mockRejectedValue(new Error('db down'))

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

    expect(escrito).not.toHaveProperty('cashDifference')
    expect(escrito.totalSales).toBe(1900)
  })

  it('🔴 sin conteo ni siquiera se consulta la gaveta: no hay descuadre que calcular', async () => {
    // La mayoría de los turnos cerrados no tienen conteo. Resolver la gaveta ahí son hasta 3
    // consultas con una carga de eventos sin tope, sólo para llenar una línea de bitácora.
    mundo({ turno: { cashDeclared: null, endingCash: '1800.00', cashDifference: null } })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

    expect(prismaMock.cashDrawerSession.findFirst).not.toHaveBeenCalled()
    expect(escrito).not.toHaveProperty('cashDifference')
  })
})

// ============================================================================
// EL CONTEO CIEGO Y LOS DATOS SIN VALIDAR
// ============================================================================

describe('lo que entra por una ruta sin Zod ni permiso de ver el esperado', () => {
  it('🔴 sin `cash-drawer:view-expected` y la gaveta ABIERTA, el descuadre NO se toca', async () => {
    // Caer a la fórmula ciega aquí sería reintroducir el defecto justo para quien no puede ver
    // el número; escribirlo sería servir el esperado de una caja abierta por la puerta de atrás
    // (`PUT {"endingCash":0}` devuelve `cashDifference = −esperado`). No se toca, y punto.
    mundo({ gaveta: { ...GAVETA_DE_LA_TARDE, status: 'OPEN' } })

    await updateShift(VENUE, TURNO, { endingCash: 0 }, { performedBy: AUTOR, puedeVerEsperado: false })

    expect(escrito).not.toHaveProperty('cashDifference')
  })

  it('🔴 lo mismo por el camino de la VENTANA, que es el único que corre hoy en producción', async () => {
    // Aquí el esperado no lo esconde `updateShift` sino `resolveShiftCashDrawer`, que omite el
    // campo con la caja ABIERTA y sin permiso. Saber que HAY gaveta ya basta para no usar la
    // fórmula del turno: sería firmar con la autoridad equivocada.
    mundo({
      gaveta: null,
      porVentana: {
        id: 'caja-por-ventana',
        status: 'OPEN',
        startingAmount: '500.00',
        events: [{ type: 'CASH_SALE', amount: '800.00', createdAt: FIN }],
        actualAmount: null,
        overShort: null,
        deviceName: null,
        openedByName: 'Cajero',
        closedByName: null,
        openedAt: INICIO,
        closedAt: null,
      },
    })

    await updateShift(VENUE, TURNO, { endingCash: 0 }, { performedBy: AUTOR, puedeVerEsperado: false })

    expect(escrito).not.toHaveProperty('cashDifference')
    const registro = (logAction as jest.Mock).mock.calls.at(-1)![0]
    expect(registro.data.expectedSource).toBe('DESCONOCIDO')
  })

  it('con la gaveta ya CERRADA el resultado está firmado y se revela igual, sin permiso', async () => {
    mundo({ gaveta: { ...GAVETA_DE_LA_TARDE, status: 'CLOSED' } })

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, { performedBy: AUTOR, puedeVerEsperado: false })

    expect(escrito.cashDifference).toBe(0)
  })

  it('🔴 un `startingCash` que llega como TEXTO no puede tumbar la bitácora DESPUÉS de guardar', async () => {
    // La ruta no lleva `validateRequest`: Prisma acepta el string y lo vuelve Decimal, pero en JS
    // `"500" + 1800` es `"5001800"` y un `.toFixed` sobre eso revienta — con el `update` YA
    // commiteado y sin fila de auditoría. El cliente vería un 500 por una edición que sí se guardó.
    mundo({ gaveta: null, turno: { cashDeclared: '2300.00', endingCash: '2300.00' } })

    await updateShift(VENUE, TURNO, { startingCash: '500' as any }, DUENO)

    // 2300 − (500 + 1800) = 0
    expect(escrito.cashDifference).toBe(0)
    const registro = (logAction as jest.Mock).mock.calls.at(-1)![0]
    expect(registro.data.expectedCash).toBe('2300.00')
  })
})

// ============================================================================
// LA BITÁCORA
// ============================================================================

describe('la bitácora dice de dónde salió el número', () => {
  it('registra autor, importes en PESOS y la autoridad del esperado', async () => {
    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

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

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, DUENO)

    const registro = (logAction as jest.Mock).mock.calls.at(-1)![0]
    expect(registro.data.expectedSource).toBe('TURNO')
    expect(registro.data.expectedCash).toBe('3800.00')
    expect(registro.data).not.toHaveProperty('cashDrawerSessionId')
  })
})

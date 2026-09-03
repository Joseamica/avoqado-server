/**
 * 🔴 DINERO — BORRAR UN TURNO NO DEJABA AUTOR.
 *
 * `deleteShift` es un borrado DURO (`prisma.shift.delete`): la fila desaparece, y con ella el
 * corte firmado — el conteo, el esperado y el descuadre. Lo que NO desaparece es el dinero: las
 * órdenes, los pagos, las comisiones y la sesión de gaveta que apuntaban a ese turno están
 * declarados `onDelete: SetNull` (`prisma/schema.prisma:3572`, `:4089`, `:12015`, `:14088`), así
 * que sobreviven SUELTOS. Borrar un turno no borra la venta: la desata de su corte.
 *
 * ⇒ Tras un borrado, la única constancia de que ese corte existió es `ActivityLog`. Y el asiento
 * `SHIFT_DELETED` se escribía SIN `staffId` y sin un solo número, mientras su hermano
 * `SHIFT_UPDATED` sí registra al autor con un comentario que explica por qué
 * (`shift.dashboard.controller.ts:101`). O sea: editar el descuadre dejaba nombre y borrarlo
 * entero, no.
 *
 * Estas pruebas fijan las dos mitades: QUIÉN lo borró y QUÉ dinero había firmado.
 */

import { prismaMock } from '../../../__helpers__/setup'
import { deleteShift } from '@/services/dashboard/shift.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const VENUE = 'venue-1'
const TURNO = 'turno-1'
const AUTOR = 'staff-gerente'

const INICIO = new Date('2026-09-03T14:00:00.000Z')
const FIN = new Date('2026-09-04T02:00:00.000Z')

/** Un turno ya cerrado y cuadrado: el caso normal de un borrado. */
function turnoCerrado(over: Record<string, unknown> = {}) {
  return {
    id: TURNO,
    venueId: VENUE,
    staffId: 'staff-1',
    startTime: INICIO,
    endTime: FIN,
    status: 'CLOSED',
    startingCash: '2000.00',
    endingCash: '1300.00',
    cashDeclared: '1300.00',
    cashDifference: '0',
    totalCashPayments: '1800.00',
    totalCashTips: '0',
    totalSales: '1800.00',
    totalTips: '150.50',
    totalOrders: 10,
    ...over,
  }
}

function mundo(over: Record<string, unknown> = {}) {
  const turno = turnoCerrado(over)
  prismaMock.shift.findFirst.mockResolvedValue(turno)
  prismaMock.shift.delete.mockResolvedValue(turno)
  return turno
}

beforeEach(() => {
  mundo()
})

/** El último asiento que se escribió en la bitácora. */
function ultimoAsiento() {
  return (logAction as jest.Mock).mock.calls.at(-1)![0]
}

describe('borrar un turno deja constancia de QUIÉN lo borró', () => {
  it('🔴 el asiento SHIFT_DELETED lleva el autor', async () => {
    await deleteShift(VENUE, TURNO, AUTOR)

    expect(ultimoAsiento()).toMatchObject({
      action: 'SHIFT_DELETED',
      entity: 'Shift',
      entityId: TURNO,
      venueId: VENUE,
      staffId: AUTOR,
    })
  })

  it('sin autor identificado, el asiento se escribe igual — perder el rastro entero es peor', async () => {
    // Un borrado sin `authContext` no debe abortar: la bitácora incompleta sigue siendo mejor
    // evidencia que ninguna, y el hueco se ve porque `staffId` viene vacío.
    await deleteShift(VENUE, TURNO)

    expect(ultimoAsiento()).toMatchObject({ action: 'SHIFT_DELETED', entityId: TURNO })
    expect(ultimoAsiento().staffId).toBeUndefined()
  })
})

describe('la bitácora guarda el retrato del dinero que se borró', () => {
  it('🔴 registra el corte firmado: contado, descuadre, ventas y propina', async () => {
    await deleteShift(VENUE, TURNO, AUTOR)

    // En PESOS y como texto, igual que `SHIFT_UPDATED`: el dashboard renderiza este jsonb tal
    // cual, y la fila del turno ya no existe para contrastarlo.
    expect(ultimoAsiento().data).toMatchObject({
      startingCash: '2000.00',
      cashDeclared: '1300.00',
      cashDifference: '0.00',
      totalSales: '1800.00',
      totalTips: '150.50',
      totalOrders: 10,
      status: 'CLOSED',
    })
  })

  it('un turno sin conteo NO inventa ceros: dice que no hubo conteo', async () => {
    // `cashDeclared`/`cashDifference` en NULL es un cierre sin arqueo. Volcarlos como "0.00"
    // afirmaría que alguien contó y cuadró — la misma mentira que el cierre ya evita al decir
    // "Sin conteo" en vez de "Cuadró".
    mundo({ cashDeclared: null, cashDifference: null, endingCash: null })

    await deleteShift(VENUE, TURNO, AUTOR)

    expect(ultimoAsiento().data.cashDeclared).toBeNull()
    expect(ultimoAsiento().data.cashDifference).toBeNull()
  })
})

describe('lo que ya protegía y no se toca', () => {
  it('un turno ABIERTO no se borra', async () => {
    mundo({ status: 'OPEN', endTime: null })

    await expect(deleteShift(VENUE, TURNO, AUTOR)).rejects.toThrow(/open shift/i)
    expect(prismaMock.shift.delete).not.toHaveBeenCalled()
  })

  it('🔴 un turno en CLOSING TAMPOCO se borra (P1.4 de la auditoría de Codex, 3-sep-2026)', async () => {
    // `CLOSING` no es decorativo: es el compare-and-set del cierre (`shift.tpv.service.ts`), o sea
    // la ventana en la que alguien está contando el efectivo. Borrar ahí no sólo se lleva el corte:
    // el `updateMany` del cierre ya no encuentra la fila, el cierre falla a medias, y las órdenes,
    // pagos, comisiones y la gaveta quedan sueltas — con un cajero delante del cajón abierto.
    // La guarda vieja sólo miraba OPEN, así que ese estado pasaba de largo.
    mundo({ status: 'CLOSING', endTime: null })

    await expect(deleteShift(VENUE, TURNO, AUTOR)).rejects.toThrow(/cerrando|closing/i)
    expect(prismaMock.shift.delete).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 CLOSING con `endTime` ya pasado TAMPOCO se borra — la guarda mira el estado CRUDO', async () => {
    // Esta es la que discrimina. El estado "efectivo" se deriva del reloj: si `endTime` ya pasó lo
    // declara CLOSED. Y el cierre ESCRIBE `endTime` mientras trabaja, así que el caso real —turno
    // cerrándose, con su hora de fin puesta— se vería como cerrado. Una guarda escrita sobre
    // `effectiveStatus` pasaría la prueba de arriba y fallaría ésta, que es el escenario de verdad.
    // Fecha FIJA y claramente vieja, no la de hoy: con `2026-09-03T00:00Z` esta prueba discriminaba
    // sólo si corría después del mediodía UTC — antes de esa hora el `endTime` estaba en el FUTURO,
    // `effectiveStatus` seguía siendo CLOSING y una guarda mal escrita habría pasado igual. Una
    // prueba cuyo poder depende del reloj de la máquina no guarda nada la mitad del día.
    mundo({ status: 'CLOSING', endTime: new Date('2020-01-01T00:00:00.000Z') })

    await expect(deleteShift(VENUE, TURNO, AUTOR)).rejects.toThrow(/cerrando|closing/i)
    expect(prismaMock.shift.delete).not.toHaveBeenCalled()
  })

  it('un turno de OTRO venue no se borra ni se registra', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(null)

    await expect(deleteShift(VENUE, TURNO, AUTOR)).resolves.toBe(false)
    expect(prismaMock.shift.delete).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
})

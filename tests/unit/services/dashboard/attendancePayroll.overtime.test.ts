/**
 * Las horas extra en el resumen de nómina, CON autorización (founder, 29-ago-2026).
 *
 * Salen de la MISMA rejilla que el retardo y la falta: una sola verdad. Y el reparto
 * doble/triple va sobre lo AUTORIZADO, porque es lo que se paga — mientras que la infracción
 * del art. 66 se juzga sobre lo MEDIDO, porque no autorizar no deshace lo que ya se trabajó.
 */
import { buildAttendanceGrid } from '@/services/dashboard/attendance.dashboard.service'
import { getPayrollSummary } from '@/services/dashboard/attendancePayroll.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/dashboard/attendance.dashboard.service', () => ({
  buildAttendanceGrid: jest.fn(),
}))

const gridMock = buildAttendanceGrid as jest.MockedFunction<typeof buildAttendanceGrid>
const aprobaciones = prisma.overtimeApproval.findMany as jest.Mock

/** Una celda de la rejilla con lo mínimo; el resto son valores neutros. */
function celda(over: Partial<any> = {}): any {
  return {
    staffId: 's1',
    staffVenueId: 'sv1',
    name: 'Ana Martínez',
    date: '2026-08-24',
    expectedStart: '09:00',
    expectedEnd: '17:00',
    clockInTime: new Date('2026-08-24T15:00:00.000Z'),
    clockOutTime: new Date('2026-08-25T01:00:00.000Z'),
    status: 'ON_TIME',
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    absenceType: null,
    overtimeMinutes: 0,
    // 🔴 La huella coincide con la de `autorizacion()` a propósito: aquí se prueba la
    // aritmética de los buckets y el reparto. Que una jornada CAMBIADA invalide la
    // autorización vive en `overtime.huellaInvalida.test.ts`; si las huellas no cuadraran,
    // todos estos casos caerían a «pendiente» y no se probaría nada.
    overtimeFingerprint: 'h',
    ...over,
  }
}

/** Una autorización ya guardada. `medidosAlAutorizar` por default = lo autorizado. */
function autorizacion(date: string, minutesApproved: number, minutesMeasured?: number, staffVenueId = 'sv1') {
  return {
    staffVenueId,
    date,
    minutesApproved,
    minutesMeasured: minutesMeasured ?? minutesApproved,
    sourceFingerprint: 'h', // la misma jornada que la celda: sin cambios
  }
}

function conCeldas(cells: any[], autorizadas: any[] = []) {
  gridMock.mockResolvedValue({
    cells,
    graceMinutes: 10,
    timezone: 'America/Mexico_City',
    workedTotalsByStaff: new Map([['s1', { totalHours: 8, breakMinutes: 0 }]]),
  } as any)
  aprobaciones.mockResolvedValue(autorizadas)
}

beforeEach(() => jest.clearAllMocks())

describe('getPayrollSummary — horas extra medidas', () => {
  it('suma los minutos extra del periodo aunque nadie los haya autorizado', async () => {
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 60 }), celda({ date: '2026-08-25', overtimeMinutes: 30 })])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimeMinutes).toBe(90)
  })

  it('🔴 sin autorizar NO se reparte en doble ni triple — queda PENDIENTE', async () => {
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 120 })])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimePendingMinutes).toBe(120)
    expect(rows[0].overtimeApprovedMinutes).toBe(0)
    expect(rows[0].overtimeDoubleMinutes).toBe(0)
    expect(rows[0].overtimeTripleMinutes).toBe(0)
  })

  it('🔴 …pero lo medido sigue visible: no pagar no puede ser invisible', async () => {
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 120 })])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimeMinutes).toBe(120)
  })
})

describe('getPayrollSummary — reparto sobre lo AUTORIZADO', () => {
  it('una semana de 12 h autorizadas da 9 dobles y 3 triples', async () => {
    const dias = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27']
    conCeldas(
      dias.map(d => celda({ date: d, overtimeMinutes: 180 })),
      dias.map(d => autorizacion(d, 180)),
    )
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimeApprovedMinutes).toBe(720)
    expect(rows[0].overtimeDoubleMinutes).toBe(540)
    expect(rows[0].overtimeTripleMinutes).toBe(180)
  })

  it('🔴 autorizar de MENOS puede sacar las horas del triple', async () => {
    // Se midieron 12 h pero sólo se autorizaron 6: nada llega al umbral de las 9.
    const dias = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27']
    conCeldas(
      dias.map(d => celda({ date: d, overtimeMinutes: 180 })),
      dias.map(d => autorizacion(d, 90, 180)),
    )
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimeApprovedMinutes).toBe(360)
    expect(rows[0].overtimeDoubleMinutes).toBe(360)
    expect(rows[0].overtimeTripleMinutes).toBe(0)
    expect(rows[0].overtimeDeniedMinutes).toBe(360)
  })

  it('🔴 dos semanas NO se mezclan: cada una tiene su propio umbral de 9 h', async () => {
    conCeldas(
      [celda({ date: '2026-08-30', overtimeMinutes: 480 }), celda({ date: '2026-08-31', overtimeMinutes: 480 })],
      [autorizacion('2026-08-30', 480), autorizacion('2026-08-31', 480)],
    )
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-09-06')
    expect(rows[0].overtimeApprovedMinutes).toBe(960)
    expect(rows[0].overtimeTripleMinutes).toBe(0)
  })

  it('un día NEGADO (autorizado en cero) no entra al reparto ni queda pendiente', async () => {
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 120 })], [autorizacion('2026-08-24', 0, 120)])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimeApprovedMinutes).toBe(0)
    expect(rows[0].overtimeDeniedMinutes).toBe(120)
    expect(rows[0].overtimePendingMinutes).toBe(0)
  })

  it('cada persona lleva su propio acumulado semanal', async () => {
    conCeldas(
      [
        celda({ date: '2026-08-24', overtimeMinutes: 600 }),
        celda({ staffId: 's2', staffVenueId: 'sv2', name: 'Beto Ruiz', date: '2026-08-24', overtimeMinutes: 60 }),
      ],
      [autorizacion('2026-08-24', 600), autorizacion('2026-08-24', 60, 60, 'sv2')],
    )
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    const ana = rows.find(r => r.staffVenueId === 'sv1')!
    const beto = rows.find(r => r.staffVenueId === 'sv2')!
    // Si se mezclaran, Beto heredaría triples que no hizo.
    expect(ana.overtimeTripleMinutes).toBe(60)
    expect(beto.overtimeTripleMinutes).toBe(0)
  })
})

describe('la checada cambió después de autorizar', () => {
  it('🔴 el excedente NO hereda la autorización: editar una salida no se autoriza a sí mismo', async () => {
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 240 })], [autorizacion('2026-08-24', 120, 120)])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimeApprovedMinutes).toBe(120)
    expect(rows[0].overtimePendingMinutes).toBe(120)
    expect(rows[0].overtimeDaysToReview).toEqual(['2026-08-24'])
  })

  it('si ahora se mide MENOS, no se paga más de lo trabajado', async () => {
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 60 })], [autorizacion('2026-08-24', 240, 240)])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimeApprovedMinutes).toBe(60)
    expect(rows[0].overtimeDaysToReview).toEqual(['2026-08-24'])
  })
})

describe('infracciones del art. 66 — sobre lo MEDIDO, no sobre lo autorizado', () => {
  it('🔴 trabajar 4 h en un día es infracción aunque sólo se autorice una', async () => {
    // No autorizar no deshace lo que ya pasó: la ley se rompió al trabajarlas.
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 240 })], [autorizacion('2026-08-24', 60, 240)])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].hasOvertimeViolation).toBe(true)
  })

  it('señala hacer extra más de 3 veces en la semana, sin autorizaciones de por medio', async () => {
    conCeldas(['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27'].map(d => celda({ date: d, overtimeMinutes: 30 })))
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].hasOvertimeViolation).toBe(true)
  })

  it('una semana dentro de la ley no se marca', async () => {
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 120 }), celda({ date: '2026-08-25', overtimeMinutes: 120 })])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].hasOvertimeViolation).toBe(false)
  })
})

describe('varios', () => {
  it('🔴 una semana que el rango no cubre entera queda marcada como parcial', async () => {
    conCeldas([celda({ date: '2026-08-26', overtimeMinutes: 600 })], [autorizacion('2026-08-26', 600)])
    const { rows } = await getPayrollSummary('v1', '2026-08-26', '2026-08-28')
    expect(rows[0].overtimeWeeks[0].parcial).toBe(true)
  })

  it('sin horas extra los campos van en cero y NO se consulta la base', async () => {
    conCeldas([celda({ overtimeMinutes: 0 })])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimeMinutes).toBe(0)
    expect(rows[0].overtimeWeeks).toEqual([])
    // Sin días con extra no hay nada que autorizar: la consulta se ahorra.
    expect(aprobaciones).not.toHaveBeenCalled()
  })

  describe('regresión: lo que ya funcionaba sigue igual', () => {
    it('los retardos y sus minutos no se tocan', async () => {
      conCeldas([celda({ status: 'LATE', lateMinutes: 25, overtimeMinutes: 60 })])
      const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
      expect(rows[0].lateDays).toBe(1)
      expect(rows[0].lateMinutesTotal).toBe(25)
    })

    it('las ausencias tipificadas siguen contándose', async () => {
      conCeldas([celda({ status: 'DAY_OFF', absenceType: 'VACATION', overtimeMinutes: 0 })])
      const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
      expect(rows[0].absences).toEqual({ VACATION: 1 })
    })

    it('las horas trabajadas siguen saliendo de la rejilla', async () => {
      conCeldas([celda()])
      const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
      expect(rows[0].hoursWorked).toBe(8)
    })
  })
})

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

/** Una autorización ya guardada sobre la MISMA jornada que la celda (huella `h`). */
function autorizacion(date: string, minutesApproved: number, minutesMeasured?: number, staffVenueId = 'sv1') {
  return {
    staffVenueId,
    date,
    minutesApproved,
    minutesMeasured: minutesMeasured ?? minutesApproved,
    sourceFingerprint: 'h', // la misma jornada que la celda: sin cambios
  }
}

/**
 * Una autorización firmada sobre una jornada que YA NO EXISTE — alguien editó la checada
 * después. Es la única forma en que lo medido puede diferir de lo firmado: cualquier cambio
 * de tramos, descansos, cuadrante o zona mueve la huella.
 */
function autorizacionSobreJornadaVieja(date: string, minutesApproved: number, minutesMeasured: number, staffVenueId = 'sv1') {
  return { staffVenueId, date, minutesApproved, minutesMeasured, sourceFingerprint: 'jornada-vieja' }
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

  it('🔴 sin autorizar, todo queda PENDIENTE y no entra a ninguna semana pagable', async () => {
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 120 })])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimePendingMinutes).toBe(120)
    expect(rows[0].overtimeApprovedMinutes).toBe(0)
  })

  it('🔴 …pero lo medido sigue visible: no pagar no puede ser invisible', async () => {
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 120 })])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimeMinutes).toBe(120)
  })
})

describe('la checada cambió después de autorizar', () => {
  it('🔴 editar la salida INVALIDA la firma entera: nada se hereda y nada se paga', async () => {
    // Firmaron 120 sobre 120 medidos; después alguien editó la salida y hoy son 240. Quien
    // firmó no vio ESTA jornada, así que su decisión no vale ni para los 120 originales.
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 240 })], [autorizacionSobreJornadaVieja('2026-08-24', 120, 120)])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimeApprovedMinutes).toBe(0)
    expect(rows[0].overtimePendingMinutes).toBe(240)
    expect(rows[0].overtimeDaysToReview).toEqual(['2026-08-24'])
    // 🔴 Y lo que de verdad cuesta dinero: no puede pagarse lo que se declara no autorizado.
  })

  it('si ahora se mide MENOS, tampoco se paga: la jornada cambió y se vuelve a revisar', async () => {
    // Firmaron 240; luego la salida se corrigió a 60. Ni 240 (sería pagar aire) ni 60 (nadie
    // firmó esa hora): 60 pendientes, cero pagados.
    conCeldas([celda({ date: '2026-08-24', overtimeMinutes: 60 })], [autorizacionSobreJornadaVieja('2026-08-24', 240, 240)])
    const { rows } = await getPayrollSummary('v1', '2026-08-24', '2026-08-30')
    expect(rows[0].overtimeApprovedMinutes).toBe(0)
    expect(rows[0].overtimePendingMinutes).toBe(60)
    expect(rows[0].overtimeDaysToReview).toEqual(['2026-08-24'])
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

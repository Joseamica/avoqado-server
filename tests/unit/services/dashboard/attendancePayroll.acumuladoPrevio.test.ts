/**
 * El ACUMULADO de la semana previa también respeta la huella.
 *
 * 🔴 Hallazgo P1 #1 de la 2ª auditoría de Codex (30-ago-2026), su mitad menos visible. Cuando
 * el rango de nómina empieza a media semana, el servicio consulta los días previos para saber
 * cuánto del umbral de 9 h semanales (LFT art. 67) ya se consumió. Esa consulta era una CUARTA
 * copia de la regla «cuánto se paga» y **ni siquiera pedía `sourceFingerprint`**.
 *
 * Consecuencia, y es dinero en la dirección cara: una autorización previa cuya jornada ya
 * cambió —que el sistema declara inválida en la pantalla y en el reparto— seguía consumiendo
 * umbral, así que las horas de ESTA semana cruzaban antes el corte de las 9 h y se pagaban a
 * TRIPLE en vez de a doble.
 */
import { getPayrollSummary } from '@/services/dashboard/attendancePayroll.service'
import { buildAttendanceGrid } from '@/services/dashboard/attendance.dashboard.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/dashboard/attendance.dashboard.service', () => ({
  buildAttendanceGrid: jest.fn(),
}))

const gridMock = buildAttendanceGrid as jest.MockedFunction<typeof buildAttendanceGrid>
const aprobaciones = prisma.overtimeApproval.findMany as jest.Mock

const MEMBRESIA = 'sv1'
const HUELLA_HOY = 'huella-de-la-jornada-actual'

/** Una celda de la rejilla con hora extra. */
const celda = (date: string, overtimeMinutes: number, fingerprint: string | null = HUELLA_HOY) => ({
  staffVenueId: MEMBRESIA,
  staffId: 's1',
  name: 'Ana Martínez',
  date,
  status: 'ON_TIME',
  lateMinutes: 0,
  overtimeMinutes,
  overtimeFingerprint: fingerprint,
  overtimeApprovedMinutes: null,
  overtimeApprovedUpdatedAt: null,
  absenceType: null,
})

const rejilla = (cells: any[]) =>
  ({
    cells,
    graceMinutes: 10,
    timezone: 'America/Mexico_City',
    workedTotalsByStaff: new Map([['s1', { totalHours: 8, breakMinutes: 0 }]]),
  }) as any

/**
 * El rango arranca el MIÉRCOLES 26, así que el servicio pide además el tramo lunes-martes de
 * esa misma semana. La primera llamada a la rejilla es la del periodo; la segunda, la previa.
 */
function escenario(previas: any[], autorizacionesPrevias: any[], autorizacionesDelPeriodo: any[] = []) {
  gridMock.mockReset()
  gridMock.mockResolvedValueOnce(rejilla([celda('2026-08-26', 480)])) // 8 h el miércoles
  gridMock.mockResolvedValueOnce(rejilla(previas))
  aprobaciones.mockReset()
  aprobaciones.mockResolvedValueOnce(autorizacionesPrevias) // las de la semana previa
  aprobaciones.mockResolvedValueOnce(autorizacionesDelPeriodo) // las del periodo
}

/** Autorizado el lunes 24: 4 h, sobre la jornada `huella`. */
const autorizacionPrevia = (huella: string | null) => ({
  staffVenueId: MEMBRESIA,
  date: '2026-08-24',
  minutesApproved: 240,
  minutesMeasured: 240,
  sourceFingerprint: huella,
})

const autorizacionDelPeriodo = {
  staffVenueId: MEMBRESIA,
  date: '2026-08-26',
  minutesApproved: 480,
  minutesMeasured: 480,
  sourceFingerprint: HUELLA_HOY,
}

beforeEach(() => jest.clearAllMocks())

describe('el umbral semanal sólo lo consume lo que de verdad se paga', () => {
  it('🔴 una autorización previa INVÁLIDA no empuja las horas de hoy a TRIPLE', async () => {
    // Lunes: 4 h autorizadas… pero firmadas sobre una jornada que ya cambió (huella vieja).
    // Miércoles: 8 h autorizadas. Si las 4 del lunes contaran, 9 − 4 = 5 h irían a doble y
    // 3 h a TRIPLE. Como no valen, las 8 h caben enteras bajo las 9 h ⇒ todo doble.
    escenario([celda('2026-08-24', 240)], [autorizacionPrevia('jornada-vieja')], [autorizacionDelPeriodo])
    const { rows } = await getPayrollSummary('v1', '2026-08-26', '2026-08-30')
    expect(rows[0].overtimeDoubleMinutes).toBe(480)
    expect(rows[0].overtimeTripleMinutes).toBe(0)
  })

  it('y una autorización previa VÁLIDA sí lo consume: el triple aparece cuando toca', async () => {
    escenario([celda('2026-08-24', 240)], [autorizacionPrevia(HUELLA_HOY)], [autorizacionDelPeriodo])
    const { rows } = await getPayrollSummary('v1', '2026-08-26', '2026-08-30')
    // 540 semanales − 240 ya consumidos = 300 a doble; las 180 restantes, a triple.
    expect(rows[0].overtimeDoubleMinutes).toBe(300)
    expect(rows[0].overtimeTripleMinutes).toBe(180)
  })

  it('una previa SIN revisar tampoco consume umbral', async () => {
    escenario([celda('2026-08-24', 240)], [], [autorizacionDelPeriodo])
    const { rows } = await getPayrollSummary('v1', '2026-08-26', '2026-08-30')
    expect(rows[0].overtimeDoubleMinutes).toBe(480)
    expect(rows[0].overtimeTripleMinutes).toBe(0)
  })
})

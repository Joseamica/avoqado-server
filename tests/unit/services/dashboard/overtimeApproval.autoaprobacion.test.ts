/**
 * Separación de funciones: NADIE autoriza sus propias horas extra.
 *
 * Decisión del founder (2026-08-30), respondiendo a la pregunta que dejó abierta la auditoría
 * de Codex: «un gerente no, sería sólo admin». Un gerente que se firma a sí mismo sus horas
 * extra es exactamente la figura que la autorización venía a evitar — si puedes aprobarte, la
 * autorización no controla nada.
 *
 * 🔴 La regla es sobre la PERSONA, no sobre el rol: un ADMIN tampoco puede autorizarse a sí
 * mismo. Quien tenga el permiso puede firmar las de CUALQUIER OTRO; las suyas las firma otro.
 */
import { approveOvertime } from '@/services/dashboard/overtimeApproval.service'
import { buildAttendanceGrid } from '@/services/dashboard/attendance.dashboard.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/dashboard/attendance.dashboard.service', () => ({
  buildAttendanceGrid: jest.fn(),
}))

const gridMock = buildAttendanceGrid as jest.MockedFunction<typeof buildAttendanceGrid>
const findMembership = prisma.staffVenue.findFirst as jest.Mock
const upsert = prisma.overtimeApproval.upsert as jest.Mock

const VENUE = 'v1'
const MEMBRESIA = 'sv1'
const DIA = '2026-08-24'
/** El dueño de esas horas extra. */
const ANA = 'staff-ana'
/** Cualquier otra persona con `attendance:manage`. */
const GERENTE = 'staff-gerente'

beforeEach(() => {
  jest.clearAllMocks()
  // La membresía `sv1` es de ANA: esas horas extra son suyas.
  findMembership.mockResolvedValue({ id: MEMBRESIA, staffId: ANA })
  upsert.mockImplementation(({ create }: any) => Promise.resolve({ id: 'ap1', ...create }))
  gridMock.mockResolvedValue({
    cells: [{ staffVenueId: MEMBRESIA, date: DIA, overtimeMinutes: 120, staffId: ANA, name: 'Ana' }],
    graceMinutes: 10,
    timezone: 'America/Mexico_City',
    workedTotalsByStaff: new Map(),
  } as any)
})

function autorizar(approvedById: string) {
  return approveOvertime({ venueId: VENUE, staffVenueId: MEMBRESIA, date: DIA, minutesApproved: 60, approvedById })
}

describe('no se pueden autorizar las horas extra propias', () => {
  it('🔴 Ana NO puede autorizar las suyas', async () => {
    await expect(autorizar(ANA)).rejects.toThrow(/tus propias horas|no puedes autorizar tus/i)
  })

  it('🔴 y NO escribe nada al rechazar', async () => {
    await expect(autorizar(ANA)).rejects.toThrow()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('otra persona SÍ puede autorizárselas', async () => {
    await expect(autorizar(GERENTE)).resolves.toMatchObject({ minutesApproved: 60 })
  })

  it('🔴 la regla es por PERSONA, no por rol: da igual quién sea, si son suyas no puede', async () => {
    // La membresía es de GERENTE ahora; él tampoco puede firmarse las propias.
    findMembership.mockResolvedValue({ id: MEMBRESIA, staffId: GERENTE })
    gridMock.mockResolvedValue({
      cells: [{ staffVenueId: MEMBRESIA, date: DIA, overtimeMinutes: 120, staffId: GERENTE, name: 'Gerente' }],
      graceMinutes: 10,
      timezone: 'America/Mexico_City',
      workedTotalsByStaff: new Map(),
    } as any)
    await expect(autorizar(GERENTE)).rejects.toThrow(/tus propias horas|no puedes autorizar tus/i)
    await expect(autorizar(ANA)).resolves.toBeDefined()
  })

  it('🔴 se comprueba ANTES de recalcular la rejilla — no cuesta una consulta cara', async () => {
    await expect(autorizar(ANA)).rejects.toThrow()
    expect(gridMock).not.toHaveBeenCalled()
  })
})

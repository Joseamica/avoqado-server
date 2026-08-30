/**
 * Autorizar horas extra — el camino de ESCRITURA.
 *
 * Es dinero, así que la prueba va primero. Lo que protege:
 *
 *  🔴 Los minutos MEDIDOS los pone el servidor, jamás el cliente. Si el cliente los mandara,
 *     bastaría con decir "medí 8 h" para autorizarse 8 h que nadie trabajó.
 *  🔴 No se puede autorizar MÁS de lo medido.
 *  🔴 Una membresía de OTRO negocio se rechaza — aislamiento de tenant.
 */
import { approveOvertime } from '@/services/dashboard/overtimeApproval.service'
import { buildAttendanceGrid } from '@/services/dashboard/attendance.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/dashboard/attendance.dashboard.service', () => ({
  buildAttendanceGrid: jest.fn(),
}))

const gridMock = buildAttendanceGrid as jest.MockedFunction<typeof buildAttendanceGrid>
const findMembership = prisma.staffVenue.findFirst as jest.Mock
const create = prisma.overtimeApproval.create as jest.Mock
const findApproval = prisma.overtimeApproval.findUnique as jest.Mock

const VENUE = 'v1'
const MEMBRESIA = 'sv1'
const DIA = '2026-08-24'
const GERENTE = 'staff-gerente'

/** La rejilla dice que ese día se midieron `minutos` de extra. */
function midio(minutos: number, date = DIA, staffVenueId = MEMBRESIA) {
  gridMock.mockResolvedValue({
    cells: [{ staffVenueId, date, overtimeMinutes: minutos, staffId: 's1', name: 'Ana' }],
    graceMinutes: 10,
    timezone: 'America/Mexico_City',
    workedTotalsByStaff: new Map(),
  } as any)
}

beforeEach(() => {
  jest.clearAllMocks()
  findMembership.mockResolvedValue({ id: MEMBRESIA, venueId: VENUE, staffId: 's1' })
  // Sin autorización previa: el camino de CREAR, que es el que estas pruebas ejercitan.
  findApproval.mockResolvedValue(null)
  create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'ap1', ...data }))
})

describe('approveOvertime', () => {
  it('guarda lo autorizado y el retrato de lo medido', async () => {
    midio(120)
    const r = await approveOvertime({
      venueId: VENUE,
      staffVenueId: MEMBRESIA,
      date: DIA,
      minutesApproved: 120,
      approvedById: GERENTE,
    })
    expect(r.minutesApproved).toBe(120)
    expect(r.minutesMeasured).toBe(120)
  })

  it('🔴 los minutos MEDIDOS los pone el servidor, no el cliente', async () => {
    midio(60) // el reloj dice 1 h
    await approveOvertime({
      venueId: VENUE,
      staffVenueId: MEMBRESIA,
      date: DIA,
      minutesApproved: 60,
      approvedById: GERENTE,
      // Aunque alguien mandara `minutesMeasured: 480` en el cuerpo, no existe como parámetro:
      // la firma no lo acepta. Esta prueba fija que la fila guarde lo que midió el servidor.
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ minutesMeasured: 60 }) }))
  })

  it('🔴 no se puede autorizar MÁS de lo medido', async () => {
    midio(60)
    await expect(
      approveOvertime({
        venueId: VENUE,
        staffVenueId: MEMBRESIA,
        date: DIA,
        minutesApproved: 240,
        approvedById: GERENTE,
      }),
    ).rejects.toThrow(/no puedes autorizar más/i)
    expect(create).not.toHaveBeenCalled()
  })

  it('autorizar EXACTAMENTE lo medido sí se puede', async () => {
    midio(60)
    await expect(
      approveOvertime({
        venueId: VENUE,
        staffVenueId: MEMBRESIA,
        date: DIA,
        minutesApproved: 60,
        approvedById: GERENTE,
      }),
    ).resolves.toBeDefined()
  })

  it('autorizar CERO es negar, y se permite', async () => {
    midio(120)
    const r = await approveOvertime({
      venueId: VENUE,
      staffVenueId: MEMBRESIA,
      date: DIA,
      minutesApproved: 0,
      approvedById: GERENTE,
    })
    expect(r.minutesApproved).toBe(0)
  })

  it('un número negativo se rechaza', async () => {
    midio(120)
    await expect(
      approveOvertime({
        venueId: VENUE,
        staffVenueId: MEMBRESIA,
        date: DIA,
        minutesApproved: -30,
        approvedById: GERENTE,
      }),
    ).rejects.toThrow()
  })

  it('🔴 una membresía de OTRO negocio se rechaza (aislamiento de tenant)', async () => {
    findMembership.mockResolvedValue(null)
    midio(120)
    await expect(
      approveOvertime({
        venueId: VENUE,
        staffVenueId: 'sv-de-otro-venue',
        date: DIA,
        minutesApproved: 60,
        approvedById: GERENTE,
      }),
    ).rejects.toThrow(/no encontrad/i)
    expect(create).not.toHaveBeenCalled()
  })

  it('🔴 …y la CONSULTA acota por venueId, no sólo por el id de la membresía', async () => {
    // Codex (P2 #15): la prueba de arriba simula `findFirst → null` y pasa aunque alguien
    // QUITE el filtro de tenant — el mock devuelve null pase lo que pase. Lo que de verdad
    // protege es la FORMA de la consulta, así que es lo que hay que fijar. Sin el `venueId`,
    // un negocio podría autorizarle horas a un empleado de otro.
    midio(120)
    await approveOvertime({
      venueId: VENUE,
      staffVenueId: MEMBRESIA,
      date: DIA,
      minutesApproved: 60,
      approvedById: GERENTE,
    })
    expect(findMembership).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: MEMBRESIA, venueId: VENUE }) }),
    )
  })

  it('un día SIN horas extra no se puede autorizar', async () => {
    midio(0)
    await expect(
      approveOvertime({
        venueId: VENUE,
        staffVenueId: MEMBRESIA,
        date: DIA,
        minutesApproved: 60,
        approvedById: GERENTE,
      }),
    ).rejects.toThrow(/no hay horas extra/i)
  })

  it('una fecha inválida se rechaza ANTES de consultar la rejilla', async () => {
    await expect(
      approveOvertime({
        venueId: VENUE,
        staffVenueId: MEMBRESIA,
        date: '2026-13-40',
        minutesApproved: 60,
        approvedById: GERENTE,
      }),
    ).rejects.toThrow(/fecha/i)
    expect(gridMock).not.toHaveBeenCalled()
  })

  it('🔴 la primera autorización del día se CREA con su llave de persona y día', async () => {
    // Corregir una que YA existe exige la revisión que se vio, y eso vive en
    // `overtimeApproval.concurrencia.test.ts`: aquí sólo se fija el alta.
    midio(120)
    await approveOvertime({
      venueId: VENUE,
      staffVenueId: MEMBRESIA,
      date: DIA,
      minutesApproved: 90,
      approvedById: GERENTE,
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ staffVenueId: MEMBRESIA, date: DIA, minutesApproved: 90, minutesMeasured: 120 }),
      }),
    )
  })

  it('deja rastro en la bitácora, con quién y cuánto', async () => {
    midio(120)
    await approveOvertime({
      venueId: VENUE,
      staffVenueId: MEMBRESIA,
      date: DIA,
      minutesApproved: 90,
      approvedById: GERENTE,
      note: 'inventario de fin de mes',
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'OVERTIME_APPROVED',
        entity: 'OvertimeApproval',
        staffId: GERENTE,
        venueId: VENUE,
        data: expect.objectContaining({ minutesApproved: 90, minutesMeasured: 120, date: DIA }),
      }),
    )
  })

  it('🔴 si la bitácora truena, la autorización NO se cae', async () => {
    // `logAction` es fire-and-forget: registrar no puede tumbar la operación.
    ;(logAction as jest.Mock).mockRejectedValueOnce(new Error('bitácora caída'))
    midio(120)
    await expect(
      approveOvertime({
        venueId: VENUE,
        staffVenueId: MEMBRESIA,
        date: DIA,
        minutesApproved: 60,
        approvedById: GERENTE,
      }),
    ).resolves.toBeDefined()
  })
})

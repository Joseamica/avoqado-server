/**
 * P1 #3 de la auditoría de Codex — **la actualización perdida**.
 *
 * El `@@unique(staffVenueId, date)` garantiza UNA fila, pero no resuelve la decisión: dos
 * gerentes ven los mismos 120 minutos pendientes, uno autoriza 120 y el otro niega con 0, y
 * los DOS reciben éxito. Gana el último `UPDATE` y el primero nunca sabe que su pantalla
 * estaba vieja.
 *
 * 🔴 El arreglo NO es reintentar en silencio: eso convierte el conflicto en «el último gana»,
 * que es justo el problema. Es revisión optimista — quien autoriza manda la revisión que
 * VIO, y si ya cambió recibe un 409 para que vuelva a mirar. Mismo patrón que ya se usa al
 * publicar turnos rotativos.
 */
import { approveOvertime } from '@/services/dashboard/overtimeApproval.service'
import { buildAttendanceGrid } from '@/services/dashboard/attendance.dashboard.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/dashboard/attendance.dashboard.service', () => ({
  buildAttendanceGrid: jest.fn(),
}))

const gridMock = buildAttendanceGrid as jest.MockedFunction<typeof buildAttendanceGrid>
const findMembership = prisma.staffVenue.findFirst as jest.Mock
const findApproval = prisma.overtimeApproval.findUnique as jest.Mock
const create = prisma.overtimeApproval.create as jest.Mock
const updateMany = prisma.overtimeApproval.updateMany as jest.Mock

const VENUE = 'v1'
const MEMBRESIA = 'sv1'
const DIA = '2026-08-24'
const GERENTE = 'staff-gerente'

function autorizar(extra: Record<string, unknown> = {}) {
  return approveOvertime({
    venueId: VENUE,
    staffVenueId: MEMBRESIA,
    date: DIA,
    minutesApproved: 60,
    approvedById: GERENTE,
    ...extra,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  findMembership.mockResolvedValue({ id: MEMBRESIA, staffId: 's1' })
  gridMock.mockResolvedValue({
    cells: [{ staffVenueId: MEMBRESIA, date: DIA, overtimeMinutes: 120, staffId: 's1', name: 'Ana' }],
    graceMinutes: 10,
    timezone: 'America/Mexico_City',
    workedTotalsByStaff: new Map(),
  } as any)
  findApproval.mockResolvedValue(null) // por defecto: nadie ha autorizado ese día
  create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'ap1', ...data }))
  updateMany.mockResolvedValue({ count: 1 })
})

describe('primera autorización del día', () => {
  it('sin fila previa se CREA, sin pedir revisión', async () => {
    await expect(autorizar()).resolves.toMatchObject({ minutesApproved: 60 })
    expect(create).toHaveBeenCalled()
  })

  it('🔴 si alguien la creó entre la lectura y la escritura, NO se pisa en silencio', async () => {
    // La carrera real: los dos leen `null` y los dos intentan crear. El unique de la base
    // rebota al segundo con P2002, y eso NO puede convertirse en «el último gana».
    create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    await expect(autorizar()).rejects.toThrow(/alguien más|ya (fue|la) autoriz/i)
  })
})

describe('corregir una autorización existente', () => {
  const EXISTENTE = {
    id: 'ap1',
    minutesApproved: 120,
    minutesMeasured: 120,
    updatedAt: new Date('2026-08-30T10:00:00.000Z'),
  }

  it('🔴 sin mandar la revisión que se vio, se RECHAZA con SU mensaje', async () => {
    // Corregir a ciegas es exactamente «el último gana». Quien corrige tiene que haber mirado.
    //
    // 🔴 Se exige el mensaje EXACTO de este caso, no cualquier conflicto: al sabotear el `if`
    // a propósito, la comparación de abajo también rebotaba (`new Date(undefined)` da NaN y
    // nunca coincide), así que una aserción laxa pasaba con la guarda quitada — no probaba
    // nada. Lo que distingue este camino es lo que se le DICE al usuario.
    findApproval.mockResolvedValue(EXISTENTE)
    await expect(autorizar()).rejects.toThrow(/ya tiene una autorizaci[oó]n/i)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('con la revisión correcta, se actualiza', async () => {
    findApproval.mockResolvedValue(EXISTENTE)
    await expect(autorizar({ expectedUpdatedAt: EXISTENTE.updatedAt.toISOString() })).resolves.toMatchObject({
      minutesApproved: 60,
    })
    expect(updateMany).toHaveBeenCalled()
  })

  it('🔴 con una revisión VIEJA se rechaza: tu pantalla ya no es la verdad', async () => {
    findApproval.mockResolvedValue(EXISTENTE)
    await expect(
      autorizar({ expectedUpdatedAt: new Date('2026-08-30T09:00:00.000Z').toISOString() }),
    ).rejects.toThrow(/cambi[oó]|conflicto|vuelve a/i)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('🔴 y si cambia ENTRE la lectura y el UPDATE, el CAS lo caza', async () => {
    // La revisión coincidía al leer, pero otro gerente escribió justo después. El
    // `updateMany` condicionado por `updatedAt` afecta 0 filas y eso NO es un éxito.
    findApproval.mockResolvedValue(EXISTENTE)
    updateMany.mockResolvedValue({ count: 0 })
    await expect(autorizar({ expectedUpdatedAt: EXISTENTE.updatedAt.toISOString() })).rejects.toThrow(
      /cambi[oó]|conflicto|vuelve a/i,
    )
  })

  it('el error dice QUÉ hacer, no un código', async () => {
    findApproval.mockResolvedValue(EXISTENTE)
    await expect(autorizar()).rejects.toThrow(/vuelve a (mirar|cargar|revisar)/i)
  })
})

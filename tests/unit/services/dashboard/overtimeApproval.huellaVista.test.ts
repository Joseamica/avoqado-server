/**
 * Se firma la jornada que el gerente VIO, no la que haya en el servidor al llegar.
 *
 * 🔴 Hallazgo P1 #3 de la 2ª auditoría de Codex (30-ago-2026). La huella se introdujo para
 * que una autorización dejara de valer si las checadas cambiaban… pero al AUTORIZAR se
 * estampaba la huella ACTUAL, calculada en ese mismo instante. Consecuencia: si alguien
 * editaba la checada entre que el gerente abría el panel y tocaba «Autorizar», la firma
 * nacía **vigente sobre una jornada que nadie revisó** — justo lo que la huella impedía
 * después, pero no en el momento de nacer.
 *
 * `expectedUpdatedAt` no cubría esto: protege contra dos AUTORIZACIONES simultáneas, no
 * contra un cambio de las CHECADAS. Son dos carreras distintas y hacen falta las dos.
 */
import { approveOvertime } from '@/services/dashboard/overtimeApproval.service'
import { buildAttendanceGrid } from '@/services/dashboard/attendance.dashboard.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/dashboard/attendance.dashboard.service', () => ({
  buildAttendanceGrid: jest.fn(),
}))

const gridMock = buildAttendanceGrid as jest.MockedFunction<typeof buildAttendanceGrid>
const findMembership = prisma.staffVenue.findFirst as jest.Mock
const findUnique = prisma.overtimeApproval.findUnique as jest.Mock
const create = prisma.overtimeApproval.create as jest.Mock

const VENUE = 'v1'
const MEMBRESIA = 'sv1'
const DIA = '2026-08-24'
const ANA = 'staff-ana'
const GERENTE = 'staff-gerente'

/** La huella que el servidor calcula AHORA, tras la edición de la checada. */
const HUELLA_ACTUAL = 'a'.repeat(32)
/** La que el gerente tenía en pantalla cuando decidió. */
const HUELLA_VISTA = 'b'.repeat(32)

beforeEach(() => {
  jest.clearAllMocks()
  findMembership.mockResolvedValue({ id: MEMBRESIA, staffId: ANA })
  findUnique.mockResolvedValue(null)
  create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'ap1', ...data }))
  gridMock.mockResolvedValue({
    cells: [
      {
        staffVenueId: MEMBRESIA,
        date: DIA,
        overtimeMinutes: 240,
        overtimeFingerprint: HUELLA_ACTUAL,
        staffId: ANA,
        name: 'Ana',
      },
    ],
    graceMinutes: 10,
    timezone: 'America/Mexico_City',
    workedTotalsByStaff: new Map(),
  } as any)
})

function autorizar(expectedSourceFingerprint?: string) {
  return approveOvertime({
    venueId: VENUE,
    staffVenueId: MEMBRESIA,
    date: DIA,
    minutesApproved: 120,
    approvedById: GERENTE,
    expectedSourceFingerprint,
  })
}

describe('la firma vale sobre la jornada que se revisó', () => {
  it('🔴 si las checadas cambiaron mientras revisaba, se RECHAZA', async () => {
    await expect(autorizar(HUELLA_VISTA)).rejects.toThrow(/cambiaron mientras|vuelve a cargar/i)
  })

  it('🔴 y no escribe nada: no hay firma a medias sobre horas que nadie miró', async () => {
    await expect(autorizar(HUELLA_VISTA)).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })

  it('si la jornada es la misma que vio, se autoriza normal', async () => {
    await expect(autorizar(HUELLA_ACTUAL)).resolves.toMatchObject({ minutesApproved: 120 })
    expect(create).toHaveBeenCalled()
  })

  it('la firma guardada es la de la jornada comprobada', async () => {
    await autorizar(HUELLA_ACTUAL)
    expect(create.mock.calls[0][0].data).toMatchObject({ sourceFingerprint: HUELLA_ACTUAL })
  })

  /**
   * 🔴 CORREGIDO tras la 3ª auditoría de Codex (31-ago-2026, P1 #2). Antes esta prueba
   * afirmaba que omitir la huella «se acepta porque el campo es opcional», y con eso el
   * agujero quedaba convertido en comportamiento esperado: cualquier cliente que no la
   * mandara —el MCP, un script, curl— firmaba sobre la jornada que hubiera en ese instante.
   *
   * Ahora la exige el SERVICIO, no sólo Zod: es donde está la rejilla y donde se sabe si el
   * día tiene huella. Un cliente viejo recibe un error que dice qué hacer, no una protección
   * silenciosamente renunciada.
   */
  it('🔴 omitir la huella NO se acepta: se rechaza diciendo qué falta', async () => {
    await expect(autorizar(undefined)).rejects.toThrow(/vuelve a consultar|huella|revisa/i)
  })

  it('🔴 y tampoco escribe nada', async () => {
    await expect(autorizar(undefined)).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })
})

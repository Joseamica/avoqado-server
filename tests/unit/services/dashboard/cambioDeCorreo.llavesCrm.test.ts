/**
 * D4 (6-nov): cambiar el correo del perfil NO debe quitarle a nadie sus llaves del CRM.
 *
 * `getCrmAccess` busca la fila de `PlatformAccess` por el correo de la persona. Si confirmar el cambio sólo movía
 * `Staff.email`, su fila (reclamada por ella) quedaba con el correo viejo y `GET /crm/me` daba 403. Ahora la fila se muda
 * al correo nuevo en la MISMA transacción, subiendo `llavesVersion` (L11: si no sube, el disparador apaga las finas).
 */
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret-crm-correo'

const enviar = jest.fn()
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmail: (...a: unknown[]) => enviar(...a) } }))
jest.mock('@/utils/passwordChangeGuard', () => ({
  emisionDelToken: () => Date.now(),
  motivoDeConcesionInvalidada: jest.fn().mockResolvedValue(null),
}))

import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { confirmarCambioDeCorreo, solicitarCambioDeCorreo } from '@/services/dashboard/cambioDeCorreo.service'

const YO = 'cstaffcorreo00000000000001'
const ANTES = 'rafa@playtelecom.mx'
const NUEVO = 'rafa@avoqado.io'
const MI_FILA = { id: 'caccesscorreo000000000001' }
const OTRA_FILA = { id: 'caccesscorreo000000000002' }

/** `platformAccess.findUnique`: por `staffId` devuelve la fila propia; por `email`, la del correo nuevo. */
function filas({ propia, delCorreoNuevo }: { propia: object | null; delCorreoNuevo: object | null }) {
  prismaMock.platformAccess.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(where.staffId ? propia : where.email === NUEVO ? delCorreoNuevo : null),
  )
}

function tokenDelCorreo(): string {
  const html: string = enviar.mock.calls.at(-1)[0].html
  return decodeURIComponent(html.match(/confirm-email-change\?token=([^"&\s<]+)/)![1])
}

async function pedirYSacarToken(): Promise<string> {
  await solicitarCambioDeCorreo(YO, NUEVO)
  return tokenDelCorreo()
}

beforeEach(() => {
  enviar.mockReset().mockResolvedValue(true)
  prismaMock.staff.findUnique.mockReset().mockImplementation(({ where }: any) =>
    // Por id: yo. Por correo: nadie más tiene el nuevo.
    Promise.resolve(where.id === YO ? { id: YO, email: ANTES, firstName: 'Rafa', active: true } : null),
  )
  prismaMock.staffOrganization.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.staff.updateMany.mockReset().mockResolvedValue({ count: 1 })
  prismaMock.platformAccess.findUnique.mockReset()
  prismaMock.platformAccess.updateMany.mockReset().mockResolvedValue({ count: 1 })
  filas({ propia: MI_FILA, delCorreoNuevo: null })
})

it('🔴 confirmar muda MI fila de llaves al correo nuevo y sube llavesVersion (L11)', async () => {
  const token = await pedirYSacarToken()

  await confirmarCambioDeCorreo(token)

  expect(prismaMock.staff.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: YO, email: ANTES }, data: expect.objectContaining({ email: NUEVO }) }),
  )
  expect(prismaMock.platformAccess.updateMany).toHaveBeenCalledWith({
    where: { staffId: YO },
    data: { email: NUEVO, llavesVersion: { increment: 1 } },
  })
  // Las dos escrituras van juntas: o cambian las dos o ninguna.
  expect(prismaMock.$transaction).toHaveBeenCalled()
})

it('🔴 si el correo nuevo ya tiene OTRA fila de llaves, pedir el cambio se rechaza y no sale correo', async () => {
  filas({ propia: MI_FILA, delCorreoNuevo: OTRA_FILA })

  await expect(solicitarCambioDeCorreo(YO, NUEVO)).rejects.toMatchObject({ statusCode: 409, code: 'CRM_KEYS_EMAIL_IN_USE' })
  expect(enviar).not.toHaveBeenCalled()
})

it('🔴 si esa otra fila aparece entre pedir y confirmar, el correo NO cambia', async () => {
  const token = await pedirYSacarToken()
  filas({ propia: MI_FILA, delCorreoNuevo: OTRA_FILA })

  await expect(confirmarCambioDeCorreo(token)).rejects.toMatchObject({ statusCode: 409, code: 'CRM_KEYS_EMAIL_IN_USE' })
  expect(prismaMock.staff.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.platformAccess.updateMany).not.toHaveBeenCalled()
})

it('sin llaves propias, un correo nuevo con llaves sin reclamar sí se puede (se reclaman en su primer acceso)', async () => {
  filas({ propia: null, delCorreoNuevo: OTRA_FILA })
  const token = await pedirYSacarToken()

  await expect(confirmarCambioDeCorreo(token)).resolves.toEqual({ correoNuevo: NUEVO })
})

it('si el CAS del correo pierde (otra pestaña ya lo cambió), no se toca ninguna fila de llaves', async () => {
  const token = await pedirYSacarToken()
  prismaMock.staff.updateMany.mockResolvedValue({ count: 0 })

  await expect(confirmarCambioDeCorreo(token)).rejects.toMatchObject({ statusCode: 400, code: 'EMAIL_CHANGE_LINK_STALE' })
  expect(prismaMock.platformAccess.updateMany).not.toHaveBeenCalled()
})

it('un único que choca en la carrera (P2002) es 409, no 500', async () => {
  const token = await pedirYSacarToken()
  prismaMock.platformAccess.updateMany.mockRejectedValue(
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
  )

  await expect(confirmarCambioDeCorreo(token)).rejects.toMatchObject({ statusCode: 409 })
})

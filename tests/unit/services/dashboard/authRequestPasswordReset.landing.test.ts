/**
 * «Olvidé mi contraseña» y el prospecto de landing (alta con código de 6 dígitos).
 *
 * La cuenta de landing nace con `emailVerified: false`. Si el prospecto pierde el correo de
 * bienvenida o su código, «olvidé mi contraseña» tiene que servirle — pero SOLO a él: los
 * empleados creados sin contraseña y sin verificar entran aceptando su invitación, y una
 * cuenta con contraseña sin verificar sigue callada (como hoy).
 *
 * Todas las ramas contestan el MISMO mensaje: nada de enumerar cuentas.
 */
import prisma from '@/utils/prismaClient'
import { requestPasswordReset } from '../../../../src/services/dashboard/auth.service'
import { enviarEnlaceDeRestablecimiento } from '../../../../src/services/dashboard/enlaceDeRestablecimiento'
import { esProspectoDeLanding } from '@/services/onboarding/signup.service'

jest.mock('../../../../src/services/dashboard/enlaceDeRestablecimiento', () => ({
  enviarEnlaceDeRestablecimiento: jest.fn(),
}))
jest.mock('@/services/onboarding/signup.service', () => ({
  esProspectoDeLanding: jest.fn(),
}))

const prismaMock = prisma as any
const enviarMock = enviarEnlaceDeRestablecimiento as jest.Mock
const esProspectoMock = esProspectoDeLanding as jest.Mock

const MENSAJE = 'Si existe una cuenta con este email, recibirás un enlace de restablecimiento.'

const cuenta = (extra: Record<string, unknown> = {}) => ({
  id: 'staff_1',
  email: 'duena@negocio.mx',
  emailVerified: false,
  firstName: 'Ana',
  active: true,
  ...extra,
})

beforeEach(() => {
  jest.clearAllMocks()
  enviarMock.mockResolvedValue(true)
  esProspectoMock.mockResolvedValue(false)
})

describe('requestPasswordReset — prospecto de landing sin verificar', () => {
  it('🔴 un prospecto de landing (sin contraseña, sin verificar) SÍ recibe el enlace', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta())
    esProspectoMock.mockResolvedValue(true)

    const res = await requestPasswordReset({ email: 'Duena@Negocio.mx' })

    expect(esProspectoMock).toHaveBeenCalledWith('staff_1')
    expect(enviarMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'staff_1' }))
    expect(res.message).toBe(MENSAJE)
  })

  it('REGRESIÓN: una cuenta CON contraseña y sin verificar sigue callada (no es prospecto)', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta())
    esProspectoMock.mockResolvedValue(false)

    const res = await requestPasswordReset({ email: 'duena@negocio.mx' })

    expect(enviarMock).not.toHaveBeenCalled()
    expect(res.message).toBe(MENSAJE)
  })

  it('REGRESIÓN: un empleado sin contraseña y sin verificar sigue callado (entra por su invitación)', async () => {
    // Sin contraseña NO basta: lo decide `esProspectoDeLanding` (OWNER de una org sin onboarding).
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ id: 'staff_empleado' }))
    esProspectoMock.mockResolvedValue(false)

    const res = await requestPasswordReset({ email: 'empleado@negocio.mx' })

    expect(esProspectoMock).toHaveBeenCalledWith('staff_empleado')
    expect(enviarMock).not.toHaveBeenCalled()
    expect(res.message).toBe(MENSAJE)
  })

  it('una cuenta verificada sigue recibiendo el enlace sin consultar si es prospecto', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ emailVerified: true }))

    const res = await requestPasswordReset({ email: 'duena@negocio.mx' })

    expect(esProspectoMock).not.toHaveBeenCalled()
    expect(enviarMock).toHaveBeenCalledTimes(1)
    expect(res.message).toBe(MENSAJE)
  })

  it('un prospecto desactivado no recibe nada (el candado de «activa» sigue después)', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta({ active: false }))
    esProspectoMock.mockResolvedValue(true)

    const res = await requestPasswordReset({ email: 'duena@negocio.mx' })

    expect(enviarMock).not.toHaveBeenCalled()
    expect(res.message).toBe(MENSAJE)
  })

  it('un correo que no existe contesta lo mismo y no consulta nada más', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(null)

    const res = await requestPasswordReset({ email: 'nadie@negocio.mx' })

    expect(esProspectoMock).not.toHaveBeenCalled()
    expect(enviarMock).not.toHaveBeenCalled()
    expect(res.message).toBe(MENSAJE)
  })

  it('si consultar al prospecto truena, contesta lo mismo y no manda nada', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(cuenta())
    esProspectoMock.mockRejectedValue(new Error('db caída'))

    const res = await requestPasswordReset({ email: 'duena@negocio.mx' })

    expect(enviarMock).not.toHaveBeenCalled()
    expect(res.message).toBe(MENSAJE)
  })
})

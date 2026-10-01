import { prismaMock } from '@tests/__helpers__/setup'
import { updateProfile } from '@/services/public/customerPortal.public.service'
import { customerUpdateProfileSchema } from '@/schemas/dashboard/creditPack.schema'

/**
 * 🔴 Auditoría de seguridad 2026-10-01: «Mi Cuenta» dejaba poner cualquier teléfono que no tuviera otro cliente, sin probar que
 * fuera de quien lo escribe; el portal empata reservas de invitado por ese teléfono y entrega su `cancelSecret`. El teléfono ya
 * no se cambia desde el perfil (lo cambia el negocio desde su dashboard). Los nombres se siguen guardando.
 */
const VENUE = 'venue-1'
const CLIENTE = 'c1'

describe('updateProfile — el teléfono no se cambia desde el perfil', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.customer.findFirst.mockResolvedValue({ phone: '+525512345678' } as any)
    prismaMock.customer.update.mockResolvedValue({
      id: CLIENTE,
      firstName: 'Ana',
      lastName: null,
      email: 'a@b.com',
      phone: '+525512345678',
    } as any)
  })

  it('otro teléfono: 400 CUSTOMER_PHONE_CHANGE_NOT_ALLOWED y no se guarda nada', async () => {
    await expect(updateProfile(VENUE, CLIENTE, { firstName: 'Ana', phone: '+525599999999' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CUSTOMER_PHONE_CHANGE_NOT_ALLOWED',
    })
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })

  it.each([
    ['el mismo teléfono', '+525512345678'],
    ['el mismo teléfono con otro formato', '55 1234 5678'],
    ['sin teléfono', undefined],
    ['teléfono vacío', ''],
  ])('%s: guarda los nombres y nunca escribe el teléfono', async (_caso, phone) => {
    await updateProfile(VENUE, CLIENTE, { firstName: 'Ana', phone })

    expect(prismaMock.customer.update).toHaveBeenCalledTimes(1)
    const { data } = prismaMock.customer.update.mock.calls[0][0] as any
    expect(data).toEqual({ firstName: 'Ana' })
  })

  it('la comparación es contra el teléfono de ESTE cliente, de este negocio', async () => {
    await updateProfile(VENUE, CLIENTE, { phone: '+525512345678' })
    expect(prismaMock.customer.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: CLIENTE, venueId: VENUE } }))
  })
})

// La frontera HTTP no debe rechazar antes lo que el servicio sí acepta (mismo teléfono con formato, o vacío).
describe('customerUpdateProfileSchema — el teléfono sólo se acota', () => {
  const valida = (body: Record<string, unknown>) => customerUpdateProfileSchema.safeParse({ params: { venueSlug: 'v' }, body }).success

  it.each([['55 1234 5678'], ['+52 (55) 1234-5678'], ['']])('acepta %p para que el servicio decida', phone => {
    expect(valida({ firstName: 'Ana', phone })).toBe(true)
  })

  it('rechaza un teléfono absurdamente largo', () => {
    expect(valida({ phone: '5'.repeat(33) })).toBe(false)
  })
})

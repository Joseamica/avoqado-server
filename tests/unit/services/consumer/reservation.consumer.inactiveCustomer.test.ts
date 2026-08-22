import { prismaMock } from '@tests/__helpers__/setup'

import { ensureVenueCustomer } from '@/services/consumer/reservation.consumer.service'

const VENUE = 'venue-1'
const CONSUMER = { id: 'cons-1', email: 'a@b.com', phone: '+525511111111', firstName: 'Ana', lastName: 'R', active: true }

/**
 * Fase 0.B — la app de consumidor NO vincula ni usa un Customer que el venue desactivó,
 * en ninguna de las tres ramas (por consumerId, por email, por teléfono).
 * Rechaza con 401 CUSTOMER_INACTIVE; no crea un duplicado (chocaría con los índices
 * únicos por venue) ni deja pasar como invitado.
 */
describe('ensureVenueCustomer — Customer.active', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.consumer.findUnique.mockResolvedValue(CONSUMER as any)
  })

  it('rama consumerId: Customer ya vinculado pero inactivo → 401 CUSTOMER_INACTIVE', async () => {
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1', venueId: VENUE, consumerId: 'cons-1', active: false } as any)

    await expect(ensureVenueCustomer(VENUE, 'cons-1')).rejects.toMatchObject({ statusCode: 401, code: 'CUSTOMER_INACTIVE' })
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
  })

  it('rama email: contacto inactivo → 401 CUSTOMER_INACTIVE, no se vincula', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(null)
    prismaMock.customer.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.venueId_email) return { id: 'c_mail', venueId: VENUE, active: false }
      return null
    })

    await expect(ensureVenueCustomer(VENUE, 'cons-1')).rejects.toMatchObject({ statusCode: 401, code: 'CUSTOMER_INACTIVE' })
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })

  it('rama teléfono: contacto inactivo → 401 CUSTOMER_INACTIVE, no se vincula', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(null)
    prismaMock.customer.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.venueId_phone) return { id: 'c_tel', venueId: VENUE, active: false }
      return null
    })

    await expect(ensureVenueCustomer(VENUE, 'cons-1')).rejects.toMatchObject({ statusCode: 401, code: 'CUSTOMER_INACTIVE' })
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })

  it('regresión: Customer vinculado y activo → se devuelve sin tocar nada', async () => {
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1', venueId: VENUE, consumerId: 'cons-1', active: true } as any)

    const r = await ensureVenueCustomer(VENUE, 'cons-1')
    expect(r.customer.id).toBe('c1')
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })
})

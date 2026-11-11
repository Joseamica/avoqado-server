/**
 * S7 (P2-1, codex-plan2-r1 #2): las reservas de INVITADA (y su `cancelSecret`) sólo se buscan con los contactos que ESTA sesión
 * probó. La contraseña prueba la ficha, no su correo; el token de reservas de hoy no prueba ningún contacto.
 */
jest.mock('@/services/wallet/stampLedger.service', () => ({ __esModule: true, getStampCardStatus: jest.fn() }))

import bcrypt from 'bcryptjs'
import { prismaMock } from '@tests/__helpers__/setup'
import { verifyCustomerSession, type ContactoProbado } from '@/jwt.service'
import { getCustomerPortal, loginCustomer } from '@/services/public/customerPortal.public.service'

const VENUE = 'cvenue000000000000000000a'
const FICHA = {
  id: 'cficha00000000000000000a1',
  firstName: 'Ana',
  lastName: null,
  email: 'ana@gmail.com',
  phone: '55 1111 2222',
  loyaltyPoints: 40,
  totalVisits: 2,
}
const TEL: ContactoProbado = { tipo: 'PHONE', valor: '+525511112222', metodo: 'WHATSAPP', probadoEn: 1_800_000_000 }
const CORREO: ContactoProbado = { tipo: 'EMAIL', valor: 'ana@gmail.com', metodo: 'GOOGLE', probadoEn: 1_800_000_000 }

function armar() {
  prismaMock.customer.findFirst.mockReset().mockResolvedValue(FICHA as any)
  prismaMock.creditPackPurchase.findMany.mockResolvedValue([])
  prismaMock.reservation.findMany.mockReset().mockResolvedValue([])
  prismaMock.loyaltyConfig.findUnique.mockResolvedValue(null)
}
const filtros = () => (prismaMock.reservation.findMany as jest.Mock).mock.calls.map(([q]) => q.where.OR)

describe('getCustomerPortal · reservas de invitada', () => {
  it('sin contactos probados (token de hoy o contraseña) ⇒ sólo su ficha, invitadaRequiereEntrar', async () => {
    armar()
    const r: any = await getCustomerPortal(VENUE, FICHA.id, { contactos: [] })
    expect(filtros()).toEqual([[{ customerId: FICHA.id }], [{ customerId: FICHA.id }]])
    expect(r.invitadaRequiereEntrar).toBe(true)
  })

  it('sin `auth` (llamada vieja) tampoco usa los contactos de la ficha', async () => {
    armar()
    const r: any = await getCustomerPortal(VENUE, FICHA.id)
    expect(filtros()).toEqual([[{ customerId: FICHA.id }], [{ customerId: FICHA.id }]])
    expect(r.invitadaRequiereEntrar).toBe(true)
  })

  it('con contactos probados ⇒ busca por ellos (en su forma probada y en la de la ficha, si es el mismo)', async () => {
    armar()
    const r: any = await getCustomerPortal(VENUE, FICHA.id, { contactos: [TEL, CORREO] })
    const esperado = [
      { customerId: FICHA.id },
      { guestPhone: { in: ['+525511112222', '55 1111 2222'] } },
      { guestEmail: { equals: 'ana@gmail.com', mode: 'insensitive' } },
    ]
    expect(filtros()).toEqual([esperado, esperado])
    expect(r.invitadaRequiereEntrar).toBe(false)
  })

  it('un contacto probado que la ficha ya no tiene no arrastra el campo de la ficha', async () => {
    armar()
    prismaMock.customer.findFirst.mockResolvedValue({ ...FICHA, phone: '+525599990000' } as any)
    await getCustomerPortal(VENUE, FICHA.id, { contactos: [TEL] })
    expect(filtros()[0]).toEqual([{ customerId: FICHA.id }, { guestPhone: { in: ['+525511112222'] } }])
  })
})

describe('loginCustomer · contraseña ⇒ sesión SIN contactos probados', () => {
  it('firma la sesión única con la versión de la ficha y contactos vacíos', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({
      ...FICHA,
      venueId: VENUE,
      active: true,
      versionDeSesion: 2,
      password: await bcrypt.hash('secreto', 4),
    } as any)
    const r = await loginCustomer(VENUE, 'ana@gmail.com', 'secreto')
    expect(verifyCustomerSession(r.token)).toMatchObject({ sub: FICHA.id, venueId: VENUE, v: 2, contactos: [] })
  })
})

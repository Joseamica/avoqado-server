import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { findCustomerIdByPhone } from '@/services/public/customerPhoneLookup'
import { resolvePassCustomer } from '@/services/aggregators/core/customerIdentity.service'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
// El teléfono se busca con el buscador canónico (los teléfonos viejos están guardados sin normalizar).
jest.mock('@/services/public/customerPhoneLookup', () => ({ findCustomerIdByPhone: jest.fn() }))

const tx = prismaMock as any
const byPhone = findCustomerIdByPhone as jest.Mock
const base = {
  venueId: 'v1',
  provider: 'TOTALPASS' as const,
  externalUserId: 'EQ2B3FBK',
  user: { name: 'Ana López', email: 'ANA@x.com', phone: '55 1234 5678' },
}
const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
const sqlCalls = () => tx.$executeRawUnsafe.mock.calls.map((c: unknown[]) => c[0])

describe('resolvePassCustomer', () => {
  beforeEach(() => {
    byPhone.mockReset().mockResolvedValue(null)
  })

  // nuevo
  it('si ya existe la identidad, usa ese cliente', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce({ customerId: 'cu1' })
    await expect(resolvePassCustomer(tx, base)).resolves.toEqual({ customerId: 'cu1', created: false })
    expect(tx.customerExternalIdentity.findUnique.mock.calls[0][0].where).toEqual({
      venueId_provider_externalUserId: { venueId: 'v1', provider: 'TOTALPASS', externalUserId: 'EQ2B3FBK' },
    })
    expect(byPhone).not.toHaveBeenCalled()
    expect(tx.customer.findFirst).not.toHaveBeenCalled()
    expect(tx.customer.create).not.toHaveBeenCalled()
    expect(tx.customerExternalIdentity.create).not.toHaveBeenCalled()
  })

  // nuevo
  it('liga por teléfono normalizado y guarda la identidad', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce(null)
    byPhone.mockResolvedValueOnce('cu2')
    tx.customerExternalIdentity.create.mockResolvedValueOnce({})
    await expect(resolvePassCustomer(tx, base)).resolves.toEqual({ customerId: 'cu2', created: false })
    expect(byPhone).toHaveBeenCalledWith(tx, 'v1', '+525512345678')
    expect(tx.customer.findFirst).not.toHaveBeenCalled()
    expect(tx.customer.create).not.toHaveBeenCalled()
    expect(tx.customerExternalIdentity.create.mock.calls[0][0].data).toEqual({
      venueId: 'v1',
      customerId: 'cu2',
      provider: 'TOTALPASS',
      externalUserId: 'EQ2B3FBK',
    })
  })

  // nuevo
  it('sin teléfono que coincida, liga por correo sin importar mayúsculas', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce(null)
    tx.customer.findFirst.mockResolvedValueOnce({ id: 'cu5' })
    tx.customerExternalIdentity.create.mockResolvedValueOnce({})
    await expect(resolvePassCustomer(tx, base)).resolves.toEqual({ customerId: 'cu5', created: false })
    expect(tx.customer.findFirst.mock.calls[0][0].where).toEqual({
      venueId: 'v1',
      email: { equals: 'ana@x.com', mode: 'insensitive' },
    })
    expect(tx.customer.create).not.toHaveBeenCalled()
  })

  // nuevo
  it('sin coincidencias crea el cliente con correo en minúsculas y teléfono E.164', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce(null)
    tx.customer.findFirst.mockResolvedValueOnce(null)
    tx.customer.create.mockResolvedValueOnce({ id: 'cu3' })
    tx.customerExternalIdentity.create.mockResolvedValueOnce({})
    await expect(resolvePassCustomer(tx, base)).resolves.toEqual({ customerId: 'cu3', created: true })
    expect(tx.customer.create.mock.calls[0][0].data).toEqual({
      venueId: 'v1',
      firstName: 'Ana',
      lastName: 'López',
      email: 'ana@x.com',
      phone: '+525512345678',
      provider: 'EMAIL',
    })
    expect(tx.customerExternalIdentity.create.mock.calls[0][0].data).toMatchObject({ customerId: 'cu3' })
  })

  // nuevo
  it('sin teléfono ni correo crea el cliente sólo con el nombre', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce(null)
    tx.customer.create.mockResolvedValueOnce({ id: 'cu6' })
    tx.customerExternalIdentity.create.mockResolvedValueOnce({})
    await expect(resolvePassCustomer(tx, { ...base, user: { name: '  Cisne ', email: null, phone: null } })).resolves.toEqual({
      customerId: 'cu6',
      created: true,
    })
    expect(byPhone).not.toHaveBeenCalled()
    expect(tx.customer.findFirst).not.toHaveBeenCalled()
    expect(tx.customer.create.mock.calls[0][0].data).toMatchObject({ firstName: 'Cisne', lastName: null, email: null, phone: null })
  })

  // regresión — un teléfono basura no rompe ni liga a quien no es
  it('teléfono inválido ⇒ se ignora y se intenta por correo', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce(null)
    tx.customer.findFirst.mockResolvedValueOnce({ id: 'cu4' })
    tx.customerExternalIdentity.create.mockResolvedValueOnce({})
    await expect(resolvePassCustomer(tx, { ...base, user: { ...base.user, phone: 'xxxxxxxxx' } })).resolves.toEqual({
      customerId: 'cu4',
      created: false,
    })
    expect(byPhone).not.toHaveBeenCalled()
    expect(tx.customer.findFirst.mock.calls[0][0].where).toMatchObject({ email: { equals: 'ana@x.com' } })
  })

  // regresión — teléfono inválido y sin correo: se crea sin teléfono, nunca se guarda la basura
  it('teléfono inválido y sin correo ⇒ cliente nuevo sin teléfono', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce(null)
    tx.customer.create.mockResolvedValueOnce({ id: 'cu7' })
    tx.customerExternalIdentity.create.mockResolvedValueOnce({})
    await resolvePassCustomer(tx, { ...base, user: { name: 'Pedro', email: null, phone: '6399907-8947' } })
    expect(tx.customer.create.mock.calls[0][0].data).toMatchObject({ phone: null, email: null })
  })

  // nuevo — dos primeros eventos del mismo socio a la vez: el segundo usa el cliente del primero
  it('choque de identidad (P2002) ⇒ deshace su alta y usa el cliente que ganó', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ customerId: 'cuGanador' })
    tx.customer.findFirst.mockResolvedValueOnce(null)
    tx.customer.create.mockResolvedValueOnce({ id: 'cuPerdedor' })
    tx.customerExternalIdentity.create.mockRejectedValueOnce(p2002())
    await expect(resolvePassCustomer(tx, base)).resolves.toEqual({ customerId: 'cuGanador', created: false })
    // El alta del cliente y de la identidad van en un savepoint: el choque deshace el cliente duplicado.
    const sql = sqlCalls()
    expect(sql[0]).toMatch(/^SAVEPOINT \w+$/)
    expect(sql[1]).toMatch(/^ROLLBACK TO SAVEPOINT \w+$/)
    expect(sql).not.toContainEqual(expect.stringMatching(/^RELEASE/))
  })

  // nuevo — el choque también puede salir en el alta del cliente (mismo correo o teléfono)
  it('choque al crear el cliente (P2002) ⇒ usa la identidad que ya quedó', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ customerId: 'cuGanador' })
    tx.customer.findFirst.mockResolvedValueOnce(null)
    tx.customer.create.mockRejectedValueOnce(p2002())
    await expect(resolvePassCustomer(tx, base)).resolves.toEqual({ customerId: 'cuGanador', created: false })
    expect(tx.customerExternalIdentity.create).not.toHaveBeenCalled()
  })

  // nuevo — si tras el choque no aparece la identidad, no se inventa un resultado
  it('choque (P2002) sin identidad visible ⇒ se propaga el error', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    byPhone.mockResolvedValueOnce('cu2')
    tx.customerExternalIdentity.create.mockRejectedValueOnce(p2002())
    await expect(resolvePassCustomer(tx, base)).rejects.toMatchObject({ code: 'P2002' })
  })

  // nuevo
  it('un error que no es de duplicado se propaga sin releer', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce(null)
    byPhone.mockResolvedValueOnce('cu2')
    tx.customerExternalIdentity.create.mockRejectedValueOnce(new Error('se cayó la base'))
    await expect(resolvePassCustomer(tx, base)).rejects.toThrow('se cayó la base')
    expect(tx.customerExternalIdentity.findUnique).toHaveBeenCalledTimes(1)
  })

  // regresión — nunca al log el nombre, correo o teléfono del socio
  it('el log no lleva datos personales del socio', async () => {
    tx.customerExternalIdentity.findUnique.mockResolvedValueOnce(null)
    tx.customer.findFirst.mockResolvedValueOnce(null)
    tx.customer.create.mockResolvedValueOnce({ id: 'cu3' })
    tx.customerExternalIdentity.create.mockResolvedValueOnce({})
    await resolvePassCustomer(tx, base)
    const logged = JSON.stringify([
      (logger.info as jest.Mock).mock.calls,
      (logger.warn as jest.Mock).mock.calls,
      (logger.debug as jest.Mock).mock.calls,
    ])
    expect(logged).toContain('cu3')
    for (const pii of ['Ana', 'López', 'ana@x.com', 'ANA@x.com', '5512345678', '1234']) expect(logged).not.toContain(pii)
  })
})

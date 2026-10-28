// tests/unit/routes/editarClienteMobile.routes.test.ts — editar cliente desde el POS (26-oct-2026).
// Promesa: docs/audit/2026-10-26-editar-cliente-pos/promesa.md. La puerta de las apps reutiliza el SERVICIO del dashboard,
// pide `customers:update` (que acepta el PIN de gerente), sólo deja cambiar datos de contacto y sólo DEVUELVE datos de
// contacto (Codex r1 #3 y #4: el registro completo traía la contraseña cifrada y montos como texto).
import { Prisma } from '@prisma/client'
import { MobileUpdateCustomerSchema } from '@/schemas/dashboard/customer.schema'
import { updateCustomerContact } from '@/controllers/mobile/customer.mobile.controller'
import mobileRouter from '@/routes/mobile.routes'
import prisma from '@/utils/prismaClient'
import { updateCustomer } from '@/services/dashboard/customer.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const VENUE = 'ckvenue00000000000000000001'
const CLIENTE = 'ckcust000000000000000000001'
const PATH = '/venues/:venueId/customers/:customerId'

const conCuerpo = (body: unknown) => MobileUpdateCustomerSchema.safeParse({ params: { venueId: VENUE, customerId: CLIENTE }, body })
const mensajes = (r: ReturnType<typeof conCuerpo>) => (r.success ? [] : r.error.errors.map(e => e.message))

describe('Esquema de editar cliente desde el POS (sólo contacto, en español)', () => {
  it('acepta nombre, apellido, teléfono y correo, juntos o sueltos', () => {
    expect(conCuerpo({ firstName: 'Ana' }).success).toBe(true)
    expect(conCuerpo({ firstName: 'Ana', lastName: 'López', phone: '+527351748538', email: 'ana@ejemplo.mx' }).success).toBe(true)
  })

  it('un cuerpo vacío no se acepta', () => {
    const r = conCuerpo({})
    expect(r.success).toBe(false)
    expect(mensajes(r)).toEqual(['Cambia al menos un dato del cliente'])
  })

  it('no deja tocar lo que no es contacto (activo, etiquetas, consentimiento)', () => {
    for (const extra of [{ active: false }, { tags: ['vip'] }, { marketingConsent: true }, { notes: 'x' }]) {
      const r = conCuerpo({ firstName: 'Ana', ...extra })
      expect(r.success).toBe(false)
      expect(mensajes(r)).toEqual(['Desde el POS sólo se edita nombre, apellido, teléfono y correo'])
    }
  })

  it('formatos inválidos se rechazan con mensaje en español', () => {
    expect(mensajes(conCuerpo({ phone: '735 174 8538' }))).toEqual(['El teléfono debe tener de 10 a 15 dígitos'])
    expect(mensajes(conCuerpo({ email: 'ana@' }))).toEqual(['El correo no es válido'])
    expect(mensajes(conCuerpo({ firstName: '' }))).toEqual(['El nombre no puede quedar vacío'])
    expect(mensajes(conCuerpo({ lastName: 'x'.repeat(51) }))).toEqual(['El apellido es demasiado largo'])
  })
})

describe('Ruta PUT /mobile/venues/:venueId/customers/:customerId', () => {
  const stack: any[] = (mobileRouter as any).stack
  const capa = stack.find(l => l.route?.path === PATH && l.route.methods.put)
  const handles = () => capa.route.stack.map((l: any) => l.handle)

  it('existe y exige customers:update (el permiso que acepta el PIN de gerente)', () => {
    expect(capa).toBeDefined()
    expect(
      handles()
        .map((h: any) => h?.requiredPermission)
        .find(Boolean),
    ).toBe('customers:update')
  })

  it('termina en el controlador de contacto, después de validar', () => {
    const hs = handles()
    expect(hs[hs.length - 1]).toBe(updateCustomerContact)
    expect(hs.length).toBeGreaterThanOrEqual(4) // auth, permiso, validación, controlador
  })

  it('no cambia crear ni listar', () => {
    const crear = stack.find(l => l.route?.path === '/venues/:venueId/customers' && l.route.methods.post)
    const listar = stack.find(l => l.route?.path === '/venues/:venueId/customers' && l.route.methods.get)
    expect(crear.route.stack.map((l: any) => l.handle?.requiredPermission).find(Boolean)).toBe('customers:create')
    expect(listar.route.stack.map((l: any) => l.handle?.requiredPermission).find(Boolean)).toBe('customers:read')
  })
})

describe('La bitácora dice QUIÉN editó al cliente', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.customer.findFirst as jest.Mock).mockResolvedValueOnce({ id: CLIENTE, venueId: VENUE, phone: '+527351748538', email: null })
    ;(prisma.customer.update as jest.Mock).mockResolvedValue({ id: CLIENTE, phone: '+527351748538', email: null })
  })

  it('CUSTOMER_UPDATED lleva el staffId de quien guardó y los campos que cambió', async () => {
    await updateCustomer(VENUE, CLIENTE, { firstName: 'Ana', lastName: 'López' }, 'ckstaff00000000000000000001')
    const llamada = (logAction as jest.Mock).mock.calls.find(c => c[0].action === 'CUSTOMER_UPDATED')
    expect(llamada).toBeDefined()
    expect(llamada[0].staffId).toBe('ckstaff00000000000000000001')
    expect(llamada[0].data).toEqual(expect.objectContaining({ fields: ['firstName', 'lastName'] }))
  })
})

describe('El controlador sólo devuelve datos de contacto', () => {
  const res = () => {
    const r: any = {}
    r.status = jest.fn(() => r)
    r.json = jest.fn(() => r)
    return r
  }

  it('nunca la contraseña ni el resto del registro', async () => {
    ;(prisma.customer.findFirst as jest.Mock).mockResolvedValueOnce({ id: CLIENTE, venueId: VENUE, phone: '+527351748538', email: null })
    ;(prisma.customer.update as jest.Mock).mockResolvedValueOnce({
      id: CLIENTE,
      firstName: 'Ana',
      lastName: null,
      phone: '+527351748538',
      email: null,
      password: '$2b$10$hash',
      totalSpent: new Prisma.Decimal('65.00'),
      notes: 'privado',
    })
    const r = res()
    const next = jest.fn()
    await updateCustomerContact(
      {
        params: { venueId: VENUE, customerId: CLIENTE },
        body: { firstName: 'Ana' },
        authContext: { userId: 'ckstaff00000000000000000001' },
      } as any,
      r,
      next,
    )
    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(200)
    expect(r.json).toHaveBeenCalledWith({
      message: 'Cliente actualizado',
      customer: { id: CLIENTE, firstName: 'Ana', lastName: null, phone: '+527351748538', email: null },
    })
  })
})

describe('Teléfono o correo ya registrados salen con código estable', () => {
  beforeEach(() => jest.clearAllMocks())

  it('la búsqueda previa encuentra el teléfono en otro cliente', async () => {
    ;(prisma.customer.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: CLIENTE, venueId: VENUE, phone: null, email: null })
      .mockResolvedValueOnce({ id: 'ckotro00000000000000000001' })
    await expect(updateCustomer(VENUE, CLIENTE, { phone: '+525511112222' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CUSTOMER_PHONE_TAKEN',
    })
  })

  it('la búsqueda previa encuentra el correo en otro cliente', async () => {
    ;(prisma.customer.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: CLIENTE, venueId: VENUE, phone: null, email: null })
      .mockResolvedValueOnce({ id: 'ckotro00000000000000000001' })
    await expect(updateCustomer(VENUE, CLIENTE, { email: 'ana@x.mx' })).rejects.toMatchObject({ code: 'CUSTOMER_EMAIL_TAKEN' })
  })

  it('dos aparatos al mismo tiempo: el índice único se vuelve el mismo 400, no un 500 (Codex r1 #7)', async () => {
    ;(prisma.customer.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: CLIENTE, venueId: VENUE, phone: null, email: null })
      .mockResolvedValueOnce(null)
    ;(prisma.customer.update as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['venueId', 'phone'] },
      }),
    )
    await expect(updateCustomer(VENUE, CLIENTE, { phone: '+525511112222' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CUSTOMER_PHONE_TAKEN',
    })
  })
})

/**
 * Cobro simple · S1.6: el aprobado tardío se le avisa al DUEÑO y a los GERENTES (no al cajero), con el tipo que ya existe
 * (`PAYMENT_RECEIVED`), en alta prioridad, con el cómo devolver según el procesador (diseño §6) y la lista de cobros del mismo
 * importe (Review Focus 5). Nunca lanza.
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
const mockCorreo = jest.fn().mockResolvedValue(true)
jest.mock('@/services/resend.service', () => ({ sendNotificationEmail: (...a: unknown[]) => mockCorreo(...(a as [])) }))

import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { avisarAprobadoTardio, avisarAprobadoTardioDeLaSolicitud, comoDevolverlo } from '@/services/tpv/avisoDeCobroTardio'

const db = prisma as any

beforeEach(() => {
  jest.clearAllMocks()
  db.staffVenue.findMany.mockResolvedValue([
    { staffId: 'duena', staff: { email: 'duena@negocio.test' } },
    { staffId: 'gerente', staff: { email: null } },
  ])
  db.staffOrganization.findMany.mockResolvedValue([{ staffId: 'duena', staff: { email: 'duena@negocio.test' } }])
  db.notification.create.mockImplementation(async ({ data }: any) => ({ id: `n-${data.recipientId}`, ...data }))
})

const base = {
  venueId: 'v1',
  orderId: 'o1',
  orderNumber: 'ORD-77',
  paymentId: 'pay-1',
  montoPesos: 236.5,
  cobrosMismoImporte: [] as { orderNumber: string; at: Date }[],
}

describe('S1.6 · aprobado tardío ⇒ aviso al dueño', () => {
  it('avisa al dueño y a los gerentes (sólo esos roles, una vez por persona), nunca al cajero', async () => {
    await avisarAprobadoTardio({ ...base, procesador: 'ANGELPAY' })
    const roles = db.staffVenue.findMany.mock.calls[0][0].where.role.in
    expect(roles).toEqual(expect.arrayContaining(['OWNER', 'ADMIN', 'MANAGER']))
    expect(roles).not.toContain('CASHIER')
    expect(roles).not.toContain('WAITER')
    const destinatarios = db.notification.create.mock.calls.map((c: any[]) => c[0].data.recipientId).sort()
    expect(destinatarios).toEqual(['duena', 'gerente'])
    expect(db.notification.create.mock.calls[0][0].data).toMatchObject({ type: 'PAYMENT_RECEIVED', priority: 'HIGH' })
    // Correo sólo a quien tiene correo.
    expect(mockCorreo).toHaveBeenCalledTimes(1)
    expect(mockCorreo.mock.calls[0][0]).toBe('duena@negocio.test')
  })

  it('el texto dice qué pasó y cómo devolver según el procesador', async () => {
    await avisarAprobadoTardio({ ...base, procesador: 'BLUMON' })
    const msg: string = db.notification.create.mock.calls[0][0].data.message
    expect(msg).toContain('El banco aprobó tarde un cobro de $236.50 de la cuenta ORD-77 que se había dado por no cobrado. Ya quedó registrado.')
    expect(msg).toContain('Si el cliente pagó otra vez, devuélvele $236.50.')
    expect(msg).toContain(comoDevolverlo('BLUMON'))
    expect(comoDevolverlo('ANGELPAY')).toContain('antes de las 22:59')
    expect(comoDevolverlo('BLUMON')).toContain('con la tarjeta del cliente')
  })

  it('Review Focus 5 · con la cuenta cobrada otra vez, lista los cobros con tarjeta del mismo importe', async () => {
    await avisarAprobadoTardio({ ...base, procesador: 'ANGELPAY', cobrosMismoImporte: [{ orderNumber: 'ORD-78', at: new Date() }] })
    expect(db.notification.create.mock.calls[0][0].data.message).toContain('Cobros de $236.50 con tarjeta desde entonces: ORD-78.')
  })

  it('nunca lanza (un aviso no puede deshacer el registro del cobro)', async () => {
    db.staffVenue.findMany.mockRejectedValue(new Error('db down'))
    await expect(avisarAprobadoTardio({ ...base, procesador: null })).resolves.toBeUndefined()
  })
})

describe('Codex S1 r1 #4 · «del mismo importe» es el mismo TOTAL (venta + propina)', () => {
  it('lista el cobro de $120 sin propina y no el de $100, para un aprobado de $100 + $20 de propina', async () => {
    const D = (n: number) => new Prisma.Decimal(n)
    db.payment.findFirst.mockResolvedValue({ amount: D(100), tipAmount: D(20), order: { orderNumber: 'ORD-1' }, merchantAccount: null })
    db.payment.findMany.mockResolvedValue([
      { createdAt: new Date(), amount: D(100), tipAmount: D(0), order: { orderNumber: 'ORD-100' } },
      { createdAt: new Date(), amount: D(120), tipAmount: D(0), order: { orderNumber: 'ORD-120' } },
    ])
    await avisarAprobadoTardioDeLaSolicitud({ requestId: 'r', venueId: 'v1', paymentId: 'pay-1', orderId: 'o1', desde: new Date(0) })
    const msg: string = db.notification.create.mock.calls[0][0].data.message
    expect(msg).toContain('ORD-120')
    expect(msg).not.toContain('ORD-100')
    expect(msg).toContain('$120.00')
  })
})

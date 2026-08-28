import { prismaMock } from '@tests/__helpers__/setup'
import { hashOtpCode } from '@/lib/otp'

jest.mock('@/services/whatsapp.service', () => ({ __esModule: true, sendOtpWhatsApp: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendOtpCodeEmail: jest.fn().mockResolvedValue(true) } }))
jest.mock('@/jwt.service', () => ({ __esModule: true, generateCustomerToken: jest.fn(() => 'tok') }))
jest.mock('@/services/public/customerBookingAccess.service', () => ({
  __esModule: true,
  activateCustomerAccount: jest.fn(async () => ({ approvalStatus: 'APPROVED', requestsApproval: false, approvalVersion: 0 })),
}))

import { verifyOtp } from '@/services/public/otpAuth.public.service'

/**
 * 🔴 El cliente que YA existe no puede duplicarse al entrar por codigo.
 *
 * El OTP normaliza el telefono a E.164 (`+525512345678`) y busca al cliente por ese
 * valor exacto. Pero los clientes existentes lo tienen guardado como lo escribio
 * quien los dio de alta: `5512345678`, `55 1234 5678`, `(55) 1234-5678`. Al no
 * encontrarlo, se crea uno NUEVO — y el cliente pierde sus sellos, sus puntos y su
 * historial, mientras el negocio acaba con dos fichas de la misma persona.
 *
 * Medido en la base local el 2026-08-27: 681 de 682 clientes con telefono lo tienen
 * SIN normalizar. Es decir, practicamente todos. Salio al probar el cartel del
 * mostrador, que es justo lo que va a mandar a todos los clientes por este camino.
 */
const VENUE_ID = 'v1'
const NORM = '+525512345678'
const CODE = '123456'

function sembrarReto() {
  prismaMock.otpChallenge.findFirst.mockResolvedValue({
    id: 'ch1',
    venueId: VENUE_ID,
    destination: NORM,
    channel: 'whatsapp',
    codeHash: hashOtpCode(CODE),
    attempts: 0,
    maxAttempts: 5,
    expiresAt: new Date(Date.now() + 300000),
    consumedAt: null,
  } as any)
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.otpChallenge.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.consumer.findMany.mockResolvedValue([])
  prismaMock.consumer.findFirst.mockResolvedValue(null)
  prismaMock.consumer.create.mockResolvedValue({ id: 'cons1', phone: NORM } as any)
  prismaMock.customer.update.mockImplementation(async ({ data }: any) => ({ id: 'existente', active: true, ...data }) as any)
}

describe('verifyOtp — cliente con el telefono guardado sin normalizar', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    sembrarReto()
  })

  it('ENCUENTRA al cliente existente aunque su telefono este guardado sin +52', async () => {
    const VIEJO = { id: 'existente', venueId: VENUE_ID, phone: '5512345678', firstName: 'Juan', active: true, consumerId: null }
    // Por E.164 exacto NO lo encuentra: asi esta hoy la base entera.
    prismaMock.customer.findUnique.mockImplementation(async (args: any) => (args?.where?.id === 'existente' ? (VIEJO as any) : null))
    // Por consumerId tampoco: el cliente viejo nunca paso por el OTP.
    prismaMock.customer.findFirst.mockResolvedValue(null)
    // La UNICA forma de reconocerlo: los ultimos 10 digitos.
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'existente', phone: '5512345678' }] as any)

    const r = await verifyOtp({ venueId: VENUE_ID, channel: 'whatsapp', destination: NORM, code: CODE })

    expect(r.customer.id).toBe('existente')
    // 🔴 Lo que de verdad protege esto: no se creo una segunda ficha.
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
  })

  it('NO confunde a dos personas que comparten los ultimos 10 digitos', async () => {
    // El filtro por 10 digitos es barato pero grueso: un numero de otro pais puede
    // terminar igual. `phonesMatch` es la verificacion canonica que lo descarta —
    // sin ella, un cliente veria la tarjeta de un desconocido.
    prismaMock.customer.findUnique.mockResolvedValue(null)
    prismaMock.customer.findFirst.mockResolvedValue(null)
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'otro-pais', phone: '+15512345678' }] as any)
    prismaMock.customer.create.mockResolvedValue({ id: 'nuevo', active: true, phone: NORM } as any)

    const r = await verifyOtp({ venueId: VENUE_ID, channel: 'whatsapp', destination: NORM, code: CODE })
    expect(r.customer.id).toBe('nuevo')
  })

  it('si de verdad no existe, SI lo crea', async () => {
    prismaMock.customer.findUnique.mockResolvedValue(null)
    prismaMock.customer.findFirst.mockResolvedValue(null)
    prismaMock.$queryRaw.mockResolvedValue([] as any)
    prismaMock.customer.create.mockResolvedValue({ id: 'nuevo', active: true, phone: NORM } as any)

    const r = await verifyOtp({ venueId: VENUE_ID, channel: 'whatsapp', destination: NORM, code: CODE })
    expect(r.customer.id).toBe('nuevo')
    expect(prismaMock.customer.create).toHaveBeenCalled()
  })
})

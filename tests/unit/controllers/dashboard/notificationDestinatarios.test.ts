/**
 * hz:f26b3afc:D1 — `POST /dashboard/notifications` (y `/bulk`) aceptaban el id de CUALQUIER persona de la plataforma: quien
 * tuviera el permiso de avisos en su negocio podía mandarle avisos (y push a su teléfono) al personal de otro negocio. El
 * permiso se revisa en el negocio de la petición; el aviso tiene que ser de ese negocio y para su gente.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { createNotification, sendBulkNotification } from '@/controllers/dashboard/notification.dashboard.controller'
import * as notificationService from '@/services/dashboard/notification.dashboard.service'

jest.mock('@/services/dashboard/notification.dashboard.service', () => ({
  createNotification: jest.fn(async (d: unknown) => ({ id: 'n1', ...(d as object) })),
  sendBulkNotification: jest.fn(async (ids: string[]) => ids.map(id => ({ id: `n-${id}` }))),
}))

const MI_NEGOCIO = 'cminegocio000000000000000'
const OTRO_NEGOCIO = 'cotronegocio0000000000000'
const MIO = 'cempleadomio0000000000000'
const AJENO = 'cempleadoajeno00000000000'

/** `role` = el del token; `resolvedRole` = el vigente que dejó `checkPermission`. */
const req = (body: object, opts: { role?: string; resolvedRole?: string; header?: string } = {}) =>
  ({
    body,
    params: {},
    headers: opts.header ? { 'x-venue-id': opts.header } : {},
    authContext: { userId: 'cdueno0000000000000000000', venueId: MI_NEGOCIO, role: opts.role ?? 'OWNER' },
    resolvedRole: opts.resolvedRole ?? opts.role ?? 'OWNER',
  }) as any

/** `asyncHandler` no devuelve la promesa: se espera a que el controlador conteste (`res.json`) o falle (`next`). */
async function correr(handler: any, r: any) {
  let listo!: () => void
  const termino = new Promise<void>(resolve => (listo = resolve))
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => (listo(), res)) }
  const next = jest.fn((_error?: unknown) => listo())
  handler(r, res, next)
  await termino
  return { res, error: next.mock.calls[0]?.[0] as (Error & { statusCode?: number }) | undefined }
}

const aviso = { type: 'NEW_ORDER', title: 'Hola', message: 'Prueba' }

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'corg00000000000000000000a' } as never)
  // Sólo MIO trabaja en MI_NEGOCIO; en OTRO_NEGOCIO no trabaja nadie de la prueba.
  prismaMock.staff.count.mockImplementation((async (args: any) => {
    const enElNegocio = args.where.OR?.[0]?.venues?.some?.venueId
    return enElNegocio === MI_NEGOCIO ? (args.where.id.in as string[]).filter((id: string) => id === MIO).length : 0
  }) as never)
})

describe('avisos que manda una persona: sólo para la gente de su negocio (D1)', () => {
  it('🔴 a una persona de OTRO negocio: 403 y no se manda nada', async () => {
    const { error } = await correr(createNotification, req({ ...aviso, recipientId: AJENO }))
    expect(error?.statusCode).toBe(403)
    expect(notificationService.createNotification).not.toHaveBeenCalled()
  })

  it('🔴 un aviso con el negocio de OTRO en el cuerpo: 403', async () => {
    const { error } = await correr(createNotification, req({ ...aviso, recipientId: MIO, venueId: OTRO_NEGOCIO }))
    expect(error?.statusCode).toBe(403)
    expect(notificationService.createNotification).not.toHaveBeenCalled()
  })

  it('🔴 en bloque: si UNO es de otro negocio, no sale ninguno', async () => {
    const { error } = await correr(sendBulkNotification, req({ ...aviso, recipientIds: [MIO, AJENO] }))
    expect(error?.statusCode).toBe(403)
    expect(notificationService.sendBulkNotification).not.toHaveBeenCalled()
  })

  it('regresión: a alguien de mi negocio sí sale, también en bloque', async () => {
    expect((await correr(createNotification, req({ ...aviso, recipientId: MIO }))).error).toBeUndefined()
    expect(notificationService.createNotification).toHaveBeenCalledTimes(1)
    expect((await correr(sendBulkNotification, req({ ...aviso, recipientIds: [MIO, MIO], venueId: MI_NEGOCIO }))).error).toBeUndefined()
    expect(notificationService.sendBulkNotification).toHaveBeenCalledTimes(1)
  })

  it('el negocio que cuenta es el de la petición (encabezado), igual que el permiso', async () => {
    const { error } = await correr(createNotification, req({ ...aviso, recipientId: MIO, venueId: OTRO_NEGOCIO }, { header: OTRO_NEGOCIO }))
    // En OTRO_NEGOCIO, MIO no trabaja: se niega aunque el cuerpo coincida con el encabezado.
    expect(error?.statusCode).toBe(403)
  })

  it('un SUPERADMIN manda a quien sea (avisos de la plataforma), aunque su token diga otro rol', async () => {
    const { error } = await correr(createNotification, req({ ...aviso, recipientId: AJENO }, { role: 'ADMIN', resolvedRole: 'SUPERADMIN' }))
    expect(error).toBeUndefined()
    expect(notificationService.createNotification).toHaveBeenCalledTimes(1)
  })

  it('🔴 quien YA NO es SUPERADMIN (token viejo que lo dice) no se salta el candado (Codex r1)', async () => {
    const { error } = await correr(createNotification, req({ ...aviso, recipientId: AJENO }, { role: 'SUPERADMIN', resolvedRole: 'ADMIN' }))
    expect(error?.statusCode).toBe(403)
    expect(notificationService.createNotification).not.toHaveBeenCalled()
  })

  it('compatibilidad: alguien de mi ORGANIZACIÓN (sin fila en esta sucursal) sí recibe', async () => {
    prismaMock.staff.count.mockImplementation((async (args: any) =>
      args.where.OR?.[1]?.organizations?.some?.organizationId === 'corg00000000000000000000a' ? 1 : 0) as never)
    const { error } = await correr(createNotification, req({ ...aviso, recipientId: AJENO }))
    expect(error).toBeUndefined()
  })
})

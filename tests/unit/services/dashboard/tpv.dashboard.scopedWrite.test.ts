/**
 * `updateScopedTerminal` (Task 10, Step 1): lo ÚNICO que escriben los ajustes de una terminal. La prueba entra por los DOS
 * servicios que lo usan (`updateTpvSettings` y `resetTerminalToDefaults`) — no por el controlador de la TPV, que escribe
 * con su propio `tx.terminal.update` y nunca pasa por este helper (Codex r9, N13).
 *
 * Es de CARACTERIZACIÓN: pasa con el helper que recibía un `data` libre y tiene que seguir pasando con el que arma el
 * objeto de Prisma campo por campo (un refactor no cambia lo que se escribe).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { NotFoundError } from '@/errors/AppError'
import { resetTerminalToDefaults, updateTpvSettings } from '@/services/dashboard/tpv.dashboard.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

// `organizationId: null` ⇒ sin defaults de organización (no se consulta nada más). Ya trae una excepción guardada
// (`trackPromoterLocation`) para comprobar que una actualización ajena NO la borra.
const leida = {
  venueId: 'v1',
  config: { settings: { kioskDefaultMerchantId: 'mk' }, otra: 'se conserva' },
  configOverrides: { trackPromoterLocation: true },
  venue: { organizationId: null },
}
const escrito = () => prismaMock.terminal.update.mock.calls[0][0] as { where: unknown; data: Record<string, unknown> }

beforeEach(() => {
  prismaMock.terminal.findUnique.mockResolvedValue(leida as any)
  prismaMock.terminal.update.mockResolvedValue({} as any)
  // S1 de F1: `updateTpvSettings` lee y escribe dentro de una transacción, después del candado de la fila. La transacción
  // corre con el mismo mock y el candado devuelve la fila de la terminal en su negocio.
  prismaMock.$transaction.mockImplementation((cb: any) => cb(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([{ id: 't1', venueId: 'v1' }])
})

it('updateTpvSettings escribe EXACTAMENTE config, configOverrides y updatedAt, con el ámbito con que leyó', async () => {
  await updateTpvSettings('t1', {} as any, { venueId: 'v1' })
  expect(escrito().where).toEqual({ id: 't1', venueId: 'v1' })
  expect(Object.keys(escrito().data).sort()).toEqual(['config', 'configOverrides', 'updatedAt'])
  expect(escrito().data.config).toMatchObject({ otra: 'se conserva' })
  expect(escrito().data.updatedAt).toBeInstanceOf(Date)
})

// Codex r10, N17: sin mirar el VALOR, un helper que escribiera siempre `JsonNull` pasaba las tres pruebas y borraba las
// excepciones de cada terminal en cada guardado.
it('updateTpvSettings conserva la excepción que ya había y guarda la que se pide', async () => {
  await updateTpvSettings('t1', {} as any, { venueId: 'v1' })
  expect(escrito().data.configOverrides).toEqual({ kioskDefaultMerchantId: 'mk', trackPromoterLocation: true })

  prismaMock.terminal.update.mockClear()
  await updateTpvSettings('t1', { trackPromoterLocation: false } as any, { venueId: 'v1' })
  expect(escrito().data.configOverrides).toEqual({ kioskDefaultMerchantId: 'mk', trackPromoterLocation: false })
})

it('resetTerminalToDefaults limpia las excepciones con JsonNull y conserva el resto de config y el comercio del kiosco', async () => {
  await resetTerminalToDefaults('t1', { venueId: 'v1' })
  expect(Object.keys(escrito().data).sort()).toEqual(['config', 'configOverrides', 'updatedAt'])
  expect(escrito().data.configOverrides).toBe(Prisma.JsonNull)
  expect(escrito().data.config).toMatchObject({ otra: 'se conserva', settings: expect.objectContaining({ kioskDefaultMerchantId: 'mk' }) })
})

it('si la terminal se mudó entre la lectura y la escritura (P2025), 404 y no 500', async () => {
  prismaMock.terminal.update.mockRejectedValue(
    new Prisma.PrismaClientKnownRequestError('no existe', { code: 'P2025', clientVersion: 'test' }),
  )
  await expect(updateTpvSettings('t1', {} as any, { venueId: 'v1' })).rejects.toBeInstanceOf(NotFoundError)
  await expect(resetTerminalToDefaults('t1', { venueId: 'v1' })).rejects.toBeInstanceOf(NotFoundError)
})

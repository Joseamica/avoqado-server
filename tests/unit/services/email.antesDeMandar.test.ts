/**
 * `antesDeMandar` de `sendEmailWithResult` (el cupo de Resend, Codex r2 del medidor): la última pregunta antes de llamar a
 * Resend, sin nada asíncrono en medio. Una respuesta del login que cruza el 80 mientras el transporte esperaba al candado
 * demo ya no deja salir la campaña.
 */
import type { ExecutionContext } from '@/observability/executionContext'
import prisma from '@/utils/prismaClient'

const mockSend = jest.fn()
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...a: unknown[]) => mockSend(...a) } })) }))

const db = prisma as unknown as { venue: { findUnique: jest.Mock } }
const REAL = 'creal0000000000000000000b'
const ctx: ExecutionContext = { correlationId: 'c', source: 'http', entrypoint: 'test', venueId: REAL }

let email: any
let runWithContext: <T>(c: ExecutionContext, fn: () => T) => T
let olvidarDemos: () => void

beforeAll(() => {
  process.env.RESEND_API_KEY = 're_test_antes_de_mandar'
  jest.isolateModules(() => {
    email = require('@/services/email.service')
    runWithContext = require('@/observability/executionContext').runWithContext
    olvidarDemos = require('@/services/demo/candadoDemo').__olvidarNegociosDemoParaPruebas
  })
})

beforeEach(() => {
  jest.clearAllMocks()
  olvidarDemos()
  db.venue.findUnique.mockResolvedValue({ status: 'ACTIVE' })
  mockSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null })
})

const correo = { to: 'cliente@gmail.com', subject: 'Hola', html: '<p>hola</p>' }

it('si antesDeMandar devuelve un código, no se llama a Resend y vuelve como fallo transitorio con ese código', async () => {
  await expect(email.default.sendEmailWithResult({ ...correo, antesDeMandar: () => 'cupo_en_pausa' })).resolves.toEqual({
    ok: false,
    transient: true,
    errorCode: 'cupo_en_pausa',
  })
  expect(mockSend).not.toHaveBeenCalled()
})

it('la pausa que llega mientras el transporte espera al candado demo frena el correo (se pregunta DESPUÉS de esa espera)', async () => {
  let pausa = false
  // El candado demo consulta el negocio; mientras tanto, la respuesta de un login cruza el 80.
  db.venue.findUnique.mockImplementation(async () => {
    pausa = true
    return { status: 'ACTIVE' }
  })

  const resultado = await runWithContext(ctx, () =>
    email.default.sendEmailWithResult({ ...correo, antesDeMandar: () => (pausa ? 'cupo_en_pausa' : null) }),
  )

  expect(db.venue.findUnique).toHaveBeenCalled()
  expect(resultado).toMatchObject({ ok: false, errorCode: 'cupo_en_pausa' })
  expect(mockSend).not.toHaveBeenCalled()
})

it('sin antesDeMandar, o si devuelve null, se manda como siempre', async () => {
  await expect(email.default.sendEmailWithResult(correo)).resolves.toMatchObject({ ok: true, resendId: 'msg_1' })
  await expect(email.default.sendEmailWithResult({ ...correo, antesDeMandar: () => null })).resolves.toMatchObject({ ok: true })
  expect(mockSend).toHaveBeenCalledTimes(2)
})

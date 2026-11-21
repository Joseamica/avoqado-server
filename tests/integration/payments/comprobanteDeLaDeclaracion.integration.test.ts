/**
 * F1 · cierre bloque 7 (18-nov, `plan-minimo-v2-tpv.md` §4 y `plan-cierre-familias.md` I4 / §5 puntos 1 y 3) — contra Postgres REAL.
 *
 * El comprobante de una declaración «no se cobró» / «no presentó tarjeta» es el MISMO en el POST de la declaración, en S6 (por
 * intento) y en el GET por solicitud de la terminal: `declarationReceipt`. Cuando el POST devuelve una declaración que YA estaba
 * guardada (respuesta perdida y repetida, o un segundo gerente con el mismo `resolutionId`), el comprobante trae al firmante y la
 * hora REALES del guardado y `alreadyStored: true`: el cliente no puede decirle al segundo gerente «quedó tu firma».
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { resolveNoInstrument } from '@/services/tpv/no-instrument-resolution.service'
import { _olvidarTodoParaPruebas } from '@/services/tpv/avisosNoGuardados'
import type { DeclarationReceipt } from '@/services/tpv/comprobanteDeDeclaracion'
import { crearFixture, exigirBaseDesechable, type Fixture } from './webhookCheckpoint.fixture'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(() => null), getBroadcastingService: jest.fn(() => null), emitDurableTerminalPaymentResult: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(() => undefined), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const PIN_GERENTE_2 = '582614'
let f: Fixture
let gerente2: { staffId: string }

beforeAll(async () => {
  exigirBaseDesechable()
  f = await crearFixture('comprob')
  const staff = await prisma.staff.create({
    data: {
      email: `${f.fixture}-firmante2@example.test`,
      firstName: 'Segunda',
      lastName: 'Gerente',
      organizations: { create: { organizationId: f.fixture, role: 'MEMBER', isPrimary: true, isActive: true } },
      venues: { create: { venueId: f.venueId, role: 'MANAGER', pin: PIN_GERENTE_2, active: true } },
    },
  })
  gerente2 = { staffId: staff.id }
})
afterEach(async () => {
  await _olvidarTodoParaPruebas()
  await prisma.activityLog.deleteMany({ where: { venueId: f.venueId } })
  await prisma.terminalAttemptResolution.deleteMany({ where: { venueId: f.venueId } })
  await f.limpiar()
})
afterAll(async () => {
  await f.destruir()
  await prisma.staff.deleteMany({ where: { id: gerente2.staffId } })
})

const entrega = () => ({
  protocol: 'DURABLE',
  ackVersion: 1,
  cancelDispositionVersion: 1,
  probeVersion: 1,
  socketId: 'socket-viejo',
  at: new Date().toISOString(),
  replay: false,
})

/** Una solicitud del POS entregada (TPV v1), en duda, con su orden y su intento vinculado. */
async function enDuda(over: Record<string, unknown> = {}) {
  const venta = await f.nuevaVenta(100)
  const solicitud = await f.solicitud({
    orderId: venta.id,
    status: 'UNKNOWN',
    failureCode: 'ACK_TIMEOUT',
    acknowledgedAt: new Date(),
    expiresAt: new Date(Date.now() - 60_000),
    deliveryProvenance: { deliveries: [entrega()] },
    ...over,
  })
  const attemptId = randomUUID()
  await prisma.terminalPaymentAttemptLink.create({
    data: { attemptId, requestId: solicitud.requestId, venueId: f.venueId, terminalId: f.llaveTerminal },
  })
  return { requestId: solicitud.requestId, attemptId }
}

const s6 = (attemptId: string) =>
  terminalPaymentService.consultarIntentoDeTerminal({ attemptId, venueId: f.venueId, terminalSerial: f.serial })
const porSolicitud = (requestId: string) =>
  terminalPaymentService.consultarSolicitudDeTerminal({ requestId, venueId: f.venueId, terminalSerial: f.serial })

/** De dos firmas concurrentes con el mismo `resolutionId`: exactamente una guardó; la otra recibe la guardada. Devuelve la primera. */
function soloUnaGuardo(crudos: (DeclarationReceipt | null | undefined)[]): DeclarationReceipt {
  for (const r of crudos) expect(r).toBeTruthy()
  const recibos = crudos as DeclarationReceipt[]
  expect(recibos.map(r => r.alreadyStored).sort()).toEqual([false, true])
  const primera = recibos.find(r => !r.alreadyStored)!
  expect([f.gerente.staffId, gerente2.staffId]).toContain(primera.staffId)
  for (const r of recibos) expect(r).toMatchObject({ staffId: primera.staffId, acceptedAt: primera.acceptedAt })
  return primera
}

describe('dos_gerentes_mismo_id_se_muestra_el_acuse_del_primero', () => {
  it('por INTENTO (TPV SOLA): dos gerentes a la vez y la respuesta perdida y repetida reciben el acuse del primero', async () => {
    const attemptId = randomUUID()
    const cuerpo = { resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 }
    const firmar = (pin: string) =>
      resolveNoInstrument(
        { venueId: f.venueId, terminalSerial: f.serial, attemptId, actorStaffId: f.staffId },
        { ...cuerpo, supervisorPin: pin },
      )

    const [a, b] = await Promise.all([firmar(f.gerente.pin), firmar(PIN_GERENTE_2)])
    const primera = soloUnaGuardo([a.declarationReceipt, b.declarationReceipt])
    expect(primera).toEqual({
      id: cuerpo.resolutionId,
      kind: 'NO_INSTRUMENT_PRESENTED',
      by: 'SUPERVISOR_PIN',
      staffId: primera.staffId,
      acceptedAt: primera.acceptedAt,
      scope: 'ATTEMPT',
      attemptId,
      requestId: null,
      humanSignature: true,
      alreadyStored: false,
    })

    // Se perdió la respuesta del segundo gerente y la repite: sigue siendo la firma del primero, ya guardada.
    const repetida = await firmar(PIN_GERENTE_2)
    expect(repetida.declarationReceipt).toEqual({ ...primera, alreadyStored: true })
    // S6 publica el MISMO comprobante.
    expect((await s6(attemptId))!.declarationReceipt).toEqual({ ...primera, alreadyStored: true })
    expect(await prisma.activityLog.count({ where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED' } })).toBe(1)
  })

  it('por SOLICITUD (POS → TPV): el POST, el GET por solicitud y S6 dicen lo mismo, y el texto ya no dice «El cajero»', async () => {
    const { requestId, attemptId } = await enDuda()
    const cuerpo = { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 }
    const firmar = (pin: string) =>
      terminalPaymentService.releaseUnknownRequest({
        requestId,
        venueId: f.venueId,
        actor: { staffId: f.staffId, source: 'TPV' },
        reason: 'Liberada desde la terminal',
        declaration: { ...cuerpo, supervisorPin: pin },
      })

    const [a, b] = await Promise.all([firmar(f.gerente.pin), firmar(PIN_GERENTE_2)])
    expect([a.released, b.released]).toEqual([true, true])
    const primera = soloUnaGuardo([a.declarationReceipt, b.declarationReceipt])
    expect(primera).toEqual({
      id: cuerpo.resolutionId,
      kind: 'UNCHARGED_VERIFIED',
      by: 'SUPERVISOR_PIN',
      staffId: primera.staffId,
      acceptedAt: primera.acceptedAt,
      scope: 'REQUEST',
      attemptId: null,
      requestId,
      humanSignature: true,
      alreadyStored: false,
    })

    const repetida = await firmar(f.gerente.pin)
    expect(repetida.declarationReceipt).toEqual({ ...primera, alreadyStored: true })
    expect((await porSolicitud(requestId))!.declarationReceipt).toEqual({ ...primera, alreadyStored: true })
    expect((await s6(attemptId))!.declarationReceipt).toEqual({ ...primera, alreadyStored: true })
    expect(
      await prisma.activityLog.count({ where: { venueId: f.venueId, action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED' } }),
    ).toBe(1)

    // El texto persistido es cierto para las dos épocas: ya no afirma que firmó «el cajero», y dice quién, si consta.
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId } })
    const texto = (fila.resultJson as { errorMessage: string }).errorMessage
    expect(texto).not.toMatch(/cajero/i)
    expect(texto).toMatch(/ revisó y lo marcó como no cobrado\. Ya puedes cobrar esta cuenta\.$/)
    expect(texto).toContain(primera.staffId === gerente2.staffId ? 'Segunda Gerente' : 'Gerente Webhook')
  })
})

describe('el comprobante dice lo que consta, no lo que el cliente quisiera leer', () => {
  it('GET por solicitud: «no presentó tarjeta» vinculado sale con su intento y su autor', async () => {
    const { requestId, attemptId } = await enDuda()
    await resolveNoInstrument(
      { venueId: f.venueId, terminalSerial: f.serial, attemptId, actorStaffId: f.staffId },
      { requestId, resolutionId: randomUUID(), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1, supervisorPin: f.gerente.pin },
    )
    expect((await porSolicitud(requestId))!.declarationReceipt).toMatchObject({
      kind: 'NO_INSTRUMENT_PRESENTED',
      by: 'SUPERVISOR_PIN',
      staffId: f.gerente.staffId,
      scope: 'ATTEMPT',
      attemptId,
      requestId,
      humanSignature: true,
      alreadyStored: true,
    })
  })

  it('un SESSION histórico (antes de F1) sale tal cual con su autor; el rechazo del banco no es una firma humana; sin declaración, null', async () => {
    // Ranura ya suelta: el índice de la ranura admite UNA en vuelo por terminal, y aquí hay tres solicitudes.
    const suelta = { status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' }
    const historica = await enDuda(suelta)
    const acceptedAt = new Date('2026-10-01T15:00:00.000Z').toISOString()
    await prisma.terminalPaymentAttemptLink.update({
      where: { attemptId: historica.attemptId },
      data: {
        operatorResolution: {
          id: randomUUID(),
          kind: 'NO_INSTRUMENT_PRESENTED',
          acceptedAt,
          bodyHash: 'h',
          staffId: f.staffId,
          staffVenueId: 'sv',
          by: 'SESSION',
          statementVersion: 1,
        },
      },
    })
    expect((await s6(historica.attemptId))!.declarationReceipt).toMatchObject({
      by: 'SESSION',
      staffId: f.staffId,
      acceptedAt,
      humanSignature: true,
    })

    const delBanco = await enDuda(suelta)
    await prisma.terminalPaymentRequest.update({
      where: { requestId: delBanco.requestId },
      data: {
        operatorReconciliation: {
          id: randomUUID(),
          kind: 'BANK_DECLINED',
          acceptedAt,
          bodyHash: 'h',
          staffId: null,
          staffVenueId: null,
          statementVersion: 1,
          source: 'WEBHOOK',
        },
      },
    })
    expect((await porSolicitud(delBanco.requestId))!.declarationReceipt).toMatchObject({
      kind: 'BANK_DECLINED',
      by: null,
      staffId: null,
      scope: 'REQUEST',
      humanSignature: false,
    })

    const limpia = await enDuda(suelta)
    expect((await porSolicitud(limpia.requestId))!.declarationReceipt).toBeNull()
    expect((await s6(limpia.attemptId))!.declarationReceipt).toBeNull()
  })
})

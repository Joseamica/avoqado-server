/**
 * D22 · A1 (founder, 17-nov): «Ya revisé la terminal: no se cobró» de un **Pago rápido** llega al servidor.
 *
 * Es la tercera clase de la ruta de la terminal (`UNCHARGED_VERIFIED`), sólo en el camino LOCAL (sin solicitud del POS). Lo
 * que fijan estas pruebas: pide `payments:reconcile-uncharged`, no el de «no presentó tarjeta», y 🔴 desde F1 (17-nov) lo firma
 * SIEMPRE el PIN de un gerente de este local (la sesión del cajero ya no basta); trae el monto
 * según la terminal y sin él se rechaza; queda en `TerminalAttemptResolution` y en la bitácora con la acción que el
 * DASHBOARD ya traduce («Cajero declaró «no se cobró»»); el reintento con el mismo cuerpo responde igual sin escribir; con
 * dinero no se declara; y las dos clases de hoy no cambian (ni su `bodyHash`).
 *
 * Mock: el `prismaMock` global; la transacción corre el callback con el propio mock y `$queryRaw` contesta `[]` (sin
 * dinero ni evidencia que vete) salvo que la prueba diga otra cosa.
 */
import { createHash } from 'crypto'
import prisma from '@/utils/prismaClient'
import {
  CHECKED_UNCHARGED_PERMISSION,
  NoInstrumentResolutionError,
  readOperatorResolution,
  resolveNoInstrument,
} from '@/services/tpv/no-instrument-resolution.service'

const prismaMock = prisma as any

const venueId = 'v1'
const terminalSerial = 'AVQD-2841548417'
const terminalId = '2841548417'
const attemptId = 'att-local-1'
const resolutionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const identidad = (actorStaffId: string | null = 'staff-cashier') => ({ venueId, terminalSerial, attemptId, actorStaffId })
/** 🔴 F1: con el PIN del gerente por default; `supervisorPin: undefined` lo quita. */
const PIN_GERENTE = '2222'
const revisada = (over: Record<string, unknown> = {}) => ({
  resolutionId,
  statement: 'UNCHARGED_VERIFIED',
  statementVersion: 1,
  amountCents: 1000,
  tipCents: 150,
  supervisorPin: PIN_GERENTE,
  ...over,
})
const sinPin = { supervisorPin: undefined }

type Miembro = { id: string; staffId: string; role: string; pin?: string }
const CASHIER: Miembro = { id: 'sv-cashier', staffId: 'staff-cashier', role: 'CASHIER', pin: '3333' }
const WAITER: Miembro = { id: 'sv-waiter', staffId: 'staff-waiter', role: 'WAITER', pin: '4444' }
const MANAGER: Miembro = { id: 'sv-manager', staffId: 'staff-manager', role: 'MANAGER', pin: '2222' }

let declaraciones: Map<string, any>

function armar() {
  declaraciones = new Map()
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) => {
    if (where.venueId !== venueId || where.active !== true || where.staff?.active !== true) return null
    const m = [CASHIER, WAITER, MANAGER].find(x => (where.pin !== undefined ? x.pin === where.pin : x.staffId === where.staffId))
    return m ? { id: m.id, staffId: m.staffId, role: m.role, permissionSetId: null, permissionSet: null } : null
  })
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  // Pago rápido: sin vínculo con una solicitud del POS.
  prismaMock.terminalPaymentAttemptLink.findUnique.mockResolvedValue(null)
  prismaMock.terminalPaymentAttemptLink.findFirst?.mockResolvedValue?.(null)
  prismaMock.terminalAttemptResolution.findUnique.mockImplementation(async ({ where }: any) => declaraciones.get(where.attemptId) ?? null)
  prismaMock.terminalAttemptResolution.findFirst.mockImplementation(async ({ where }: any) => {
    const d = declaraciones.get(where.attemptId)
    return d && d.venueId === where.venueId && d.terminalId === where.terminalId ? d : null
  })
  prismaMock.terminalAttemptResolution.create.mockImplementation(async ({ data }: any) => {
    declaraciones.set(data.attemptId, { ...data, createdAt: new Date() })
    return data
  })
  prismaMock.payment.findFirst.mockResolvedValue(null)
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  prismaMock.$queryRaw.mockResolvedValue([])
}

const rechaza = async (promesa: Promise<unknown>, code: string, statusCode = 409) => {
  await expect(promesa).rejects.toBeInstanceOf(NoInstrumentResolutionError)
  await expect(promesa).rejects.toMatchObject({ code, statusCode })
}
const nadaEscrito = () => {
  expect(prismaMock.terminalAttemptResolution.create).not.toHaveBeenCalled()
  expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
}

beforeEach(() => {
  jest.clearAllMocks()
  armar()
})

describe('D22 · «Ya revisé la terminal: no se cobró» de un Pago rápido llega a Avoqado', () => {
  it('🔴 F1: en la terminal del CAJERO firma el GERENTE con su PIN: testimonio con monto + bitácora que el DASHBOARD ya traduce', async () => {
    expect(CHECKED_UNCHARGED_PERMISSION).toBe('payments:reconcile-uncharged')
    const r = await resolveNoInstrument(identidad(), revisada())
    expect(r.resolution).toMatchObject({ id: resolutionId, by: 'SUPERVISOR_PIN' })

    const guardada = declaraciones.get(attemptId)
    expect(guardada).toMatchObject({ attemptId, venueId, terminalId })
    expect(guardada.resolution).toMatchObject({
      id: resolutionId,
      kind: 'UNCHARGED_VERIFIED',
      staffId: 'staff-manager',
      staffVenueId: 'sv-manager',
      by: 'SUPERVISOR_PIN',
      statementVersion: 1,
      amountCents: 1000,
      tipCents: 150,
    })
    // Un Pago rápido no tiene solicitud: no se le inventa un estado previo.
    expect(guardada.resolution.previousRequest).toBeUndefined()

    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: {
        action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED',
        entity: 'TerminalAttemptResolution',
        entityId: attemptId,
        venueId,
        staffId: 'staff-manager',
        data: {
          attemptId,
          terminalId,
          by: 'SUPERVISOR_PIN',
          sinSolicitud: true,
          sessionStaffId: 'staff-cashier',
          resolutionId,
          amountPesos: 10,
          tipPesos: 1.5,
        },
      },
    })
    // La consulta S6 publica la declaración: es lo que deja recuperar a una terminal que murió tras mandarla.
    expect(r.attempt?.resolution).toMatchObject({ kind: 'UNCHARGED_VERIFIED', id: resolutionId })
    // El PIN no se guarda ni se audita.
    expect(JSON.stringify([...declaraciones.values()])).not.toContain(PIN_GERENTE)
    expect(JSON.stringify(prismaMock.activityLog.create.mock.calls)).not.toContain(PIN_GERENTE)
  })

  it('🔴 F1: sin PIN no se declara — ni el cajero, ni el gerente con su propia sesión → 403, nada escrito', async () => {
    await rechaza(resolveNoInstrument(identidad(), revisada(sinPin)), 'SUPERVISOR_AUTHORIZATION_REQUIRED', 403)
    await rechaza(resolveNoInstrument(identidad('staff-manager'), revisada(sinPin)), 'SUPERVISOR_AUTHORIZATION_REQUIRED', 403)
    nadaEscrito()
  })

  it('reintento con el MISMO cuerpo responde igual sin segunda escritura; otro monto es RESOLUTION_CONFLICT', async () => {
    await resolveNoInstrument(identidad(), revisada())
    const otra = await resolveNoInstrument(identidad(), revisada())
    expect(otra.resolution).toMatchObject({ id: resolutionId, by: 'SUPERVISOR_PIN' })
    expect(prismaMock.terminalAttemptResolution.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(readOperatorResolution(declaraciones.get(attemptId).resolution)).not.toBeNull()
    await rechaza(resolveNoInstrument(identidad(), revisada({ amountCents: 2000 })), 'RESOLUTION_CONFLICT')
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
  })

  it('🔴 F1: el MESERO sin PIN → 403, y el PIN de un CAJERO ya no firma; el del gerente sí', async () => {
    await rechaza(resolveNoInstrument(identidad('staff-waiter'), revisada(sinPin)), 'SUPERVISOR_AUTHORIZATION_REQUIRED', 403)
    await rechaza(
      resolveNoInstrument(identidad('staff-waiter'), revisada({ supervisorPin: CASHIER.pin })),
      'SUPERVISOR_AUTHORIZATION_REQUIRED',
      403,
    )
    nadaEscrito()
    const r = await resolveNoInstrument(identidad('staff-waiter'), revisada())
    expect(r.resolution).toMatchObject({ by: 'SUPERVISOR_PIN' })
    expect(declaraciones.get(attemptId).resolution).toMatchObject({ staffId: 'staff-manager', by: 'SUPERVISOR_PIN' })
  })

  it('una sesión que ya no es del negocio → 403 SESSION_NOT_IN_VENUE, nada escrito', async () => {
    await rechaza(resolveNoInstrument(identidad('staff-de-otro'), revisada()), 'SESSION_NOT_IN_VENUE', 403)
    await rechaza(resolveNoInstrument(identidad(null), revisada()), 'SESSION_NOT_IN_VENUE', 403)
    nadaEscrito()
  })

  it('el permiso de la declaración NO se mezcla: el cajero sigue sin poder declarar «no presentó tarjeta»', async () => {
    await rechaza(
      resolveNoInstrument(identidad(), {
        resolutionId,
        statement: 'NO_INSTRUMENT_PRESENTED',
        statementVersion: 1,
        supervisorPin: CASHIER.pin,
      }),
      'SUPERVISOR_AUTHORIZATION_REQUIRED',
      403,
    )
    nadaEscrito()
  })

  it('el monto es obligatorio con la clase nueva y prohibido con las otras dos (cuerpo inválido = 409, nada escrito)', async () => {
    await rechaza(resolveNoInstrument(identidad(), revisada({ amountCents: undefined })), 'ATTEMPT_NOT_ELIGIBLE')
    await rechaza(resolveNoInstrument(identidad(), revisada({ tipCents: undefined })), 'ATTEMPT_NOT_ELIGIBLE')
    await rechaza(resolveNoInstrument(identidad(), revisada({ amountCents: -1 })), 'ATTEMPT_NOT_ELIGIBLE')
    await rechaza(resolveNoInstrument(identidad(), revisada({ amountCents: 10.5 })), 'ATTEMPT_NOT_ELIGIBLE')
    await rechaza(
      resolveNoInstrument(identidad('staff-manager'), {
        resolutionId,
        statement: 'NO_INSTRUMENT_PRESENTED',
        statementVersion: 1,
        amountCents: 1000,
        tipCents: 0,
      }),
      'ATTEMPT_NOT_ELIGIBLE',
    )
    nadaEscrito()
  })

  it('un cobro del POS (con solicitud en el cuerpo o con vínculo) → 409 ATTEMPT_NOT_ELIGIBLE: tiene su propia ruta', async () => {
    await rechaza(resolveNoInstrument(identidad(), revisada({ requestId: 'req-1' })), 'ATTEMPT_NOT_ELIGIBLE')
    prismaMock.terminalPaymentAttemptLink.findUnique.mockResolvedValue({
      id: 'link-1',
      attemptId,
      requestId: 'req-1',
      venueId,
      terminalId,
      operatorResolution: null,
    })
    await rechaza(resolveNoInstrument(identidad(), revisada()), 'ATTEMPT_NOT_ELIGIBLE')
    nadaEscrito()
  })

  it('con dinero con la llave del intento → 409 POSITIVE_EVIDENCE_EXISTS, nada escrito', async () => {
    prismaMock.$queryRaw.mockImplementation(async (tpl: any) => {
      const sql = Array.isArray(tpl) ? tpl.join('?') : String(tpl?.sql ?? tpl)
      return sql.includes('"hay"') ? [{ hay: true }] : []
    })
    await rechaza(resolveNoInstrument(identidad(), revisada()), 'POSITIVE_EVIDENCE_EXISTS')
    nadaEscrito()
  })

  it('las dos clases de hoy no cambian su cuerpo: el bodyHash de «no presentó tarjeta» es el de siempre (el PIN no entra)', async () => {
    const cuerpo = { resolutionId, statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 }
    await resolveNoInstrument(identidad('staff-manager'), { ...cuerpo, supervisorPin: PIN_GERENTE })
    const guardada = declaraciones.get(attemptId).resolution
    expect(guardada.kind).toBe('NO_INSTRUMENT_PRESENTED')
    expect(guardada.amountCents).toBeUndefined()
    expect(guardada.bodyHash).toBe(createHash('sha256').update(JSON.stringify(cuerpo)).digest('hex'))
    expect(prismaMock.activityLog.create.mock.calls[0][0].data.action).toBe('TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED')
  })
})

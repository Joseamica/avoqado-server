/**
 * La declaración del cajero «no se presentó tarjeta» (plan 16-sep, Task 4): UN paso en la terminal cierra la fila como
 * `FAILED/OPERATOR_RECONCILED_NO_CHARGE`, sin reinicio y sin PIN cuando la SESIÓN de la terminal (el PIN con el que entró
 * el cajero: `authContext.userId`) ya tiene el permiso efectivo `payments:resolve-no-instrument`; el PIN de otra persona
 * sólo ELEVA a un miembro válido del venue que no lo tiene.
 *
 * Mockeo con el `prismaMock` global de `tests/__helpers__/setup.ts` (como `terminal-payment.service.test.ts`): la
 * transacción corre el callback con el propio mock; `$queryRaw` sirve al candado del intento, a los FOR UPDATE y a la
 * consulta de evidencia que veta (`[]` = sin veto, `[{ id }]` = veto); `$executeRaw` es el CAS de la declaración (Codex r1,
 * P1-C d: un UPDATE crudo con los `NOT EXISTS` de evidencia positiva — el mock aplica la escritura a la fila y devuelve 1,
 * o 0 si la fila ya no es la leída).
 *
 * 1. NEW FEATURE TESTS — autorización (sesión / elevación / negación / conjunto), identidad (404), replay, evidencia, elegibilidad
 * 2. REGRESSION TESTS — la identidad nunca sale del cuerpo; la fila acreditada o retenida no se pisa
 */
import prisma from '@/utils/prismaClient'
import { NO_INSTRUMENT_PERMISSION, NoInstrumentResolutionError, resolveNoInstrument } from '@/services/tpv/no-instrument-resolution.service'

const prismaMock = prisma as any

const venueId = 'v1'
const terminalSerial = 'AVQD-N860W173397'
const terminalId = 'n860w173397'
const attemptId = 'att-1'
const requestId = 'req-1'
const resolutionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const identidad = { venueId, terminalSerial, attemptId, actorStaffId: 'staff-owner' }
const declaracion = () => ({ requestId, resolutionId, statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 })

/** La fila que la ventana de confirmación todavía no decidió: negativo de la terminal SIN evidencia (Task 2). */
function filaTimedOutSinEvidencia(over: Record<string, unknown> = {}) {
  const ahora = new Date()
  return {
    id: 'row-1',
    requestId,
    venueId,
    terminalId,
    orderId: 'order-1',
    amountCents: 10000,
    tipCents: 0,
    status: 'TIMED_OUT',
    failureCode: null,
    cancelDisposition: null,
    paymentId: null,
    closedVia: null,
    senderDevice: null,
    lateResult: false,
    resultJson: {
      requestId,
      status: 'timeout',
      terminalResult: { status: 'failed', errorMessage: 'User cancelled\n\nSDK U100', outcomeEvidence: null },
    },
    createdAt: ahora,
    updatedAt: ahora,
    ...over,
  }
}
function linkDeEstaTerminal(over: Record<string, unknown> = {}) {
  return { id: 'link-1', attemptId, requestId, venueId, terminalId, createdAt: new Date(), operatorResolution: null, ...over }
}

/** Miembros del venue: por `staffId` (la sesión) o por `pin` (la elevación). Todo lo demás: no es miembro. */
type Miembro = { id: string; staffId: string; role: string; pin?: string; permissionSetId?: string | null; permissionSet?: unknown }
const OWNER: Miembro = { id: 'sv-owner', staffId: 'staff-owner', role: 'OWNER', pin: '1234' }
const MANAGER: Miembro = { id: 'sv-manager', staffId: 'staff-manager', role: 'MANAGER', pin: '2222' }
const CASHIER: Miembro = { id: 'sv-cashier', staffId: 'staff-cashier', role: 'CASHIER', pin: '3333' }

function conMiembros(miembros: Miembro[]) {
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) => {
    if (where.venueId !== venueId || where.active !== true || where.staff?.active !== true) return null
    const m = miembros.find(x => (where.pin !== undefined ? x.pin === where.pin : x.staffId === where.staffId))
    if (!m) return null
    return {
      id: m.id,
      staffId: m.staffId,
      role: m.role,
      permissionSetId: m.permissionSetId ?? null,
      permissionSet: m.permissionSet ?? null,
    }
  })
}

let fila: ReturnType<typeof filaTimedOutSinEvidencia>
let link: ReturnType<typeof linkDeEstaTerminal>

/** El camino feliz: sesión OWNER, fila de la ventana, un solo intento, sin Payment, sin evidencia que vete. */
function armar(filaOver: Record<string, unknown> = {}, linkOver: Record<string, unknown> = {}) {
  fila = filaTimedOutSinEvidencia(filaOver)
  link = linkDeEstaTerminal(linkOver)
  prismaMock.terminalPaymentRequest.findFirst.mockImplementation(async ({ where }: any) =>
    where.requestId === fila.requestId &&
    where.venueId === fila.venueId &&
    (where.terminalId === undefined || where.terminalId === fila.terminalId)
      ? fila
      : null,
  )
  // El CAS de la declaración es un `$executeRaw` (UPDATE condicional + NOT EXISTS): el mock aplica a `fila` lo que el SQL escribe
  // si la fila sigue siendo la leída (id, status, sin Payment); si no, 0 filas.
  prismaMock.$executeRaw.mockImplementation(async (tpl: any, ...values: unknown[]) => {
    const sql = sqlDe([tpl])
    if (!sql.includes('UPDATE "TerminalPaymentRequest"')) return 0
    const json = values.find(v => typeof v === 'string' && v.includes('"operatorResolution"')) as string | undefined
    if (!json || !values.includes(fila.id) || !values.includes(fila.status) || fila.paymentId !== null) return 0
    Object.assign(fila, {
      status: 'FAILED',
      failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
      cancelDisposition: null,
      resultJson: JSON.parse(json),
    })
    return 1
  })
  prismaMock.terminalPaymentAttemptLink.findUnique.mockImplementation(async ({ where }: any) =>
    where.attemptId === link.attemptId ? link : null,
  )
  prismaMock.terminalPaymentAttemptLink.count.mockResolvedValue(1)
  prismaMock.terminalPaymentAttemptLink.update.mockImplementation(async ({ data }: any) => Object.assign(link, data))
  prismaMock.order.findFirst.mockImplementation(async ({ where }: any) =>
    where.id === fila.orderId && where.venueId === venueId ? { id: where.id } : null,
  )
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.payment.findFirst.mockResolvedValue(null)
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  // `$queryRaw` contesta por el TEXTO de la sentencia: el candado del intento, los FOR UPDATE y la consulta de evidencia que veta.
  // El candado de la orden es VENUE-scoped y devuelve la fila bloqueada (o nada, si la orden no es del venue).
  prismaMock.$queryRaw.mockImplementation(async (tpl: any) => {
    const sql = Array.isArray(tpl) ? tpl.join('?') : String(tpl)
    if (sql.includes('"Order"') && sql.includes('FOR UPDATE')) return fila.orderId ? [{ id: fila.orderId }] : []
    return []
  })
  conMiembros([OWNER, MANAGER, CASHIER])
}
const sqlDe = (call: any[]) => (Array.isArray(call[0]) ? call[0].join('?') : String(call[0]))

/** Volver a armar A MEDIA prueba: limpia también los contadores, o `nadaEscrito()` vería las llamadas de la mitad anterior. */
const rearmar = (filaOver: Record<string, unknown> = {}, linkOver: Record<string, unknown> = {}) => {
  jest.clearAllMocks()
  armar(filaOver, linkOver)
}

const rechaza = async (promesa: Promise<unknown>, code: string, statusCode = 409) => {
  await expect(promesa).rejects.toBeInstanceOf(NoInstrumentResolutionError)
  await expect(promesa).rejects.toMatchObject({ code, statusCode })
}

const nadaEscrito = () => {
  expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
  expect(prismaMock.terminalPaymentRequest.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.terminalPaymentAttemptLink.update).not.toHaveBeenCalled()
  expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
}
/** El CAS escrito: SQL exterior, el fragmento anidado de los NOT EXISTS y el sobre que viaja como jsonb. */
const casEscrito = () => {
  const llamadas = prismaMock.$executeRaw.mock.calls.filter((c: any[]) => sqlDe(c).includes('UPDATE "TerminalPaymentRequest"'))
  expect(llamadas).toHaveLength(1)
  const [tpl, ...values] = llamadas[0]
  // El fragmento anidado viaja como `Prisma.Sql` (objeto con `sql` y `values`); se reconoce por forma (el cliente está mockeado).
  const anidado = values.find((v: unknown) => !!v && typeof v === 'object' && typeof (v as { sql?: unknown }).sql === 'string') as
    | { sql: string }
    | undefined
  const json = values.find((v: unknown) => typeof v === 'string' && (v as string).includes('"operatorResolution"')) as string
  return { sql: sqlDe([tpl]), anidado: anidado?.sql ?? '', values, sobre: JSON.parse(json) }
}

beforeEach(() => {
  jest.clearAllMocks()
  armar()
})

describe('resolveNoInstrument — la declaración del cajero cierra el intento como OPERATOR_RECONCILED_NO_CHARGE', () => {
  it('1. la sesión con permiso efectivo declara sin PIN y la fila queda acreditada por OPERADOR', async () => {
    const r = await resolveNoInstrument(identidad, declaracion())
    expect(r.resolution).toMatchObject({ id: resolutionId, by: 'SESSION' })
    expect(typeof r.resolution.acceptedAt).toBe('string')
    // El CAS es UN UPDATE crudo condicional (Codex r1, P1-C d): estado LEÍDO, sin Payment, y los dos NOT EXISTS de evidencia positiva.
    const cas = casEscrito()
    expect(cas.sql).toMatch(/SET "status" = 'FAILED', "failureCode" = 'OPERATOR_RECONCILED_NO_CHARGE', "cancelDisposition" = NULL/)
    expect(cas.sql).toMatch(/"resultJson" = \?::jsonb, "updatedAt" = \(NOW\(\) AT TIME ZONE 'UTC'\)/)
    expect(cas.sql).toMatch(/WHERE "id" = \? AND "status" = \?::"TerminalPaymentRequestStatus" AND "paymentId" IS NULL/)
    expect(cas.values).toEqual(expect.arrayContaining(['row-1', 'TIMED_OUT']))
    expect(cas.anidado.match(/NOT EXISTS/g)).toHaveLength(2)
    expect(cas.anidado).toMatch(/"ProviderEventLog"[\s\S]*"TerminalPaymentAttemptLink"[\s\S]*= 'APROBADO'/)
    expect(cas.anidado).toMatch(
      /"Payment"[\s\S]*"terminalPaymentRequestId" = \?[\s\S]*->>'terminalPaymentRequestId' = \?[\s\S]*"idempotencyKey" IN/,
    )
    expect(cas.sobre).toMatchObject({ status: 'failed', outcomeEvidence: 'OPERATOR_RECONCILED' })
    // El sobre ORIGINAL de la terminal no se pierde: se conserva dentro del resultJson nuevo.
    const escrito = cas.sobre
    expect(escrito.terminalResult.errorMessage).toContain('SDK U100')
    expect(escrito.operatorResolution).toMatchObject({
      id: resolutionId,
      kind: 'NO_INSTRUMENT_PRESENTED',
      staffId: 'staff-owner',
      by: 'SESSION',
    })
    // La declaración se guarda UNA vez en el vínculo, con quién la hizo y qué había antes.
    expect(prismaMock.terminalPaymentAttemptLink.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { attemptId },
        data: {
          operatorResolution: expect.objectContaining({
            id: resolutionId,
            kind: 'NO_INSTRUMENT_PRESENTED',
            staffId: 'staff-owner',
            staffVenueId: 'sv-owner',
            by: 'SESSION',
            statementVersion: 1,
            previousRequest: { status: 'TIMED_OUT', failureCode: null },
          }),
        },
      }),
    )
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED',
          entity: 'TerminalPaymentRequest',
          entityId: 'row-1',
          venueId,
          staffId: 'staff-owner',
          data: expect.objectContaining({ requestId, attemptId, terminalId, by: 'SESSION', sessionStaffId: 'staff-owner', resolutionId }),
        }),
      }),
    )
    // La respuesta es la MISMA proyección de S6 (nada se quita) más la resolución: el POS lee NOT_CHARGED / OPERATOR.
    expect(r).toMatchObject({
      attemptId,
      requestId,
      attempt: expect.objectContaining({ outcome: 'NOT_RECORDED', paymentId: null }),
      request: expect.objectContaining({
        requestId,
        status: 'FAILED',
        failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
        outcome: 'NOT_CHARGED',
        outcomeEvidence: 'OPERATOR_RECONCILED',
        evidenceClass: 'OPERATOR',
      }),
    })
    // Nadie buscó un PIN: la sesión bastó.
    expect(prismaMock.staffVenue.findFirst.mock.calls.some(([a]: any[]) => a.where.pin !== undefined)).toBe(false)
  })

  it('2. otra persona con permiso (MANAGER) también declara sin PIN: el permiso decide, no el rol OWNER', async () => {
    const r = await resolveNoInstrument({ ...identidad, actorStaffId: 'staff-manager' }, declaracion())
    expect(r.resolution).toMatchObject({ by: 'SESSION' })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ staffId: 'staff-manager', data: expect.objectContaining({ by: 'SESSION' }) }),
      }),
    )
    expect(NO_INSTRUMENT_PERMISSION).toBe('payments:resolve-no-instrument')
  })

  it('3. sesión SIN permiso (CASHIER) y sin supervisorPin → 403 SUPERVISOR_AUTHORIZATION_REQUIRED, nada escrito', async () => {
    await rechaza(
      resolveNoInstrument({ ...identidad, actorStaffId: 'staff-cashier' }, declaracion()),
      'SUPERVISOR_AUTHORIZATION_REQUIRED',
      403,
    )
    nadaEscrito()
  })

  it('4. sesión SIN permiso + PIN de alguien CON permiso → declara por SUPERVISOR_PIN con el staffId del PIN; la bitácora lleva a los dos', async () => {
    const r = await resolveNoInstrument({ ...identidad, actorStaffId: 'staff-cashier' }, { ...declaracion(), supervisorPin: '1234' })
    expect(r.resolution).toMatchObject({ by: 'SUPERVISOR_PIN' })
    expect(prismaMock.terminalPaymentAttemptLink.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { operatorResolution: expect.objectContaining({ staffId: 'staff-owner', staffVenueId: 'sv-owner', by: 'SUPERVISOR_PIN' }) },
      }),
    )
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          staffId: 'staff-owner',
          data: expect.objectContaining({ by: 'SUPERVISOR_PIN', sessionStaffId: 'staff-cashier' }),
        }),
      }),
    )
    // El PIN no se guarda ni se serializa en ningún lado.
    expect(JSON.stringify(prismaMock.terminalPaymentAttemptLink.update.mock.calls)).not.toContain('1234')
    expect(JSON.stringify(prismaMock.activityLog.create.mock.calls)).not.toContain('1234')
    expect(JSON.stringify(prismaMock.$executeRaw.mock.calls)).not.toContain('1234')
  })

  it('4b. un PIN que no es de nadie, o de alguien SIN permiso, no eleva → 403 y nada escrito', async () => {
    await rechaza(
      resolveNoInstrument({ ...identidad, actorStaffId: 'staff-cashier' }, { ...declaracion(), supervisorPin: '9999' }),
      'SUPERVISOR_AUTHORIZATION_REQUIRED',
      403,
    )
    // El PIN de OTRO cajero tampoco: quien eleva tiene que tener el permiso.
    await rechaza(
      resolveNoInstrument({ ...identidad, actorStaffId: 'staff-cashier' }, { ...declaracion(), supervisorPin: '3333' }),
      'SUPERVISOR_AUTHORIZATION_REQUIRED',
      403,
    )
    nadaEscrito()
  })

  it('5. el permiso negado explícitamente en VenueRolePermission.deniedPermissions → 403 aunque el rol lo traiga', async () => {
    prismaMock.venueRolePermission.findUnique.mockResolvedValue({ permissions: [], deniedPermissions: [NO_INSTRUMENT_PERMISSION] })
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'SUPERVISOR_AUTHORIZATION_REQUIRED', 403)
    nadaEscrito()
  })

  it('5b. un conjunto de permisos asignado REEMPLAZA al rol: sin el permiso → 403 aunque sea OWNER; con él → declara aunque el rol no lo tenga', async () => {
    conMiembros([{ ...OWNER, permissionSetId: 'ps-1', permissionSet: { permissions: ['orders:read'] } }])
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'SUPERVISOR_AUTHORIZATION_REQUIRED', 403)
    nadaEscrito()

    rearmar()
    conMiembros([{ ...CASHIER, permissionSetId: 'ps-2', permissionSet: { permissions: ['orders:read', NO_INSTRUMENT_PERMISSION] } }])
    const r = await resolveNoInstrument({ ...identidad, actorStaffId: 'staff-cashier' }, declaracion())
    expect(r.resolution).toMatchObject({ by: 'SESSION' })
    // Con conjunto asignado no se consulta la personalización por rol: el conjunto ES la lista efectiva.
    expect(prismaMock.venueRolePermission.findUnique).not.toHaveBeenCalled()
  })

  it('6. sesión INVÁLIDA para este venue → 403 SESSION_NOT_IN_VENUE, y un supervisorPin válido NO la rescata', async () => {
    // Sin StaffVenue en este venue / inactivo / staff inactivo / de otro venue: para el servicio es «no es miembro».
    conMiembros([OWNER]) // el actor de la sesión ('staff-ajeno') no está
    await rechaza(
      resolveNoInstrument({ ...identidad, actorStaffId: 'staff-ajeno' }, { ...declaracion(), supervisorPin: '1234' }),
      'SESSION_NOT_IN_VENUE',
      403,
    )
    // Ni siquiera se buscó el PIN: la elevación cubre sólo «miembro válido sin permiso».
    expect(prismaMock.staffVenue.findFirst.mock.calls.some(([a]: any[]) => a.where.pin !== undefined)).toBe(false)
    // Y sin identidad de sesión (token sin `sub`) tampoco hay a quién elevar.
    await rechaza(
      resolveNoInstrument({ ...identidad, actorStaffId: null }, { ...declaracion(), supervisorPin: '1234' }),
      'SESSION_NOT_IN_VENUE',
      403,
    )
    nadaEscrito()
  })

  it('7. el cuerpo NO puede traer identidad: `staffId`/`role` extra se rechazan (esquema estricto) y nunca se leen', async () => {
    await rechaza(
      resolveNoInstrument({ ...identidad, actorStaffId: 'staff-cashier' }, { ...declaracion(), staffId: 'staff-owner', role: 'OWNER' }),
      'ATTEMPT_NOT_ELIGIBLE',
    )
    nadaEscrito()
    expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
    // Y un cuerpo malformado (statement distinto, versión distinta, resolutionId que no es uuid) tampoco escribe.
    await rechaza(resolveNoInstrument(identidad, { ...declaracion(), statement: 'OTRA_COSA' }), 'ATTEMPT_NOT_ELIGIBLE')
    await rechaza(resolveNoInstrument(identidad, { ...declaracion(), statementVersion: 2 }), 'ATTEMPT_NOT_ELIGIBLE')
    await rechaza(resolveNoInstrument(identidad, { ...declaracion(), resolutionId: 'no-es-uuid' }), 'ATTEMPT_NOT_ELIGIBLE')
    nadaEscrito()
  })

  it('8. el vínculo del intento es de OTRA terminal (terminalSerial del JWT ≠ link.terminalId) → 404 ATTEMPT_NOT_FOUND', async () => {
    armar({}, { terminalId: 'otra-terminal' })
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'ATTEMPT_NOT_FOUND', 404)
    nadaEscrito()
  })

  it('8b. el vínculo existe pero apunta a OTRA solicitud (link.requestId ≠ body.requestId) → 404', async () => {
    armar({}, { requestId: 'req-otra' })
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'ATTEMPT_NOT_FOUND', 404)
    nadaEscrito()
  })

  it('8c. la solicitud existe pero es de otra terminal del MISMO venue → 404 (indistinguible de la desconocida)', async () => {
    armar({ terminalId: 'otra-terminal' })
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'ATTEMPT_NOT_FOUND', 404)
    nadaEscrito()
    // Un intento que nadie conoce se contesta igual.
    rearmar()
    await rechaza(resolveNoInstrument({ ...identidad, attemptId: 'att-desconocido' }, declaracion()), 'ATTEMPT_NOT_FOUND', 404)
    nadaEscrito()
  })

  it('9. replay con el mismo resolutionId y el mismo cuerpo → la misma resolución, sin segunda escritura ni segunda bitácora; distinto cuerpo → 409 RESOLUTION_CONFLICT', async () => {
    const primera = await resolveNoInstrument(identidad, declaracion())
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.terminalPaymentAttemptLink.update).toHaveBeenCalledTimes(1)
    // La fila ya es FAILED/OPERATOR_RECONCILED_NO_CHARGE y el vínculo ya lleva la declaración: el replay la devuelve tal cual.
    const replay = await resolveNoInstrument(identidad, declaracion())
    expect(replay.resolution).toEqual(primera.resolution)
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.terminalPaymentAttemptLink.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1)
    // El replay tampoco vuelve a pedir autorización: lo que ya se declaró no se re-litiga con la sesión del momento.
    prismaMock.staffVenue.findFirst.mockClear()
    await resolveNoInstrument({ ...identidad, actorStaffId: 'staff-cashier' }, declaracion())
    expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
    // El mismo cuerpo con OTRO resolutionId es otra declaración sobre un intento ya declarado: conflicto, nada se reescribe.
    // (Un cuerpo distinto sólo puede diferir en `requestId`, y eso ya es 404 antes de llegar aquí.)
    await rechaza(
      resolveNoInstrument(identidad, { ...declaracion(), resolutionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
      'RESOLUTION_CONFLICT',
    )
    expect(prismaMock.terminalPaymentAttemptLink.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
  })

  it('9b. la solicitud tiene DOS vínculos (dos intentos) → 409 OTHER_ATTEMPT_UNRESOLVED', async () => {
    prismaMock.terminalPaymentAttemptLink.count.mockResolvedValue(2)
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'OTHER_ATTEMPT_UNRESOLVED')
    nadaEscrito()
  })

  describe('10. cualquier evidencia POSITIVA veta la declaración → 409 POSITIVE_EVIDENCE_EXISTS, nada escrito', () => {
    it('hay un Payment con la llave del intento (o etiquetado con la solicitud), aunque esté PENDING', async () => {
      prismaMock.payment.findFirst.mockResolvedValue({ id: 'pay-1' })
      await rechaza(resolveNoInstrument(identidad, declaracion()), 'POSITIVE_EVIDENCE_EXISTS')
      nadaEscrito()
      expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { OR: expect.arrayContaining([{ idempotencyKey: attemptId }, { terminalPaymentRequestId: requestId }]) },
        }),
      )
    })

    it('la fila lleva paymentId', async () => {
      armar({ paymentId: 'pay-ganador' })
      await rechaza(resolveNoInstrument(identidad, declaracion()), 'POSITIVE_EVIDENCE_EXISTS')
      nadaEscrito()
    })

    it.each([
      ['status success', { status: 'success' }],
      ['approved true', { approved: true }],
      ['paymentId', { paymentId: 'pay-x' }],
      ['authorizationCode', { authorizationCode: '123456' }],
      ['transactionId', { transactionId: 'tx-1' }],
      ['reference', { reference: 'ref-1' }],
      ['readMode', { readMode: 'CONTACTLESS' }],
    ])('el sobre trae una señal positiva (%s)', async (_nombre, senal) => {
      armar({ resultJson: { requestId, status: 'timeout', ...senal } })
      await rechaza(resolveNoInstrument(identidad, declaracion()), 'POSITIVE_EVIDENCE_EXISTS')
      nadaEscrito()
    })

    // Codex r1 · P1-D: el `success` inacreditable que `closeRow` degradó a UNKNOWN conserva su afirmación en `claimedSuccess`.
    it.each([
      ['paymentId', { paymentId: 'pay-inexistente' }],
      ['authorizationCode', { authorizationCode: 'A1' }],
      ['transactionId', { transactionId: 'tx-1' }],
      ['reference', { reference: 'ref-1' }],
      ['readMode', { readMode: 'CONTACTLESS' }],
      ['approved', { approved: true }],
    ])('P1-D · una fila UNKNOWN con claimedSuccess.%s (un `success` degradado) veta la declaración', async (_nombre, afirmacion) => {
      armar({
        status: 'UNKNOWN',
        resultJson: {
          requestId,
          status: 'timeout',
          errorMessage: 'El pago sigue pendiente de confirmar en Avoqado',
          claimedSuccess: afirmacion,
        },
      })
      await rechaza(resolveNoInstrument(identidad, declaracion()), 'POSITIVE_EVIDENCE_EXISTS')
      nadaEscrito()
    })

    it('P1-D · un claimedSuccess con TODOS los campos vacíos no veta (no afirma nada): la declaración procede', async () => {
      armar({
        status: 'UNKNOWN',
        resultJson: { requestId, status: 'timeout', claimedSuccess: { paymentId: '', reference: null, approved: false } },
      })
      expect((await resolveNoInstrument(identidad, declaracion())).resolution).toMatchObject({ by: 'SESSION' })
    })

    // Codex r1 · P1-E: la identidad LEGACY del Payment (etiqueta en processorData) también veta, acotada al venue.
    it('P1-E · el veto de Payment pregunta también por processorData.terminalPaymentRequestId, acotado al venue', async () => {
      await resolveNoInstrument(identidad, declaracion())
      expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: expect.arrayContaining([
              { idempotencyKey: attemptId },
              { terminalPaymentRequestId: requestId },
              { venueId, processorData: { path: ['terminalPaymentRequestId'], equals: requestId } },
            ]),
          },
        }),
      )
    })

    it('hay un ProviderEventLog del intento APROBADO por el banco, o con contradicción de procedencia', async () => {
      prismaMock.$queryRaw.mockImplementation(async (tpl: any) =>
        sqlDe([tpl]).includes('"ProviderEventLog"') ? [{ id: 'e1' }] : sqlDe([tpl]).includes('"Order"') ? [{ id: 'order-1' }] : [],
      )
      await rechaza(resolveNoInstrument(identidad, declaracion()), 'POSITIVE_EVIDENCE_EXISTS')
      nadaEscrito()
    })
  })

  it('11. una fila ya acreditada (FAILED/TPV_CONFIRMED_NO_CHARGE con PROCESSOR_DECLINED) o todavía PENDING → 409 ATTEMPT_NOT_ELIGIBLE', async () => {
    armar({
      status: 'FAILED',
      failureCode: 'TPV_CONFIRMED_NO_CHARGE',
      resultJson: { requestId, status: 'failed', outcomeEvidence: 'PROCESSOR_DECLINED' },
    })
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'ATTEMPT_NOT_ELIGIBLE')
    nadaEscrito()
    rearmar({ status: 'PENDING', resultJson: null })
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'ATTEMPT_NOT_ELIGIBLE')
    nadaEscrito()
  })

  it('12. una fila liberada por la ventana (FAILED/NO_EVIDENCE_AFTER_WINDOW) → ATTEMPT_NOT_ELIGIBLE; una retenida por el banco (TIMED_OUT/BANK_APPROVED_AWAITING_PAYMENT) → POSITIVE_EVIDENCE_EXISTS: la evidencia no se pisa', async () => {
    armar({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'ATTEMPT_NOT_ELIGIBLE')
    nadaEscrito()
    rearmar({ failureCode: 'BANK_APPROVED_AWAITING_PAYMENT' })
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'POSITIVE_EVIDENCE_EXISTS')
    nadaEscrito()
  })

  it('13. la orden de la fila no pertenece al venue → 409 ATTEMPT_NOT_ELIGIBLE (lo decide el propio FOR UPDATE, acotado al venue)', async () => {
    prismaMock.$queryRaw.mockImplementation(async (tpl: any) => (sqlDe([tpl]).includes('"Order"') ? [] : []))
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'ATTEMPT_NOT_ELIGIBLE')
    nadaEscrito()
    const candadoDeOrden = prismaMock.$queryRaw.mock.calls.find((c: any[]) => sqlDe(c).includes('"Order"'))
    expect(candadoDeOrden).toBeDefined()
    expect(sqlDe(candadoDeOrden)).toMatch(/"Order" WHERE "id" = \? AND "venueId" = \? FOR UPDATE/)
    expect(candadoDeOrden.slice(1)).toEqual(['order-1', venueId])
    // Una sola consulta decide candado y pertenencia: no hay segunda lectura de la orden sin candado.
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
  })

  it('1b. `supervisorPin: null` es «ausente» (un DTO String? serializado con nulls no puede volverse 409): con permiso declara por SESSION; sin permiso → 403', async () => {
    const r = await resolveNoInstrument(identidad, { ...declaracion(), supervisorPin: null })
    expect(r.resolution).toMatchObject({ by: 'SESSION' })
    rearmar()
    await rechaza(
      resolveNoInstrument({ ...identidad, actorStaffId: 'staff-cashier' }, { ...declaracion(), supervisorPin: null }),
      'SUPERVISOR_AUTHORIZATION_REQUIRED',
      403,
    )
    nadaEscrito()
    // Y un PIN que no es cadena de dígitos sigue siendo cuerpo inválido.
    await rechaza(
      resolveNoInstrument({ ...identidad, actorStaffId: 'staff-cashier' }, { ...declaracion(), supervisorPin: 1234 }),
      'ATTEMPT_NOT_ELIGIBLE',
    )
    await rechaza(
      resolveNoInstrument({ ...identidad, actorStaffId: 'staff-cashier' }, { ...declaracion(), supervisorPin: '12' }),
      'ATTEMPT_NOT_ELIGIBLE',
    )
  })

  it('el candado del intento y el vínculo usan la llave NORMALIZADA (`llaveDeIntento`): un param con espacios alrededor es el mismo intento', async () => {
    const r = await resolveNoInstrument({ ...identidad, attemptId: '  att-1  ' }, declaracion())
    expect(r.resolution).toMatchObject({ by: 'SESSION' })
    const candado = prismaMock.$queryRaw.mock.calls.find((c: any[]) => sqlDe(c).includes('pg_advisory_xact_lock'))
    expect(candado).toBeDefined()
    expect(candado[candado.length - 1]).toBe('att-1')
    expect(prismaMock.terminalPaymentAttemptLink.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { attemptId: 'att-1' } }),
    )
    expect(prismaMock.terminalPaymentAttemptLink.update).toHaveBeenCalledWith(expect.objectContaining({ where: { attemptId: 'att-1' } }))
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ data: expect.objectContaining({ attemptId: 'att-1' }) }) }),
    )
    // Una llave que `llaveDeIntento` no acepta (vacía o de más de 64) es un intento que no existe: 404, sin candado.
    rearmar()
    await rechaza(resolveNoInstrument({ ...identidad, attemptId: '   ' }, declaracion()), 'ATTEMPT_NOT_FOUND', 404)
    await rechaza(resolveNoInstrument({ ...identidad, attemptId: 'a'.repeat(65) }, declaracion()), 'ATTEMPT_NOT_FOUND', 404)
    expect(prismaMock.$queryRaw.mock.calls.some((c: any[]) => sqlDe(c).includes('pg_advisory_xact_lock'))).toBe(false)
    nadaEscrito()
  })

  it('el CAS que pierde (la fila cambió entre la lectura y la escritura, o apareció evidencia positiva: el UPDATE devuelve 0) no escribe el vínculo ni la bitácora', async () => {
    prismaMock.$executeRaw.mockResolvedValue(0)
    await rechaza(resolveNoInstrument(identidad, declaracion()), 'ATTEMPT_NOT_ELIGIBLE')
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1)
    expect(prismaMock.terminalPaymentAttemptLink.update).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('el orden de los candados: candado del intento → Order FOR UPDATE → TerminalPaymentRequest FOR UPDATE, dentro de UNA transacción', async () => {
    await resolveNoInstrument(identidad, declaracion())
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'ReadCommitted', timeout: 10_000 })
    const crudas = prismaMock.$queryRaw.mock.calls.map(([tpl]: any[]) => (Array.isArray(tpl) ? tpl.join('?') : String(tpl)))
    const candado = crudas.findIndex((s: string) => s.includes('pg_advisory_xact_lock'))
    const orden = crudas.findIndex((s: string) => s.includes('"Order"') && s.includes('FOR UPDATE'))
    const solicitud = crudas.findIndex((s: string) => s.includes('"TerminalPaymentRequest"') && s.includes('FOR UPDATE'))
    expect(candado).toBeGreaterThanOrEqual(0)
    expect(orden).toBeGreaterThan(candado)
    expect(solicitud).toBeGreaterThan(orden)
  })
})

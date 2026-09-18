/**
 * Revisión final · ronda 3 (17-sep) — los 3 P1 preexistentes que Codex r8 dejó abiertos, y su P2 de índice.
 *
 * Invariante: una solicitud LIBERADA (`FAILED` + `NO_EVIDENCE_AFTER_WINDOW` u `OPERATOR_RECONCILED_NO_CHARGE` + sin
 * `paymentId`) nunca puede seguir diciendo «no se cobró / puedes volver a cobrar» cuando existe una señal POSITIVA de que
 * sí se cobró. Las tres señales que faltaban:
 *
 *  · P1-A — un Payment ligado que llega FUERA de los 30 min del barrido, o cuyo evento el backfill sella sin pasar por el
 *    vínculo ⇒ red durable (una consulta correlacionada por pasada, horizonte de 7 días) + gancho en el backfill.
 *  · P1-B — la COLISIÓN DE REFERENCIA por REST (evidencia PENDING, no un Payment COMPLETED) ⇒ re-retención con razón
 *    `REFERENCE_COLLISION_AFTER_RELEASE`, sólo si la identidad acreditada del llamador es la terminal de la solicitud.
 *  · P1-C — una AFIRMACIÓN positiva tardía de la propia terminal sin Payment ⇒ re-retención con `TERMINAL_CLAIMED_SUCCESS`
 *    (el marcador y la razón que ya existían ANTES de liberar), recuperando la ranura.
 */
import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { hayPagoLigadoSql, pagoLigadoDeLaFilaSql, hayEvidenciaDeConciliacionSql } from '@/services/tpv/evidenciaPositivaSql'

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: jest.fn() },
  socketManager: { getServer: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => {
  const normalizeTerminalId = (id: string) => id.replace(/^AVQD-/i, '').toLowerCase()
  return {
    normalizeTerminalId,
    terminalRegistry: { getTerminal: jest.fn(), getTerminalBySocketId: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
  }
})

const prismaMock = prisma as any
const tpr = () => prismaMock.terminalPaymentRequest
const svc = terminalPaymentService as any
const opsAlert = require('@/services/alerts/opsAlert.service')
const logger = require('@/config/logger').default

/** El texto COMPLETO de un tagged template de Prisma: las plantillas y los fragmentos `Prisma.sql` anidados. */
const sqlDe = (llamada: any[]) => {
  const [strings, ...values] = llamada
  const fragmentos: string[] = []
  const recolectar = (v: unknown) => {
    if (v && typeof v === 'object' && typeof (v as { sql?: unknown }).sql === 'string') {
      fragmentos.push((v as { sql: string }).sql)
      for (const anidado of ((v as { values?: unknown[] }).values ?? []) as unknown[]) recolectar(anidado)
    }
  }
  for (const v of values) recolectar(v)
  return { texto: (strings as string[]).join('?'), fragmentos, values }
}
const llamadasDelCas = () =>
  prismaMock.$executeRaw.mock.calls.filter((c: any[]) => (c[0] as string[]).join('?').includes('UPDATE "TerminalPaymentRequest"'))
const textoCompletoDelCas = () => {
  const [c] = llamadasDelCas()
  const { texto, fragmentos } = sqlDe(c)
  return texto + ' ' + fragmentos.join(' ')
}

const liberadaEn = '2026-09-17T10:00:00.000Z'
const liberada = (extra: Record<string, unknown> = {}) => ({
  id: 'row-c',
  requestId: 'REQ-C',
  venueId: 'venue-1',
  terminalId: 't-c',
  orderId: 'order-c',
  amountCents: 10000,
  tipCents: 0,
  status: 'FAILED',
  failureCode: 'NO_EVIDENCE_AFTER_WINDOW',
  paymentId: null,
  updatedAt: new Date('2026-09-17T10:05:00.000Z'),
  resultJson: {
    requestId: 'REQ-C',
    status: 'failed',
    outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
    errorMessage: 'No se confirmó el cobro en la ventana de 30 s. Se puede volver a cobrar.',
    releasedAfterWindow: { windowMs: 30_000, releasedAt: liberadaEn, origen: 'TIMER' },
    terminalResult: { status: 'failed', errorMessage: 'SDK U100', outcomeEvidence: null },
  },
  ...extra,
})

let orden: string[]
let alerta: jest.SpyInstance

beforeEach(() => {
  orden = []
  alerta = jest.spyOn(opsAlert, 'sendOpsAlert').mockImplementation(async () => {
    orden.push('correo')
    return true
  })
  tpr().findFirst.mockReset().mockResolvedValue(null)
  tpr().findMany.mockReset().mockResolvedValue([])
  tpr().updateMany.mockReset().mockResolvedValue({ count: 1 })
  tpr().count.mockReset().mockResolvedValue(0)
  prismaMock.terminalPaymentAttemptLink.findMany.mockReset().mockResolvedValue([])
  prismaMock.terminalPaymentAttemptLink.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.payment.count.mockReset().mockResolvedValue(0)
  prismaMock.payment.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.$queryRaw.mockReset().mockResolvedValue([])
  prismaMock.$executeRaw.mockReset().mockResolvedValue(1)
  prismaMock.activityLog.create.mockReset().mockResolvedValue({ id: 'log' })
  prismaMock.activityLog.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.$transaction.mockReset().mockImplementation((callback: any) => callback(prismaMock))
  ;(logger.error as jest.Mock).mockClear()
  ;(logger.warn as jest.Mock).mockClear()
  ;(logger.info as jest.Mock).mockClear()
})
afterEach(() => {
  alerta.mockRestore()
  prismaMock.$transaction.mockReset().mockImplementation((callback: any) => callback(prismaMock))
})

// ───────────────────────────────── P2 · la expresión del índice ─────────────────────────────────
describe('Ronda 3 · P2: la etiqueta legacy se compara con la expresión INDEXADA', () => {
  it('`pagoLigadoSql` usa `#> {terminalPaymentRequestId}` (la del índice) y ya no `->>`', () => {
    const { sql } = hayPagoLigadoSql('REQ-C', 'venue-1')
    expect(sql).toContain(`#> '{terminalPaymentRequestId}'`)
    expect(sql).not.toContain(`->>'terminalPaymentRequestId'`)
    expect(sql).not.toContain(`->> 'terminalPaymentRequestId'`)
    // La comparación es jsonb contra jsonb (una cadena JSON), que es lo que el índice puede resolver.
    expect(sql).toContain(`#> '{terminalPaymentRequestId}' = to_jsonb(?::text)`)
  })

  it('las TRES identidades siguen ahí: puntero, etiqueta legacy y la llave de un vínculo actual', () => {
    const { sql } = hayPagoLigadoSql('REQ-C', 'venue-1')
    expect(sql).toContain('"terminalPaymentRequestId" = ')
    expect(sql).toContain(`#> '{terminalPaymentRequestId}'`)
    expect(sql).toContain('"idempotencyKey" IN (')
    expect(sql).toContain(`"status" = 'COMPLETED'`)
    expect(sql).toContain(`'CREDIT_CARD', 'DEBIT_CARD'`)
    expect(sql).toContain(`<> 'REFUND'`)
  })

  it('la versión CORRELACIONADA pregunta lo MISMO sobre las columnas de la fila (para el barrido de una sola consulta)', () => {
    const { sql } = pagoLigadoDeLaFilaSql('r')
    expect(sql).toContain('r."requestId"')
    expect(sql).toContain('r."venueId"')
    expect(sql).toContain(`#> '{terminalPaymentRequestId}' = to_jsonb(r."requestId"::text)`)
    expect(sql).toContain('"idempotencyKey" IN (')
    // 🔴 El MISMO cuerpo que la de parámetros: si divergieran, el barrido y el CAS dirían cosas distintas del mismo cobro.
    const normalizar = (s: string) =>
      s
        .replace(/\?/g, 'X')
        .replace(/r\."(requestId|venueId)"/g, 'X')
        .replace(/\s+/g, ' ')
        .trim()
    expect(normalizar(hayPagoLigadoSql('REQ-C', 'venue-1').sql)).toContain(normalizar(sql))
  })

  it('un alias que no sea un identificador simple se rechaza (nunca se interpola texto ajeno en SQL crudo)', () => {
    expect(() => pagoLigadoDeLaFilaSql('r"; DROP TABLE "Payment')).toThrow(/Alias de tabla inválido/)
  })
})

// ──────────────────── P1-B · la colisión de referencia sobre una solicitud liberada ────────────────────
describe('Ronda 3 · P1-B: retenerSolicitudLiberadaPorColisionDeReferencia', () => {
  const entrada = {
    requestId: 'REQ-C',
    venueId: 'venue-1',
    paymentId: 'evid-1',
    capturedBySerial: 'AVQD-T-C',
    origen: 'REST' as const,
  }
  const evidencia = {
    id: 'evid-1',
    status: 'PENDING',
    terminalPaymentRequestId: 'REQ-C',
    processorData: { reconciliation: { kind: 'POSSIBLE_REFERENCE_COLLISION' }, deviceSerialNumber: 't-c' },
    terminal: { serialNumber: 'AVQD-t-c' },
  }

  beforeEach(() => {
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      orden.push('abre-tx')
      const r = await callback(prismaMock)
      orden.push('commit')
      return r
    })
    prismaMock.$queryRaw.mockImplementation(async (strings: string[], ...values: unknown[]) => {
      const texto = strings.join('?')
      if (texto.includes('pg_advisory_xact_lock')) orden.push(`candado:${values[0]}:${values[1]}`)
      return []
    })
    prismaMock.terminalPaymentAttemptLink.findMany.mockImplementation(async () => {
      orden.push('vinculos')
      return [{ attemptId: 'att-c' }]
    })
    prismaMock.payment.findFirst.mockImplementation(async () => {
      orden.push('evidencia')
      return evidencia
    })
    tpr().findFirst.mockResolvedValue(liberada())
  })

  it('el CAS exige la EVIDENCIA de conciliación de la solicitud — NUNCA un Payment ligado (la colisión no liga por ninguna identidad)', async () => {
    const r = await svc.retenerSolicitudLiberadaPorColisionDeReferencia(entrada)
    expect(r).toBe('HELD')
    const texto = textoCompletoDelCas()
    expect(texto).toMatch(/SET "status" = 'TIMED_OUT', "failureCode" = 'PAYMENT_UNBOUND_AWAITING_REVIEW'/)
    expect(texto).toContain(`->'reconciliation'->>'kind'`)
    expect(texto).not.toContain(`"status" = 'COMPLETED'`)
    // Orden de candados y la lectura de la evidencia BAJO ellos.
    expect(orden.filter(o => o.startsWith('candado') || ['abre-tx', 'vinculos', 'evidencia', 'commit'].includes(o))).toEqual([
      'abre-tx',
      'candado:7310114:REQ-C',
      'vinculos',
      'candado:7310113:att-c',
      'evidencia',
      'commit',
    ])
  })

  it('HELD ⇒ el sobre lleva `referenceCollisionAfterRelease` con el id de la evidencia, UN asiento propio, 🚨 y correo', async () => {
    await svc.retenerSolicitudLiberadaPorColisionDeReferencia(entrada)
    const { values } = sqlDe(llamadasDelCas()[0])
    const sobre = JSON.parse(
      values.find((v: unknown) => typeof v === 'string' && String(v).includes('referenceCollisionAfterRelease')) as string,
    )
    expect(sobre.status).toBe('timeout')
    expect(sobre.outcomeEvidence).toBeNull()
    expect(sobre.errorMessage).not.toContain('volver a cobrar.')
    expect(sobre.referenceCollisionAfterRelease).toMatchObject({
      paymentId: 'evid-1',
      reason: 'REFERENCE_COLLISION_AFTER_RELEASE',
      origen: 'REST',
      previousFailureCode: 'NO_EVIDENCE_AFTER_WINDOW',
    })
    expect(typeof sobre.referenceCollisionAfterRelease.at).toBe('string')
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'TERMINAL_PAYMENT_REFERENCE_COLLISION_AFTER_RELEASE',
      entity: 'TerminalPaymentRequest',
      entityId: 'row-c',
      venueId: 'venue-1',
    })
    expect(alerta).toHaveBeenCalledTimes(1)
    expect(alerta.mock.calls[0][0].subject).toContain('Colisión de referencia sobre un cobro ya liberado')
    expect(orden.indexOf('commit')).toBeLessThan(orden.indexOf('correo'))
  })

  it('🔴 la identidad acreditada del llamador NO es la terminal de la solicitud ⇒ la fila NO se toca, 🚨 con la contradicción', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({
      ...evidencia,
      terminal: { serialNumber: 'AVQD-OTRA' },
      processorData: { reconciliation: { kind: 'POSSIBLE_REFERENCE_COLLISION' }, deviceSerialNumber: 'OTRA' },
    })
    const r = await svc.retenerSolicitudLiberadaPorColisionDeReferencia({ ...entrada, capturedBySerial: 'AVQD-OTRA' })
    expect(r).toBe('IDENTITY_MISMATCH')
    expect(llamadasDelCas()).toHaveLength(0)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(alerta).not.toHaveBeenCalled()
    const grito = (logger.error as jest.Mock).mock.calls.find(c => String(c[0]).includes('🚨'))
    expect(grito).toBeDefined()
    expect(grito[1]).toMatchObject({ requestId: 'REQ-C', reason: 'TERMINAL_MISMATCH' })
  })

  it('la evidencia reportada no existe en el venue ⇒ NOT_APPLICABLE sin escribir', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(null)
    expect(await svc.retenerSolicitudLiberadaPorColisionDeReferencia(entrada)).toBe('NOT_APPLICABLE')
    expect(llamadasDelCas()).toHaveLength(0)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('la fila no está liberada ⇒ NOT_APPLICABLE sin abrir transacción', async () => {
    tpr().findFirst.mockResolvedValue(liberada({ status: 'COMPLETED', failureCode: null, paymentId: 'pay-1' }))
    expect(await svc.retenerSolicitudLiberadaPorColisionDeReferencia(entrada)).toBe('NOT_APPLICABLE')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('el CAS en 0 (otra pasada ya la retuvo) ⇒ NOT_APPLICABLE, sin asiento ni correo', async () => {
    prismaMock.$executeRaw.mockResolvedValue(0)
    expect(await svc.retenerSolicitudLiberadaPorColisionDeReferencia(entrada)).toBe('NOT_APPLICABLE')
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(alerta).not.toHaveBeenCalled()
  })

  it('el predicado de la evidencia acepta las dos clases de conciliación PENDING y acota por venue y solicitud', () => {
    const { sql } = hayEvidenciaDeConciliacionSql('REQ-C', 'venue-1')
    expect(sql).toContain('POSSIBLE_REFERENCE_COLLISION')
    expect(sql).toContain('POSSIBLE_SECOND_CAPTURE')
    expect(sql).toContain(`"status" = 'PENDING'`)
    expect(sql).toContain('"venueId" = ')
    expect(sql).toContain('"terminalPaymentRequestId" = ')
  })
})

// ──────────────── P1-C · la afirmación positiva tardía de la terminal, sin Payment ────────────────
describe('Ronda 3 · P1-C: retenerSolicitudLiberadaPorAfirmacionDeLaTerminal', () => {
  const entrada = { requestId: 'REQ-C', venueId: 'venue-1', origen: 'SOCKET' as const }
  const conAfirmacion = liberada({
    resultJson: { ...liberada().resultJson, claimedSuccess: { transactionId: '260917120000', authorizationCode: 'A1B2C3' } },
  })

  beforeEach(() => {
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      orden.push('abre-tx')
      const r = await callback(prismaMock)
      orden.push('commit')
      return r
    })
    tpr().findFirst.mockResolvedValue(conAfirmacion)
  })

  it('el CAS exige que la AFIRMACIÓN esté en el sobre (el positivo del veto de la ventana), no un Payment', async () => {
    expect(await svc.retenerSolicitudLiberadaPorAfirmacionDeLaTerminal(entrada)).toBe('HELD')
    const texto = textoCompletoDelCas()
    expect(texto).toMatch(/SET "status" = 'TIMED_OUT', "failureCode" = 'PAYMENT_UNBOUND_AWAITING_REVIEW'/)
    expect(texto).toMatch(/NOT \(coalesce\(nullif\("resultJson"->'claimedSuccess'/)
    expect(texto).not.toContain(`"status" = 'COMPLETED'`)
  })

  it('HELD ⇒ sobre `terminalClaimedSuccessAfterRelease` con la afirmación leída bajo el candado, UN asiento, 🚨 y correo', async () => {
    await svc.retenerSolicitudLiberadaPorAfirmacionDeLaTerminal(entrada)
    const { values } = sqlDe(llamadasDelCas()[0])
    const sobre = JSON.parse(
      values.find((v: unknown) => typeof v === 'string' && String(v).includes('terminalClaimedSuccessAfterRelease')) as string,
    )
    expect(sobre.status).toBe('timeout')
    expect(sobre.errorMessage).not.toContain('volver a cobrar.')
    expect(sobre.terminalClaimedSuccessAfterRelease).toMatchObject({
      reason: 'TERMINAL_CLAIMED_SUCCESS',
      origen: 'SOCKET',
      previousFailureCode: 'NO_EVIDENCE_AFTER_WINDOW',
      claimedSuccess: { transactionId: '260917120000', authorizationCode: 'A1B2C3' },
    })
    // El sobre NO reescribe `claimedSuccess`: el `||` de jsonb conserva el que ya está en la fila.
    expect(sobre.claimedSuccess).toBeUndefined()
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'TERMINAL_PAYMENT_TERMINAL_CLAIM_AFTER_RELEASE',
      entityId: 'row-c',
      venueId: 'venue-1',
    })
    expect(prismaMock.activityLog.create.mock.calls[0][0].data.data).toMatchObject({ reason: 'TERMINAL_CLAIMED_SUCCESS' })
    expect(alerta).toHaveBeenCalledTimes(1)
    expect(alerta.mock.calls[0][0].subject).toContain('La terminal afirmó haber cobrado un cobro ya liberado')
  })

  it('sin afirmación en el sobre ⇒ NOT_APPLICABLE sin abrir transacción (lo que la ventana no habría vetado, no se retiene)', async () => {
    tpr().findFirst.mockResolvedValue(liberada())
    expect(await svc.retenerSolicitudLiberadaPorAfirmacionDeLaTerminal(entrada)).toBe('NOT_APPLICABLE')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('la fila ya no está liberada ⇒ NOT_APPLICABLE; el CAS en 0 tampoco escribe nada', async () => {
    tpr().findFirst.mockResolvedValue({ ...conAfirmacion, status: 'TIMED_OUT', failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW' })
    expect(await svc.retenerSolicitudLiberadaPorAfirmacionDeLaTerminal(entrada)).toBe('NOT_APPLICABLE')
    tpr().findFirst.mockResolvedValue(conAfirmacion)
    prismaMock.$executeRaw.mockResolvedValue(0)
    expect(await svc.retenerSolicitudLiberadaPorAfirmacionDeLaTerminal(entrada)).toBe('NOT_APPLICABLE')
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})

describe('Ronda 3 · P1-C: el `success` degradado del socket pide la re-retención y ya no proyecta «no se cobró»', () => {
  let porAfirmacion: jest.SpyInstance
  beforeEach(() => {
    porAfirmacion = jest.spyOn(svc, 'retenerSolicitudLiberadaPorAfirmacionDeLaTerminal').mockResolvedValue('NOT_APPLICABLE')
    tpr().updateMany.mockResolvedValue({ count: 0 })
    tpr().findFirst.mockResolvedValue(liberada())
  })
  afterEach(() => porAfirmacion.mockRestore())

  it('un `success` SIN Payment sobre una liberada: la afirmación se persiste PRIMERO y luego se pide la re-retención', async () => {
    await svc.closeRow('REQ-C', 'venue-1', { requestId: 'REQ-C', status: 'success', transactionId: '260917120000' })
    const persistencia = prismaMock.$executeRaw.mock.calls.findIndex((c: any[]) => (c[0] as string[]).join('?').includes('claimedSuccess'))
    expect(persistencia).toBeGreaterThanOrEqual(0)
    expect(porAfirmacion).toHaveBeenCalledWith({ requestId: 'REQ-C', venueId: 'venue-1', origen: 'SOCKET' })
  })

  it('si la re-retención GANA, el resultado que se devuelve es el de la fila RETENIDA — nunca «se puede volver a cobrar»', async () => {
    porAfirmacion.mockResolvedValue('HELD')
    const retenida = {
      ...liberada(),
      status: 'TIMED_OUT',
      failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW',
      resultJson: {
        requestId: 'REQ-C',
        status: 'timeout',
        errorMessage: 'La terminal afirmó haber cobrado este intento después de liberarlo. No lo cobres otra vez: se está revisando.',
      },
    }
    // El escritor del `success` degradado busca con un `OR` de brazos; la RELECTURA de después pide la fila a secas.
    tpr().findFirst.mockImplementation(async ({ where }: any) => (where?.OR ? liberada() : retenida))
    const r = await svc.closeRow('REQ-C', 'venue-1', { requestId: 'REQ-C', status: 'success', transactionId: '260917120000' })
    expect(r.status).toBe('timeout')
    expect(r.errorMessage).toContain('se está revisando')
    expect(r.errorMessage).not.toContain('volver a cobrar')
  })

  it('un `success` con Payment que SÍ liga no pide la re-retención por afirmación', async () => {
    const cierre = jest.spyOn(svc, 'closeRowFromPaymentTx').mockResolvedValue({ bound: true, reopened: false, contractMismatch: false })
    tpr().findFirst.mockResolvedValue({ ...liberada(), status: 'COMPLETED', failureCode: null, paymentId: 'pay-1', resultJson: {} })
    await svc.closeRow('REQ-C', 'venue-1', { requestId: 'REQ-C', status: 'success', paymentId: 'pay-1' })
    expect(porAfirmacion).not.toHaveBeenCalled()
    cierre.mockRestore()
  })
})

// ───────────────── P1-A · la red durable: el barrido ya no depende de la ventana de 30 min ─────────────────
describe('Ronda 3 · P1-A: red durable — las liberadas CON un Payment ligado se re-retienen en un tiempo acotado', () => {
  let porSolicitud: jest.SpyInstance
  const CONSULTA = 'liberadas-con-senal'

  beforeEach(() => {
    porSolicitud = jest.spyOn(svc, 'retenerSolicitudLiberadaPorPagoSinLigar').mockResolvedValue('HELD')
    prismaMock.$queryRaw.mockImplementation(async () => [])
  })
  afterEach(() => porSolicitud.mockRestore())

  const consultas = () => prismaMock.$queryRaw.mock.calls.filter((c: any[]) => (c[0] as string[]).join('?').includes(CONSULTA))

  it('UNA consulta correlacionada por lote: los dos códigos de liberación, sin pago, horizonte de 7 días, keyset y tope', async () => {
    await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
    expect(consultas()).toHaveLength(1)
    const { texto, fragmentos, values } = sqlDe(consultas()[0])
    const completo = texto + ' ' + fragmentos.join(' ')
    expect(completo).toContain(`r."status" = 'FAILED'`)
    expect(completo).toContain('r."paymentId" IS NULL')
    // Los dos códigos de liberación viajan LIGADOS (`Prisma.join`), no como texto.
    expect(JSON.stringify(values)).toContain('NO_EVIDENCE_AFTER_WINDOW')
    expect(JSON.stringify(values)).toContain('OPERATOR_RECONCILED_NO_CHARGE')
    // UNA consulta correlacionada (el LATERAL filtra y trae el id), no una pregunta por fila.
    expect(completo).toContain('JOIN LATERAL')
    expect(completo).toContain('r."requestId"')
    expect(completo).toMatch(/ORDER BY r\."createdAt" ASC, r\."id" ASC/)
    expect(completo).toContain('LIMIT')
    expect(values).toContain(200)
    // El horizonte: 7 días exactos antes de `now`, atado con `utcTs` (nunca un Date pelón).
    expect(completo).toContain(`AT TIME ZONE 'UTC'`)
    expect(JSON.stringify(values)).toContain('2026-09-10T12:00:00')
  })

  it('🔴 cada fila pasa por el MISMO veredicto que el barrido de 30 min (conciliar o re-retener), con origen BARRIDO_LIGADOS', async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
      (strings as string[]).join('?').includes(CONSULTA)
        ? [
            {
              requestId: 'REQ-1',
              venueId: 'venue-1',
              createdAt: new Date('2026-09-11T00:00:00Z'),
              id: 'row-1',
              paymentId: 'pay-1',
              evidenciaIds: null,
              afirmacion: false,
            },
            {
              requestId: 'REQ-2',
              venueId: 'venue-2',
              createdAt: new Date('2026-09-12T00:00:00Z'),
              id: 'row-2',
              paymentId: 'pay-2',
              evidenciaIds: null,
              afirmacion: false,
            },
          ]
        : [],
    )
    tpr().findFirst.mockImplementation(async ({ where }: any) => ({ ...liberada(), requestId: where.requestId, venueId: where.venueId }))
    const veredicto = jest.spyOn(svc, 'conciliarORetenerLiberada').mockResolvedValueOnce('HELD').mockResolvedValueOnce('RECONCILED')
    try {
      const retenidas = await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
      expect(veredicto).toHaveBeenCalledTimes(2)
      expect(veredicto.mock.calls[0][0]).toMatchObject({ requestId: 'REQ-1' })
      expect(veredicto.mock.calls[0][1]).toBe('BARRIDO_LIGADOS')
      expect(veredicto.mock.calls[1][0]).toMatchObject({ requestId: 'REQ-2' })
      // Sólo cuenta las RETENIDAS: un cobro atribuible se CONCILIA (COMPLETED), que es el desenlace correcto, no una retención.
      expect(retenidas).toEqual({ conPago: 1, sinPago: 0 })
    } finally {
      veredicto.mockRestore()
    }
  })

  it('una fila que ya no está (otro la cerró entre la consulta y la relectura) se salta sin veredicto', async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
      (strings as string[]).join('?').includes(CONSULTA)
        ? [
            {
              requestId: 'REQ-1',
              venueId: 'venue-1',
              createdAt: new Date(),
              id: 'row-1',
              paymentId: 'pay-1',
              evidenciaIds: null,
              afirmacion: false,
            },
          ]
        : [],
    )
    tpr().findFirst.mockResolvedValue(null)
    const veredicto = jest.spyOn(svc, 'conciliarORetenerLiberada')
    try {
      expect(await svc.retenerLiberadasConSenalPositiva(new Date())).toEqual({ conPago: 0, sinPago: 0 })
      expect(veredicto).not.toHaveBeenCalled()
    } finally {
      veredicto.mockRestore()
    }
  })

  it('🔴 el veredicto compartido: un cobro ATRIBUIBLE se concilia por el cierre común; uno ligado que no liga se re-retiene', async () => {
    const row = liberada()
    const buscar = jest.spyOn(svc, 'findReconcilablePayment').mockResolvedValue({ id: 'pay-a' })
    const cierre = jest.spyOn(svc, 'closeRowFromPaymentTx').mockResolvedValue({ bound: true, reopened: false, contractMismatch: false })
    try {
      expect(await svc.conciliarORetenerLiberada(row, 'BARRIDO_LIGADOS')).toBe('RECONCILED')
      expect(porSolicitud).not.toHaveBeenCalled()

      cierre.mockResolvedValue({ bound: false, reason: 'PAYMENT_BOUND_ELSEWHERE' })
      expect(await svc.conciliarORetenerLiberada(row, 'BARRIDO_LIGADOS')).toBe('HELD')
      expect(porSolicitud).toHaveBeenCalledWith({
        requestId: 'REQ-C',
        venueId: 'venue-1',
        paymentId: 'pay-a',
        origen: 'BARRIDO_LIGADOS',
      })

      // `ALREADY_BOUND` = otro la cerró con ESE cobro: no hay nada que retener.
      porSolicitud.mockClear()
      cierre.mockResolvedValue({ bound: false, reason: 'ALREADY_BOUND' })
      expect(await svc.conciliarORetenerLiberada(row, 'BARRIDO_LIGADOS')).toBe('NADA')
      expect(porSolicitud).not.toHaveBeenCalled()

      // Sin cobro atribuible, pero con uno LIGADO (G1 tras liberar): se re-retiene con ése.
      buscar.mockResolvedValue(null)
      prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
        (strings as string[]).join('?').includes('ligados') ? [{ id: 'pay-g1' }] : [],
      )
      expect(await svc.conciliarORetenerLiberada(row, 'BARRIDO_LIGADOS')).toBe('HELD')
      expect(porSolicitud).toHaveBeenCalledWith({
        requestId: 'REQ-C',
        venueId: 'venue-1',
        paymentId: 'pay-g1',
        origen: 'BARRIDO_LIGADOS',
      })

      // Y sin ninguno de los dos, nada.
      porSolicitud.mockClear()
      prismaMock.$queryRaw.mockImplementation(async () => [])
      expect(await svc.conciliarORetenerLiberada(row, 'BARRIDO_LIGADOS')).toBe('NADA')
      expect(porSolicitud).not.toHaveBeenCalled()
    } finally {
      buscar.mockRestore()
      cierre.mockRestore()
    }
  })

  it('el cursor AVANZA por keyset: un lote lleno vuelve a consultar desde la última fila, y con el tope avisa', async () => {
    const lote = (n: number) =>
      Array.from({ length: 200 }, (_, i) => ({
        requestId: `REQ-${n}-${i}`,
        venueId: 'venue-1',
        createdAt: new Date(`2026-09-1${(n % 5) + 1}T00:00:00Z`),
        id: `row-${n}-${i}`,
        paymentId: 'pay-x',
        evidenciaIds: null,
        afirmacion: false,
      }))
    let pasada = 0
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
      (strings as string[]).join('?').includes(CONSULTA) ? lote(pasada++) : [],
    )
    await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
    expect(consultas().length).toBe(25)
    const segunda = sqlDe(consultas()[1])
    expect(segunda.texto + segunda.fragmentos.join(' ')).toContain('r."createdAt" >')
    expect((logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('batch cap'))).toBe(true)
  })

  it('un lote incompleto termina el recorrido (no vuelve a preguntar)', async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
      (strings as string[]).join('?').includes(CONSULTA)
        ? [
            {
              requestId: 'REQ-1',
              venueId: 'venue-1',
              createdAt: new Date(),
              id: 'row-1',
              paymentId: 'pay-x',
              evidenciaIds: null,
              afirmacion: false,
            },
          ]
        : [],
    )
    await svc.retenerLiberadasConSenalPositiva(new Date())
    expect(consultas()).toHaveLength(1)
  })

  it('la red corre en la pasada del watchdog (`reconcileUnknownRequests`) y reporta cuántas retuvo', async () => {
    const red = jest.spyOn(svc, 'retenerLiberadasConSenalPositiva').mockResolvedValue({ conPago: 3, sinPago: 0 })
    const r = await svc.reconcileUnknownRequests(new Date())
    expect(red).toHaveBeenCalled()
    expect(r.heldWithLinkedPayment).toBe(3)
    red.mockRestore()
  })

  it('un fallo de la red durable no tumba el resto de la pasada', async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) => {
      if ((strings as string[]).join('?').includes(CONSULTA)) throw new Error('base caída')
      return []
    })
    const r = await svc.reconcileUnknownRequests(new Date())
    expect(r.heldWithLinkedPayment).toBe(0)
    expect((logger.warn as jest.Mock).mock.calls.some(c => String(c[0]).includes('red durable'))).toBe(true)
  })
})

describe('Ronda 3 · P1-A: el origen BACKFILL existe y la re-retención por Payment lo acepta', () => {
  it('`retenerLiberadasPorPagoSinLigar` con origen BACKFILL resuelve las identidades del Payment', async () => {
    const porSolicitud = jest.spyOn(svc, 'retenerSolicitudLiberadaPorPagoSinLigar').mockResolvedValue('DEFERRED')
    const r = await svc.retenerLiberadasPorPagoSinLigar(
      {
        id: 'pay-b',
        venueId: 'venue-1',
        status: 'COMPLETED',
        method: 'CREDIT_CARD',
        type: null,
        idempotencyKey: null,
        terminalPaymentRequestId: 'REQ-C',
        processorData: {},
      },
      'BACKFILL',
    )
    expect(porSolicitud).toHaveBeenCalledWith({ requestId: 'REQ-C', venueId: 'venue-1', paymentId: 'pay-b', origen: 'BACKFILL' })
    expect(r).toEqual([{ requestId: 'REQ-C', resultado: 'DEFERRED' }])
    porSolicitud.mockRestore()
  })
})

// El tipo de dato del resultado: `IDENTITY_MISMATCH` es aditivo y no se confunde con `DEFERRED` (que exige reintento).
describe('Ronda 3 · el contrato del resultado', () => {
  it('una contradicción de identidad NO es `DEFERRED`: quien llama no debe reintentar', async () => {
    tpr().findFirst.mockResolvedValue(liberada())
    prismaMock.terminalPaymentAttemptLink.findMany.mockResolvedValue([])
    prismaMock.payment.findFirst.mockResolvedValue({
      id: 'evid-1',
      status: 'PENDING',
      terminalPaymentRequestId: 'REQ-C',
      processorData: { reconciliation: { kind: 'POSSIBLE_REFERENCE_COLLISION' } },
      terminal: null,
    })
    const r = await svc.retenerSolicitudLiberadaPorColisionDeReferencia({
      requestId: 'REQ-C',
      venueId: 'venue-1',
      paymentId: 'evid-1',
      capturedBySerial: null,
      origen: 'REST',
    })
    expect(r).toBe('IDENTITY_MISMATCH')
    expect(r).not.toBe('DEFERRED')
  })
})

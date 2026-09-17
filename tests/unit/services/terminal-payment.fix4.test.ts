/**
 * Revisión final · ronda 4 (17-sep) — lo que Codex r9 dejó abierto, y su causa de fondo.
 *
 * 🔑 La causa es UNA: `DEFERRED` —el «no pude ahora, lo intento luego» del núcleo de re-retención— NO tenía quién lo
 * reintentara, y los llamadores lo trataban como si fuera «hecho». La red durable de la ronda 3 sólo recogía las liberadas
 * con un `Payment` COMPLETED ligado, así que las DOS señales que no producen Payment —la colisión de referencia (evidencia
 * PENDING) y la afirmación de la propia terminal— se quedaban fuera: un conflicto transitorio de candado las dejaba
 * liberadas PARA SIEMPRE diciéndole al POS «puedes volver a cobrar».
 *
 *  · P1-B — la colisión REST diferida se queda sin recuperación (y su log prometía una red que no la cubría).
 *  · P1-C(a) — la afirmación de la terminal sin Payment, diferida, tampoco tenía barrido.
 *  · P1-C(b) — `closeRow` sólo releía cuando SU llamada devolvía `HELD`: si otro proceso retenía o completaba la fila en
 *    medio, el POS recibía la instantánea ANTERIOR («Se puede volver a cobrar») sobre una fila ya retenida.
 *  · P2 — un error leyendo el vínculo se leía como «comprobado» y el backfill sellaba.
 */
import prisma from '@/utils/prismaClient'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { evidenciaDeConciliacionDeLaFilaSql, hayEvidenciaDeConciliacionSql } from '@/services/tpv/evidenciaPositivaSql'

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

const liberadaEn = '2026-09-17T10:00:00.000Z'
const liberada = (extra: Record<string, unknown> = {}) => ({
  id: 'row-d',
  requestId: 'REQ-D',
  venueId: 'venue-1',
  terminalId: 't-d',
  orderId: 'order-d',
  amountCents: 10000,
  tipCents: 0,
  status: 'FAILED',
  failureCode: 'NO_EVIDENCE_AFTER_WINDOW',
  paymentId: null,
  updatedAt: new Date('2026-09-17T10:05:00.000Z'),
  resultJson: {
    requestId: 'REQ-D',
    status: 'failed',
    outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
    errorMessage: 'No se confirmó el cobro en la ventana de 30 s. Se puede volver a cobrar.',
    releasedAfterWindow: { windowMs: 30_000, releasedAt: liberadaEn, origen: 'TIMER' },
    terminalResult: { status: 'failed', errorMessage: 'SDK U100', outcomeEvidence: null },
  },
  ...extra,
})

/** La MISMA fila después de que OTRO proceso la re-retuviera: TIMED_OUT con el marcador de la familia. */
const retenidaPorOtro = () =>
  liberada({
    status: 'TIMED_OUT',
    failureCode: 'PAYMENT_UNBOUND_AWAITING_REVIEW',
    resultJson: {
      requestId: 'REQ-D',
      status: 'timeout',
      outcomeEvidence: null,
      errorMessage: 'La terminal afirmó haber cobrado este intento después de liberarlo. No lo cobres otra vez: se está revisando.',
    },
  })

let alerta: jest.SpyInstance

beforeEach(() => {
  alerta = jest.spyOn(opsAlert, 'sendOpsAlert').mockResolvedValue(true as never)
  tpr().findFirst.mockReset().mockResolvedValue(null)
  tpr().findMany.mockReset().mockResolvedValue([])
  tpr().updateMany.mockReset().mockResolvedValue({ count: 0 })
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
  svc.contradiccionesDeLaRed?.clear?.()
})
afterEach(() => alerta.mockRestore())

// ══════════════ P1-C(b) · `closeRow` proyecta la fila que existe AHORA, gane quien gane ══════════════
describe('Ronda 4 · P1-C(b): la carrera de `closeRow` — la respuesta describe la fila ACTUAL, no la de hace tres líneas', () => {
  let porAfirmacion: jest.SpyInstance
  const afirmacion = { requestId: 'REQ-D', status: 'success' as const, transactionId: '260917120000' }

  /**
   * La secuencia que Codex reprodujo: `escribirSuccessDegradado` ve la fila LIBERADA (ningún brazo la acepta, así que
   * devuelve su proyección: «Se puede volver a cobrar»), y ENTRE esa lectura y la respuesta otro proceso la mueve.
   */
  const otroProcesoLaMueve = (despues: () => any) => {
    let movida = false
    tpr().findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.OR) return null // la fila liberada no entra en el brazo en vuelo ni en el tardío
      return movida ? despues() : liberada()
    })
    porAfirmacion.mockImplementation(async () => {
      movida = true
      return 'NOT_APPLICABLE' // el núcleo, bajo los candados, ya no la ve liberada: no es SU retención
    })
  }

  beforeEach(() => {
    porAfirmacion = jest.spyOn(svc, 'retenerSolicitudLiberadaPorAfirmacionDeLaTerminal').mockResolvedValue('NOT_APPLICABLE')
  })
  afterEach(() => porAfirmacion.mockRestore())

  it('🔴 otro proceso RETIENE la fila en medio: la respuesta es «se está revisando», nunca «puedes volver a cobrar»', async () => {
    otroProcesoLaMueve(retenidaPorOtro)
    const r = await svc.closeRow('REQ-D', 'venue-1', afirmacion)
    expect(r.status).toBe('timeout')
    expect(String(r.errorMessage)).toMatch(/se está revisando/)
    expect(String(r.errorMessage)).not.toMatch(/volver a cobrar/)
  })

  it('🔴 otro proceso COMPLETA la fila en medio: la respuesta es el éxito con su `paymentId`', async () => {
    otroProcesoLaMueve(() =>
      liberada({ status: 'COMPLETED', failureCode: null, paymentId: 'pay-otro', resultJson: { requestId: 'REQ-D', status: 'success' } }),
    )
    const r = await svc.closeRow('REQ-D', 'venue-1', afirmacion)
    expect(r.status).toBe('success')
    expect(r.paymentId).toBe('pay-otro')
  })

  it('🔴 con la re-retención DIFERIDA la fila sigue liberada, y aun así NO se contesta «puedes volver a cobrar»', async () => {
    porAfirmacion.mockResolvedValue('DEFERRED')
    tpr().findFirst.mockImplementation(async ({ where }: any) => (where?.OR ? null : liberada()))
    const r = await svc.closeRow('REQ-D', 'venue-1', afirmacion)
    expect(r.status).toBe('timeout')
    expect(String(r.errorMessage)).not.toMatch(/volver a cobrar/)
  })

  it('la relectura ocurre DESPUÉS de pedir la re-retención, gane o no (`NOT_APPLICABLE` incluido)', async () => {
    tpr().findFirst.mockImplementation(async ({ where }: any) => (where?.OR ? null : liberada()))
    await svc.closeRow('REQ-D', 'venue-1', afirmacion)
    expect(porAfirmacion).toHaveBeenCalledWith({ requestId: 'REQ-D', venueId: 'venue-1', origen: 'SOCKET' })
    // 🔴 Lo que guarda el arreglo: con el `return escrito` anterior NO había ninguna lectura después de la re-retención.
    const pedido = porAfirmacion.mock.invocationCallOrder[0]
    const despues = tpr()
      .findFirst.mock.calls.map((c: any[], i: number) => ({ where: c[0]?.where, orden: tpr().findFirst.mock.invocationCallOrder[i] }))
      .filter((x: { where: any; orden: number }) => !x.where?.OR && x.orden > pedido)
    expect(despues).toHaveLength(1)
  })

  it('control: si la re-retención GANA, se sigue devolviendo la fila retenida', async () => {
    porAfirmacion.mockResolvedValue('HELD')
    tpr().findFirst.mockImplementation(async ({ where }: any) => (where?.OR ? null : retenidaPorOtro()))
    const r = await svc.closeRow('REQ-D', 'venue-1', afirmacion)
    expect(r.status).toBe('timeout')
    expect(String(r.errorMessage)).toMatch(/se está revisando/)
  })
})

// ══════════════ Fix de RAÍZ · la red durable recoge TODO lo que quedó a medias ══════════════
describe('Ronda 4 · la evidencia de conciliación, CORRELACIONADA para el selector de la red', () => {
  it('pregunta lo MISMO que el CAS, sobre las columnas de la fila', () => {
    const { sql } = evidenciaDeConciliacionDeLaFilaSql('r')
    expect(sql).toContain('r."requestId"')
    expect(sql).toContain('r."venueId"')
    expect(sql).toContain(`p."status" = 'PENDING'`)
    expect(sql).toContain('POSSIBLE_REFERENCE_COLLISION')
    expect(sql).toContain('POSSIBLE_SECOND_CAPTURE')
    // 🔴 El MISMO cuerpo que la de parámetros: si divergieran, el selector y el CAS dirían cosas distintas de la misma evidencia.
    const normalizar = (s: string) =>
      s
        .replace(/\?/g, 'X')
        .replace(/r\."(requestId|venueId)"/g, 'X')
        .replace(/\s+/g, ' ')
        .trim()
    expect(normalizar(hayEvidenciaDeConciliacionSql('REQ-D', 'venue-1').sql)).toContain(normalizar(sql))
  })

  it('un alias que no sea un identificador simple se rechaza', () => {
    expect(() => evidenciaDeConciliacionDeLaFilaSql('r"; DROP TABLE "Payment')).toThrow(/Alias de tabla inválido/)
  })
})

describe('Ronda 4 · la red durable: el selector recoge las TRES señales, no sólo el Payment ligado', () => {
  const CONSULTA = 'liberadas-con-senal'
  const consultas = () => prismaMock.$queryRaw.mock.calls.filter((c: any[]) => (c[0] as string[]).join('?').includes(CONSULTA))
  const textoDeLaConsulta = () => {
    const { texto, fragmentos } = sqlDe(consultas()[0])
    return texto + ' ' + fragmentos.join(' ')
  }

  it('UNA consulta por lote con las tres clases: cobro ligado, evidencia de colisión y afirmación de la terminal', async () => {
    await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
    expect(consultas()).toHaveLength(1)
    const completo = textoDeLaConsulta()
    // Las dos correlacionadas, como LATERAL (filtran y traen el id para el aviso).
    expect(completo).toContain('LEFT JOIN LATERAL')
    expect(completo).toContain(`#> '{terminalPaymentRequestId}' = to_jsonb(r."requestId"::text)`)
    expect(completo).toContain(`p."status" = 'PENDING'`)
    // La tercera clase es una prueba sobre la propia fila (la afirmación vive en su sobre).
    expect(completo).toContain(`r."resultJson"->'claimedSuccess'`)
    // Y las tres van en UN solo `OR`: el mismo recorrido, el mismo tope, el mismo cursor.
    expect(completo).toMatch(/ligado\."id" IS NOT NULL OR .*colision\."id" IS NOT NULL/s)
    expect(completo).toMatch(/ORDER BY r\."createdAt" ASC, r\."id" ASC/)
    const { values } = sqlDe(consultas()[0])
    expect(values).toContain(200)
    expect(JSON.stringify(values)).toContain('2026-09-10T12:00:00')
  })

  it('🔴 una liberada con EVIDENCIA de colisión y sin cobro ligado se re-retiene por su variante, con origen BARRIDO_SENALES', async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
      (strings as string[]).join('?').includes(CONSULTA)
        ? [
            {
              requestId: 'REQ-D',
              venueId: 'venue-1',
              createdAt: new Date('2026-09-16T00:00:00Z'),
              id: 'row-d',
              paymentId: null,
              evidenciaId: 'pay-evidencia',
              afirmacion: false,
            },
          ]
        : [],
    )
    tpr().findFirst.mockResolvedValue(liberada())
    const veredicto = jest.spyOn(svc, 'conciliarORetenerLiberada').mockResolvedValue('NADA')
    const colision = jest.spyOn(svc, 'retenerSolicitudLiberadaPorColisionDeReferencia').mockResolvedValue('HELD')
    try {
      const r = await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
      expect(veredicto).toHaveBeenCalledTimes(1) // el veredicto COMPARTIDO va primero
      expect(colision).toHaveBeenCalledWith({
        requestId: 'REQ-D',
        venueId: 'venue-1',
        paymentId: 'pay-evidencia',
        origen: 'BARRIDO_SENALES',
      })
      expect(r).toMatchObject({ sinPago: 1 })
    } finally {
      veredicto.mockRestore()
      colision.mockRestore()
    }
  })

  it('🔴 una liberada con la AFIRMACIÓN de la terminal y sin Payment se re-retiene por su variante', async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
      (strings as string[]).join('?').includes(CONSULTA)
        ? [
            {
              requestId: 'REQ-D',
              venueId: 'venue-1',
              createdAt: new Date('2026-09-16T00:00:00Z'),
              id: 'row-d',
              paymentId: null,
              evidenciaId: null,
              afirmacion: true,
            },
          ]
        : [],
    )
    tpr().findFirst.mockResolvedValue(liberada())
    const veredicto = jest.spyOn(svc, 'conciliarORetenerLiberada').mockResolvedValue('NADA')
    const porAfirmacion = jest.spyOn(svc, 'retenerSolicitudLiberadaPorAfirmacionDeLaTerminal').mockResolvedValue('HELD')
    try {
      const r = await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
      expect(porAfirmacion).toHaveBeenCalledWith({ requestId: 'REQ-D', venueId: 'venue-1', origen: 'BARRIDO_SENALES' })
      expect(r).toMatchObject({ sinPago: 1 })
    } finally {
      veredicto.mockRestore()
      porAfirmacion.mockRestore()
    }
  })

  it('🔴 el veredicto COMPARTIDO manda: si el cobro es atribuible y se concilia, no se pide ninguna variante', async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
      (strings as string[]).join('?').includes(CONSULTA)
        ? [
            {
              requestId: 'REQ-D',
              venueId: 'venue-1',
              createdAt: new Date('2026-09-16T00:00:00Z'),
              id: 'row-d',
              paymentId: 'pay-1',
              evidenciaId: 'pay-evidencia',
              afirmacion: true,
            },
          ]
        : [],
    )
    tpr().findFirst.mockResolvedValue(liberada())
    const veredicto = jest.spyOn(svc, 'conciliarORetenerLiberada').mockResolvedValue('RECONCILED')
    const colision = jest.spyOn(svc, 'retenerSolicitudLiberadaPorColisionDeReferencia').mockResolvedValue('HELD')
    const porAfirmacion = jest.spyOn(svc, 'retenerSolicitudLiberadaPorAfirmacionDeLaTerminal').mockResolvedValue('HELD')
    try {
      const r = await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
      expect(colision).not.toHaveBeenCalled()
      expect(porAfirmacion).not.toHaveBeenCalled()
      expect(r).toMatchObject({ conPago: 0, sinPago: 0 })
    } finally {
      veredicto.mockRestore()
      colision.mockRestore()
      porAfirmacion.mockRestore()
    }
  })

  it('una contradicción de identidad no se vuelve a gritar en cada pasada (el 🚨 no puede repetirse cada 30 s)', async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: string[]) =>
      (strings as string[]).join('?').includes(CONSULTA)
        ? [
            {
              requestId: 'REQ-D',
              venueId: 'venue-1',
              createdAt: new Date('2026-09-16T00:00:00Z'),
              id: 'row-d',
              paymentId: null,
              evidenciaId: 'pay-evidencia',
              afirmacion: false,
            },
          ]
        : [],
    )
    tpr().findFirst.mockResolvedValue(liberada())
    const veredicto = jest.spyOn(svc, 'conciliarORetenerLiberada').mockResolvedValue('NADA')
    const colision = jest.spyOn(svc, 'retenerSolicitudLiberadaPorColisionDeReferencia').mockResolvedValue('IDENTITY_MISMATCH')
    try {
      await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:00.000Z'))
      await svc.retenerLiberadasConSenalPositiva(new Date('2026-09-17T12:00:30.000Z'))
      expect(colision).toHaveBeenCalledTimes(1)
    } finally {
      veredicto.mockRestore()
      colision.mockRestore()
    }
  })

  it('la pasada del watchdog reporta las dos cuentas: con Payment y sin Payment', async () => {
    const red = jest.spyOn(svc, 'retenerLiberadasConSenalPositiva').mockResolvedValue({ conPago: 2, sinPago: 3 })
    tpr().findMany.mockResolvedValue([])
    try {
      const r = await svc.reconcileUnknownRequests(new Date())
      expect(r.heldWithLinkedPayment).toBe(2)
      expect(r.heldWithoutPayment).toBe(3)
    } finally {
      red.mockRestore()
    }
  })
})

// ══════════════ P2 · «no pude comprobar» no es «comprobé y no había nada» ══════════════
describe('Ronda 4 · P2: una lectura fallida del vínculo se reporta como DIFERIDA, nunca como comprobación terminada', () => {
  const pago = {
    id: 'pay-1',
    venueId: 'venue-1',
    status: 'COMPLETED',
    method: 'CREDIT_CARD',
    type: null,
    idempotencyKey: 'att-1',
    terminalPaymentRequestId: null,
    processorData: null,
  }

  it('🔴 si la lectura del vínculo revienta, el resultado incluye un `DEFERRED` (el backfill NO puede sellar)', async () => {
    prismaMock.terminalPaymentAttemptLink.findUnique.mockRejectedValue(new Error('base caída'))
    const r = await svc.retenerLiberadasPorPagoSinLigar(pago, 'BACKFILL')
    expect(r.some((x: any) => x.resultado === 'DEFERRED')).toBe(true)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('control: sin vínculo (leído bien) y sin otras identidades, la comprobación SÍ terminó — lista vacía', async () => {
    prismaMock.terminalPaymentAttemptLink.findUnique.mockResolvedValue(null)
    expect(await svc.retenerLiberadasPorPagoSinLigar(pago, 'BACKFILL')).toEqual([])
  })

  it('control: un pago que no es cobro con tarjeta COMPLETED se descarta sin diferir nada', async () => {
    expect(await svc.retenerLiberadasPorPagoSinLigar({ ...pago, status: 'PENDING' }, 'BACKFILL')).toEqual([])
  })
})

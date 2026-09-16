/**
 * §8 C.1 — DESENLACE CANÓNICO del cobro con terminal, por LISTA BLANCA de `(status, failureCode)`.
 *
 * 🔴 Por qué lista blanca y no lista negra: la traducción vieja (`hasUnprovenLegacyOutcome`) enumeraba los códigos
 * MALOS, así que cualquier código nuevo, manual o desconocido salía como «no se cobró» — y las apps publicadas leen
 * FAILED como desenlace final y sueltan su llave durable. Un código que nadie clasificó tiene que ser UNRESOLVED:
 * es la única dirección que no regala dinero.
 *
 * La tabla de abajo lleva UN caso por cada escritor real de `(status, failureCode)` del árbol (y por los que HEAD
 * dejó escritos en producción), más los desconocidos. Si alguien añade un escritor sin clasificarlo aquí, la prueba
 * «ningún código fuera de la lista blanca es NOT_CHARGED» lo caza.
 */

import { Prisma, TerminalPaymentRequestStatus as S } from '@prisma/client'

import { desenlaceCanonico, proyectarCancelDisposition, proyectarEstado, type FilaDeDesenlace } from '@/services/terminal-payment.service'

const EVIDENCIA_DECLINADA = { outcomeEvidence: 'PROCESSOR_DECLINED' } as Prisma.JsonValue
const EVIDENCIA_PREAUTH = { outcomeEvidence: 'PRE_AUTHORIZATION' } as Prisma.JsonValue

function fila(overrides: Partial<FilaDeDesenlace> & { status: S }): FilaDeDesenlace {
  return { failureCode: null, cancelDisposition: null, paymentId: null, resultJson: null, ...overrides }
}

/** [nombre, fila, outcome, evidencia, clase] — el escritor real va en el nombre. */
type Caso = [string, FilaDeDesenlace, string, string | null, string | null]

const CASOS: Caso[] = [
  // ── CHARGED ────────────────────────────────────────────────────────────────────────────────────
  [
    'closeRowFromPaymentTx / vigía: COMPLETED con Payment',
    fila({ status: S.COMPLETED, paymentId: 'pay-1' }),
    'CHARGED',
    'PAYMENT_RECORDED',
    'TERMINAL',
  ],
  [
    'marcaDeDescuadre: COMPLETED + CONTRACT_MISMATCH (el dinero salió; lo concilia un humano)',
    fila({ status: S.COMPLETED, paymentId: 'pay-1', failureCode: 'CONTRACT_MISMATCH' }),
    'CHARGED',
    'PAYMENT_RECORDED',
    'TERMINAL',
  ],
  ['COMPLETED SIN Payment no prueba cobro', fila({ status: S.COMPLETED }), 'UNRESOLVED', null, null],

  // ── NOT_CHARGED: lápida de admisión (H.5/H.6) ──────────────────────────────────────────────────
  [
    'lápida :707 REJECTED_TERMINAL_NOT_CONNECTED',
    fila({ status: S.FAILED, failureCode: 'REJECTED_TERMINAL_NOT_CONNECTED' }),
    'NOT_CHARGED',
    'REJECTED_AT_ADMISSION',
    'SERVER',
  ],
  [
    'lápida :707 REJECTED_TERMINAL_NO_SOCKET',
    fila({ status: S.FAILED, failureCode: 'REJECTED_TERMINAL_NO_SOCKET' }),
    'NOT_CHARGED',
    'REJECTED_AT_ADMISSION',
    'SERVER',
  ],
  [
    'lápida :707 REJECTED_TERMINAL_OTHER_VENUE',
    fila({ status: S.FAILED, failureCode: 'REJECTED_TERMINAL_OTHER_VENUE' }),
    'NOT_CHARGED',
    'REJECTED_AT_ADMISSION',
    'SERVER',
  ],
  [
    'lápida :707 REJECTED_TERMINAL_BUSY',
    fila({ status: S.FAILED, failureCode: 'REJECTED_TERMINAL_BUSY' }),
    'NOT_CHARGED',
    'REJECTED_AT_ADMISSION',
    'SERVER',
  ],
  [
    'lápida :707 REJECTED_ORDER_BUSY',
    fila({ status: S.FAILED, failureCode: 'REJECTED_ORDER_BUSY' }),
    'NOT_CHARGED',
    'REJECTED_AT_ADMISSION',
    'SERVER',
  ],
  [
    'lápida :707 REJECTED_ORDER_CANCELLED',
    fila({ status: S.FAILED, failureCode: 'REJECTED_ORDER_CANCELLED' }),
    'NOT_CHARGED',
    'REJECTED_AT_ADMISSION',
    'SERVER',
  ],
  [
    'lápida :707 REJECTED_ORDER_PAID',
    fila({ status: S.FAILED, failureCode: 'REJECTED_ORDER_PAID' }),
    'NOT_CHARGED',
    'REJECTED_AT_ADMISSION',
    'SERVER',
  ],
  [
    'lápida :707 REJECTED_ORDER_NOT_FOUND',
    fila({ status: S.FAILED, failureCode: 'REJECTED_ORDER_NOT_FOUND' }),
    'NOT_CHARGED',
    'REJECTED_AT_ADMISSION',
    'SERVER',
  ],

  // ── NOT_CHARGED: evidencia de la terminal ──────────────────────────────────────────────────────
  [
    'closeRow :1424 FAILED/TPV_CONFIRMED_NO_CHARGE con PROCESSOR_DECLINED',
    fila({ status: S.FAILED, failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: EVIDENCIA_DECLINADA }),
    'NOT_CHARGED',
    'PROCESSOR_DECLINED',
    'TERMINAL',
  ],
  [
    'closeRow :1424 FAILED/TPV_CONFIRMED_NO_CHARGE con PRE_AUTHORIZATION',
    fila({ status: S.FAILED, failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: EVIDENCIA_PREAUTH }),
    'NOT_CHARGED',
    'PRE_AUTHORIZATION',
    'TERMINAL',
  ],
  [
    'sonda :2662 FAILED/TPV_NEVER_RECEIVED',
    fila({ status: S.FAILED, failureCode: 'TPV_NEVER_RECEIVED' }),
    'NOT_CHARGED',
    'NEVER_DELIVERED',
    'SERVER',
  ],
  [
    'preparado para A: FAILED/TPV_INBOX_NOT_FOUND',
    fila({ status: S.FAILED, failureCode: 'TPV_INBOX_NOT_FOUND' }),
    'NOT_CHARGED',
    'NOT_FOUND_CONTINUOUS_INBOX',
    'TERMINAL',
  ],
  [
    'preparado para B: FAILED/OPERATOR_RECONCILED_NO_CHARGE',
    fila({ status: S.FAILED, failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' }),
    'NOT_CHARGED',
    'OPERATOR_RECONCILED',
    'OPERATOR',
  ],
  [
    'handleCancelDispositionFromSocket :2424 CANCELLED + ACCEPTED',
    fila({ status: S.CANCELLED, cancelDisposition: 'ACCEPTED' }),
    'NOT_CHARGED',
    'CANCEL_ACCEPTED',
    'TERMINAL',
  ],
  [
    'closeRow :1426 CANCELLED + ACCEPTED con evidencia en el sobre',
    fila({ status: S.CANCELLED, cancelDisposition: 'ACCEPTED', resultJson: EVIDENCIA_PREAUTH }),
    'NOT_CHARGED',
    'CANCEL_ACCEPTED',
    'TERMINAL',
  ],

  // ── UNRESOLVED: en vuelo ───────────────────────────────────────────────────────────────────────
  ['admisión :841 PENDING', fila({ status: S.PENDING }), 'UNRESOLVED', null, null],
  ['markDelivered :1198 SENT', fila({ status: S.SENT }), 'UNRESOLVED', null, null],
  ['cancelPayment :2372 CANCEL_REQUESTED', fila({ status: S.CANCEL_REQUESTED }), 'UNRESOLVED', null, null],
  [
    'CANCEL_REQUESTED con disposición ACTIVE (la terminal dijo «sigue vivo»)',
    fila({ status: S.CANCEL_REQUESTED, cancelDisposition: 'ACTIVE' }),
    'UNRESOLVED',
    null,
    null,
  ],

  // ── UNRESOLVED: UNKNOWN, con cualquier código ──────────────────────────────────────────────────
  ['ACK perdido :1063 UNKNOWN/ACK_TIMEOUT', fila({ status: S.UNKNOWN, failureCode: 'ACK_TIMEOUT' }), 'UNRESOLVED', null, null],
  ['ACK rechazado :1063 UNKNOWN/ACK_REJECTED', fila({ status: S.UNKNOWN, failureCode: 'ACK_REJECTED' }), 'UNRESOLVED', null, null],
  [
    'failUndelivered :1004 UNKNOWN/SOCKET_NOT_FOUND',
    fila({ status: S.UNKNOWN, failureCode: 'SOCKET_NOT_FOUND' }),
    'UNRESOLVED',
    null,
    null,
  ],
  [
    'failUndelivered :1029 UNKNOWN/DELIVERY_NOT_RECORDED',
    fila({ status: S.UNKNOWN, failureCode: 'DELIVERY_NOT_RECORDED' }),
    'UNRESOLVED',
    null,
    null,
  ],
  ['vigía :1797 UNKNOWN/TIMED_OUT', fila({ status: S.UNKNOWN, failureCode: 'TIMED_OUT' }), 'UNRESOLVED', null, null],
  ['closeRow degradado a timeout :1424 UNKNOWN sin código', fila({ status: S.UNKNOWN }), 'UNRESOLVED', null, null],

  // ── UNRESOLVED: TIMED_OUT (lo escribió HEAD en PRODUCCIÓN; el árbol ya no) ──────────────────────
  ['producción HEAD TIMED_OUT/AUTO_RELEASED', fila({ status: S.TIMED_OUT, failureCode: 'AUTO_RELEASED' }), 'UNRESOLVED', null, null],
  ['producción HEAD TIMED_OUT/MANUAL_RELEASE', fila({ status: S.TIMED_OUT, failureCode: 'MANUAL_RELEASE' }), 'UNRESOLVED', null, null],
  ['producción HEAD TIMED_OUT/MANUAL_RECONCILE', fila({ status: S.TIMED_OUT, failureCode: 'MANUAL_RECONCILE' }), 'UNRESOLVED', null, null],
  ['TIMED_OUT sin código', fila({ status: S.TIMED_OUT }), 'UNRESOLVED', null, null],

  // ── UNRESOLVED: FAILED que NO acredita nada ────────────────────────────────────────────────────
  [
    'legacy FAILED/TPV_ERROR (6 filas reales en producción)',
    fila({ status: S.FAILED, failureCode: 'TPV_ERROR' }),
    'UNRESOLVED',
    null,
    null,
  ],
  ['legacy FAILED/ACK_TIMEOUT', fila({ status: S.FAILED, failureCode: 'ACK_TIMEOUT' }), 'UNRESOLVED', null, null],
  ['legacy FAILED/ACK_REJECTED', fila({ status: S.FAILED, failureCode: 'ACK_REJECTED' }), 'UNRESOLVED', null, null],
  [
    'legacy FAILED/SOCKET_NOT_FOUND (hoy salía FAILED: lista negra)',
    fila({ status: S.FAILED, failureCode: 'SOCKET_NOT_FOUND' }),
    'UNRESOLVED',
    null,
    null,
  ],
  ['legacy FAILED/DELIVERY_NOT_RECORDED', fila({ status: S.FAILED, failureCode: 'DELIVERY_NOT_RECORDED' }), 'UNRESOLVED', null, null],
  [
    'puesto a mano FAILED/QA_MANUAL_RESOLVE_NO_MONEY',
    fila({ status: S.FAILED, failureCode: 'QA_MANUAL_RESOLVE_NO_MONEY' }),
    'UNRESOLVED',
    null,
    null,
  ],
  ['FAILED sin código', fila({ status: S.FAILED }), 'UNRESOLVED', null, null],
  [
    'FAILED con un código que nadie clasificó',
    fila({ status: S.FAILED, failureCode: 'CODIGO_QUE_NADIE_CLASIFICO' }),
    'UNRESOLVED',
    null,
    null,
  ],
  [
    '🔴 FAILED/TPV_CONFIRMED_NO_CHARGE SIN evidencia en el sobre',
    fila({ status: S.FAILED, failureCode: 'TPV_CONFIRMED_NO_CHARGE' }),
    'UNRESOLVED',
    null,
    null,
  ],
  [
    '🔴 FAILED/TPV_CONFIRMED_NO_CHARGE con un sobre sin la llave',
    fila({ status: S.FAILED, failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: {} as Prisma.JsonValue }),
    'UNRESOLVED',
    null,
    null,
  ],
  [
    '🔴 FAILED/TPV_CONFIRMED_NO_CHARGE con una evidencia que no acredita',
    fila({ status: S.FAILED, failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: { outcomeEvidence: 'OTRA_COSA' } as Prisma.JsonValue }),
    'UNRESOLVED',
    null,
    null,
  ],
  [
    'FAILED/TPV_CONFIRMED_NO_CHARGE con un sobre que no es objeto',
    fila({ status: S.FAILED, failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: [1, 2] as unknown as Prisma.JsonValue }),
    'UNRESOLVED',
    null,
    null,
  ],

  // ── UNRESOLVED: CANCELLED sin aceptación de la terminal ────────────────────────────────────────
  ['CANCELLED sin disposición (gracia del vigía en producción)', fila({ status: S.CANCELLED }), 'UNRESOLVED', null, null],
  [
    'CANCELLED + ACTIVE (la terminal dijo que seguía vivo)',
    fila({ status: S.CANCELLED, cancelDisposition: 'ACTIVE' }),
    'UNRESOLVED',
    null,
    null,
  ],
  ['CANCELLED + ALREADY_RESOLVED', fila({ status: S.CANCELLED, cancelDisposition: 'ALREADY_RESOLVED' }), 'UNRESOLVED', null, null],
  ['CANCELLED + una disposición desconocida', fila({ status: S.CANCELLED, cancelDisposition: 'LO_QUE_SEA' }), 'UNRESOLVED', null, null],
]

describe('desenlaceCanonico — tabla por (status, failureCode), un caso por escritor real', () => {
  it.each(CASOS)('%s', (_nombre, row, outcome, outcomeEvidence, evidenceClass) => {
    expect(desenlaceCanonico(row)).toMatchObject({ outcome, outcomeEvidence, evidenceClass })
  })

  it('CONTRACT_MISMATCH sobre un COMPLETED pide conciliación; un COMPLETED normal no', () => {
    expect(
      desenlaceCanonico(fila({ status: S.COMPLETED, paymentId: 'pay-1', failureCode: 'CONTRACT_MISMATCH' })).reconciliationRequired,
    ).toBe(true)
    expect(desenlaceCanonico(fila({ status: S.COMPLETED, paymentId: 'pay-1' })).reconciliationRequired).toBeUndefined()
  })

  it('🔴 CONTRACT_MISMATCH sin Payment NO es un cobro: sigue UNRESOLVED y sin pedir conciliación', () => {
    const d = desenlaceCanonico(fila({ status: S.COMPLETED, failureCode: 'CONTRACT_MISMATCH' }))
    expect(d.outcome).toBe('UNRESOLVED')
    expect(d.reconciliationRequired).toBeUndefined()
  })
})

describe('invariantes de la lista blanca', () => {
  const TODOS_LOS_ESTADOS = Object.values(S)
  const CODIGOS = [
    null,
    'ACK_TIMEOUT',
    'ACK_REJECTED',
    'TPV_ERROR',
    'SOCKET_NOT_FOUND',
    'DELIVERY_NOT_RECORDED',
    'TIMED_OUT',
    'AUTO_RELEASED',
    'MANUAL_RELEASE',
    'MANUAL_RECONCILE',
    'CONTRACT_MISMATCH',
    'QA_MANUAL_RESOLVE_NO_MONEY',
    'CODIGO_DESCONOCIDO',
    'TPV_CONFIRMED_NO_CHARGE',
    'TPV_NEVER_RECEIVED',
    'TPV_INBOX_NOT_FOUND',
    'OPERATOR_RECONCILED_NO_CHARGE',
    'REJECTED_TERMINAL_BUSY',
  ]
  const DISPOSICIONES = [null, 'ACTIVE', 'ACCEPTED', 'ALREADY_RESOLVED']
  const SOBRES: Prisma.JsonValue[] = [
    null as unknown as Prisma.JsonValue,
    {} as Prisma.JsonValue,
    EVIDENCIA_DECLINADA,
    EVIDENCIA_PREAUTH,
    { outcomeEvidence: 'OTRA' } as Prisma.JsonValue,
  ]

  /** El producto cartesiano completo: 8 estados × 18 códigos × 4 disposiciones × 5 sobres × con/sin Payment. */
  function universo(): FilaDeDesenlace[] {
    const filas: FilaDeDesenlace[] = []
    for (const status of TODOS_LOS_ESTADOS)
      for (const failureCode of CODIGOS)
        for (const cancelDisposition of DISPOSICIONES)
          for (const resultJson of SOBRES)
            for (const paymentId of [null, 'pay-1']) filas.push({ status, failureCode, cancelDisposition, paymentId, resultJson })
    return filas
  }

  it('🔴 sólo CHARGED cuando hay COMPLETED con Payment — ninguna otra combinación', () => {
    for (const row of universo()) {
      const esperado = row.status === S.COMPLETED && !!row.paymentId
      expect([JSON.stringify(row), desenlaceCanonico(row).outcome === 'CHARGED']).toEqual([JSON.stringify(row), esperado])
    }
  })

  it('🔴 NOT_CHARGED SIEMPRE trae evidencia y clase; UNRESOLVED nunca las trae', () => {
    for (const row of universo()) {
      const d = desenlaceCanonico(row)
      if (d.outcome === 'UNRESOLVED') {
        expect([JSON.stringify(row), d.outcomeEvidence, d.evidenceClass]).toEqual([JSON.stringify(row), null, null])
      } else {
        expect(d.outcomeEvidence).not.toBeNull()
        expect(d.evidenceClass).not.toBeNull()
      }
    }
  })

  it('🔴 un estado NO terminal (en vuelo) nunca acredita un desenlace', () => {
    const enVuelo: S[] = [S.PENDING, S.SENT, S.CANCEL_REQUESTED]
    for (const row of universo().filter(r => enVuelo.includes(r.status))) {
      expect([JSON.stringify(row), desenlaceCanonico(row).outcome]).toEqual([JSON.stringify(row), 'UNRESOLVED'])
    }
  })

  it('🔴 UNKNOWN y TIMED_OUT son UNRESOLVED con CUALQUIER código: ningún código los acredita', () => {
    for (const row of universo().filter(r => r.status === S.UNKNOWN || r.status === S.TIMED_OUT)) {
      expect([JSON.stringify(row), desenlaceCanonico(row).outcome]).toEqual([JSON.stringify(row), 'UNRESOLVED'])
    }
  })

  it('🔴 la evidencia de un FAILED sale del CÓDIGO, nunca de la disposición ni del Payment', () => {
    for (const row of universo().filter(r => r.status === S.FAILED)) {
      const gemela = desenlaceCanonico({ ...row, cancelDisposition: null, paymentId: null })
      expect([JSON.stringify(row), desenlaceCanonico(row)]).toEqual([JSON.stringify(row), gemela])
    }
  })
})

/**
 * §8 C.1 — la PROYECCIÓN hacia el cliente. `status` conserva sus valores de siempre con UNA traducción, y
 * `cancelDisposition` deja de mentir sin dejar sin salida a las apps publicadas.
 */
describe('proyectarEstado — lo que ven las apps', () => {
  const base = {
    requestId: 'REQ-1',
    venueId: 'venue-1',
    terminalId: 'term-1',
    amountCents: 12345,
    tipCents: 55,
    orderId: null,
    senderDevice: 'tablet',
    lateResult: false,
    createdAt: new Date('2026-09-11T10:00:00.000Z'),
    updatedAt: new Date('2026-09-11T10:05:00.000Z'),
  }
  const proyectar = (row: Partial<FilaDeDesenlace> & { status: S }) => proyectarEstado({ ...base, ...fila(row) })

  it('🔴 FAILED sin desenlace acreditado se muestra UNKNOWN (las apps publicadas leen FAILED como «no se cobró»)', () => {
    for (const failureCode of ['TPV_ERROR', 'ACK_TIMEOUT', 'SOCKET_NOT_FOUND', 'QA_MANUAL_RESOLVE_NO_MONEY', 'LO_QUE_SEA', null]) {
      expect([failureCode, proyectar({ status: S.FAILED, failureCode }).status]).toEqual([failureCode, S.UNKNOWN])
    }
  })

  it('🔴 CANCELLED sin aceptación de la terminal se muestra UNKNOWN', () => {
    expect(proyectar({ status: S.CANCELLED }).status).toBe(S.UNKNOWN)
    expect(proyectar({ status: S.CANCELLED, cancelDisposition: 'ACTIVE' }).status).toBe(S.UNKNOWN)
  })

  it('🔴 una LÁPIDA de admisión NO se traduce: sale FAILED, que es lo que hace a las apps publicadas soltar su llave', () => {
    const p = proyectar({ status: S.FAILED, failureCode: 'REJECTED_TERMINAL_BUSY' })
    expect(p).toMatchObject({
      status: S.FAILED,
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'REJECTED_AT_ADMISSION',
      failureCode: 'REJECTED_TERMINAL_BUSY',
    })
  })

  it('un rechazo del banco CON evidencia sale FAILED (desenlace real), no UNKNOWN', () => {
    expect(proyectar({ status: S.FAILED, failureCode: 'TPV_CONFIRMED_NO_CHARGE', resultJson: EVIDENCIA_DECLINADA }).status).toBe(S.FAILED)
  })

  it('COMPLETED, PENDING, SENT, CANCEL_REQUESTED, UNKNOWN y TIMED_OUT nunca se traducen', () => {
    for (const status of [S.COMPLETED, S.PENDING, S.SENT, S.CANCEL_REQUESTED, S.UNKNOWN, S.TIMED_OUT]) {
      expect([status, proyectar({ status, failureCode: 'LO_QUE_SEA' }).status]).toEqual([status, status])
    }
  })

  it('🔴 un cancelDisposition ACCEPTED NUNCA se anula: es la única vía de «no se cobró» por cancelación de Android 2.18.x / iOS 1.10.x', () => {
    // Compatibilidad, tal cual la leen las apps publicadas: CANCELLED (sin traducir) + su disposición ACCEPTED.
    expect(proyectar({ status: S.CANCELLED, cancelDisposition: 'ACCEPTED' })).toMatchObject({
      status: S.CANCELLED,
      cancelDisposition: 'ACCEPTED',
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'CANCEL_ACCEPTED',
    })
    expect(proyectar({ status: S.CANCELLED, cancelDisposition: 'ACCEPTED' }).cancelDisposition).toBe('ACCEPTED')
    expect(
      proyectarCancelDisposition('ACCEPTED', { outcome: 'NOT_CHARGED', outcomeEvidence: 'CANCEL_ACCEPTED', evidenceClass: 'TERMINAL' }),
    ).toBe('ACCEPTED')
    expect(
      proyectarCancelDisposition('ACCEPTED', { outcome: 'CHARGED', outcomeEvidence: 'PAYMENT_RECORDED', evidenceClass: 'TERMINAL' }),
    ).toBe('ACCEPTED')
  })

  it('🔴 un ACTIVE viejo encima de un desenlace final se proyecta null (si no, la app dice «sigue activo» PARA SIEMPRE)', () => {
    // Cancel rechazado por la terminal (ACTIVE) y luego rechazo del banco: el cobro ya terminó.
    const rechazado = proyectar({
      status: S.FAILED,
      failureCode: 'TPV_CONFIRMED_NO_CHARGE',
      resultJson: EVIDENCIA_DECLINADA,
      cancelDisposition: 'ACTIVE',
    })
    expect(rechazado).toMatchObject({ status: S.FAILED, outcome: 'NOT_CHARGED', cancelDisposition: null })
    // Y con el cobro YA registrado, tampoco puede decir «sigue activo».
    expect(proyectar({ status: S.COMPLETED, paymentId: 'pay-1', cancelDisposition: 'ACTIVE' }).cancelDisposition).toBeNull()
  })

  it('🔴 un ACTIVE sobre un cobro TODAVÍA sin desenlace se conserva: ahí sí sigue vivo', () => {
    expect(proyectar({ status: S.CANCEL_REQUESTED, cancelDisposition: 'ACTIVE' }).cancelDisposition).toBe('ACTIVE')
    expect(proyectar({ status: S.UNKNOWN, cancelDisposition: 'ACTIVE' }).cancelDisposition).toBe('ACTIVE')
  })

  it('los campos de siempre siguen intactos y en pesos; los nuevos van al lado', () => {
    expect(proyectar({ status: S.COMPLETED, paymentId: 'pay-1' })).toEqual({
      requestId: 'REQ-1',
      venueId: 'venue-1',
      terminalId: 'term-1',
      status: S.COMPLETED,
      amount: 123.45,
      tip: 0.55,
      orderId: null,
      paymentId: 'pay-1',
      senderDevice: 'tablet',
      lateResult: false,
      cancelDisposition: null,
      failureCode: null,
      outcome: 'CHARGED',
      outcomeEvidence: 'PAYMENT_RECORDED',
      evidenceClass: 'TERMINAL',
      createdAt: '2026-09-11T10:00:00.000Z',
      updatedAt: '2026-09-11T10:05:00.000Z',
    })
  })

  it('reconciliationRequired sólo aparece cuando hay descuadre: nunca como `false`', () => {
    expect(proyectar({ status: S.COMPLETED, paymentId: 'pay-1' })).not.toHaveProperty('reconciliationRequired')
    expect(proyectar({ status: S.COMPLETED, paymentId: 'pay-1', failureCode: 'CONTRACT_MISMATCH' }).reconciliationRequired).toBe(true)
  })
})

/**
 * Los dos contraejemplos de la auditoría de Codex (P2-5, 11-sep). Van como aserciones DIRECTAS y no sólo dentro
 * de la tabla de equivalencia contra Postgres: la tabla demuestra que SQL y función coinciden, pero si ambos se
 * equivocaran igual seguiría en verde. Esto fija la respuesta correcta, no el acuerdo entre dos implementaciones.
 */
describe('P1 valores que rompían la clasificación sin que nadie los escribiera', () => {
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    'un failureCode llamado "%s" NO acredita un «no se cobró» (es una propiedad HEREDADA del objeto de códigos)',
    codigo => {
      const d = desenlaceCanonico(fila({ status: S.FAILED, failureCode: codigo }))
      // Antes de `Object.hasOwn`, el acceso pelón devolvía algo truthy del prototipo y esto salía NOT_CHARGED
      // con `outcomeEvidence: undefined` — o sea, la terminal se liberaba acreditando una evidencia inexistente.
      expect([codigo, d.outcome]).toEqual([codigo, 'UNRESOLVED'])
      expect(d.outcomeEvidence).toBeNull()
    },
  )

  it('P1 COMPLETED con paymentId CADENA VACÍA NO acredita cobro: retiene la ranura', () => {
    // `paymentId` es una referencia blanda sin FK, así que `''` cabe en el esquema. JS ya lo leía como ausente y
    // el SQL sólo miraba `IS NULL`: divergían. Se alineó hacia el lado SEGURO —los dos lo tratan como ausente—,
    // porque la alternativa era acreditar un cobro que no existe y soltar la terminal.
    const d = desenlaceCanonico(fila({ status: S.COMPLETED, paymentId: '' }))
    expect(d.outcome).toBe('UNRESOLVED')
    expect(d.outcomeEvidence).toBeNull()
  })
})

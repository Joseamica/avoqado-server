import { Prisma } from '@prisma/client'
import { elegirRegistroPorReferencia, esElMismoCobroPorReferencia } from '@/services/tpv/identidadDelCobro'

const existente = { orderId: 'orden-1', amountPesos: new Prisma.Decimal('100'), tipPesos: new Prisma.Decimal('0'), merchantAccountId: 'm1' }

describe('S0-a · identidad suficiente para deduplicar por referencia', () => {
  it('el reintento legítimo coincide en todo lo comparable', () => {
    expect(esElMismoCobroPorReferencia(existente, { orderId: 'orden-1', amountPesos: 100, tipPesos: 0, merchantAccountId: 'm1' })).toEqual({
      mismo: true,
    })
  })

  it('lo que un lado no conoce no descalifica: orden nula (venta rápida) y afiliación nula (cobro legacy)', () => {
    expect(esElMismoCobroPorReferencia(existente, { orderId: null, amountPesos: 100, tipPesos: 0, merchantAccountId: null })).toEqual({
      mismo: true,
    })
    expect(
      esElMismoCobroPorReferencia(
        { ...existente, merchantAccountId: null, tipPesos: null },
        { orderId: 'orden-1', amountPesos: 100, tipPesos: 0, merchantAccountId: 'm1' },
      ),
    ).toEqual({ mismo: true })
  })

  it.each([
    ['IMPORTE', { orderId: 'orden-1', amountPesos: 50, tipPesos: 0, merchantAccountId: 'm1' }],
    ['PROPINA', { orderId: 'orden-1', amountPesos: 100, tipPesos: 10, merchantAccountId: 'm1' }],
    ['ORDEN', { orderId: 'orden-2', amountPesos: 100, tipPesos: 0, merchantAccountId: 'm1' }],
    // Codex R7-2: otra afiliación con OTRA autorización sí demuestra otro cargo.
    ['AFILIACION', { orderId: 'orden-1', amountPesos: 100, tipPesos: 0, merchantAccountId: 'm2', authorizationNumber: 'B2' }],
  ] as const)('una diferencia en %s es otro cobro, no un reintento', (motivo, entrante) => {
    expect(esElMismoCobroPorReferencia({ ...existente, authorizationNumber: 'A1' }, entrante)).toEqual({ mismo: false, motivo })
  })

  describe('Codex R7-2 · la afiliación es un CONJUNTO de identidades (definitiva + la del APK) y el enrutamiento de hoy no demuestra que un cargo histórico sea distinto', () => {
    it('el replay cuya afiliación DEFINITIVA cambió (M1 → M2 por serial) sigue siendo el mismo cargo si la que MANDÓ el APK coincide con el registro', () => {
      expect(
        esElMismoCobroPorReferencia(existente, {
          orderId: 'orden-1',
          amountPesos: 100,
          tipPesos: 0,
          merchantAccountId: 'm2',
          merchantAccountIdDelApk: 'm1',
        }),
      ).toEqual({ mismo: true })
    })
    it('…y al revés: el registro conserva la evidencia de lo que mandó el APK (`merchantAccountIdFromApk`) y el entrante trae esa identidad', () => {
      expect(
        esElMismoCobroPorReferencia(
          { ...existente, merchantAccountId: 'm2', merchantAccountIdDelApk: 'm1' },
          { orderId: 'orden-1', amountPesos: 100, tipPesos: 0, merchantAccountId: 'm1' },
        ),
      ).toEqual({ mismo: true })
    })
    it('conjuntos que NO se cruzan y sin autorización que lo desmienta ⇒ identidad INCIERTA (evidencia, nunca venta nueva)', () => {
      expect(
        esElMismoCobroPorReferencia(existente, { orderId: 'orden-1', amountPesos: 100, tipPesos: 0, merchantAccountId: 'm2' }),
      ).toEqual({
        mismo: false,
        motivo: 'AFILIACION_INCIERTA',
      })
      expect(
        esElMismoCobroPorReferencia(
          { ...existente, authorizationNumber: 'A1' },
          { orderId: 'orden-1', amountPesos: 100, tipPesos: 0, merchantAccountId: 'm2', authorizationNumber: 'A1' },
        ),
      ).toEqual({ mismo: false, motivo: 'AFILIACION_INCIERTA' })
    })
    it('conjuntos que NO se cruzan y autorizaciones DISTINTAS ⇒ otro cargo (AFILIACION)', () => {
      expect(
        esElMismoCobroPorReferencia(
          { ...existente, authorizationNumber: 'A1' },
          { orderId: 'orden-1', amountPesos: 100, tipPesos: 0, merchantAccountId: 'm2', authorizationNumber: 'B2' },
        ),
      ).toEqual({ mismo: false, motivo: 'AFILIACION' })
    })
  })

  it('compara al centavo, no en flotantes', () => {
    expect(
      esElMismoCobroPorReferencia(
        { ...existente, amountPesos: '19.99' },
        { orderId: 'orden-1', amountPesos: 1999 / 100, tipPesos: 0, merchantAccountId: 'm1' },
      ),
    ).toEqual({ mismo: true })
    expect(
      esElMismoCobroPorReferencia(
        { ...existente, amountPesos: '19.99' },
        { orderId: 'orden-1', amountPesos: 19.98, tipPesos: 0, merchantAccountId: 'm1' },
      ),
    ).toEqual({ mismo: false, motivo: 'IMPORTE' })
  })
})

describe('Codex R1 · P1-1c: la llave fuerte manda sobre la referencia débil', () => {
  const huella = { orderId: 'orden-1', amountPesos: 100, tipPesos: 0, merchantAccountId: 'm1' }

  it('dos llaves presentes y DISTINTAS son dos intentos aunque todo lo demás coincida (misma referencia = mismo segundo)', () => {
    expect(esElMismoCobroPorReferencia({ ...existente, idempotencyKey: 'intento-A' }, { ...huella, idempotencyKey: 'intento-B' })).toEqual({
      mismo: false,
      motivo: 'LLAVE',
    })
  })

  it('la misma llave no descalifica, y una llave ausente en cualquiera de los dos lados tampoco (cobro legacy sin llave)', () => {
    expect(esElMismoCobroPorReferencia({ ...existente, idempotencyKey: 'intento-A' }, { ...huella, idempotencyKey: 'intento-A' })).toEqual({
      mismo: true,
    })
    expect(esElMismoCobroPorReferencia({ ...existente, idempotencyKey: null }, { ...huella, idempotencyKey: 'intento-B' })).toEqual({
      mismo: true,
    })
    expect(esElMismoCobroPorReferencia({ ...existente, idempotencyKey: 'intento-A' }, { ...huella, idempotencyKey: undefined })).toEqual({
      mismo: true,
    })
  })

  it('la llave se juzga ANTES que el dinero: con llaves distintas el motivo es LLAVE, no IMPORTE', () => {
    expect(
      esElMismoCobroPorReferencia(
        { ...existente, idempotencyKey: 'intento-A' },
        { ...huella, amountPesos: 50, idempotencyKey: 'intento-B' },
      ),
    ).toEqual({ mismo: false, motivo: 'LLAVE' })
  })
})

describe('Codex R1 · P1-1 (diseño de S0-a): sin llave, la referencia exige además la misma terminal y la misma solicitud', () => {
  const huella = { orderId: 'orden-1', amountPesos: 100, tipPesos: 0, merchantAccountId: 'm1' }

  it('dos terminales distintas en el mismo segundo son dos cobros (con o sin prefijo AVQD-)', () => {
    expect(esElMismoCobroPorReferencia({ ...existente, terminalSerial: 'AVQD-N86A' }, { ...huella, terminalSerial: 'n86b' })).toEqual({
      mismo: false,
      motivo: 'TERMINAL',
    })
    expect(esElMismoCobroPorReferencia({ ...existente, terminalSerial: 'AVQD-N86A' }, { ...huella, terminalSerial: 'n86a' })).toEqual({
      mismo: true,
    })
  })

  it('dos solicitudes distintas son dos cobros; una solicitud desconocida de un lado no descalifica', () => {
    expect(
      esElMismoCobroPorReferencia({ ...existente, terminalPaymentRequestId: 'req-1' }, { ...huella, terminalPaymentRequestId: 'req-2' }),
    ).toEqual({ mismo: false, motivo: 'SOLICITUD' })
    expect(
      esElMismoCobroPorReferencia({ ...existente, terminalPaymentRequestId: null }, { ...huella, terminalPaymentRequestId: 'req-2' }),
    ).toEqual({
      mismo: true,
    })
  })

  it('un entrante acreditado por vínculo (exigeLlave) NUNCA es el mismo cobro que un Payment sin llave', () => {
    expect(
      esElMismoCobroPorReferencia({ ...existente, idempotencyKey: null }, { ...huella, idempotencyKey: 'intento-A', exigeLlave: true }),
    ).toEqual({
      mismo: false,
      motivo: 'LLAVE',
    })
    // Sin exigirla (REST), el Payment legacy sin llave sigue siendo un reintento válido de la transición APK viejo → nuevo.
    expect(esElMismoCobroPorReferencia({ ...existente, idempotencyKey: null }, { ...huella, idempotencyKey: 'intento-A' })).toEqual({
      mismo: true,
    })
  })
})

describe('Codex R2 · P1-1: entre varios candidatos de la misma referencia se elige el que tiene identidad suficiente', () => {
  const huella = { orderId: null, amountPesos: 100, tipPesos: 0, merchantAccountId: 'm1' }
  const A = { id: 'A', ...huella, idempotencyKey: 'llave-A', terminalSerial: 'AVQD-T1' }
  const B = { id: 'B', ...huella, idempotencyKey: null, terminalSerial: 'AVQD-T2' }

  it('el replay legacy de B (sin llave, T2) encuentra a B aunque A (con llave, T1) venga primero en la lista', () => {
    expect(elegirRegistroPorReferencia([A, B], { ...huella, idempotencyKey: null, terminalSerial: 'AVQD-T2' }).elegido?.id).toBe('B')
  })

  it('descartar al primer candidato NO es permiso para crear: sólo se crea cuando NINGUNO tiene identidad suficiente', () => {
    const ninguno = elegirRegistroPorReferencia([A, B], { ...huella, idempotencyKey: null, terminalSerial: 'AVQD-T3' })
    expect(ninguno.elegido).toBeNull()
    expect(ninguno.descartes).toEqual([
      { id: 'B', motivo: 'TERMINAL' },
      { id: 'A', motivo: 'TERMINAL' },
    ])
    expect(elegirRegistroPorReferencia([], { ...huella, idempotencyKey: null }).elegido).toBeNull()
  })

  it('un entrante SIN llave prefiere al candidato sin llave (legacy ↔ legacy) sobre uno con llave de la misma terminal', () => {
    const A1 = { ...A, terminalSerial: 'AVQD-T2' }
    expect(elegirRegistroPorReferencia([A1, B], { ...huella, idempotencyKey: null, terminalSerial: 'AVQD-T2' }).elegido?.id).toBe('B')
  })
})

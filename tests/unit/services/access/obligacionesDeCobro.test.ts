/**
 * V5-A (diseño v5, autorizado con cambios por Codex el 22-sep-2026): el núcleo PURO de la compra.
 *
 * Tres preguntas, sin base ni Stripe, para que la regla viva en un solo sitio y se pueda auditar:
 *   1. ¿Qué vende esta suscripción? (plan · función · ajeno · desconocido — desconocido NUNCA es «nada»)
 *   2. ¿Es compatible una obligación nueva con lo que el cliente ya tiene vivo en Stripe?
 *   3. Al entregar una suscripción de plan, ¿qué se hace con las filas de los DOS tiers?
 */
import {
  clasificarEstado,
  clasificarSuscripcion,
  decidirEntregaDePlan,
  evaluarCompatibilidad,
  type CatalogoDeCobro,
  type ObligacionViva,
} from '@/services/access/obligacionesDeCobro'

const catalogo: CatalogoDeCobro = {
  productoAFuncion: { prod_pro: 'PLAN_PRO', prod_premium: 'PLAN_PREMIUM', prod_inv: 'INVENTORY_TRACKING', prod_cfdi: 'CFDI' },
  productosAjenos: new Set(['prod_tokens']),
}
const item = (productId: string, lookupKey: string | null = null) => ({ priceId: `price_${productId}`, productId, lookupKey })

describe('clasificarSuscripcion — qué vende', () => {
  it('un plan se reconoce por su lookup_key aunque el producto no esté en el catálogo (precio histórico)', () => {
    const r = clasificarSuscripcion([item('prod_viejo', 'plan_premium_annual')], catalogo)
    expect(r.proyecciones).toEqual([{ tipo: 'PLAN', tier: 'PREMIUM' }])
  })

  it('una función se reconoce por su PRODUCTO, no por el precio vigente del catálogo', () => {
    const r = clasificarSuscripcion([item('prod_inv')], catalogo)
    expect(r.proyecciones).toEqual([{ tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' }])
  })

  it('el producto de un plan en el catálogo cuenta como plan', () => {
    expect(clasificarSuscripcion([item('prod_pro')], catalogo).proyecciones).toEqual([{ tipo: 'PLAN', tier: 'PRO' }])
  })

  it('un producto ajeno conocido no es obligación de acceso', () => {
    expect(clasificarSuscripcion([item('prod_tokens')], catalogo).proyecciones).toEqual([{ tipo: 'AJENO', productId: 'prod_tokens' }])
  })

  it('🔴 un producto que nadie reconoce es DESCONOCIDO, nunca «no hay obligación»', () => {
    expect(clasificarSuscripcion([item('prod_misterio')], catalogo).proyecciones).toEqual([
      { tipo: 'DESCONOCIDO', productId: 'prod_misterio' },
    ])
  })

  it('una suscripción con varios ítems se marca: nosotros sólo creamos de un ítem', () => {
    const r = clasificarSuscripcion([item('prod_pro'), item('prod_inv')], catalogo)
    expect(r.variosItems).toBe(true)
    expect(r.proyecciones).toHaveLength(2)
  })

  it('sin ítems es DESCONOCIDO (no se puede afirmar que no venda nada)', () => {
    expect(clasificarSuscripcion([], catalogo).proyecciones).toEqual([{ tipo: 'DESCONOCIDO', productId: null }])
  })
})

describe('clasificarEstado', () => {
  it.each([
    ['active', 'HABILITANTE'],
    ['trialing', 'HABILITANTE'],
    ['canceled', 'TERMINAL'],
    ['incomplete_expired', 'TERMINAL'],
    ['past_due', 'RECUPERABLE'],
    ['unpaid', 'RECUPERABLE'],
    ['incomplete', 'RECUPERABLE'],
    ['paused', 'RECUPERABLE'],
    ['un_estado_nuevo_de_stripe', 'RECUPERABLE'],
  ])('%s ⇒ %s', (status, esperado) => {
    expect(clasificarEstado(status)).toBe(esperado)
  })
})

describe('evaluarCompatibilidad — ¿se puede abrir otra obligación?', () => {
  // Qué funciones incluye cada plan (en producción: `elPlanConcede`). Pro incluye CFDI; Premium, además, inventario.
  const incluye = (tier: 'PRO' | 'PREMIUM', code: string) => code === 'CFDI' || (tier === 'PREMIUM' && code === 'INVENTORY_TRACKING')
  const viva = (subscriptionId: string, ...proyecciones: ObligacionViva['proyecciones']): ObligacionViva => ({
    subscriptionId,
    proyecciones,
  })

  it('sin nada vivo, un plan se puede contratar', () => {
    expect(evaluarCompatibilidad([], { tipo: 'PLAN', tier: 'PRO' }, incluye)).toEqual({ ok: true })
  })

  it('🔴 ya hay un plan vivo (aunque esté suspendido o sin entregar): no se abre otro', () => {
    const r = evaluarCompatibilidad([viva('sub_1', { tipo: 'PLAN', tier: 'PRO' })], { tipo: 'PLAN', tier: 'PREMIUM' }, incluye)
    expect(r).toMatchObject({ ok: false, codigo: 'PLAN_YA_CONTRATADO', suscripciones: ['sub_1'] })
  })

  it('🔴 contratar un plan que absorbe una función suelta que sigue cobrando: no', () => {
    const r = evaluarCompatibilidad(
      [viva('sub_inv', { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' })],
      { tipo: 'PLAN', tier: 'PREMIUM' },
      incluye,
    )
    expect(r).toMatchObject({ ok: false, codigo: 'PLAN_ABSORBE_SUELTA', suscripciones: ['sub_inv'] })
  })

  it('una suelta que el plan destino NO incluye no estorba', () => {
    const r = evaluarCompatibilidad(
      [viva('sub_inv', { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' })],
      { tipo: 'PLAN', tier: 'PRO' },
      incluye,
    )
    expect(r).toEqual({ ok: true })
  })

  it('🔴 comprar una función que ya cobra otra suscripción: no', () => {
    const r = evaluarCompatibilidad(
      [viva('sub_inv', { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' })],
      { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' },
      incluye,
    )
    expect(r).toMatchObject({ ok: false, codigo: 'FUNCION_YA_CONTRATADA' })
  })

  it('🔴 comprar una función que el plan vivo ya incluye: no', () => {
    const r = evaluarCompatibilidad([viva('sub_p', { tipo: 'PLAN', tier: 'PRO' })], { tipo: 'FUNCION', featureCode: 'CFDI' }, incluye)
    expect(r).toMatchObject({ ok: false, codigo: 'INCLUIDA_EN_EL_PLAN', suscripciones: ['sub_p'] })
  })

  it('🔴 cualquier obligación DESCONOCIDA bloquea, aunque lo pedido parezca compatible', () => {
    const r = evaluarCompatibilidad(
      [viva('sub_x', { tipo: 'DESCONOCIDO', productId: 'prod_misterio' })],
      { tipo: 'PLAN', tier: 'PRO' },
      incluye,
    )
    expect(r).toMatchObject({ ok: false, codigo: 'OBLIGACION_DESCONOCIDA', suscripciones: ['sub_x'] })
  })

  it('lo ajeno conocido no estorba', () => {
    const r = evaluarCompatibilidad([viva('sub_t', { tipo: 'AJENO', productId: 'prod_tokens' })], { tipo: 'PLAN', tier: 'PRO' }, incluye)
    expect(r).toEqual({ ok: true })
  })

  it('🔴 Codex P2-5: el conjunto ya roto (dos planes vivos) bloquea también comprar una función que ninguno incluye', () => {
    const r = evaluarCompatibilidad(
      [viva('s1', { tipo: 'PLAN', tier: 'PRO' }), viva('s2', { tipo: 'PLAN', tier: 'PRO' })],
      { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' },
      incluye,
    )
    expect(r).toMatchObject({ ok: false, codigo: 'OBLIGACIONES_INCOMPATIBLES', suscripciones: ['s1', 's2'] })
  })

  it('🔴 una función cobrada dos veces ya es un conjunto roto: no se abre nada encima', () => {
    const r = evaluarCompatibilidad(
      [
        viva('s1', { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' }),
        viva('s2', { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' }),
      ],
      { tipo: 'FUNCION', featureCode: 'CFDI' },
      incluye,
    )
    expect(r).toMatchObject({ ok: false, codigo: 'OBLIGACIONES_INCOMPATIBLES', suscripciones: ['s1', 's2'] })
  })

  it('🔴 Codex R2-2: dos ÍTEMS de la misma función dentro de UNA suscripción ya es un conjunto roto', () => {
    const r = evaluarCompatibilidad(
      [viva('s1', { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' }, { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' })],
      { tipo: 'PLAN', tier: 'PRO' },
      incluye,
    )
    expect(r).toMatchObject({ ok: false, codigo: 'OBLIGACIONES_INCOMPATIBLES', suscripciones: ['s1'] })
  })

  it('🔴 Codex R2-3: comprar una función con un plan que YA incluye otra suelta viva: el conjunto ya cobra algo dos veces', () => {
    const r = evaluarCompatibilidad(
      [viva('sP', { tipo: 'PLAN', tier: 'PRO' }), viva('sF', { tipo: 'FUNCION', featureCode: 'CFDI' })],
      { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' },
      incluye,
    )
    expect(r).toMatchObject({ ok: false, codigo: 'OBLIGACIONES_INCOMPATIBLES', suscripciones: ['sF'] })
  })

  describe('cambio de plan = sustituir el precio de UNA suscripción identificada', () => {
    it('el mismo plan que se cambia no cuenta como «otro plan»', () => {
      const r = evaluarCompatibilidad(
        [viva('sub_p', { tipo: 'PLAN', tier: 'PRO' })],
        { tipo: 'CAMBIO_DE_PLAN', subscriptionId: 'sub_p', tierDestino: 'PREMIUM' },
        incluye,
      )
      expect(r).toEqual({ ok: true })
    })

    it('🔴 si hay OTRO plan vivo además del que se cambia: no', () => {
      const r = evaluarCompatibilidad(
        [viva('sub_p', { tipo: 'PLAN', tier: 'PRO' }), viva('sub_p2', { tipo: 'PLAN', tier: 'PRO' })],
        { tipo: 'CAMBIO_DE_PLAN', subscriptionId: 'sub_p', tierDestino: 'PREMIUM' },
        incluye,
      )
      expect(r).toMatchObject({ ok: false, codigo: 'OTRO_PLAN_VIVO', suscripciones: ['sub_p2'] })
    })

    it('🔴 la suscripción a cambiar no es un plan vivo: no', () => {
      const r = evaluarCompatibilidad([], { tipo: 'CAMBIO_DE_PLAN', subscriptionId: 'sub_p', tierDestino: 'PREMIUM' }, incluye)
      expect(r).toMatchObject({ ok: false, codigo: 'SIN_PLAN_QUE_CAMBIAR' })
    })

    it('🔴 Codex P2-5: una suscripción con DOS ítems de plan no es un cambio inequívoco', () => {
      const r = evaluarCompatibilidad(
        [viva('s1', { tipo: 'PLAN', tier: 'PRO' }, { tipo: 'PLAN', tier: 'PREMIUM' })],
        { tipo: 'CAMBIO_DE_PLAN', subscriptionId: 's1', tierDestino: 'PRO' },
        incluye,
      )
      expect(r).toMatchObject({ ok: false, codigo: 'CAMBIO_AMBIGUO', suscripciones: ['s1'] })
    })

    it('🔴 Codex C7: una suscripción con el plan Y otro ítem no es un cambio inequívoco (se cambiaría el ítem equivocado)', () => {
      const r = evaluarCompatibilidad(
        [viva('s1', { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' }, { tipo: 'PLAN', tier: 'PREMIUM' })],
        { tipo: 'CAMBIO_DE_PLAN', subscriptionId: 's1', tierDestino: 'PRO' },
        incluye,
      )
      expect(r).toMatchObject({ ok: false, codigo: 'CAMBIO_AMBIGUO', suscripciones: ['s1'] })
    })

    it('🔴 subir a un plan que absorbe una suelta viva: no (la fase 2 sigue fuera)', () => {
      const r = evaluarCompatibilidad(
        [viva('sub_p', { tipo: 'PLAN', tier: 'PRO' }), viva('sub_inv', { tipo: 'FUNCION', featureCode: 'INVENTORY_TRACKING' })],
        { tipo: 'CAMBIO_DE_PLAN', subscriptionId: 'sub_p', tierDestino: 'PREMIUM' },
        incluye,
      )
      expect(r).toMatchObject({ ok: false, codigo: 'PLAN_ABSORBE_SUELTA', suscripciones: ['sub_inv'] })
    })
  })
})

describe('decidirEntregaDePlan — una operación por FILA, no una sola acción', () => {
  // Notación de Codex: PRO=(s1,true) = { vinculo: 's1', active: true }.
  const f = (vinculo: string | null, active: boolean) => ({ vinculo, active })
  const decide = (e: Partial<Parameters<typeof decidirEntregaDePlan>[0]>) =>
    decidirEntregaDePlan({ subscriptionId: 's1', tier: 'PRO', estado: 'HABILITANTE', filas: {}, puedeCobrar: {}, ...e })

  describe('caminos normales', () => {
    it('sin filas: liga y concede', () => {
      expect(decide({})).toEqual({ filas: { PRO: { op: 'LIGAR', activar: true } }, reintentar: false })
    })

    it('«ausente ⇒ liga» NO implica acceso: recuperable liga sin conceder', () => {
      expect(decide({ estado: 'RECUPERABLE' })).toEqual({ filas: { PRO: { op: 'LIGAR', activar: false } }, reintentar: false })
    })

    it('la fila ya apunta a esta suscripción: el estado lo aplica su manejador (gracia, suspensión)', () => {
      expect(decide({ filas: { PRO: f('s1', false) } })).toEqual({ filas: { PRO: { op: 'APLICAR_ESTADO' } }, reintentar: false })
    })

    it('vínculo distinto y TERMINADO: se sustituye', () => {
      expect(decide({ filas: { PRO: f('s0', false) }, puedeCobrar: { s0: 'NO' } })).toEqual({
        filas: { PRO: { op: 'SUSTITUIR', activar: true } },
        reintentar: false,
      })
    })

    it('cambio de tier con destino vacío: el origen SUELTA (unicidad del vínculo) y el destino liga', () => {
      expect(decide({ tier: 'PREMIUM', filas: { PRO: f('s1', true) } })).toEqual({
        filas: { PRO: { op: 'SOLTAR' }, PREMIUM: { op: 'LIGAR', activar: true } },
        reintentar: false,
      })
    })

    it('cambio de tier RECUPERABLE con destino vacío: se representa sin conceder', () => {
      expect(decide({ tier: 'PREMIUM', estado: 'RECUPERABLE', filas: { PRO: f('s1', true) } })).toEqual({
        filas: { PRO: { op: 'SOLTAR' }, PREMIUM: { op: 'LIGAR', activar: false } },
        reintentar: false,
      })
    })
  })

  describe('🔴 no pisar una obligación viva', () => {
    it('vínculo distinto y VIVO en el destino: conflicto, la fila no se toca (dos pestañas pagadas)', () => {
      expect(decide({ filas: { PRO: f('s0', true) }, puedeCobrar: { s0: 'SI' } })).toEqual({
        filas: {},
        conflictoCon: ['s0'],
        reintentar: false,
      })
    })

    it('el OTRO tier tiene un plan vivo: conflicto aunque el destino esté vacío (dos checkouts legacy)', () => {
      expect(decide({ tier: 'PREMIUM', filas: { PRO: f('s0', true) }, puedeCobrar: { s0: 'SI' } })).toEqual({
        filas: {},
        conflictoCon: ['s0'],
        reintentar: false,
      })
    })

    it('un vínculo sin respuesta de Stripe es INCIERTO, nunca terminado: se reintenta sin tocar su fila', () => {
      expect(decide({ filas: { PRO: f('s0', false) } })).toEqual({ filas: {}, reintentar: true })
    })

    it('Codex P1-1: una entrante TERMINAL sólo retira lo SUYO; nunca se mueve sobre la fila ajena', () => {
      // s1, PRO, TERMINAL; PREMIUM=(s1,true), PRO=(s2,true), s2 vivo.
      expect(decide({ estado: 'TERMINAL', filas: { PREMIUM: f('s1', true), PRO: f('s2', true) }, puedeCobrar: { s2: 'SI' } })).toEqual({
        filas: { PREMIUM: { op: 'RETIRAR_ACCESO' } },
        reintentar: false,
      })
    })

    it('terminal y sin vínculo propio: no hace nada', () => {
      expect(decide({ estado: 'TERMINAL', filas: { PRO: f('s2', true) }, puedeCobrar: { s2: 'SI' } })).toEqual({
        filas: {},
        reintentar: false,
      })
    })
  })

  describe('🔴 conflicto ≠ conservar el acceso que ya no está respaldado', () => {
    it('Codex P1-2A: s1 RECUPERABLE ya ligada en PRO y PREMIUM vivo en otra: se aplica su estado Y se registra el conflicto', () => {
      expect(decide({ estado: 'RECUPERABLE', filas: { PRO: f('s1', true), PREMIUM: f('s2', true) }, puedeCobrar: { s2: 'SI' } })).toEqual({
        filas: { PRO: { op: 'APLICAR_ESTADO' } },
        conflictoCon: ['s2'],
        reintentar: false,
      })
    })

    it('… y con el otro INCIERTO, también se aplica el estado mientras se reintenta', () => {
      expect(
        decide({ estado: 'RECUPERABLE', filas: { PRO: f('s1', true), PREMIUM: f('s2', true) }, puedeCobrar: { s2: 'INCIERTO' } }),
      ).toEqual({ filas: { PRO: { op: 'APLICAR_ESTADO' } }, reintentar: true })
    })

    it('Codex P1-2B: s1 pasó de PREMIUM a PRO y PRO está ocupado por uno INCIERTO: PREMIUM se retira YA (sin soltar el vínculo)', () => {
      expect(decide({ filas: { PREMIUM: f('s1', true), PRO: f('s2', true) }, puedeCobrar: { s2: 'INCIERTO' } })).toEqual({
        filas: { PREMIUM: { op: 'RETIRAR_ACCESO' } },
        reintentar: true,
      })
    })

    it('PREMIUM→PRO con PRO ocupado por otra VIVA: conflicto, y PREMIUM se retira conservando el vínculo', () => {
      expect(decide({ filas: { PREMIUM: f('s1', true), PRO: f('s2', true) }, puedeCobrar: { s2: 'SI' } })).toEqual({
        filas: { PREMIUM: { op: 'RETIRAR_ACCESO' } },
        conflictoCon: ['s2'],
        reintentar: false,
      })
    })

    it('Codex P1-3A: el otro tier con una obligación TERMINADA pero activa se retira aunque la entrega sea normal', () => {
      expect(decide({ filas: { PREMIUM: f('s2', true) }, puedeCobrar: { s2: 'NO' } })).toEqual({
        filas: { PREMIUM: { op: 'RETIRAR_ACCESO' }, PRO: { op: 'LIGAR', activar: true } },
        reintentar: false,
      })
    })

    it('Codex P1-3B (imposible por la unicidad del vínculo, pero se trata): la misma suscripción en las dos filas ⇒ el origen suelta', () => {
      expect(decide({ filas: { PRO: f('s1', false), PREMIUM: f('s1', true) } })).toEqual({
        filas: { PREMIUM: { op: 'SOLTAR' }, PRO: { op: 'APLICAR_ESTADO' } },
        reintentar: false,
      })
    })
  })

  describe('Codex R2-1: el destino con obligación TERMINADA se retira aunque el otro tier bloquee', () => {
    it('con el otro tier VIVO: conflicto y el destino pierde el acceso sin respaldo (conserva su vínculo)', () => {
      expect(
        decide({ tier: 'PREMIUM', filas: { PREMIUM: f('s0', true), PRO: f('s2', true) }, puedeCobrar: { s0: 'NO', s2: 'SI' } }),
      ).toEqual({ filas: { PREMIUM: { op: 'RETIRAR_ACCESO' } }, conflictoCon: ['s2'], reintentar: false })
    })

    it('con el otro tier INCIERTO: se reintenta y el destino igual pierde el acceso sin respaldo', () => {
      expect(
        decide({ tier: 'PREMIUM', filas: { PREMIUM: f('s0', true), PRO: f('s2', true) }, puedeCobrar: { s0: 'NO', s2: 'INCIERTO' } }),
      ).toEqual({ filas: { PREMIUM: { op: 'RETIRAR_ACCESO' } }, reintentar: true })
    })
  })

  describe('concesiones locales (cortesía o prueba, sin vínculo): la política vive AQUÍ', () => {
    it('Codex P2-4: una suscripción pagada y HABILITANTE sustituye la concesión local del otro tier', () => {
      expect(decide({ filas: { PREMIUM: f(null, true) } })).toEqual({
        filas: { PREMIUM: { op: 'RETIRAR_ACCESO' }, PRO: { op: 'LIGAR', activar: true } },
        reintentar: false,
      })
    })

    it('una RECUPERABLE no quita nada: la concesión local del otro tier se conserva', () => {
      expect(decide({ estado: 'RECUPERABLE', filas: { PREMIUM: f(null, true) } })).toEqual({
        filas: { PRO: { op: 'LIGAR', activar: false } },
        reintentar: false,
      })
    })

    it('Codex R2-4: la fila del MISMO tier la TOMA la suscripción de pago; su acceso lo decide ella desde ya (una fila no puede representar dos procedencias)', () => {
      // Declarado: si la pagada aún no habilita, la concesión local de ese tier se pierde. Con Checkout de tarjeta, completar ya
      // implica cobro, así que el caso es raro; conservarla exigiría guardar su procedencia aparte.
      expect(decide({ estado: 'RECUPERABLE', filas: { PRO: f(null, true) } })).toEqual({
        filas: { PRO: { op: 'LIGAR', activar: false } },
        reintentar: false,
      })
    })

    it('una fila local INACTIVA en el otro tier no se toca', () => {
      expect(decide({ filas: { PREMIUM: f(null, false) } })).toEqual({ filas: { PRO: { op: 'LIGAR', activar: true } }, reintentar: false })
    })
  })
})

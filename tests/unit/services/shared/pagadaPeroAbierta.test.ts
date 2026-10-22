import { Prisma } from '@prisma/client'
import {
  baseQueDebeCubrirseSql,
  cerrarPedidoDePlataformaSoloDeEstado,
  criterioPagadaPeroAbiertaSql,
  esDeUnaPlataformaSql,
  findPaidButOpenOrders,
  findPedidosDePlataformaPorCerrar,
  instanteUtcSql,
  laCocinaLoTerminoSql,
  momentoDeCerrarUnPedidoDePlataformaSql,
  pedidoDePlataformaAceptadoSql,
  pedidoDePlataformaQueBDejaAbiertoSql,
  seAcaboSuDiaDelNegocioSql,
} from '@/services/shared/pagadaPeroAbierta'

describe('criterio SQL «pagada pero abierta»', () => {
  const sql = criterioPagadaPeroAbiertaSql('o')

  it('excluye los estados terminales de la orden', () => {
    expect(sql).toMatch(/o\.status NOT IN \('COMPLETED', ?'CANCELLED', ?'DELETED'\)/)

    // El alias manda de verdad: con otro alias, el criterio habla de ESA tabla y de ninguna otra.
    const conAlias = criterioPagadaPeroAbiertaSql('x')
    expect(conAlias).toMatch(/x\.status NOT IN \('COMPLETED', ?'CANCELLED', ?'DELETED'\)/)
    expect(conAlias).not.toMatch(/o\.status/)
  })

  it('exige al menos un cobro REGULAR o FAST positivo; la suma ignora el tipo salvo REFUND', () => {
    expect(sql).toMatch(/p\.type IN \('REGULAR', ?'FAST'\)/)
    expect(sql).toMatch(/p\.amount > 0/)
    expect(sql).toMatch(/SUM\(p\.amount\)[\s\S]*?p\.status = 'COMPLETED' AND p\.type IS DISTINCT FROM 'REFUND'/)
  })

  it('compara la suma de cobros COMPLETED que NO son REFUND contra lo que la cuenta DEBE, con tolerancia de un centavo', () => {
    expect(sql).toMatch(
      /SELECT COALESCE\(SUM\(p\.amount\), 0\) FROM "Payment" p\s+WHERE p\."orderId" = o\.id AND p\.status = 'COMPLETED' AND p\.type IS DISTINCT FROM 'REFUND'\s*\)\s*>=/,
    )
  })

  /**
   * 🔴 EL CARGO POR SERVICIO ES PARTE DE LO QUE LA CUENTA DEBE (auditoría de Codex, 2-sep-2026).
   *
   * El schema lo dice con todas sus letras (`Order.serviceChargeAmount`): «A DIFERENCIA de la
   * propina, esto es INGRESO GRAVABLE del negocio: SUMA al total y entra al corte y al CFDI».
   * Comparando sólo contra `subtotal − descuento`, una cuenta de $100 + $10 de cargo con $100
   * cobrados salía elegida como «pagada»: el barrido la cerraba, `reconcileOrderFromPayments`
   * le REESCRIBÍA el total hacia abajo y la mesa se liberaba — $10 perdidos, sin rastro.
   *
   * La propina se queda FUERA a propósito: no es deuda de la cuenta sino dinero del mesero, y
   * `computeOrderBalance` (`shared/orderBalance.ts`) la pone a los DOS lados de la comparación
   * (entra al total y entra a lo pagado), así que se cancela. Lo que el criterio compara es lo
   * mismo que aquélla: `mercancía + cargo por servicio` contra `Σ amount`.
   */
  it('lo que la cuenta debe INCLUYE el cargo por servicio y EXCLUYE la propina', () => {
    expect(sql).toMatch(
      /GREATEST\(0, o\.subtotal - COALESCE\(o\."discountAmount", 0\)\) \+ COALESCE\(o\."serviceChargeAmount", 0\) \+ GREATEST\(0, COALESCE\(o\."taxAmount", 0\)\) - 0\.01/,
    )

    // El alias manda también aquí: el cargo se lee de la MISMA tabla que el subtotal.
    expect(criterioPagadaPeroAbiertaSql('x')).toContain('COALESCE(x."serviceChargeAmount", 0)')

    // 🔴 Guarda contra la «simplificación» que reintroduce el defecto: la base NO puede volver
    // a terminar en el descuento. Con el término del cargo borrado, esta línea falla.
    expect(sql).not.toMatch(/COALESCE\(o\."discountAmount", 0\)\) - 0\.01/)

    // La propina NUNCA entra: sumarla haría que una cuenta saldada pareciera deber la propina.
    expect(sql).not.toContain('tipAmount')
  })

  /**
   * 🔴 EL IVA ENTRA CUANDO VA SEPARADO, Y NO CAMBIA NADA CUANDO EL PRECIO YA LO TRAE (7-sep-2026).
   *
   * `Order.taxAmount` carga dos significados (memoria `iva-el-precio-de-catalogo-es-final`,
   * y es el MISMO discriminador que lee el CFDI): `0` ⇒ «el precio ya trae el IVA», la
   * convención mexicana que escriben los 8 caminos de venta nativos; `> 0` ⇒ «el IVA va
   * separado y SUMA al total», que es como nacen las órdenes de SoftRestaurant (Testarudo).
   *
   * El arreglo del 5-sep quitó el IVA de la base por la primera convención y se llevó la
   * segunda por delante: la corrida del vigilante del 7-sep pasó de 41 a 31,283 alarmas, y
   * 31,241 eran clientes de Testarudo que pagaron EXACTAMENTE `Order.total` — el «exceso»
   * era el IVA, al centavo, en el 99.96 % de los casos. Con 30 ranuras por invariante, los
   * ~13 sobrepagos reales de Amaena, BAE y Mindform quedaban enterrados.
   *
   * Y el barrido comparte esta base: sin el IVA, una cuenta de Testarudo con sólo el
   * subtotal cobrado salía elegida como «pagada» y el reconciliador la cerraba.
   */
  it('🔴 lo que la cuenta debe INCLUYE el IVA cuando va separado (taxAmount > 0) y lo ignora cuando el precio ya lo trae (taxAmount = 0)', () => {
    // La base canónica, verbatim: mercancía clampada + cargo + IVA clampado.
    expect(baseQueDebeCubrirseSql('o')).toBe(
      'GREATEST(0, o.subtotal - COALESCE(o."discountAmount", 0)) + COALESCE(o."serviceChargeAmount", 0) + GREATEST(0, COALESCE(o."taxAmount", 0))',
    )
    // El criterio la usa tal cual, con el alias que le pasen.
    expect(criterioPagadaPeroAbiertaSql('x')).toContain('GREATEST(0, COALESCE(x."taxAmount", 0))')

    // 🔴 El IVA va CLAMPADO: un `taxAmount` negativo (el que dejaría `estimateAverageTaxRate`
    // sobre una orden con IVA incluido) nunca BAJA lo que la cuenta debe — ésa era la
    // cortesía total que salía como SOBREPAGO de $300 con $0 cobrados.
    expect(baseQueDebeCubrirseSql('o')).not.toMatch(/\+ COALESCE\(o\."taxAmount", 0\)(?!\))/)
  })
})

/**
 * La consulta que arma `findPaidButOpenOrders`. Se prueba contra un doble de `$queryRaw`
 * porque lo que hay que fijar es la FORMA de la plantilla —la ventana de gracia, el tope de
 * antigüedad, el orden y el límite—, no lo que devuelva Postgres.
 */
describe('findPaidButOpenOrders — la consulta que arma', () => {
  const AHORA = new Date('2026-09-02T20:00:00Z')
  const DESDE = new Date('2026-08-03T20:00:00Z')
  const GRACIA_MS = 300_000

  const dobleDb = () => ({ $queryRaw: jest.fn().mockResolvedValue([]) })
  type DobleDb = ReturnType<typeof dobleDb>
  const comoDb = (db: DobleDb) => db as unknown as Parameters<typeof findPaidButOpenOrders>[0]

  /**
   * `$queryRaw` se invoca como plantilla etiquetada, así que el doble recibe
   * `(strings, ...values)`. Volver a armarla con `Prisma.sql` es exactamente lo que Prisma
   * hace por dentro: APLANA los fragmentos anidados (`Prisma.raw`, `utcTs`) y deja el texto
   * completo con `?` más la lista PLANA de valores ligados. Sin eso, un `strings.join('?')`
   * pelón no vería lo que aporta un fragmento anidado.
   */
  const consultaCapturada = (db: DobleDb) => {
    const [strings, ...values] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    return Prisma.sql(strings, ...values)
  }

  it('acota por la ventana de gracia y por `since`, ordena de la más vieja y limita', async () => {
    const db = dobleDb()
    await findPaidButOpenOrders(comoDb(db), { graceMs: GRACIA_MS, limit: 50, now: AHORA, since: DESDE })

    const q = consultaCapturada(db)
    expect(q.sql).toContain('o."updatedAt" <')
    expect(q.sql).toContain('o."createdAt" >=')
    expect(q.sql).toContain('ORDER BY o."createdAt" ASC')
    expect(q.sql).toContain('LIMIT')
    // El criterio compartido viaja DENTRO, verbatim: nadie reescribe el WHERE a mano.
    expect(q.sql).toContain(criterioPagadaPeroAbiertaSql('o'))

    // 🔴 Aquí se cae un signo invertido en la aritmética de la gracia: la ventana mira
    // HACIA ATRÁS (20:00 − 5 min), nunca hacia adelante.
    expect(q.values).toEqual([new Date('2026-09-02T19:55:00.000Z'), DESDE, 50])
  })

  it('🔴 NO propone reparar una cuenta con el IVA separado (taxAmount > 0), y deja intacto el criterio que lee el vigilante', async () => {
    const db = dobleDb()
    await findPaidButOpenOrders(comoDb(db), { graceMs: GRACIA_MS, limit: 50, now: AHORA })

    const q = consultaCapturada(db)
    // El reparador reescribe el total con el IVA DENTRO del subtotal (convención mexicana): sobre una cuenta que guarda
    // el IVA aparte (el histórico de SoftRestaurant) le quitaría el IVA al total.
    expect(q.sql).toContain('COALESCE(o."taxAmount", 0) <= 0')
    // …pero el filtro vive FUERA del criterio compartido: el vigilante la sigue reportando como pagada pero abierta.
    expect(criterioPagadaPeroAbiertaSql('o')).not.toContain('<= 0')
  })

  it('sin `since` NO acota por fecha de creación — así el barrido a mano alcanza el rezago viejo', async () => {
    const db = dobleDb()
    await findPaidButOpenOrders(comoDb(db), { graceMs: GRACIA_MS, limit: 50, now: AHORA })

    const q = consultaCapturada(db)
    expect(q.sql).not.toContain('o."createdAt" >=')
    expect(q.values).toEqual([new Date('2026-09-02T19:55:00.000Z'), 50])
  })
  /**
   * 🔴 Codex b1 #1 (Rappi fase 2): el total de un pedido de plataforma lleva cargos del comercio (el envío del repartidor propio,
   * los cargos de Uber) que el reparador no ve. Proponérselo era quitarle el envío a la venta y denunciar un sobrepago falso.
   */
  it('🔴 NO propone reparar un pedido cuyo dinero liquida una plataforma, y deja intacto el criterio que lee el vigilante', async () => {
    const db = dobleDb()
    await findPaidButOpenOrders(comoDb(db), { graceMs: GRACIA_MS, limit: 50, now: AHORA })

    const q = consultaCapturada(db)
    expect(esDeUnaPlataformaSql('o')).toBe(`o."originSystem" = 'DELIVERY_PLATFORM'`)
    expect(q.sql).toContain(`AND NOT (o."originSystem" = 'DELIVERY_PLATFORM')`)
    // El filtro vive fuera del criterio compartido, como el del IVA aparte: el vigilante ve el mismo conjunto que antes.
    expect(criterioPagadaPeroAbiertaSql('o')).not.toContain('originSystem')
  })
})

/**
 * La cuarta pasada del barrido: los pedidos de plataforma se cierran SÓLO de estado, nunca uno sin aceptar, y el CUÁNDO vive en
 * un solo sitio (`momentoDeCerrarUnPedidoDePlataformaSql`): la decisión «B» del founder (22-oct-2026) —cuando la cocina lo
 * termina, o al acabar el día del negocio, lo que pase primero—. Lo que el SQL ELIGE de verdad lo prueba la integración
 * (`barridoDePagadasReparto.test.ts`, contra Postgres); aquí se fija la FORMA.
 */
describe('findPedidosDePlataformaPorCerrar — la consulta que arma', () => {
  const AHORA = new Date('2026-10-22T20:00:00Z')
  const DESDE = new Date('2026-09-22T20:00:00Z')
  const dobleDb = () => ({ $queryRaw: jest.fn().mockResolvedValue([]) })
  const consultaCapturada = (db: ReturnType<typeof dobleDb>) => {
    const [strings, ...values] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    return Prisma.sql(strings, ...values)
  }

  it('sólo pedidos de plataforma que el núcleo dio por PAGADOS, aceptados y que cumplen el criterio compartido; gracia, ventana, orden y tope', async () => {
    const db = dobleDb()
    await findPedidosDePlataformaPorCerrar(db as never, { graceMs: 300_000, limit: 50, now: AHORA, since: DESDE })

    const q = consultaCapturada(db)
    expect(q.sql).toContain(criterioPagadaPeroAbiertaSql('o'))
    expect(q.sql).toContain(esDeUnaPlataformaSql('o'))
    // El barrido no decide si un pedido de plataforma está pagado: lo dice el núcleo de reparto (uno con efectivo por cobrar no).
    expect(q.sql).toContain(`o."paymentStatus" = 'PAID'`)
    expect(q.sql).toContain(pedidoDePlataformaAceptadoSql('o'))
    // 🔴 El CUÁNDO, con el AHORA del barrido (el mismo reloj que su gracia), no el de la sesión de Postgres.
    expect(q.sql).toContain(momentoDeCerrarUnPedidoDePlataformaSql('o', instanteUtcSql(AHORA)))
    expect(q.sql).toContain('o."updatedAt" <')
    expect(q.sql).toContain('o."createdAt" >=')
    expect(q.sql).toContain('ORDER BY o."createdAt" ASC')
    // Sin binds de fecha nuevos: el ahora del CUÁNDO va como literal UTC.
    expect(q.values).toEqual([new Date('2026-10-22T19:55:00.000Z'), DESDE, 50])
  })

  it('🔴 «aceptado» = CONFIRMED o más adelante, o PENDING con la aceptación acreditada: uno que espera a la cocina nunca se cierra', () => {
    expect(pedidoDePlataformaAceptadoSql('o')).toBe(`(o.status <> 'PENDING' OR o."providerAcceptedAt" IS NOT NULL)`)
  })
})

describe('decisión B: CUÁNDO se cierra un pedido de plataforma pagado y aceptado', () => {
  const AHORA = instanteUtcSql(new Date('2026-10-22T20:00:00Z'))

  it('el ahora va como literal del reloj de pared UTC (como el corte del vigilante), nunca como bind de fecha', () => {
    expect(AHORA).toBe(`TIMESTAMP '2026-10-22 20:00:00.000'`)
    // Un Date inválido no se convierte en SQL.
    expect(() => instanteUtcSql(new Date('no es fecha'))).toThrow()
  })

  it('🔴 «la cocina lo terminó»: el pedido tiene comanda y NINGUNA sigue en la cocina (NEW o PREPARING), del mismo negocio', () => {
    const sql = laCocinaLoTerminoSql('x')
    // Es el mismo «comanda abierta» del tablero (`kdsCapacidades.ts`, COMANDA_ABIERTA) y del reintento del «listo».
    expect(sql).toMatch(/^\(EXISTS \(SELECT 1 FROM "KdsOrder" k WHERE k\."orderId" = x\.id AND k\."venueId" = x\."venueId"\)/)
    expect(sql).toMatch(
      /AND NOT EXISTS \(\s*SELECT 1 FROM "KdsOrder" k WHERE k\."orderId" = x\.id AND k\."venueId" = x\."venueId" AND k\.status IN \('NEW', 'PREPARING'\)/,
    )
    // El alias manda: no habla de otra tabla.
    expect(sql).not.toMatch(/\bo\./)
  })

  it('🔴 «se acabó su día del negocio»: el día de la venta y el de AHORA, los dos en la zona del negocio (nunca la del servidor ni UTC)', () => {
    const sql = seAcaboSuDiaDelNegocioSql('x', AHORA)
    // El día de la venta: el último de llegó, se aceptó o se programó (un programado no se cierra antes de su día).
    expect(sql).toContain(
      `((GREATEST(x."createdAt", x."providerAcceptedAt", x."scheduledFor") AT TIME ZONE 'UTC') AT TIME ZONE z.tz)::date`,
    )
    // El de AHORA, con el reloj que le pasen y la MISMA zona.
    expect(sql).toContain(`((${AHORA} AT TIME ZONE 'UTC') AT TIME ZONE z.tz)::date`)
    expect(sql).toMatch(/::date < \(\(TIMESTAMP/)
    // La zona es la del negocio de ESA venta; una zona que Postgres no conoce cae en la de default y no tumba la pasada.
    expect(sql).toContain(`FROM "Venue" vz`)
    expect(sql).toContain(`vz.id = x."venueId"`)
    expect(sql).toContain(`vz.timezone IN (SELECT name FROM pg_timezone_names)`)
    expect(sql).toContain(`ELSE 'America/Mexico_City'`)
    expect(sql).not.toMatch(/\bo\./)
  })

  it('el momento = la cocina lo terminó O se acabó su día, lo que pase primero; nunca NULL', () => {
    const sql = momentoDeCerrarUnPedidoDePlataformaSql('o', AHORA)
    expect(sql).toBe(`COALESCE((${laCocinaLoTerminoSql('o')} OR ${seAcaboSuDiaDelNegocioSql('o', AHORA)}), FALSE)`)
  })

  it('🔴 lo que B deja abierto es el complemento EXACTO de lo que el barrido cierra (el vigilante no puede divergir del barrido)', () => {
    const sql = pedidoDePlataformaQueBDejaAbiertoSql('o', AHORA)
    expect(sql).toContain(esDeUnaPlataformaSql('o'))
    expect(sql).toContain(`o."paymentStatus" = 'PAID'`)
    expect(sql).toContain(pedidoDePlataformaAceptadoSql('o'))
    expect(sql).toContain(`NOT ${momentoDeCerrarUnPedidoDePlataformaSql('o', AHORA)}`)
  })
})

describe('cerrarPedidoDePlataformaSoloDeEstado', () => {
  const AHORA = new Date('2026-10-22T20:00:00Z')
  const pedido = { id: 'ord-1', venueId: 'v1', status: 'CONFIRMED' }

  it('🔴 escribe SÓLO el estado: ni total, ni propina, ni lo pagado, ni lo por cobrar, ni el estado de cobro', async () => {
    const db = { order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    expect(await cerrarPedidoDePlataformaSoloDeEstado(db as never, pedido, AHORA)).toBe(true)

    expect(db.order.updateMany).toHaveBeenCalledTimes(1)
    const [{ where, data }] = db.order.updateMany.mock.calls[0]
    expect(data).toEqual({ status: 'COMPLETED', completedAt: AHORA })
    // CAS sobre lo leído: si otro lo canceló o lo cerró en medio, no escribe. Sólo pedidos de plataforma ya pagados.
    expect(where).toEqual({ id: 'ord-1', venueId: 'v1', status: 'CONFIRMED', originSystem: 'DELIVERY_PLATFORM', paymentStatus: 'PAID' })
  })

  it('si otro lo cambió en medio (CAS en 0) contesta false y no lanza', async () => {
    const db = { order: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }
    expect(await cerrarPedidoDePlataformaSoloDeEstado(db as never, pedido, AHORA)).toBe(false)
  })
})

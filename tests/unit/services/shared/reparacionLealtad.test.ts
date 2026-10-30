import { readFileSync } from 'fs'
import { join } from 'path'
import {
  OTRA_HISTORIA,
  PAR_AUTORIZADO,
  TOPE_PASES,
  aplicarTelefonosYPar,
  clientesPorAvisar,
  completarLealtadDeVentas,
  decidirFusionAutorizada,
  decidirReparacionDeSello,
  filaDeBitacora,
  interpretarBanderas,
  planearTelefonos,
  revalidarVenta,
  revisarBase,
  revisarEntornoPublico,
  lineaDeEntornoPublico,
  type CambioDeTelefono,
  type ChoqueDeTelefono,
  type DecisionDeFusion,
  type EstadoDeLealtad,
  type FilaDeBitacora,
  type FilaTelefono,
  type OtraHistoria,
  type PuertoDeTransaccion,
  type ResultadoDeReparacion,
  type ResumenCliente,
  type VentaPorReparar,
} from '@/services/shared/reparacionLealtad'
import { esElegibleParaLealtad, type SaleStampSnapshot } from '@/services/shared/loyaltyOnLateCustomer'

const SCRIPT = 'scripts/lealtad/reparar-telefonos-y-sellos.ts'

describe('planearTelefonos', () => {
  const fila = (id: string, venueId: string | null, phone: string): FilaTelefono => ({ id, venueId, phone })

  it('🔴 «+» + 10 dígitos ⇒ +52; lo demás no se toca', () => {
    const r = planearTelefonos(
      [fila('a', 'v1', '+5543453965'), fila('b', 'v1', '+525511112222'), fila('c', 'v1', '55 1234 5678')],
      [],
      true,
    )
    expect(r.cambios).toEqual([{ id: 'a', venueId: 'v1', de: '+5543453965', a: '+525543453965' }])
    expect(r.choques).toEqual([])
  })

  it('🔴 choque con otro cliente del MISMO negocio: no se cambia, se reporta con quién', () => {
    const r = planearTelefonos([fila('viejo', 'v1', '+8129440042')], [fila('nuevo', 'v1', '+528129440042')], true)
    expect(r.cambios).toEqual([])
    expect(r.choques).toEqual([{ id: 'viejo', venueId: 'v1', de: '+8129440042', a: '+528129440042', ocupadoPor: 'nuevo' }])
  })

  it('el mismo teléfono en OTRO negocio no es choque para Customer', () => {
    const r = planearTelefonos([fila('a', 'v1', '+5543453965')], [fila('x', 'v2', '+525543453965')], true)
    expect(r.cambios).toHaveLength(1)
  })

  it('Consumer (global): el mismo teléfono en cualquier lado SÍ es choque', () => {
    const r = planearTelefonos([fila('a', null, '+5543453965')], [fila('x', null, '+525543453965')], false)
    expect(r.choques).toHaveLength(1)
  })

  it('dos Consumers con el MISMO teléfono sin lada: el primero cambia, el segundo choca con él (no se crea el duplicado)', () => {
    const r = planearTelefonos([fila('c1', null, '+5543453965'), fila('c2', null, '+5543453965')], [], false)
    expect(r.cambios.map(c => c.id)).toEqual(['c1'])
    expect(r.choques).toEqual([{ id: 'c2', venueId: null, de: '+5543453965', a: '+525543453965', ocupadoPor: 'c1' }])
  })
})

describe('decidirFusionAutorizada (auditoría A #5: sólo el par de la spec, y revalidado)', () => {
  const sinOtraHistoria = Object.fromEntries(Object.keys(OTRA_HISTORIA).map(k => [k, 0])) as Record<OtraHistoria, number>
  const limpio = (id: string, phone: string): ResumenCliente => ({
    id,
    venueId: PAR_AUTORIZADO.venueId,
    active: true,
    phone,
    email: null,
    birthDate: null,
    loyaltyPoints: 0,
    referralCount: 0,
    referredByCustomerId: null,
    notes: null,
    tags: [],
    sellos: 0,
    ventas: 0,
    reservas: 0,
    paquetes: 0,
    otros: sinOtraHistoria,
  })
  const viejo = limpio(PAR_AUTORIZADO.retirar, '+8129440042')
  const nuevo = limpio(PAR_AUTORIZADO.conservar, '+528129440042')

  it('el par es EXACTAMENTE el de la spec (Testarudo)', () => {
    expect(PAR_AUTORIZADO).toEqual({
      venueId: 'cmiowv1yu000aqa27mhhxrdqe',
      conservar: 'cmv192e9k0968os29qhgyn86h',
      retirar: 'cmttavm9802bjpk2b6asriztj',
    })
  })

  it('el par autorizado, los dos sin ninguna historia ⇒ FUSIONAR', () => {
    expect(decidirFusionAutorizada(viejo, nuevo)).toEqual({ decision: 'FUSIONAR' })
  })

  it('🔴 cualquier OTRO choque, aunque los dos estén vacíos ⇒ sólo se reporta', () => {
    expect(decidirFusionAutorizada({ ...viejo, id: 'otro-viejo' }, nuevo).decision).toBe('SOLO_REPORTAR')
    expect(decidirFusionAutorizada(viejo, { ...nuevo, id: 'otro-nuevo' }).decision).toBe('SOLO_REPORTAR')
    expect(decidirFusionAutorizada(nuevo, viejo).decision).toBe('SOLO_REPORTAR') // al revés tampoco
  })

  it.each<[string, Partial<ResumenCliente>, Partial<ResumenCliente>]>([
    ['un sello en el viejo', { sellos: 1 }, {}],
    ['una venta en el nuevo', {}, { ventas: 1 }],
    ['🔴 una reserva (no es venta ni sello)', { reservas: 1 }, {}],
    ['🔴 un paquete o un movimiento de crédito', {}, { paquetes: 1 }],
    ['el viejo ya está desactivado', { active: false }, {}],
    ['el nuevo ya está desactivado', {}, { active: false }],
    ['otro negocio', { venueId: 'otro-venue' }, {}],
    ['el teléfono del viejo cambió', { phone: '+8129449999' }, {}],
    ['el viejo ya no tiene teléfono', { phone: null }, {}],
    ['el nuevo cambió de teléfono', {}, { phone: '+528129449999' }],
  ])('par autorizado pero %s ⇒ no se toca y se dice por qué', (_n, v, n) => {
    const r = decidirFusionAutorizada({ ...viejo, ...v }, { ...nuevo, ...n })
    expect(r.decision).toBe('SOLO_REPORTAR')
    expect(r.decision === 'SOLO_REPORTAR' && r.motivo.length).toBeGreaterThan(10)
  })

  // Fix ronda 1 (#1): toda relación del Customer que guarda historia cuenta. Una por clase.
  it.each(Object.entries(OTRA_HISTORIA) as [OtraHistoria, string][])(
    '🔴 el VIEJO tiene «%s» ⇒ no se fusiona y el motivo lo nombra',
    (clase, etiqueta) => {
      const r = decidirFusionAutorizada({ ...viejo, otros: { ...sinOtraHistoria, [clase]: 1 } }, nuevo)
      expect(r).toEqual({ decision: 'SOLO_REPORTAR', motivo: expect.stringContaining(etiqueta) })
    },
  )

  it('las clases nuevas sólo se exigen al VIEJO: el conservado conserva su historia', () => {
    const conTodo = Object.fromEntries(Object.keys(OTRA_HISTORIA).map(k => [k, 3])) as Record<OtraHistoria, number>
    expect(decidirFusionAutorizada(viejo, { ...nuevo, otros: conTodo, loyaltyPoints: 40, email: 'x@y.mx' })).toEqual({
      decision: 'FUSIONAR',
    })
  })

  it('las clases son las que pidió la ronda 1, con el nombre de la relación en el esquema', () => {
    expect(Object.keys(OTRA_HISTORIA).sort()).toEqual(
      [
        'loyaltyTransactions',
        'stampRewards',
        'stampCards',
        'externalIdentities',
        'taxProfiles',
        'referralsAsReferrer',
        'referralsAsReferred',
        'referralGrants',
        'referralTierUnlocks',
        'referredCustomers',
        'couponRedemptions',
        'customerDiscounts',
        'waitlistEntries',
        'consentEvents',
        'campaignDeliveries',
        'customerOrderMetrics',
        'approvalOutbox',
        'kioskOutreachOutbox',
        'captureTokens',
      ].sort(),
    )
  })

  it.each<[string, Partial<ResumenCliente>, Partial<ResumenCliente>, RegExp]>([
    ['el viejo tiene un correo que el conservado no tiene', { email: 'dany@correo.mx' }, {}, /correo/],
    ['el viejo tiene OTRO correo que el conservado', { email: 'dany@correo.mx' }, { email: 'otra@correo.mx' }, /correo/],
    ['el viejo tiene puntos', { loyaltyPoints: 15 }, {}, /puntos/],
    ['el viejo refirió a alguien (contador)', { referralCount: 1 }, {}, /referid/],
    ['al viejo lo refirió alguien', { referredByCustomerId: 'cAlguien' }, {}, /refiri/],
    ['el viejo tiene un cumpleaños distinto', { birthDate: '1990-05-01' }, {}, /cumpleaños/],
    ['el viejo tiene notas', { notes: 'alérgico a la nuez' }, {}, /notas/],
    ['el viejo tiene etiquetas', { tags: ['VIP'] }, {}, /etiquetas/],
  ])('🔴 %s ⇒ no se fusiona', (_n, v, n, motivo) => {
    const r = decidirFusionAutorizada({ ...viejo, ...v }, { ...nuevo, ...n })
    expect(r.decision).toBe('SOLO_REPORTAR')
    expect(r.decision === 'SOLO_REPORTAR' && r.motivo).toMatch(motivo)
  })

  it('el mismo correo o el mismo cumpleaños en los dos NO impide fusionar (no se pierde nada)', () => {
    expect(
      decidirFusionAutorizada(
        { ...viejo, email: 'dany@correo.mx', birthDate: '1990-05-01' },
        { ...nuevo, email: 'dany@correo.mx', birthDate: '1990-05-01' },
      ),
    ).toEqual({ decision: 'FUSIONAR' })
  })
})

describe('decidirReparacionDeSello', () => {
  const base: Parameters<typeof decidirReparacionDeSello>[0] = { coincidencias: 1, clienteId: 'c1', programaActivo: true, elegible: true }
  it.each<[Partial<typeof base>, string]>([
    [{}, 'COMPLETAR'],
    [{ coincidencias: 0 }, 'NO_EXISTE'],
    [{ coincidencias: 2 }, 'AMBIGUA'],
    [{ clienteId: null }, 'SIN_CLIENTE'],
    [{ programaActivo: false }, 'PROGRAMA_APAGADO'],
    [{ elegible: false }, 'NO_ELEGIBLE'],
  ])('%p ⇒ %s', (over, esperado) => {
    expect(decidirReparacionDeSello({ ...base, ...over })).toBe(esperado)
  })
})

describe('🔴 la elegibilidad de la reparación es la del sello tardío sin el plazo (auditoría A #6)', () => {
  const AHORA = Date.UTC(2026, 9, 14, 18, 0, 0)
  const venta22sep: SaleStampSnapshot = {
    customerId: 'c1',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    reembolsada: false,
    hasReversal: false,
    primaryCustomerId: 'c1',
    stampOwnerCustomerId: null,
    pointsOwnerCustomerIds: [],
    settledAt: new Date(Date.UTC(2026, 8, 22, 17, 0, 0)),
    esVentaDeTarjetas: false,
    esVentaNuevaDeCambio: false,
  }
  it('venta de hace 3 semanas: elegible para la reparación aunque ya no para el sello tardío', () => {
    expect(esElegibleParaLealtad(venta22sep, AHORA)).toBe(false)
    expect(esElegibleParaLealtad(venta22sep, AHORA, { ignorarPlazo: true })).toBe(true)
  })
  it('🔴 reembolsada (sigue PAID), cancelada u otro dueño: NO, aunque sea reparación', () => {
    expect(esElegibleParaLealtad({ ...venta22sep, reembolsada: true }, AHORA, { ignorarPlazo: true })).toBe(false)
    expect(esElegibleParaLealtad({ ...venta22sep, status: 'CANCELLED' }, AHORA, { ignorarPlazo: true })).toBe(false)
    expect(esElegibleParaLealtad({ ...venta22sep, pointsOwnerCustomerIds: ['heredado'] }, AHORA, { ignorarPlazo: true })).toBe(false)
  })
  it('🔴 ya sellada a ESTE cliente (corrida anterior cortada): SIGUE elegible, para completar lo que falte', () => {
    expect(esElegibleParaLealtad({ ...venta22sep, stampOwnerCustomerId: 'c1' }, AHORA, { ignorarPlazo: true })).toBe(true)
  })
})

describe('🔴 revalidarVenta: la elegibilidad completa salvo el plazo, también al APLICAR (B2)', () => {
  const ok: Parameters<typeof revalidarVenta>[0] = {
    existe: true,
    clienteId: 'c1',
    primarioActual: 'c1',
    elegible: true,
    decision: 'ELIGIBLE',
  }

  it('saldada, sin reembolso, el cliente sigue primario ⇒ elegible', () => {
    expect(revalidarVenta(ok)).toEqual({ elegible: true })
  })

  it.each<[string, Partial<typeof ok>, RegExp]>([
    ['la venta ya no existe', { existe: false, primarioActual: null, decision: null }, /ya no existe/],
    ['🔴 le quitaron al cliente (sin primario: la lealtad no tendría a quién sellar)', { primarioActual: null }, /primario/],
    ['🔴 otro cliente quedó como primario', { primarioActual: 'c2' }, /primario/],
    ['🔴 se reembolsó o canceló después de preparar', { elegible: false, decision: 'NOT_PAID' }, /NOT_PAID/],
  ])('%s ⇒ NO y dice por qué', (_n, over, motivo) => {
    const r = revalidarVenta({ ...ok, ...over })
    expect(r.elegible).toBe(false)
    expect(r.elegible === false && r.motivo).toMatch(motivo)
  })
})

describe('🔴 completarLealtadDeVentas: reanudable, revalidada al aplicar (B2) y con bitácora que se recupera (ronda 1 #2c)', () => {
  const venta: VentaPorReparar = { orderNumber: 'ORD-1790121567183', orderId: 'o1', clienteId: 'c1', base: 80 }
  const elegible = async () => ({ elegible: true as const })

  /** Un libro de la venta y su bitácora, en memoria. `completar` imita al envoltorio: sella primero y después acredita. */
  function libroDeVenta() {
    const libro = { sellos: 0, puntos: 0 }
    const bitacora: string[] = []
    return {
      libro,
      bitacora,
      completar: jest.fn(async () => {
        if (libro.sellos === 0) libro.sellos += 1
        if (libro.puntos === 0) libro.puntos += 1
        return { complete: true, reembolsada: false }
      }),
      estado: async (): Promise<EstadoDeLealtad> => ({ conSello: libro.sellos > 0, conPuntos: libro.puntos > 0, conVisita: false }),
      yaAuditada: jest.fn(async (v: VentaPorReparar) => bitacora.includes(v.orderId)),
      auditar: jest.fn(async (v: VentaPorReparar) => {
        bitacora.push(v.orderId)
      }),
    }
  }

  it('una corrida que se corta entre el sello y los puntos se completa en la siguiente, sin otro sello', async () => {
    const libro = { sellos: 0, puntos: 0 }
    let elProcesoMuere = true
    const completar = jest.fn(async () => {
      if (libro.sellos === 0) libro.sellos += 1
      if (elProcesoMuere) throw new Error('el proceso murió')
      if (libro.puntos === 0) libro.puntos += 1
      return { complete: true, reembolsada: false }
    })
    const estado = jest.fn(
      async (): Promise<EstadoDeLealtad> => ({ conSello: libro.sellos > 0, conPuntos: libro.puntos > 0, conVisita: false }),
    )
    const auditar = jest.fn(async () => undefined)
    const deps = { revalidar: elegible, completar, estado, yaAuditada: async () => false, auditar }

    await expect(completarLealtadDeVentas([venta], deps)).rejects.toThrow('el proceso murió')
    expect(libro).toEqual({ sellos: 1, puntos: 0 })
    expect(auditar).not.toHaveBeenCalled()

    elProcesoMuere = false
    expect(decidirReparacionDeSello({ coincidencias: 1, clienteId: 'c1', programaActivo: true, elegible: true })).toBe('COMPLETAR')
    const r = await completarLealtadDeVentas([venta], deps)

    expect(completar).toHaveBeenCalledTimes(2)
    expect(libro).toEqual({ sellos: 1, puntos: 1 })
    const esperado = {
      orderNumber: 'ORD-1790121567183',
      omitida: null,
      completa: true,
      conSello: true,
      reembolsada: false,
      cambio: true,
      auditoria: 'ESCRITA',
    }
    expect(r).toEqual([esperado])
    expect(auditar).toHaveBeenCalledTimes(1)
    expect(auditar).toHaveBeenCalledWith(venta, esperado)
  })

  it('🔴 #2c: se cae ENTRE otorgar y escribir la bitácora ⇒ la re-corrida la escribe (aunque ya no haya cambio), sin duplicar', async () => {
    const l = libroDeVenta()
    let laBitacoraFalla = true
    const auditar = jest.fn(async (v: VentaPorReparar) => {
      if (laBitacoraFalla) throw new Error('se cayó la conexión al escribir la bitácora')
      l.bitacora.push(v.orderId)
    })
    const deps = { revalidar: elegible, completar: l.completar, estado: l.estado, yaAuditada: l.yaAuditada, auditar }

    await expect(completarLealtadDeVentas([venta], deps)).rejects.toThrow('bitácora')
    expect(l.libro).toEqual({ sellos: 1, puntos: 1 }) // la lealtad SÍ quedó
    expect(l.bitacora).toEqual([]) // la bitácora no

    laBitacoraFalla = false
    const r = await completarLealtadDeVentas([venta], deps)
    // Ya no hay cambio (estaba completa), pero falta su renglón: se escribe. Decide la existencia del renglón, no el diff.
    expect(r[0]).toMatchObject({ cambio: false, auditoria: 'ESCRITA' })
    expect(l.bitacora).toEqual(['o1'])

    const otraVez = await completarLealtadDeVentas([venta], deps)
    expect(otraVez[0]).toMatchObject({ cambio: false, auditoria: 'YA_EXISTIA' })
    expect(l.bitacora).toEqual(['o1']) // sin duplicado
  })

  it('🔴 re-correr una venta ya completa Y auditada: se llama otra vez (idempotente) y no escribe otro renglón', async () => {
    const l = libroDeVenta()
    const deps = { revalidar: elegible, completar: l.completar, estado: l.estado, yaAuditada: l.yaAuditada, auditar: l.auditar }
    await completarLealtadDeVentas([venta], deps)
    const r = await completarLealtadDeVentas([venta], deps)
    expect(l.completar).toHaveBeenCalledTimes(2)
    expect(l.auditar).toHaveBeenCalledTimes(1)
    expect(r).toEqual([
      {
        orderNumber: venta.orderNumber,
        omitida: null,
        completa: true,
        conSello: true,
        reembolsada: false,
        cambio: false,
        auditoria: 'YA_EXISTIA',
      },
    ])
  })

  it('sin sello después de completar (p. ej. el tope de HOY): lo dice, no lo esconde', async () => {
    const r = await completarLealtadDeVentas([{ orderNumber: 'ORD-2', orderId: 'o2', clienteId: 'c2', base: 50 }], {
      revalidar: elegible,
      completar: async () => ({ complete: true, reembolsada: false }),
      estado: async () => ({ conSello: false, conPuntos: false, conVisita: true }),
      yaAuditada: async () => false,
      auditar: async () => undefined,
    })
    expect(r).toEqual([
      { orderNumber: 'ORD-2', omitida: null, completa: true, conSello: false, reembolsada: false, cambio: false, auditoria: 'ESCRITA' },
    ])
  })

  it('🔴 B2: preparada elegible → entra un reembolso → al aplicar NO se otorga, sin sello válido y sin bitácora', async () => {
    let reembolsada = false
    const l = libroDeVenta()
    const revalidar = jest.fn(async () =>
      reembolsada ? { elegible: false as const, motivo: 'ya no es elegible (NOT_PAID)' } : { elegible: true as const },
    )
    const informar = jest.fn()

    reembolsada = true // ← el reembolso entra entre preparar y aplicar
    const r = await completarLealtadDeVentas([venta], {
      revalidar,
      completar: l.completar,
      estado: l.estado,
      yaAuditada: l.yaAuditada,
      auditar: l.auditar,
      informar,
    })

    expect(revalidar).toHaveBeenCalledWith(venta)
    expect(l.completar).not.toHaveBeenCalled()
    expect(l.auditar).not.toHaveBeenCalled()
    expect(l.libro.sellos).toBe(0)
    expect(r).toEqual([
      {
        orderNumber: venta.orderNumber,
        omitida: 'ya no es elegible (NOT_PAID)',
        completa: false,
        conSello: false,
        reembolsada: false,
        cambio: false,
        auditoria: 'NO_APLICA',
      },
    ])
    expect(informar).toHaveBeenCalledWith(venta, r[0])
  })

  it('🔴 B2: el reembolso entra MIENTRAS se otorga ⇒ el envoltorio revierte y el resultado lo dice (sin sello válido)', async () => {
    const r = await completarLealtadDeVentas([venta], {
      revalidar: elegible,
      completar: async () => ({ complete: true, reembolsada: true }),
      estado: jest
        .fn<Promise<EstadoDeLealtad>, [VentaPorReparar]>()
        .mockResolvedValueOnce({ conSello: false, conPuntos: false, conVisita: false })
        .mockResolvedValueOnce({ conSello: false, conPuntos: true, conVisita: true }),
      yaAuditada: async () => false,
      auditar: async () => undefined,
    })
    expect(r).toEqual([
      {
        orderNumber: venta.orderNumber,
        omitida: null,
        completa: true,
        conSello: false,
        reembolsada: true,
        cambio: true,
        auditoria: 'ESCRITA',
      },
    ])
  })

  it('cada venta se revalida en SU turno, y su bitácora se escribe en cuanto termina (antes de la siguiente)', async () => {
    const orden: string[] = []
    const ventas: VentaPorReparar[] = [venta, { orderNumber: 'ORD-2', orderId: 'o2', clienteId: 'c2', base: 50 }]
    await completarLealtadDeVentas(ventas, {
      revalidar: async v => {
        orden.push(`revalidar ${v.orderId}`)
        return { elegible: true }
      },
      completar: async v => {
        orden.push(`completar ${v.orderId}`)
        return { complete: true, reembolsada: false }
      },
      estado: async () => ({ conSello: true, conPuntos: false, conVisita: false }),
      yaAuditada: async () => false,
      auditar: async v => {
        orden.push(`auditar ${v.orderId}`)
      },
    })
    expect(orden).toEqual(['revalidar o1', 'completar o1', 'auditar o1', 'revalidar o2', 'completar o2', 'auditar o2'])
  })
})

describe('🔴 aplicarTelefonosYPar: (a)+(b) y SU bitácora en la MISMA transacción (ronda 1 #2a/b, #3 ii/iii/vi)', () => {
  const cambioCliente: CambioDeTelefono = { id: 'cAna', venueId: 'v1', de: '+5543453965', a: '+525543453965' }
  const cambioConsumer: CambioDeTelefono = { id: 'kAna', venueId: null, de: '+5543453965', a: '+525543453965' }
  const choqueDelPar: ChoqueDeTelefono = {
    id: PAR_AUTORIZADO.retirar,
    venueId: PAR_AUTORIZADO.venueId,
    de: '+8129440042',
    a: '+528129440042',
    ocupadoPor: PAR_AUTORIZADO.conservar,
  }

  /** Un puerto falso que anota cada llamada en orden: así se ve qué pasa dentro de la transacción y en qué orden. */
  function puertoFalso(over: Partial<PuertoDeTransaccion> = {}) {
    const llamadas: string[] = []
    const bitacora: FilaDeBitacora[] = []
    const anota =
      <A extends unknown[], R>(nombre: string, f: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        llamadas.push(nombre)
        return f(...a)
      }
    const base: PuertoDeTransaccion = {
      bloquearPar: async () => undefined,
      cambiarTelefonoDeCliente: async () => 1,
      consumerConTelefono: async () => null,
      cambiarTelefonoDeConsumer: async () => 1,
      decidirPar: async (): Promise<DecisionDeFusion> => ({ decision: 'FUSIONAR' }),
      pasesDelViejo: async () => ['pase1'],
      moverPases: async ids => ids.length,
      desactivarViejo: async () => 1,
      escribirBitacora: async filas => {
        bitacora.push(...filas)
      },
    }
    const p = { ...base, ...over }
    const puerto: PuertoDeTransaccion = {
      bloquearPar: anota('bloquearPar', p.bloquearPar),
      cambiarTelefonoDeCliente: anota('cambiarTelefonoDeCliente', p.cambiarTelefonoDeCliente),
      consumerConTelefono: anota('consumerConTelefono', p.consumerConTelefono),
      cambiarTelefonoDeConsumer: anota('cambiarTelefonoDeConsumer', p.cambiarTelefonoDeConsumer),
      decidirPar: anota('decidirPar', p.decidirPar),
      pasesDelViejo: anota('pasesDelViejo', p.pasesDelViejo),
      moverPases: anota('moverPases', p.moverPases),
      desactivarViejo: anota('desactivarViejo', p.desactivarViejo),
      escribirBitacora: anota('escribirBitacora', p.escribirBitacora),
    }
    return { puerto, llamadas, bitacora }
  }
  const plan = { script: SCRIPT, cambiosDeClientes: [cambioCliente], cambiosDeConsumidores: [cambioConsumer], parPorFusionar: choqueDelPar }

  it('🔴 #3iii: el candado FOR UPDATE del par es lo PRIMERO; la bitácora es lo ÚLTIMO, dentro de la misma llamada', async () => {
    const f = puertoFalso()
    const r = await aplicarTelefonosYPar(f.puerto, plan)
    expect(f.llamadas).toEqual([
      'bloquearPar',
      'cambiarTelefonoDeCliente',
      'consumerConTelefono',
      'cambiarTelefonoDeConsumer',
      'decidirPar',
      'pasesDelViejo',
      'moverPases',
      'desactivarViejo',
      'escribirBitacora',
    ])
    expect(r.fusion).toEqual({ aplicada: true, pases: ['pase1'] })
    expect(f.bitacora).toEqual([
      filaDeBitacora('CUSTOMER_PHONE_NORMALIZED', 'Customer', 'cAna', 'v1', { de: '+5543453965', a: '+525543453965', script: SCRIPT }),
      filaDeBitacora('CONSUMER_PHONE_NORMALIZED', 'Consumer', 'kAna', null, { de: '+5543453965', a: '+525543453965', script: SCRIPT }),
      filaDeBitacora('CUSTOMER_MERGED_DUPLICATE', 'Customer', PAR_AUTORIZADO.retirar, PAR_AUTORIZADO.venueId, {
        conservado: PAR_AUTORIZADO.conservar,
        telefonoViejo: '+8129440042',
        pasesMovidos: ['pase1'],
        script: SCRIPT,
      }),
    ])
    expect(r.bitacora).toBe(3)
  })

  it('sin par por fusionar no se toma el candado del par', async () => {
    const f = puertoFalso()
    await aplicarTelefonosYPar(f.puerto, { ...plan, parPorFusionar: null })
    expect(f.llamadas).not.toContain('bloquearPar')
    expect(f.llamadas).not.toContain('decidirPar')
  })

  it('🔴 #2a: un CAS que falla aborta TODO y la bitácora nunca se escribe (cambio y bitácora caen juntos)', async () => {
    const f = puertoFalso({ cambiarTelefonoDeCliente: async () => 0 })
    await expect(aplicarTelefonosYPar(f.puerto, plan)).rejects.toThrow('cambió por debajo')
    expect(f.llamadas).not.toContain('escribirBitacora')
  })

  it('🔴 #2a: si escribir la bitácora falla, la llamada falla (el llamador la corre dentro de la transacción: se deshace todo)', async () => {
    const f = puertoFalso({
      escribirBitacora: async () => {
        throw new Error('la bitácora no se pudo escribir')
      },
    })
    await expect(aplicarTelefonosYPar(f.puerto, plan)).rejects.toThrow('bitácora')
  })

  it('🔴 #3ii: otro Consumer YA tiene el +52 (apareció después del plan) ⇒ ese no se cambia, se reporta y no va a la bitácora', async () => {
    const f = puertoFalso({ consumerConTelefono: async () => 'kOtro' })
    const r = await aplicarTelefonosYPar(f.puerto, plan)
    expect(f.llamadas).not.toContain('cambiarTelefonoDeConsumer')
    expect(r.consumidores).toEqual([])
    expect(r.consumidoresOmitidos).toEqual([{ ...cambioConsumer, ocupadoPor: 'kOtro' }])
    expect(f.bitacora.map(b => b.action)).toEqual(['CUSTOMER_PHONE_NORMALIZED', 'CUSTOMER_MERGED_DUPLICATE'])
  })

  it('🔴 la revalidación DENTRO de la transacción rechaza ⇒ no se mueven pases ni se desactiva; (a) sí se aplica', async () => {
    const f = puertoFalso({ decidirPar: async () => ({ decision: 'SOLO_REPORTAR', motivo: 'el viejo tiene 1 reservas' }) })
    const r = await aplicarTelefonosYPar(f.puerto, plan)
    expect(r.fusion).toEqual({ aplicada: false, motivo: 'el viejo tiene 1 reservas' })
    expect(f.llamadas).not.toContain('moverPases')
    expect(f.llamadas).not.toContain('desactivarViejo')
    expect(f.bitacora.map(b => b.action)).toEqual(['CUSTOMER_PHONE_NORMALIZED', 'CONSUMER_PHONE_NORMALIZED'])
  })

  it(`🔴 #3vi: más de ${TOPE_PASES} pases del viejo ⇒ no se fusiona y se dice por qué (nunca se mueve una parte)`, async () => {
    const muchos = Array.from({ length: TOPE_PASES + 1 }, (_, i) => `pase${i}`)
    const pasesDelViejo = jest.fn(async () => muchos)
    const f = puertoFalso({ pasesDelViejo })
    const r = await aplicarTelefonosYPar(f.puerto, plan)
    expect(pasesDelViejo).toHaveBeenCalledWith(TOPE_PASES + 1)
    expect(r.fusion).toEqual({ aplicada: false, motivo: expect.stringContaining(`más de ${TOPE_PASES} pases`) })
    expect(f.llamadas).not.toContain('moverPases')
    expect(f.llamadas).not.toContain('desactivarViejo')
  })

  it('🔴 #3vi: mover pases toca un número distinto de los que se leyeron ⇒ se aborta TODO', async () => {
    const f = puertoFalso({ moverPases: async () => 0 })
    await expect(aplicarTelefonosYPar(f.puerto, plan)).rejects.toThrow('pases')
    expect(f.llamadas).not.toContain('escribirBitacora')
  })

  it('el viejo cambió por debajo al desactivarlo ⇒ se aborta TODO', async () => {
    const f = puertoFalso({ desactivarViejo: async () => 0 })
    await expect(aplicarTelefonosYPar(f.puerto, plan)).rejects.toThrow('cambió por debajo')
  })

  it('sin nada que cambiar no escribe una bitácora vacía', async () => {
    const f = puertoFalso()
    const r = await aplicarTelefonosYPar(f.puerto, {
      script: SCRIPT,
      cambiosDeClientes: [],
      cambiosDeConsumidores: [],
      parPorFusionar: null,
    })
    expect(f.llamadas).toEqual([])
    expect(r.bitacora).toBe(0)
  })

  it('filaDeBitacora lleva los MISMOS campos que escribe logAction (actor nulo, sin organización, IP ni agente)', () => {
    expect(filaDeBitacora('X', 'Order', 'o1', 'v1', { a: 1 })).toEqual({
      staffId: null,
      venueId: 'v1',
      organizationId: null,
      action: 'X',
      entity: 'Order',
      entityId: 'o1',
      data: { a: 1 },
      ipAddress: null,
      userAgent: null,
    })
  })
})

describe('🔴 interpretarBanderas: sólo las conocidas y sin contradicciones (ronda 1 #3v)', () => {
  it.each<[string[], { base: 'render' | 'local' | null; aplicar: boolean; confirmHost: string | null }]>([
    [[], { base: null, aplicar: false, confirmHost: null }],
    [['--dry-run'], { base: null, aplicar: false, confirmHost: null }],
    [['--base', 'render'], { base: 'render', aplicar: false, confirmHost: null }],
    [['--base', 'local', '--dry-run'], { base: 'local', aplicar: false, confirmHost: null }],
    [['--base', 'render', '--apply', '--confirm-host', 'db.x.com'], { base: 'render', aplicar: true, confirmHost: 'db.x.com' }],
  ])('%p ⇒ válido', (args, esperado) => {
    expect(interpretarBanderas(args)).toEqual({ ok: true, banderas: esperado })
  })

  it.each<[string[], RegExp]>([
    [['--aplicar'], /desconocida/],
    [['--base=render'], /desconocida/],
    [['render'], /desconocida/],
    [['--dry-run', '--apply'], /contradic/],
    [['--apply', '--apply'], /repetida/],
    [['--base', 'render', '--base', 'local'], /repetida/],
    [['--base'], /valor/],
    [['--base', '--apply'], /valor/],
    [['--confirm-host'], /valor/],
    [['--base', 'prod'], /render.*local/],
  ])('%p ⇒ rechazo', (args, motivo) => {
    const r = interpretarBanderas(args)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(motivo)
  })
})

describe('🔴 revisarBase: la base por defecto nunca es prod; para escribir sin --base render, sólo loopback (ronda 1 #3iv)', () => {
  const HOST_RENDER = 'dpg-abc.oregon-postgres.render.com'
  it.each<[string, Parameters<typeof revisarBase>[0]]>([
    ['simulación local', { base: null, aplicar: false, host: 'localhost', hostRender: HOST_RENDER }],
    ['aplicar en localhost', { base: null, aplicar: true, host: 'localhost', hostRender: HOST_RENDER }],
    ['aplicar en 127.0.0.1', { base: 'local', aplicar: true, host: '127.0.0.1', hostRender: HOST_RENDER }],
    ['aplicar en ::1', { base: null, aplicar: true, host: '[::1]', hostRender: HOST_RENDER }],
    ['simulación contra una copia en otra máquina (sólo lee)', { base: null, aplicar: false, host: 'copia.lan', hostRender: HOST_RENDER }],
    ['--base render (simulación)', { base: 'render', aplicar: false, host: HOST_RENDER, hostRender: HOST_RENDER }],
    ['--base render --apply', { base: 'render', aplicar: true, host: HOST_RENDER, hostRender: HOST_RENDER }],
  ])('%s ⇒ ok', (_n, e) => {
    expect(revisarBase(e)).toEqual({ ok: true })
  })

  it.each<[string, Parameters<typeof revisarBase>[0], RegExp]>([
    [
      'default apuntando al host de RENDER_DATABASE_URL',
      { base: null, aplicar: false, host: HOST_RENDER, hostRender: HOST_RENDER },
      /producción/,
    ],
    ['default apuntando a *.render.com', { base: null, aplicar: false, host: 'otro.render.com', hostRender: null }, /producción/],
    [
      '🔴 aplicar sin --base render contra un host que no es loopback',
      { base: null, aplicar: true, host: 'copia.lan', hostRender: null },
      /local/,
    ],
    ['🔴 aplicar con --base local contra un host remoto', { base: 'local', aplicar: true, host: '10.0.0.5', hostRender: null }, /local/],
    ['localhost.evil.com no es loopback', { base: null, aplicar: true, host: 'localhost.evil.com', hostRender: null }, /local/],
  ])('%s ⇒ rechazo', (_n, e, motivo) => {
    const r = revisarBase(e)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.motivo).toMatch(motivo)
  })
})

// ── H7 (auditoría de Codex del código + revisión final Important 1, 15-oct-2026) ─────────────────────────────────────────
describe('🔴 H7 revisarEntornoPublico: escribir en PRODUCCIÓN exige que los avisos al cliente salgan con la API de producción', () => {
  it.each<[string, Parameters<typeof revisarEntornoPublico>[0]]>([
    ['--base render --apply con https://api.avoqado.io', { base: 'render', aplicar: true, baseUrl: 'https://api.avoqado.io' }],
    ['… con diagonal final', { base: 'render', aplicar: true, baseUrl: 'https://api.avoqado.io/' }],
    [
      'simulación contra render con ngrok (sólo lee: no se manda nada)',
      { base: 'render', aplicar: false, baseUrl: 'https://x.ngrok-free.dev' },
    ],
    ['simulación sin BASE_URL', { base: 'render', aplicar: false, baseUrl: undefined }],
    ['aplicar en la base LOCAL con ngrok (no es producción)', { base: null, aplicar: true, baseUrl: 'https://x.ngrok-free.dev' }],
    ['aplicar con --base local', { base: 'local', aplicar: true, baseUrl: undefined }],
  ])('%s ⇒ ok', (_n, e) => {
    expect(revisarEntornoPublico(e)).toEqual({ ok: true })
  })

  it.each<[string, string | undefined]>([
    ['el túnel de ngrok de la Mac', 'https://patchiest-noncommemorational-willia.ngrok-free.dev'],
    ['el dashboard local', 'http://localhost:5173'],
    ['sin BASE_URL', undefined],
    ['vacía', ''],
    ['no es URL', 'api.avoqado.io'],
    ['http (sin TLS)', 'http://api.avoqado.io'],
    ['un host que sólo EMPIEZA igual', 'https://api.avoqado.io.evil.com'],
    ['otro subdominio', 'https://staging.avoqado.io'],
  ])('🔴 --base render --apply con %s ⇒ rechazo (salida 2 en el script)', (_n, baseUrl) => {
    const r = revisarEntornoPublico({ base: 'render', aplicar: true, baseUrl })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.motivo).toMatch(/api\.avoqado\.io/)
  })
})

// ── H7, segunda ola (recheck de Codex, 15-oct-2026) ──────────────────────────────────────────────────────────────────────
describe('🔴 H7 clientesPorAvisar: a quién se le actualiza el pase al terminar (c), aunque el sello ya existiera', () => {
  const v = (orderNumber: string, clienteId: string): VentaPorReparar => ({ orderNumber, orderId: `o-${orderNumber}`, clienteId, base: 80 })
  const r = (over: Partial<ResultadoDeReparacion> = {}): ResultadoDeReparacion => ({
    orderNumber: 'X',
    omitida: null,
    completa: true,
    conSello: true,
    reembolsada: false,
    cambio: true,
    auditoria: 'ESCRITA',
    ...over,
  })

  it('🔴 REANUDACIÓN: una corrida anterior selló y se cortó antes del aviso; ésta sólo encuentra el sello ⇒ también se avisa', () => {
    expect(clientesPorAvisar([{ venta: v('A', 'ana'), resultado: r({ cambio: false, auditoria: 'YA_EXISTIA' }) }])).toEqual(['ana'])
  })

  it('completadas en esta corrida, sin repetir cliente; nunca las omitidas, las reembolsadas ni las que quedaron sin sello', () => {
    expect(
      clientesPorAvisar([
        { venta: v('A', 'ana'), resultado: r() },
        { venta: v('B', 'ana'), resultado: r({ cambio: false }) },
        { venta: v('C', 'beto'), resultado: r() },
        { venta: v('D', 'carla'), resultado: r({ omitida: 'ya no es elegible (NOT_PAID)', conSello: false, auditoria: 'NO_APLICA' }) },
        { venta: v('E', 'dany'), resultado: r({ reembolsada: true, conSello: false }) },
        { venta: v('F', 'eva'), resultado: r({ conSello: false }) },
      ]),
    ).toEqual(['ana', 'beto'])
  })
})

describe('H7 lineaDeEntornoPublico: lo que la simulación dice ANTES de aplicar', () => {
  it('nombra el host de BASE_URL (nunca la URL completa) y si Apple/Google Wallet están disponibles', () => {
    expect(
      lineaDeEntornoPublico({ baseUrl: 'https://api.avoqado.io/x?token=secreto', apple: true, apnsProduccion: true, google: false }),
    ).toBe('Avisos al cliente: BASE_URL → api.avoqado.io · Apple Wallet: disponible (APNs de producción) · Google Wallet: NO disponible')
    expect(lineaDeEntornoPublico({ baseUrl: undefined, apple: false, apnsProduccion: false, google: true })).toBe(
      'Avisos al cliente: BASE_URL → (sin BASE_URL) · Apple Wallet: NO disponible · Google Wallet: disponible',
    )
    expect(lineaDeEntornoPublico({ baseUrl: 'https://x.ngrok-free.dev', apple: true, apnsProduccion: false, google: true })).toContain(
      'Apple Wallet: disponible (APNs de PRUEBAS: los iPhone de clientes reales no se actualizan)',
    )
  })
})

describe('🔴 el script elige la base ANTES de cargar Prisma: nada que cargue el cliente entra por import estático', () => {
  const raiz = join(__dirname, '..', '..', '..', '..')
  const importsDe = (archivo: string): string[] =>
    [...readFileSync(join(raiz, archivo), 'utf8').matchAll(/^import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map(m => m[1])

  it('reparacionLealtad.ts sólo depende de utilidades puras (si importara el cliente de Prisma, `--base render` llegaría tarde)', () => {
    expect(importsDe('src/services/shared/reparacionLealtad.ts')).toEqual(['@/utils/phone'])
    expect(importsDe('src/utils/phone.ts')).toEqual(['libphonenumber-js'])
  })

  it('el script no importa estáticamente nada que construya el cliente de Prisma', () => {
    expect(importsDe(SCRIPT).sort()).toEqual(
      ['../../src/services/shared/reparacionLealtad', '../../src/utils/phone', '@prisma/client', 'dotenv/config'].sort(),
    )
  })

  it('🔴 #3i: el script usa normalizarTelefonoMx para buscar los teléfonos ocupados (no re-implementa la regla)', () => {
    const fuente = readFileSync(join(raiz, SCRIPT), 'utf8')
    expect(fuente).not.toMatch(/`\+52\$\{/)
    expect(fuente).toMatch(/normalizarTelefonoMx\(/)
  })

  it('🔴 #2a: el script escribe la bitácora de (a)+(b) con el cliente de la transacción, no con logAction', () => {
    const fuente = readFileSync(join(raiz, SCRIPT), 'utf8')
    expect(fuente).toMatch(/tx\.activityLog\.createMany\(/)
    expect(fuente).not.toMatch(/logAction/)
  })

  it('🔴 H7: revisa BASE_URL antes de conectarse y ESPERA los avisos/correos de la reparación antes de desconectar', () => {
    const fuente = readFileSync(join(raiz, SCRIPT), 'utf8')
    const revisa = fuente.indexOf('revisarEntornoPublico(')
    const conecta = fuente.indexOf("await import('../../src/utils/prismaClient')")
    expect(revisa).toBeGreaterThan(-1)
    expect(revisa).toBeLessThan(conecta)
    expect(fuente).toMatch(/process\.env\.BASE_URL/)
    const espera = fuente.indexOf('esperarEfectosDeSellos(')
    const desconecta = fuente.indexOf('prisma.$disconnect()')
    expect(espera).toBeGreaterThan(-1)
    expect(espera).toBeLessThan(desconecta)
    expect(fuente).toMatch(/lineaDeEntornoPublico\(/)
  })

  it('🔴 H7 (segunda ola): después de (c) llama y ESPERA el aviso al pase de cada cliente reparado (también si su sello ya existía), antes de esperar los correos y desconectar', () => {
    const fuente = readFileSync(join(raiz, SCRIPT), 'utf8')
    const quienes = fuente.indexOf('clientesPorAvisar(')
    const avisa = fuente.indexOf('await notifyCustomerPassUpdated(venueSellos')
    const espera = fuente.indexOf('esperarEfectosDeSellos(')
    expect(quienes).toBeGreaterThan(-1)
    expect(avisa).toBeGreaterThan(quienes)
    expect(avisa).toBeLessThan(espera)
    expect(espera).toBeLessThan(fuente.indexOf('prisma.$disconnect()'))
  })
})

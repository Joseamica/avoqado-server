import { readFileSync } from 'fs'
import { join } from 'path'
import {
  PAR_AUTORIZADO,
  completarLealtadDeVentas,
  decidirFusionAutorizada,
  decidirReparacionDeSello,
  planearTelefonos,
  revalidarVenta,
  type EstadoDeLealtad,
  type FilaTelefono,
  type ResumenCliente,
  type VentaPorReparar,
} from '@/services/shared/reparacionLealtad'
import { esElegibleParaLealtad, type SaleStampSnapshot } from '@/services/shared/loyaltyOnLateCustomer'

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
  const limpio = (id: string, phone: string): ResumenCliente => ({
    id,
    venueId: PAR_AUTORIZADO.venueId,
    active: true,
    phone,
    sellos: 0,
    ventas: 0,
    reservas: 0,
    paquetes: 0,
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

describe('🔴 completarLealtadDeVentas: reanudable (auditoría A #6) y revalidada al aplicar (B2)', () => {
  const venta: VentaPorReparar = { orderNumber: 'ORD-1790121567183', orderId: 'o1', clienteId: 'c1', base: 80 }
  const elegible = async () => ({ elegible: true as const })

  it('una corrida que se corta entre el sello y los puntos se completa en la siguiente, sin otro sello', async () => {
    // El libro de una venta. `completar` imita al envoltorio de la lealtad: sella primero (earnPoints → grantStamp) y
    // después acredita; lo que ya está no se repite.
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
    const registrar = jest.fn(async () => undefined)

    // 1.ª corrida: se cae a la mitad.
    await expect(completarLealtadDeVentas([venta], { revalidar: elegible, completar, estado, registrar })).rejects.toThrow(
      'el proceso murió',
    )
    expect(libro).toEqual({ sellos: 1, puntos: 0 })
    expect(registrar).not.toHaveBeenCalled()

    // 2.ª corrida: la misma venta vuelve a decidirse COMPLETAR (la decisión no mira «ya sellada») y se completa.
    elProcesoMuere = false
    expect(decidirReparacionDeSello({ coincidencias: 1, clienteId: 'c1', programaActivo: true, elegible: true })).toBe('COMPLETAR')
    const r = await completarLealtadDeVentas([venta], { revalidar: elegible, completar, estado, registrar })

    expect(completar).toHaveBeenCalledTimes(2)
    expect(libro).toEqual({ sellos: 1, puntos: 1 })
    const esperado = { orderNumber: 'ORD-1790121567183', omitida: null, completa: true, conSello: true, reembolsada: false, cambio: true }
    expect(r).toEqual([esperado])
    expect(registrar).toHaveBeenCalledWith(venta, esperado)
  })

  it('🔴 re-correr una venta YA completa: se llama otra vez (idempotente) pero no cambia nada y lo dice (sin bitácora)', async () => {
    const completar = jest.fn(async () => ({ complete: true, reembolsada: false }))
    const estado = async (): Promise<EstadoDeLealtad> => ({ conSello: true, conPuntos: true, conVisita: true })
    const r = await completarLealtadDeVentas([venta], { revalidar: elegible, completar, estado })
    expect(completar).toHaveBeenCalledTimes(1)
    expect(r).toEqual([
      { orderNumber: venta.orderNumber, omitida: null, completa: true, conSello: true, reembolsada: false, cambio: false },
    ])
  })

  it('sin sello después de completar (p. ej. el tope de HOY): lo dice, no lo esconde', async () => {
    const r = await completarLealtadDeVentas([{ orderNumber: 'ORD-2', orderId: 'o2', clienteId: 'c2', base: 50 }], {
      revalidar: elegible,
      completar: async () => ({ complete: true, reembolsada: false }),
      estado: async () => ({ conSello: false, conPuntos: false, conVisita: true }),
    })
    expect(r).toEqual([{ orderNumber: 'ORD-2', omitida: null, completa: true, conSello: false, reembolsada: false, cambio: false }])
  })

  it('🔴 B2: preparada elegible → entra un reembolso → al aplicar NO se otorga y queda sin sello válido', async () => {
    // El plan (simulación o la lectura del inicio de --apply) la vio COMPLETAR. Antes de su turno, la venta se devuelve.
    let reembolsada = false
    const libro = { sellos: 0 }
    const revalidar = jest.fn(async () =>
      reembolsada ? { elegible: false as const, motivo: 'ya no es elegible (NOT_PAID)' } : { elegible: true as const },
    )
    const completar = jest.fn(async () => {
      libro.sellos += 1
      return { complete: true, reembolsada: false }
    })
    const estado = async (): Promise<EstadoDeLealtad> => ({ conSello: libro.sellos > 0, conPuntos: false, conVisita: false })
    const registrar = jest.fn(async () => undefined)

    reembolsada = true // ← el reembolso entra entre preparar y aplicar
    const r = await completarLealtadDeVentas([venta], { revalidar, completar, estado, registrar })

    expect(revalidar).toHaveBeenCalledWith(venta)
    expect(completar).not.toHaveBeenCalled()
    expect(libro.sellos).toBe(0)
    expect(r).toEqual([
      {
        orderNumber: venta.orderNumber,
        omitida: 'ya no es elegible (NOT_PAID)',
        completa: false,
        conSello: false,
        reembolsada: false,
        cambio: false,
      },
    ])
    expect(registrar).toHaveBeenCalledWith(venta, r[0])
  })

  it('🔴 B2: el reembolso entra MIENTRAS se otorga ⇒ el envoltorio revierte y el resultado lo dice (sin sello válido)', async () => {
    const r = await completarLealtadDeVentas([venta], {
      revalidar: elegible,
      // El envoltorio otorgó, volvió a contar, vio el reembolso y revirtió el sello: EARN + REVERSAL = sin sello válido.
      completar: async () => ({ complete: true, reembolsada: true }),
      estado: jest
        .fn<Promise<EstadoDeLealtad>, [VentaPorReparar]>()
        .mockResolvedValueOnce({ conSello: false, conPuntos: false, conVisita: false })
        .mockResolvedValueOnce({ conSello: false, conPuntos: true, conVisita: true }),
    })
    expect(r).toEqual([{ orderNumber: venta.orderNumber, omitida: null, completa: true, conSello: false, reembolsada: true, cambio: true }])
  })

  it('cada venta se revalida en SU turno, no todas al principio', async () => {
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
    })
    expect(orden).toEqual(['revalidar o1', 'completar o1', 'revalidar o2', 'completar o2'])
  })
})

describe('🔴 el script elige la base ANTES de cargar Prisma: nada que cargue el cliente entra por import estático', () => {
  const raiz = join(__dirname, '..', '..', '..', '..')
  const importsDe = (archivo: string): string[] =>
    [...readFileSync(join(raiz, archivo), 'utf8').matchAll(/^import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map(m => m[1])

  it('reparacionLealtad.ts sólo depende de utilidades puras (si importara el cliente de Prisma, `--base render` llegaría tarde)', () => {
    expect(importsDe('src/services/shared/reparacionLealtad.ts')).toEqual(['@/utils/phone'])
  })

  it('el script no importa estáticamente nada que construya el cliente de Prisma', () => {
    expect(importsDe('scripts/lealtad/reparar-telefonos-y-sellos.ts').sort()).toEqual(
      ['../../src/services/shared/reparacionLealtad', '@prisma/client', 'dotenv/config'].sort(),
    )
  })
})

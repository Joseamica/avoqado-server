// tests/unit/schemas/cfdiGlobalTrigger.schema.test.ts
// C1 (Tarea 8, C1-P16 = B): el disparo de la factura global acepta `desde` opcional = el inicio (ISO) de un periodo reciente; sin cuerpo
// sigue valiendo (el último periodo cerrado, como siempre). Qué periodo es «reciente» lo decide el servicio; aquí sólo la forma.
import { listGlobalExcluidasSchema, triggerGlobalCfdiSchema, upsertEmisorSchema } from '../../../src/schemas/dashboard/cfdi.schema'

const parse = (body: unknown) => triggerGlobalCfdiSchema.safeParse({ body })

describe('triggerGlobalCfdiSchema — `desde` opcional', () => {
  it('control — sin cuerpo, o cuerpo vacío, vale', () => {
    expect(parse(undefined).success).toBe(true)
    expect(parse({}).success).toBe(true)
  })
  it('control — un instante ISO pasa tal cual', () => {
    const r = parse({ desde: '2026-10-09T06:00:00.000Z' })
    expect(r.success && r.data.body).toEqual({ desde: '2026-10-09T06:00:00.000Z' })
  })
  it('🔴 algo que no es un instante ISO ⇒ 400 en español', () => {
    for (const malo of ['ayer', '2026-10-09', 12345, '09/10/2026']) {
      const r = parse({ desde: malo })
      expect([malo, r.success]).toEqual([malo, false])
      if (!r.success)
        expect(r.error.issues[0].message).toBe('`desde` debe ser el inicio del periodo en formato ISO (2026-10-09T06:00:00.000Z)')
    }
  })
  it('🔴 un campo desconocido no pasa (no se cuela nada al servicio)', () => {
    expect(parse({ desde: '2026-10-09T06:00:00.000Z', periodo: 'x' }).success).toBe(false)
  })
})

// Ajuste del founder (7-oct): el RFC decide si su global toma las ventas cobradas fuera de la terminal (opcional y aditivo).
describe('upsertEmisorSchema — `includeOffTerminalSalesInGlobal` opcional', () => {
  const emisor = { rfc: 'EKU9003173C9', legalName: 'Empresa', regimenFiscal: '601', lugarExpedicion: '64000' }
  const parseEmisor = (body: unknown) => upsertEmisorSchema.safeParse({ body })
  it('🔴 llega al servicio tal cual (sin el esquema, el validador lo quitaría del cuerpo)', () => {
    for (const v of [true, false]) {
      const r = parseEmisor({ ...emisor, includeOffTerminalSalesInGlobal: v })
      expect(r.success && r.data.body.includeOffTerminalSalesInGlobal).toBe(v)
    }
  })
  it('🔴 algo que no es sí/no no pasa', () => {
    expect(parseEmisor({ ...emisor, includeOffTerminalSalesInGlobal: 'sí' }).success).toBe(false)
  })
  it('control — sin el campo sigue valiendo (el dashboard viejo no lo manda)', () => {
    const r = parseEmisor(emisor)
    expect(r.success).toBe(true)
    expect(r.success && 'includeOffTerminalSalesInGlobal' in r.data.body).toBe(false)
  })
})

// C1 (Tarea 11): la complementaria se pide por el id de su principal (ruta) y sin cuerpo.
import { emitGlobalComplementariaSchema } from '../../../src/schemas/dashboard/cfdi.schema'

describe('emitGlobalComplementariaSchema — por el id de la principal, sin cuerpo', () => {
  const params = { venueId: 'v1', emisorId: 'e1', principalId: 'g1' }
  it('control — sin cuerpo, o cuerpo vacío, vale', () => {
    expect(emitGlobalComplementariaSchema.safeParse({ params, body: undefined }).success).toBe(true)
    expect(emitGlobalComplementariaSchema.safeParse({ params, body: {} }).success).toBe(true)
  })
  it('🔴 un campo en el cuerpo no pasa (el periodo NO se elige: es el guardado de la principal)', () => {
    expect(emitGlobalComplementariaSchema.safeParse({ params, body: { desde: '2026-10-09T06:00:00.000Z' } }).success).toBe(false)
  })
  it('🔴 sin el id de la principal no pasa', () => {
    expect(emitGlobalComplementariaSchema.safeParse({ params: { ...params, principalId: '' }, body: {} }).success).toBe(false)
  })
})

// C1 (Tarea 12): el listado de las ventas que no entraron a la global. Qué periodo es «reciente» y si la principal existe lo decide el
// servicio; aquí sólo la forma de la consulta (lo que llega como texto en la URL).
describe('listGlobalExcluidasSchema — `principalId`, `desde`, `cursor` y `limite` opcionales', () => {
  const parseQuery = (query: unknown) => listGlobalExcluidasSchema.safeParse({ query })
  it('control — sin nada vale (el último periodo cerrado)', () => {
    expect(parseQuery({}).success).toBe(true)
  })
  it('🔴 los cuatro juntos pasan, y `limite` llega como número', () => {
    const r = parseQuery({ principalId: 'g1', desde: '2026-05-01T06:00:00.000Z', cursor: 'o9', limite: '10' })
    expect(r.success && r.data.query).toEqual({ principalId: 'g1', desde: '2026-05-01T06:00:00.000Z', cursor: 'o9', limite: 10 })
  })
  it('🔴 `limite` entre 1 y 50 (la página del servicio)', () => {
    for (const malo of ['0', '51', 'abc', '2.5', '-1']) expect([malo, parseQuery({ limite: malo }).success]).toEqual([malo, false])
    for (const bueno of ['1', '50']) expect([bueno, parseQuery({ limite: bueno }).success]).toEqual([bueno, true])
  })
  it('🔴 `desde` que no es un instante ISO ⇒ 400 en español', () => {
    for (const malo of ['ayer', '2026-05-01', '01/05/2026']) {
      const r = parseQuery({ desde: malo })
      expect([malo, r.success]).toEqual([malo, false])
      if (!r.success)
        expect(r.error.issues[0].message).toBe('`desde` debe ser el inicio del periodo en formato ISO (2026-10-09T06:00:00.000Z)')
    }
  })
  it('🔴 `principalId` o `cursor` vacíos no pasan', () => {
    expect(parseQuery({ principalId: '' }).success).toBe(false)
    expect(parseQuery({ cursor: '' }).success).toBe(false)
  })
})

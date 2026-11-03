import fs from 'fs'
import path from 'path'
import {
  createChargeSchema,
  invoiceOccurrenceSchema,
  listChargesSchema,
  listOccurrencesSchema,
  pauseChargeSchema,
  payOccurrenceSchema,
  updateChargeSchema,
} from '@/routes/superadmin/platformCharges.schemas'

/**
 * «Por cobrar» — la forma de lo que entra y los permisos de cada ruta (spec 2026-11-02-por-cobrar-superadmin §5).
 *
 * Zod sólo valida FORMA y sus mensajes salen en español (el middleware se los enseña al operador tal cual). Las reglas de negocio
 * (montos, fechas reales, tope de conceptos, perfil del cliente) son del servicio. La autorización real (el 403 de quien no es
 * SUPERADMIN) la prueba la integración con el guardia, el JWT y Postgres reales; aquí se fijan, de forma estática, los permisos
 * exactos de cada ruta y que `/summary` y `/occurrences…` vayan antes de `/:id`.
 */

const RUTAS = fs.readFileSync(path.join(__dirname, '../../../src/routes/superadmin/platformCharges.routes.ts'), 'utf8')
const PADRE = fs.readFileSync(path.join(__dirname, '../../../src/routes/superadmin.routes.ts'), 'utf8')

const RENTA = { description: 'Renta de terminal', amountCents: 50000, ivaMode: 'WITHOUT_IVA', satProductKey: '81112401', satUnitKey: 'E48' }
const COBRO = {
  customerType: 'STANDALONE',
  customerName: 'Estética Luna',
  frequency: 'MONTHLY',
  anchorDate: '2026-11-02',
  concepts: [RENTA],
  invoiceMode: 'MANUAL',
}

/** Los mensajes de error de un parseo, o `[]` si pasó. */
const errores = (schema: { safeParse: (x: unknown) => any }, entrada: unknown): string[] => {
  const r = schema.safeParse(entrada)
  return r.success ? [] : r.error.issues.map((i: { message: string }) => i.message)
}
const body = (b: unknown) => ({ body: b })
const query = (q: unknown) => ({ query: q })

describe('platformCharges.schemas — lo que entra por el cuerpo', () => {
  it('un cobro completo pasa tal cual', () => {
    const r = createChargeSchema.safeParse(body({ ...COBRO, billingTaxProfileId: 'perfil-1' }))

    expect(r.success).toBe(true)
    expect(r.success && r.data.body).toMatchObject({ ...COBRO, billingTaxProfileId: 'perfil-1' })
  })

  it('lo que no es parte del cobro se DESCARTA: nadie escribe pausedAt, createdById ni id por el cuerpo', () => {
    const r = createChargeSchema.safeParse(body({ ...COBRO, pausedAt: '2026-11-01T00:00:00Z', createdById: 'otro', id: 'x', paidAt: 'x' }))

    expect(r.success).toBe(true)
    expect(Object.keys((r.success && r.data.body) || {}).sort()).toEqual(
      ['anchorDate', 'concepts', 'customerName', 'customerType', 'frequency', 'invoiceMode'].sort(),
    )
  })

  it('tipo de cliente, periodicidad, modo de factura, IVA y fecha con formato mal: mensajes EN ESPAÑOL', () => {
    const mensajes = errores(
      createChargeSchema,
      body({
        customerType: 'NADIE',
        customerName: '',
        frequency: 'DIARIO',
        anchorDate: '02/11/2026',
        concepts: [{ ...RENTA, ivaMode: 'MITAD', amountCents: 10.5, description: '' }],
        invoiceMode: 'A_VECES',
      }),
    )

    expect(mensajes).toEqual(
      expect.arrayContaining([
        'El tipo de cliente debe ser ORGANIZATION, VENUE o STANDALONE',
        'Escribe el nombre del cliente',
        'La periodicidad debe ser WEEKLY, BIWEEKLY o MONTHLY',
        'La fecha debe tener el formato AAAA-MM-DD',
        'El IVA del concepto debe ser WITHOUT_IVA o WITH_IVA',
        'El monto debe estar en centavos enteros',
        'La descripción del concepto es requerida',
        'El modo de factura debe ser AUTOMATIC o MANUAL',
      ]),
    )
  })

  it('campos que faltan: también en español (nunca el «Required» de Zod)', () => {
    const mensajes = errores(createChargeSchema, body({}))

    expect(mensajes.length).toBeGreaterThanOrEqual(6)
    for (const mensaje of mensajes) expect(mensaje).not.toMatch(/Required|Expected|Invalid|received/i)
  })

  it('«editar» manda sólo lo que cambia: un cuerpo vacío o parcial pasa, y los ids pueden venir null para quitarlos', () => {
    expect(errores(updateChargeSchema, body({}))).toEqual([])
    expect(errores(updateChargeSchema, body({ customerName: 'Otro nombre' }))).toEqual([])
    expect(errores(updateChargeSchema, body({ billingTaxProfileId: null, organizationId: null, venueId: null }))).toEqual([])
    expect(errores(updateChargeSchema, body({ customerName: '' }))).toEqual(['Escribe el nombre del cliente'])
  })

  it('pausar: sin skipOverdue es false (se queda por cobrar, lo seguro); con algo que no es booleano, en español', () => {
    const r = pauseChargeSchema.safeParse(body({}))

    expect(r.success && r.data.body.skipOverdue).toBe(false)
    expect(errores(pauseChargeSchema, body({ skipOverdue: 'si' }))).toEqual(['skipOverdue debe ser verdadero o falso'])
    expect(pauseChargeSchema.safeParse(body({ skipOverdue: true })).success).toBe(true)
  })

  it('«Ya me pagó»: la casilla va SIEMPRE explícita (omitirla no puede volver manual una automática) y debe ser booleana', () => {
    expect(errores(payOccurrenceSchema, body({}))).toEqual(['Indica si se timbra la factura ahora'])
    expect(errores(payOccurrenceSchema, body({ invoice: 'true' }))).toEqual(['invoice debe ser verdadero o falso'])
    expect(errores(payOccurrenceSchema, body({ invoice: false }))).toEqual([])
    expect(errores(payOccurrenceSchema, body({ invoice: false }))).toEqual([])
  })

  it('facturar: ambos campos son opcionales; las claves del SAT vacías o un perfil vacío se rechazan en español', () => {
    expect(errores(invoiceOccurrenceSchema, body({}))).toEqual([])
    expect(
      errores(
        invoiceOccurrenceSchema,
        body({ billingTaxProfileId: 'perfil-1', conceptKeys: [{ satProductKey: '81112401', satUnitKey: 'E48' }] }),
      ),
    ).toEqual([])
    expect(errores(invoiceOccurrenceSchema, body({ conceptKeys: [{ satProductKey: '', satUnitKey: 'E48' }] }))).toEqual([
      'La clave del SAT del concepto es requerida',
    ])
    expect(errores(invoiceOccurrenceSchema, body({ billingTaxProfileId: '' }))).toEqual(['El perfil fiscal no es válido'])
  })

  it('el nombre y la descripción tienen tope: el SAT no acepta una descripción de más de 1,000 letras, y ya en la factura no se puede corregir', () => {
    const concepto = COBRO.concepts[0]
    expect(errores(createChargeSchema, body({ ...COBRO, concepts: [{ ...concepto, description: 'x'.repeat(1000) }] }))).toEqual([])
    expect(errores(createChargeSchema, body({ ...COBRO, concepts: [{ ...concepto, description: 'x'.repeat(1001) }] }))).toEqual([
      'La descripción no puede pasar de 1,000 letras',
    ])
    expect(errores(createChargeSchema, body({ ...COBRO, customerName: 'x'.repeat(121) }))).toEqual([
      'El nombre no puede pasar de 120 letras',
    ])
  })

  it('🔴 facturar y pagar reciben lo que se vio en pantalla, completo o nada: a medias no se puede comparar', () => {
    const receptor = { rfc: 'LUN010101AAA', razonSocial: 'ESTETICA LUNA', regimenFiscal: '601', codigoPostal: '06000' }
    expect(errores(invoiceOccurrenceSchema, body({ receptor }))).toEqual([])
    expect(errores(payOccurrenceSchema, body({ invoice: true, receptor }))).toEqual([])
    expect(errores(payOccurrenceSchema, body({ invoice: false }))).toEqual([])
    expect(errores(payOccurrenceSchema, body({ invoice: true }))).toEqual(['Para timbrar hace falta confirmar a quién se le factura'])
    expect(errores(payOccurrenceSchema, body({ invoice: true, receptor: { rfc: 'LUN010101AAA' } }))).toEqual([
      'La razón social del receptor es requerida',
      'El régimen fiscal del receptor es requerido',
      'El código postal del receptor es requerido',
    ])
    expect(errores(invoiceOccurrenceSchema, body({ conceptKeys: 'x' }))).toEqual([
      'Las claves del SAT deben ser una lista, un par por concepto',
    ])
  })
})

describe('platformCharges.schemas — lo que entra por la URL', () => {
  it('sin nada, todo es opcional (el servicio pone la vista y el tamaño por default)', () => {
    expect(errores(listOccurrencesSchema, query({}))).toEqual([])
    expect(errores(listChargesSchema, query({}))).toEqual([])
  })

  it('las vistas y los estados que existen pasan; los demás, en español', () => {
    for (const view of ['open', 'paid', 'skipped']) expect(errores(listOccurrencesSchema, query({ view }))).toEqual([])
    expect(errores(listOccurrencesSchema, query({ view: 'todo' }))).toEqual(['La vista debe ser open, paid o skipped'])
    for (const status of ['active', 'paused']) expect(errores(listChargesSchema, query({ status }))).toEqual([])
    expect(errores(listChargesSchema, query({ status: 'borrados' }))).toEqual(['El estado debe ser active o paused'])
  })

  it('page y pageSize llegan como texto y se vuelven número; el tope NO se pone aquí (lo impone el servidor, que recorta a 100)', () => {
    const r = listOccurrencesSchema.safeParse(query({ page: '2', pageSize: '500' }))

    expect(r.success && r.data.query).toMatchObject({ page: 2, pageSize: 500 })
  })

  it('página y tamaño que no son números enteros positivos, en español', () => {
    expect(errores(listOccurrencesSchema, query({ page: '0' }))).toEqual(['La página debe ser al menos 1'])
    expect(errores(listOccurrencesSchema, query({ pageSize: 'abc' }))).toEqual(['El tamaño de página debe ser un número'])
    expect(errores(listOccurrencesSchema, query({ pageSize: '1.5' }))).toEqual(['El tamaño de página debe ser un número entero'])
  })

  it('la búsqueda se recorta y tiene tope de largo', () => {
    const r = listOccurrencesSchema.safeParse(query({ q: '  luna  ' }))

    expect(r.success && r.data.query.q).toBe('luna')
    expect(errores(listOccurrencesSchema, query({ q: 'x'.repeat(121) }))).toEqual(['La búsqueda es demasiado larga'])
  })
})

describe('platformCharges.routes — permisos y orden', () => {
  /** Un bloque por cada `router.<método>(...)` del archivo (una ruta puede ocupar varias líneas). */
  const bloques = RUTAS.split(/\n(?=router\.(?:get|post|patch|put|delete)\()/).filter(b => b.startsWith('router.'))
  const rutas = bloques.map(bloque => {
    const m = /^router\.(get|post|patch|put|delete)\(\s*'([^']+)'/.exec(bloque)!
    return {
      metodo: m[1].toUpperCase(),
      ruta: m[2],
      permisos: [...bloque.matchAll(/checkPermission\('([^']+)'\)/g)].map(p => p[1]),
      bloque,
    }
  })

  it('están montadas bajo /platform-charges, dentro del router de SUPERADMIN', () => {
    expect(PADRE).toMatch(/router\.use\('\/platform-charges', platformChargesRoutes\)/)
    expect(PADRE.indexOf("router.use('/platform-charges'")).toBeGreaterThan(
      PADRE.indexOf('router.use(authorizeRole([StaffRole.SUPERADMIN]))'),
    )
  })

  it('las 12 rutas del spec existen, cada una con UN permiso, y la subruta no pasa un rol suelto a authorizeRole', () => {
    expect(rutas.map(r => `${r.metodo} ${r.ruta}`).sort()).toEqual(
      [
        'GET /summary',
        'GET /occurrences',
        'GET /occurrences/:id/pay-preview',
        'POST /occurrences/:id/pay',
        'POST /occurrences/:id/skip',
        'POST /occurrences/:id/reopen',
        'POST /occurrences/:id/invoice',
        'GET /',
        'POST /',
        'PATCH /:id',
        'POST /:id/pause',
        'POST /:id/resume',
      ].sort(),
    )
    for (const r of rutas) expect([`${r.metodo} ${r.ruta}`, r.permisos.length]).toEqual([`${r.metodo} ${r.ruta}`, 1])
    expect(RUTAS).not.toMatch(/authorizeRole\(/)
  })

  it('las lecturas piden platform-billing:view y TODAS las escrituras platform-billing:issue (permisos que ya existen, sin espejos nuevos)', () => {
    for (const r of rutas) {
      const esperado = r.metodo === 'GET' ? 'platform-billing:view' : 'platform-billing:issue'
      expect([`${r.metodo} ${r.ruta}`, r.permisos[0]]).toEqual([`${r.metodo} ${r.ruta}`, esperado])
    }
  })

  it('/summary y /occurrences… se registran ANTES de cualquier /:id', () => {
    const primeraConId = rutas.findIndex(r => /^\/:id/.test(r.ruta))
    const ultimaFija = Math.max(...rutas.map((r, i) => (/^\/(summary|occurrences)/.test(r.ruta) ? i : -1)))

    expect(primeraConId).toBeGreaterThan(-1)
    expect(ultimaFija).toBeLessThan(primeraConId)
  })

  it('el cuerpo y la URL se validan ANTES del permiso (lo mal formado falla rápido), en las rutas que reciben datos', () => {
    const conDatos = rutas.filter(r => r.bloque.includes('validateRequest('))

    expect(conDatos.length).toBeGreaterThanOrEqual(7)
    for (const r of conDatos) expect(r.bloque.indexOf('validateRequest(')).toBeLessThan(r.bloque.indexOf('checkPermission('))
  })
})

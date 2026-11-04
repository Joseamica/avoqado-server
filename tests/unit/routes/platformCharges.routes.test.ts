import fs from 'fs'
import path from 'path'
import {
  createChargeSchema,
  groupOccurrencesSchema,
  invoiceOccurrenceSchema,
  linkInvoiceSchema,
  listChargesSchema,
  listInvoiceCandidatesSchema,
  listOccurrencesSchema,
  pauseChargeSchema,
  payOccurrenceSchema,
  unlinkInvoiceSchema,
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
        'La periodicidad debe ser WEEKLY, BIWEEKLY, MONTHLY o ONE_TIME',
        'La fecha debe tener el formato AAAA-MM-DD',
        'El IVA del concepto debe ser WITHOUT_IVA o WITH_IVA',
        'El monto debe estar en centavos enteros',
        'La descripción del concepto es requerida',
        'El modo de factura debe ser AUTOMATIC, MANUAL o NONE',
      ]),
    )
  })

  it('«una sola vez» (ONE_TIME) es una periodicidad válida al dar de alta y al editar; las demás siguen pasando', () => {
    for (const frequency of ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'ONE_TIME']) {
      expect(errores(createChargeSchema, body({ ...COBRO, frequency }))).toEqual([])
      expect(errores(updateChargeSchema, body({ frequency }))).toEqual([])
    }
    expect(errores(createChargeSchema, body({ ...COBRO, frequency: 'one_time' }))).toEqual([
      'La periodicidad debe ser WEEKLY, BIWEEKLY, MONTHLY o ONE_TIME',
    ])
  })

  it('sin factura: «NONE» es un modo válido, y las claves del SAT pueden omitirse o venir vacías (el formulario manda «»)', () => {
    const omitidas = { description: 'Venta de equipo', amountCents: 1000000, ivaMode: 'WITH_IVA' }
    const vacias = { ...omitidas, satProductKey: '', satUnitKey: '' }
    for (const concepto of [omitidas, vacias]) {
      expect(errores(createChargeSchema, body({ ...COBRO, invoiceMode: 'NONE', concepts: [concepto] }))).toEqual([])
      expect(errores(updateChargeSchema, body({ invoiceMode: 'NONE', concepts: [concepto] }))).toEqual([])
      // Zod sólo ve la FORMA: que MANUAL o AUTOMATIC necesiten claves lo decide el servicio, con el modo que queda tras combinar.
      expect(errores(createChargeSchema, body({ ...COBRO, concepts: [concepto] }))).toEqual([])
    }
    expect(errores(updateChargeSchema, body({ invoiceMode: 'NONE' }))).toEqual([])
  })

  it('las claves vacías que manda el formulario llegan al servicio tal cual («»), y las omitidas siguen omitidas', () => {
    const vacias = createChargeSchema.safeParse(
      body({ ...COBRO, invoiceMode: 'NONE', concepts: [{ ...RENTA, satProductKey: '', satUnitKey: '' }] }),
    )
    const omitidas = createChargeSchema.safeParse(
      body({ ...COBRO, invoiceMode: 'NONE', concepts: [{ description: 'Venta', amountCents: 100, ivaMode: 'WITH_IVA' }] }),
    )

    expect(vacias.success && vacias.data.body.concepts?.[0]).toMatchObject({ satProductKey: '', satUnitKey: '' })
    expect(omitidas.success && omitidas.data.body.concepts?.[0]).toEqual({ description: 'Venta', amountCents: 100, ivaMode: 'WITH_IVA' })
  })

  it('unas claves que no son texto se rechazan en español, y las demás reglas del concepto siguen igual', () => {
    expect(errores(createChargeSchema, body({ ...COBRO, concepts: [{ ...RENTA, satProductKey: 123, satUnitKey: ['E48'] }] }))).toEqual([
      'La clave del SAT del concepto debe ser texto',
      'La unidad del SAT del concepto debe ser texto',
    ])
    expect(errores(createChargeSchema, body({ ...COBRO, concepts: [{ ...RENTA, amountCents: 10.5 }] }))).toEqual([
      'El monto debe estar en centavos enteros',
    ])
  })

  it('campos que faltan: también en español (nunca el «Required» de Zod)', () => {
    const mensajes = errores(createChargeSchema, body({}))

    // Con un cuerpo vacío sólo salen los que la FORMA exige siempre: la periodicidad, los conceptos y el modo dependen de la factura
    // (ver abajo) y se revisan cuando lo demás ya es válido.
    expect(mensajes.length).toBeGreaterThanOrEqual(3)
    for (const mensaje of mensajes) expect(mensaje).not.toMatch(/Required|Expected|Invalid|received/i)
  })

  describe('🔴 el alta desde una factura (invoiceId)', () => {
    const { frequency, concepts, invoiceMode, ...CLIENTE_Y_FECHA } = COBRO

    it('con invoiceId, la periodicidad, los conceptos y el modo ya no hacen falta: sólo cliente, nombre y fecha', () => {
      const r = createChargeSchema.safeParse(body({ ...CLIENTE_Y_FECHA, invoiceId: 'cfdi-19' }))

      expect(r.success).toBe(true)
      expect(r.success && r.data.body).toEqual({ ...CLIENTE_Y_FECHA, invoiceId: 'cfdi-19' })
    })

    it('con invoiceId, lo que mande sobre conceptos, periodicidad y modo pasa la forma (el servicio lo ignora)', () => {
      expect(errores(createChargeSchema, body({ ...COBRO, invoiceId: 'cfdi-19' }))).toEqual([])
    })

    it('sin invoiceId siguen siendo obligatorios, cada uno con su mensaje en español', () => {
      expect(errores(createChargeSchema, body(CLIENTE_Y_FECHA))).toEqual([
        'La periodicidad debe ser WEEKLY, BIWEEKLY, MONTHLY o ONE_TIME',
        'Agrega al menos un concepto al cobro',
        'El modo de factura debe ser AUTOMATIC, MANUAL o NONE',
      ])
      expect(errores(createChargeSchema, body({ ...CLIENTE_Y_FECHA, frequency, concepts }))).toEqual([
        'El modo de factura debe ser AUTOMATIC, MANUAL o NONE',
      ])
    })

    it('un invoiceId vacío o que no es texto se rechaza en español', () => {
      for (const invoiceId of ['', 7]) {
        expect(errores(createChargeSchema, body({ ...CLIENTE_Y_FECHA, invoiceId }))).toEqual(['Elige la factura de la que sale el cobro'])
      }
    })

    it('el cliente, el nombre y la fecha siguen siendo obligatorios, con factura o sin ella', () => {
      const mensajes = errores(createChargeSchema, body({ invoiceId: 'cfdi-19' }))

      expect(mensajes).toEqual(expect.arrayContaining(['Escribe el nombre del cliente', 'La fecha de inicio es requerida']))
    })

    it('«editar» no recibe invoiceId: se descarta (anexar y quitar tienen sus rutas)', () => {
      const r = updateChargeSchema.safeParse(body({ customerName: 'Otro', invoiceId: 'cfdi-19' }))

      expect(r.success && r.data.body).toEqual({ customerName: 'Otro' })
    })
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

  it('🔴 «Ya me pagó» puede traer el total que el operador confirmó (centavos enteros, no negativos); sin él, igual que siempre', () => {
    expect(errores(payOccurrenceSchema, body({ invoice: false, expectedTotalCents: 10000 }))).toEqual([])
    expect(errores(payOccurrenceSchema, body({ invoice: false, expectedTotalCents: 0 }))).toEqual([])
    expect(errores(payOccurrenceSchema, body({ invoice: false, expectedTotalCents: -1 }))).toHaveLength(1)
    expect(errores(payOccurrenceSchema, body({ invoice: false, expectedTotalCents: 100.5 }))).toHaveLength(1)
    expect(errores(payOccurrenceSchema, body({ invoice: false, expectedTotalCents: '10000' }))).toHaveLength(1)
    const r = payOccurrenceSchema.safeParse(body({ invoice: false, expectedTotalCents: 10000 }))
    expect(r.success && r.data.body.expectedTotalCents).toBe(10000)
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

describe('platformCharges.schemas — filtros y grupos de la lista', () => {
  /** Lo que sale de zod para la URL, o `null` si no pasó. */
  const consulta = (schema: { safeParse: (x: unknown) => any }, q: unknown) => {
    const r = schema.safeParse(query(q))
    return r.success ? (r.data.query as Record<string, unknown>) : null
  }

  it('sin filtros nada cambia: la salida no trae llaves de más', () => {
    expect(consulta(listOccurrencesSchema, {})).toEqual({})
    expect(consulta(listOccurrencesSchema, { view: 'paid', q: 'luna' })).toEqual({ view: 'paid', q: 'luna' })
  })

  it('🔴 los filtros de varios valores aceptan UN formato por parámetro repetido o separado por comas, y salen siempre como arreglo sin repetidos', () => {
    const esperado = { frequency: ['WEEKLY', 'MONTHLY'] }

    expect(consulta(listOccurrencesSchema, { frequency: ['WEEKLY', 'MONTHLY'] })).toEqual(esperado) // frequency=WEEKLY&frequency=MONTHLY
    expect(consulta(listOccurrencesSchema, { frequency: 'WEEKLY,MONTHLY' })).toEqual(esperado) // frequency=WEEKLY,MONTHLY
    expect(consulta(listOccurrencesSchema, { frequency: ['WEEKLY,MONTHLY', 'WEEKLY'] })).toEqual(esperado) // mezclados y repetidos
    expect(consulta(listOccurrencesSchema, { frequency: ' WEEKLY , MONTHLY ' })).toEqual(esperado) // con espacios
    expect(consulta(listOccurrencesSchema, { frequency: 'ONE_TIME' })).toEqual({ frequency: ['ONE_TIME'] }) // uno solo
  })

  it('los tres filtros de varios valores: periodicidad, factura y tipo de cliente', () => {
    expect(
      consulta(listOccurrencesSchema, {
        frequency: 'WEEKLY',
        invoice: 'STAMPED,PROBLEM,PENDING,NONE',
        customerType: ['ORGANIZATION', 'VENUE,STANDALONE'],
      }),
    ).toEqual({
      frequency: ['WEEKLY'],
      invoice: ['STAMPED', 'PROBLEM', 'PENDING', 'NONE'],
      customerType: ['ORGANIZATION', 'VENUE', 'STANDALONE'],
    })
  })

  it('un valor vacío (el filtro sin elegir) es «sin filtro»: un arreglo vacío, no un error', () => {
    expect(consulta(listOccurrencesSchema, { frequency: '', invoice: [''], customerType: ',' })).toEqual({
      frequency: [],
      invoice: [],
      customerType: [],
    })
  })

  it('un valor que no existe se rechaza en español, con el valor bueno y el malo mezclados también', () => {
    expect(errores(listOccurrencesSchema, query({ frequency: 'DIARIO' }))).toEqual([
      'La periodicidad debe ser WEEKLY, BIWEEKLY, MONTHLY o ONE_TIME',
    ])
    expect(errores(listOccurrencesSchema, query({ frequency: 'WEEKLY,DIARIO' }))).toEqual([
      'La periodicidad debe ser WEEKLY, BIWEEKLY, MONTHLY o ONE_TIME',
    ])
    expect(errores(listOccurrencesSchema, query({ invoice: 'FACTURADO' }))).toEqual([
      'El estado de la factura debe ser STAMPED, PROBLEM, PENDING o NONE',
    ])
    expect(errores(listOccurrencesSchema, query({ customerType: 'NADIE' }))).toEqual([
      'El tipo de cliente debe ser ORGANIZATION, VENUE o STANDALONE',
    ])
  })

  it('fechas AAAA-MM-DD y el nombre exacto del cliente (recortado, con tope); la validez del día y el orden son del servicio', () => {
    expect(consulta(listOccurrencesSchema, { from: '2026-11-01', to: '2026-11-30', customer: '  Café Ana  ' })).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
      customer: 'Café Ana',
    })
    expect(errores(listOccurrencesSchema, query({ from: '01/11/2026' }))).toEqual(['La fecha debe tener el formato AAAA-MM-DD'])
    expect(errores(listOccurrencesSchema, query({ to: '2026-11-01T00:00:00Z' }))).toEqual(['La fecha debe tener el formato AAAA-MM-DD'])
    expect(errores(listOccurrencesSchema, query({ customer: 'x'.repeat(121) }))).toEqual(['El nombre del cliente es demasiado largo'])
    // Una fecha con la forma correcta pero que no existe, o «desde» después de «hasta», pasa la FORMA: el servicio responde 400.
    expect(errores(listOccurrencesSchema, query({ from: '2026-02-30' }))).toEqual([])
    expect(errores(listOccurrencesSchema, query({ from: '2026-11-10', to: '2026-11-09' }))).toEqual([])
  })

  it('agrupar: groupBy es obligatorio y uno de cuatro; acepta los mismos filtros y la vista, y no recibe página', () => {
    expect(errores(groupOccurrencesSchema, query({}))).toEqual(['Elige cómo agrupar: customer, month, frequency o invoice'])
    expect(errores(groupOccurrencesSchema, query({ groupBy: 'cliente' }))).toEqual([
      'Elige cómo agrupar: customer, month, frequency o invoice',
    ])
    for (const groupBy of ['customer', 'month', 'frequency', 'invoice'])
      expect(errores(groupOccurrencesSchema, query({ groupBy }))).toEqual([])

    expect(
      consulta(groupOccurrencesSchema, {
        groupBy: 'month',
        view: 'paid',
        q: 'luna',
        frequency: 'MONTHLY',
        invoice: ['PENDING', 'NONE'],
        customerType: 'ORGANIZATION',
        from: '2026-11-01',
        to: '2026-11-30',
        customer: 'Café Ana',
        page: '3',
        pageSize: '10',
      }),
    ).toEqual({
      groupBy: 'month',
      view: 'paid',
      q: 'luna',
      frequency: ['MONTHLY'],
      invoice: ['PENDING', 'NONE'],
      customerType: ['ORGANIZATION'],
      from: '2026-11-01',
      to: '2026-11-30',
      customer: 'Café Ana',
    }) // page y pageSize se descartan: un grupo no se pagina
  })

  it('las candidatas y las demás listas no cambian: no traen estos filtros', () => {
    expect(consulta(listChargesSchema, { frequency: 'WEEKLY', from: '2026-11-01' })).toEqual({})
    expect(consulta(listInvoiceCandidatesSchema, { frequency: 'WEEKLY' })).toEqual({})
  })
})

describe('platformCharges.schemas — anexar una factura', () => {
  it('anexar pide cuál factura, con mensaje en español; lo demás del cuerpo se descarta', () => {
    expect(errores(linkInvoiceSchema, body({}))).toEqual(['Elige la factura que vas a anexar'])
    expect(errores(linkInvoiceSchema, body({ cfdiId: '' }))).toEqual(['Elige la factura que vas a anexar'])
    expect(errores(linkInvoiceSchema, body({ cfdiId: 7 }))).toEqual(['Elige la factura que vas a anexar'])

    const r = linkInvoiceSchema.safeParse(body({ cfdiId: 'cfdi-1', chargeLinkedAt: 'x', platformChargeOccurrenceId: 'otra' }))
    expect(r.success && r.data.body).toEqual({ cfdiId: 'cfdi-1' })
  })

  it('🔴 quitar pide la factura que el operador confirmó, en la URL, con mensaje en español', () => {
    expect(errores(unlinkInvoiceSchema, query({}))).toEqual(['Elige la factura que vas a quitar'])
    expect(errores(unlinkInvoiceSchema, query({ cfdiId: '' }))).toEqual(['Elige la factura que vas a quitar'])
    expect(errores(unlinkInvoiceSchema, query({ cfdiId: ['a', 'b'] }))).toEqual(['Elige la factura que vas a quitar'])

    const r = unlinkInvoiceSchema.safeParse(query({ cfdiId: 'cfdi-1', otro: 'x' }))
    expect(r.success && r.data.query).toEqual({ cfdiId: 'cfdi-1' })
  })

  it('las candidatas aceptan cliente, RFC, búsqueda y página; la página llega como número', () => {
    const r = listInvoiceCandidatesSchema.safeParse(
      query({ customerType: 'ORGANIZATION', organizationId: 'org-1', rfc: ' LUN010101AAA ', q: ' a19 ', page: '2', pageSize: '500' }),
    )

    expect(r.success && r.data.query).toEqual({
      customerType: 'ORGANIZATION',
      organizationId: 'org-1',
      rfc: 'LUN010101AAA',
      q: 'a19',
      page: 2,
      pageSize: 500, // el tope lo impone el servidor, no la forma
    })
  })

  it('un tipo de cliente que no existe o una página mal: mensajes en español', () => {
    expect(errores(listInvoiceCandidatesSchema, query({ customerType: 'NADIE' }))).toEqual([
      'El tipo de cliente debe ser ORGANIZATION, VENUE o STANDALONE',
    ])
    expect(errores(listInvoiceCandidatesSchema, query({ page: '0' }))).toEqual(['La página debe ser al menos 1'])
    expect(errores(listInvoiceCandidatesSchema, query({ rfc: 'x'.repeat(14) }))).toEqual(['El RFC es demasiado largo'])
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

  it('las rutas del spec existen, cada una con UN permiso, y la subruta no pasa un rol suelto a authorizeRole', () => {
    expect(rutas.map(r => `${r.metodo} ${r.ruta}`).sort()).toEqual(
      [
        'GET /summary',
        'GET /occurrences',
        'GET /occurrences/groups',
        'GET /occurrences/:id/pay-preview',
        'POST /occurrences/:id/pay',
        'POST /occurrences/:id/skip',
        'POST /occurrences/:id/reopen',
        'POST /occurrences/:id/invoice',
        'POST /occurrences/:id/invoice-link',
        'DELETE /occurrences/:id/invoice-link',
        'GET /invoice-candidates',
        'GET /',
        'POST /',
        'GET /:id',
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

  it('anexar valida el cuerpo con su esquema y las candidatas su consulta; quitar valida en la URL la factura confirmada', () => {
    const una = (metodo: string, ruta: string) => rutas.find(r => r.metodo === metodo && r.ruta === ruta)!

    expect(una('POST', '/occurrences/:id/invoice-link').bloque).toContain('validateRequest(linkInvoiceSchema)')
    expect(una('GET', '/invoice-candidates').bloque).toContain('validateRequest(listInvoiceCandidatesSchema)')
    expect(una('DELETE', '/occurrences/:id/invoice-link').bloque).toContain('validateRequest(unlinkInvoiceSchema)')
  })

  it('los grupos validan su consulta y se registran ANTES de cualquier /occurrences/:id', () => {
    const grupos = rutas.findIndex(r => r.metodo === 'GET' && r.ruta === '/occurrences/groups')
    const primeraDeUnaFecha = rutas.findIndex(r => /^\/occurrences\/:id/.test(r.ruta))

    expect(grupos).toBeGreaterThan(-1)
    expect(rutas[grupos].bloque).toContain('validateRequest(groupOccurrencesSchema)')
    expect(grupos).toBeLessThan(primeraDeUnaFecha)
  })

  it('leer un cobro (GET /:id) no recibe cuerpo ni consulta: no valida nada, sólo pide platform-billing:view', () => {
    const leer = rutas.find(r => r.metodo === 'GET' && r.ruta === '/:id')!

    expect(leer.permisos).toEqual(['platform-billing:view'])
    expect(leer.bloque).not.toContain('validateRequest(')
  })

  it('/summary, /occurrences… e /invoice-candidates se registran ANTES de cualquier /:id', () => {
    const primeraConId = rutas.findIndex(r => /^\/:id/.test(r.ruta))
    const ultimaFija = Math.max(...rutas.map((r, i) => (/^\/(summary|occurrences|invoice-candidates)/.test(r.ruta) ? i : -1)))

    expect(primeraConId).toBeGreaterThan(-1)
    expect(ultimaFija).toBeLessThan(primeraConId)
  })

  it('el cuerpo y la URL se validan ANTES del permiso (lo mal formado falla rápido), en las rutas que reciben datos', () => {
    const conDatos = rutas.filter(r => r.bloque.includes('validateRequest('))

    expect(conDatos.length).toBeGreaterThanOrEqual(7)
    for (const r of conDatos) expect(r.bloque.indexOf('validateRequest(')).toBeLessThan(r.bloque.indexOf('checkPermission('))
  })
})

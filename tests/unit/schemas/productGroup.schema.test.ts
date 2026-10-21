import {
  addVariantsSchema,
  applyGroupExistingSchema,
  createGroupSchema,
  productOptionBodySchema,
  suggestionsSchema,
  updateGroupSchema,
  variantImageSchema,
} from '@/schemas/dashboard/productGroup.schema'

const params = { venueId: 'cmosvx24400n2kk2akgx4uhgi' }
describe('productGroup.schema', () => {
  it('🔴 acepta ids de categoría y producto NO cuid (IQ: «t5ijfz9h610aeor1c93boa5r0»)', () => {
    const r = applyGroupExistingSchema.safeParse({
      params,
      body: {
        name: 'BODY HARBOR',
        expectedFingerprint: 'abc',
        categoryId: 't5ijfz9h610aeor1c93boa5r0',
        options: [{ name: 'Talla', values: ['34'] }],
        members: [{ productId: 'bt7ob9195lgkeg0mq1uy1px1v', values: ['34'] }],
      },
    })
    expect(r.success).toBe(true)
  })
  it('rechaza un id con espacios o barras', () => {
    const r = applyGroupExistingSchema.safeParse({
      params,
      body: {
        name: 'X',
        expectedFingerprint: 'a',
        options: [{ name: 'T', values: ['1'] }],
        members: [{ productId: '../x', values: ['1'] }],
      },
    })
    expect(r.success).toBe(false)
  })
  it('precio negativo en una variante se rechaza en español', () => {
    const r = createGroupSchema.safeParse({
      params,
      body: { name: 'P', categoryId: 'c1', options: [{ name: 'T', values: ['1'] }], variants: [{ values: ['1'], price: -1 }] },
    })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r)).toMatch(/precio/i)
  })
  it('pageSize de sugerencias se topa en 50', () => {
    const r = suggestionsSchema.parse({ params, query: { page: '1', pageSize: '500' } })
    expect(r.query.pageSize).toBe(50)
  })
  it('🔴 biblioteca: `values` que no es lista se rechaza ANTES de llegar al servicio', () => {
    expect(productOptionBodySchema.safeParse({ params, body: { name: 'Talla', values: 'x' } }).success).toBe(false)
  })
  it('🔴 edición: `ivaTratamiento: null` se rechaza (no es nullable); un IVA heredado (8 %) pasa y lo decide el servicio', () => {
    const p = { ...params, groupId: 'g1' }
    expect(updateGroupSchema.safeParse({ params: p, body: { ivaTratamiento: null } }).success).toBe(false)
    expect(updateGroupSchema.safeParse({ params: p, body: { ivaTratamiento: 'IVA_19' } }).success).toBe(false)
    expect(updateGroupSchema.safeParse({ params: p, body: { ivaTratamiento: 'IVA_8' } }).success).toBe(true)
  })
  it('agregar valores: cada valor y el nombre de la opción llevan el mismo tope de 40 que crear y renombrar', () => {
    const p = { ...params, groupId: 'g1' }
    const largo = 'x'.repeat(41)
    const con = (newValues: unknown) => addVariantsSchema.safeParse({ params: p, body: { newValues, variants: [] } })
    expect(con([{ optionName: 'Talla', values: ['XL'] }]).success).toBe(true)
    const r = con([{ optionName: 'Talla', values: [largo] }])
    expect(r.success).toBe(false)
    expect(JSON.stringify(r)).toMatch(/Valor muy largo/)
    expect(con([{ optionName: largo, values: ['XL'] }]).success).toBe(false)
  })
  // ── /full-testing 14-oct ─────────────────────────────────────────────────────────────────────────────────────────────
  const crearCon = (extra: Record<string, unknown>, variante: Record<string, unknown> = {}) =>
    createGroupSchema.safeParse({
      params,
      body: {
        name: 'P',
        categoryId: 'c1',
        options: [{ name: 'T', values: ['1'] }],
        variants: [{ values: ['1'], price: 1, ...variante }],
        ...extra,
      },
    })
  const g = { ...params, groupId: 'g1' }
  const agruparCon = (extra: Record<string, unknown>) =>
    applyGroupExistingSchema.safeParse({
      params,
      body: {
        name: 'X',
        expectedFingerprint: 'a',
        options: [{ name: 'T', values: ['1'] }],
        members: [{ productId: 'p1', values: ['1'] }],
        ...extra,
      },
    })

  it('🔴 I-2: la clave SAT de producto lleva la regla del producto (8 dígitos) al crear, editar y agrupar', () => {
    for (const r of [
      crearCon({ satProductKey: 'abc' }),
      updateGroupSchema.safeParse({ params: g, body: { satProductKey: 'abc' } }),
      agruparCon({ satProductKey: '123456789' }),
    ]) {
      expect(r.success).toBe(false)
      expect(JSON.stringify(r)).toMatch(/La clave de producto SAT debe tener 8 dígitos/)
    }
    expect(crearCon({ satProductKey: '53101600' }).success).toBe(true)
    expect(updateGroupSchema.safeParse({ params: g, body: { satProductKey: ' 53101600 ' } })).toMatchObject({
      success: true,
      data: { body: { satProductKey: '53101600' } },
    })
  })

  it('🔴 I-2: la clave SAT de unidad lleva la regla del producto (hasta 20); vacía = null', () => {
    expect(crearCon({ satUnitKey: 'x'.repeat(21) }).success).toBe(false)
    expect(crearCon({ satUnitKey: 'E48' }).success).toBe(true)
    expect(updateGroupSchema.safeParse({ params: g, body: { satProductKey: '', satUnitKey: '  ' } })).toMatchObject({
      success: true,
      data: { body: { satProductKey: null, satUnitKey: null } },
    })
  })

  it('🔴 I-3: precio y costo con más de 2 decimales se rechazan en español (no se redondean); el precio debe ser mayor a 0', () => {
    for (const [variante, msg] of [
      [{ price: 19.999 }, /2 decimales/],
      [{ price: 0.0000001 }, /2 decimales|mayor a 0/],
      [{ price: 0 }, /mayor a 0/],
      [{ price: 1, cost: 1.234 }, /2 decimales/],
    ] as const) {
      const r = crearCon({}, variante)
      expect(r.success).toBe(false)
      expect(JSON.stringify(r)).toMatch(msg)
    }
    expect(crearCon({}, { price: 19.99, cost: 0.01 }).success).toBe(true)
    expect(crearCon({}, { price: 19.99, cost: 0 }).success).toBe(false)
  })

  it('🔴 I-4: las fotos sólo aceptan http(s): crear, editar el padre, foto de variante y filas de variante', () => {
    const malas = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']
    for (const url of malas) {
      for (const r of [
        crearCon({ imageUrl: url }),
        crearCon({}, { variantImageUrl: url }),
        updateGroupSchema.safeParse({ params: g, body: { imageUrl: url } }),
        variantImageSchema.safeParse({ params: { ...g, productId: 'p1' }, body: { imageUrl: url } }),
        agruparCon({ imageUrl: url }),
      ]) {
        expect(r.success).toBe(false)
        expect(JSON.stringify(r)).toMatch(/http/)
      }
    }
    expect(crearCon({ imageUrl: 'https://img/p.png' }, { variantImageUrl: 'http://img/s.png' }).success).toBe(true)
    expect(variantImageSchema.safeParse({ params: { ...g, productId: 'p1' }, body: { imageUrl: '' } }).success).toBe(true)
  })

  it('el costo de una variante lleva el mismo techo que el precio', () => {
    const body = (cost: number) => ({
      name: 'P',
      categoryId: 'c1',
      options: [{ name: 'T', values: ['1'] }],
      variants: [{ values: ['1'], price: 1, cost }],
    })
    expect(createGroupSchema.safeParse({ params, body: body(10_000_000) }).success).toBe(true)
    expect(createGroupSchema.safeParse({ params, body: body(10_000_001) }).success).toBe(false)
  })
})

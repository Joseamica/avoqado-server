// tests/unit/schemas/dashboard/customerDisplay.schema.test.ts
import {
  assetKindFromQuery,
  copyCustomerDisplaySchema,
  customerDisplayDesignDraftSchema,
  listDevicesSchema,
  previewCustomerDisplaySchema,
  putCustomerDisplaySchema,
  resetCustomerDisplaySchema,
  uploadAssetSchema,
} from '@/schemas/dashboard/customerDisplay.schema'
import { MAX_COPY_TARGETS } from '@/services/customer-display/customerDisplayDesign.validation'

/**
 * Las piezas PURAS de la forma. La prueba HTTP no ve cada capa por separado: el `kind` inválido lo rechazan DOS capas
 * (el esquema y la traducción) y, con cualquiera de las dos en pie, la respuesta HTTP es la misma. Por eso cada una se
 * prueba aquí sola: quitar una no puede pasar inadvertido.
 */

const params = { venueId: 'v1', terminalId: 't1' }

describe('assetKindFromQuery — UNA sola traducción del `kind` de la consulta (C9)', () => {
  it.each([
    ['slide', 'SLIDE'],
    ['logo', 'LOGO'],
  ])('%s → %s', (crudo, esperado) => {
    expect(assetKindFromQuery(crudo)).toBe(esperado)
  })

  // 🔴 Falla CERRADO: antes era `kind === 'slide' ? 'SLIDE' : 'LOGO'`, así que cualquier otra cosa se volvía un LOGO
  // (gratis) y se saltaba el candado del plan si la forma no la hubiera atajado antes.
  it.each([['otra'], ['SLIDE'], ['LOGO'], [''], [undefined], [['slide']], [{ kind: 'slide' }]])('%p es 400 INVALID_ASSET_KIND', crudo => {
    expect(() => assetKindFromQuery(crudo)).toThrow(expect.objectContaining({ statusCode: 400, code: 'INVALID_ASSET_KIND' }))
  })
})

describe('uploadAssetSchema — la forma de la subida', () => {
  it.each(['slide', 'logo'])('acepta kind=%s', kind => {
    expect(uploadAssetSchema.safeParse({ params, query: { kind } }).success).toBe(true)
  })

  it.each(['otra', 'SLIDE', ''])('rechaza kind=%p', kind => {
    expect(uploadAssetSchema.safeParse({ params, query: { kind } }).success).toBe(false)
  })

  it('rechaza la subida sin kind', () => {
    expect(uploadAssetSchema.safeParse({ params, query: {} }).success).toBe(false)
  })
})

describe('customerDisplayDesignDraftSchema — el borrador ESTRICTO', () => {
  it('acepta un borrador con los campos que existen', () => {
    const r = customerDisplayDesignDraftSchema.safeParse({
      theme: 'DARK',
      accentColor: null,
      logoAssetId: null,
      welcomeText: 'Hola',
      thanksText: null,
      slides: [{ assetId: 'a1' }],
      slideSeconds: 8,
      showPromotions: true,
    })
    expect(r.success).toBe(true)
  })

  it('una llave que no existe es un error, no se ignora', () => {
    expect(customerDisplayDesignDraftSchema.safeParse({ welcomeText: 'Hola', venueId: 'otro' }).success).toBe(false)
  })

  it('no caben más de 4 imágenes', () => {
    const slides = Array.from({ length: 5 }, (_, i) => ({ assetId: `a${i}` }))
    expect(customerDisplayDesignDraftSchema.safeParse({ slides }).success).toBe(false)
  })
})

describe('copyCustomerDisplaySchema — el tope de destinos (M5: el MISMO número que el servicio y el MCP)', () => {
  const destino = { terminalId: 't2', editToken: 'factory' }
  const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ terminalId: `t${i}`, editToken: 'factory' }))

  it(`acepta exactamente MAX_COPY_TARGETS (${MAX_COPY_TARGETS}) destinos`, () => {
    const r = copyCustomerDisplaySchema.safeParse({ params, body: { source: destino, targets: targets(MAX_COPY_TARGETS) } })
    expect(r.success).toBe(true)
  })

  it(`rechaza MAX_COPY_TARGETS + 1 (${MAX_COPY_TARGETS + 1}) destinos, con el mensaje en español`, () => {
    const r = copyCustomerDisplaySchema.safeParse({ params, body: { source: destino, targets: targets(MAX_COPY_TARGETS + 1) } })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.errors.map(e => e.message)).toEqual([`No puedes copiar a más de ${MAX_COPY_TARGETS} dispositivos a la vez`])
    }
  })
})

describe('listDevicesSchema — el tope se APLICA, no se rechaza', () => {
  const take = (valor: unknown) => {
    const r = listDevicesSchema.safeParse({ params: { venueId: 'v1' }, query: valor === undefined ? {} : { take: valor } })
    return r.success ? r.data.query.take : 'rechazado'
  }

  it.each([
    [undefined, 25],
    ['1', 1],
    ['50', 50],
    ['51', 50],
    ['500', 50],
  ])('take=%p → %p', (valor, esperado) => {
    expect(take(valor)).toBe(esperado)
  })

  it.each(['0', '-3', 'abc', '2.5'])('take=%p no es un número de página válido', valor => {
    expect(take(valor)).toBe('rechazado')
  })
})

/**
 * 🔴 Los mensajes de Zod salen AL USUARIO (`validateRequest` los junta en el 400) y al MCP: tienen que estar en español.
 * Un `z.object` sin mensaje, o un `.strict()` pelón, sueltan el texto por defecto de Zod en inglés («Expected object,
 * received string», «Unrecognized key(s) in object»). Revisión de la Task 11, hallazgo menor 1.
 */
describe('los mensajes que ve el usuario están en ESPAÑOL', () => {
  const INGLES = /Expected|Unrecognized|Required|received|Invalid input/
  const mensajes = (r: { success: boolean; error?: { errors: { message: string }[] } }) => {
    expect(r.success).toBe(false)
    return r.error!.errors.map(e => e.message)
  }
  const destino = { terminalId: 't2', editToken: 'factory' }

  it('una llave desconocida en el borrador lo dice en español', () => {
    const textos = mensajes(customerDisplayDesignDraftSchema.safeParse({ welcomeText: 'Hola', venueId: 'otro' }))
    expect(textos).toEqual(['El diseño trae un campo que no existe'])
  })

  it.each([
    ['el diseño no es un objeto', putCustomerDisplaySchema, { params, body: { expectedEditToken: 'factory', design: 'x' } }],
    ['falta el diseño', putCustomerDisplaySchema, { params, body: { expectedEditToken: 'factory' } }],
    [
      'una imagen no es un objeto',
      putCustomerDisplaySchema,
      { params, body: { expectedEditToken: 'factory', design: { slides: ['a1'] } } },
    ],
    ['el logo no es texto', putCustomerDisplaySchema, { params, body: { expectedEditToken: 'factory', design: { logoAssetId: 7 } } }],
    ['la vista previa con un diseño que no es objeto', previewCustomerDisplaySchema, { params, body: { design: 7, previewSeq: 0 } }],
    ['el origen de la copia no es un objeto', copyCustomerDisplaySchema, { params, body: { source: 'x', targets: [destino] } }],
    ['falta el origen de la copia', copyCustomerDisplaySchema, { params, body: { targets: [destino] } }],
    ['un destino no es un objeto', copyCustomerDisplaySchema, { params, body: { source: destino, targets: ['t2'] } }],
    ['el cuerpo es un arreglo', resetCustomerDisplaySchema, { params, body: [] }],
    ['el cursor llega repetido (arreglo)', listDevicesSchema, { params: { venueId: 'v1' }, query: { cursor: ['a', 'b'] } }],
  ] as const)('%s: ningún mensaje en inglés', (_caso, esquema, entrada) => {
    const textos = mensajes((esquema as any).safeParse(entrada))
    expect(textos.length).toBeGreaterThan(0)
    for (const texto of textos) expect(texto).not.toMatch(INGLES)
  })

  it('el origen y el diseño dicen QUÉ falta, no un genérico', () => {
    expect(mensajes(copyCustomerDisplaySchema.safeParse({ params, body: { targets: [destino] } }))).toEqual([
      'Falta el dispositivo de origen',
    ])
    expect(mensajes(putCustomerDisplaySchema.safeParse({ params, body: { expectedEditToken: 'factory' } }))).toEqual(['Falta el diseño'])
    expect(mensajes(listDevicesSchema.safeParse({ params: { venueId: 'v1' }, query: { cursor: ['a', 'b'] } }))).toEqual([
      'El cursor no es válido',
    ])
  })
})

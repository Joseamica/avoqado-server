/**
 * Un almacén de precios de Stripe en memoria (planes editables B1): lo usan la prueba unitaria de Task 5
 * (`preciosDeLaVersion.test.ts`) y la integración HTTP de Task 9 (`plan-offer.http.integration.test.ts`).
 *
 * Se porta como Stripe en lo que importa a la recuperación de un precio:
 * - `create` guarda la PRIMERA respuesta de cada llave de idempotencia, también un error (como un 500 real), y la repite tal cual;
 * - `create` rechaza una llave de búsqueda repetida (400 `lookup_key_already_used`);
 * - `list({ lookup_keys, limit })` trae sólo los de esas llaves (con `hideArchived`, sin los inactivos) y `has_more` si hay más;
 * - `failNextCreateWith`: el siguiente `create` falla con ese `statusCode`/`code` (y Stripe guarda esa respuesta para la llave);
 * - `loseNextCreateResponse`: el siguiente `create` (o el primero que cumpla el predicado) CREA el precio, guarda el éxito para la
 *   llave y aun así lanza un error sin `statusCode`: la respuesta se perdió en el camino. Se apaga solo después de usarse.
 *
 * `list` y `create` son `jest.fn`: la prueba puede leer sus llamadas o cambiar una respuesta con `mockResolvedValueOnce`.
 * `reset()` deja todo como nuevo (llámalo en `beforeEach`).
 */
export class FakeStripeError extends Error {
  statusCode?: number
  code?: string
  constructor(statusCode: number | undefined, code?: string) {
    super(`stripe ${statusCode} ${code}`)
    this.statusCode = statusCode
    this.code = code
  }
}

type Resultado = { ok: boolean; value: any }

export interface AlmacenDePrecios {
  store: any[]
  idem: Map<string, Resultado>
  hideArchived: boolean
  failNextCreateWith: { statusCode?: number; code?: string } | null
  loseNextCreateResponse: boolean | ((params: any) => boolean)
  list: jest.Mock
  create: jest.Mock
  reset: () => void
}

export function crearAlmacenDePrecios(): AlmacenDePrecios {
  let seq = 0
  const almacen: AlmacenDePrecios = {
    store: [],
    idem: new Map<string, Resultado>(),
    hideArchived: false,
    failNextCreateWith: null,
    loseNextCreateResponse: false,
    list: jest.fn(),
    create: jest.fn(),
    reset: () => {
      almacen.store.length = 0
      almacen.idem.clear()
      almacen.hideArchived = false
      almacen.failNextCreateWith = null
      almacen.loseNextCreateResponse = false
      seq = 0
      almacen.list.mockReset().mockImplementation(async (params: any) => {
        const data = almacen.store.filter(p => params.lookup_keys.includes(p.lookup_key) && (!almacen.hideArchived || p.active))
        return { data: data.slice(0, params.limit), has_more: data.length > params.limit }
      })
      almacen.create.mockReset().mockImplementation(async (params: any, opts: any) => {
        const key = opts?.idempotencyKey as string
        const saved = almacen.idem.get(key)
        if (saved) {
          if (saved.ok) return saved.value
          throw saved.value
        }
        let outcome: Resultado
        let perder = false
        if (almacen.failNextCreateWith) {
          outcome = { ok: false, value: new FakeStripeError(almacen.failNextCreateWith.statusCode, almacen.failNextCreateWith.code) }
          almacen.failNextCreateWith = null
        } else if (almacen.store.some(p => p.lookup_key === params.lookup_key)) {
          outcome = { ok: false, value: new FakeStripeError(400, 'lookup_key_already_used') }
        } else {
          const price = { id: `price_${++seq}`, active: true, ...params }
          almacen.store.push(price)
          outcome = { ok: true, value: price }
          const perderSi = almacen.loseNextCreateResponse
          perder = typeof perderSi === 'function' ? perderSi(params) : perderSi
          if (perder) almacen.loseNextCreateResponse = false
        }
        almacen.idem.set(key, outcome)
        // Stripe ya lo creó y guardó el éxito para la llave; lo que no llegó es la respuesta (un error de red, sin statusCode).
        if (perder) throw new Error('ECONNRESET: la respuesta de Stripe se perdió')
        if (outcome.ok) return outcome.value
        throw outcome.value
      })
    },
  }
  almacen.reset()
  return almacen
}

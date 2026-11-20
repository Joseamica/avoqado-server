import type { StaffRole } from '@prisma/client'
import { evaluatePermissionList } from '@/lib/permissions'
import type { HelpAccess } from '@/services/support/access.service'
import {
  DATA_CAPABILITIES,
  capabilityGates,
  checkCapabilityAccess,
  dataCatalog,
  dataCatalogForAi,
  dataLabel,
  type AnyDataCapability,
  type DataCatalog,
  type DataScope,
} from '@/services/support/data/catalog'
import { SUPPORT_DATA_REFUSALS, type DataRefusalKey } from '@/services/support/data/texts'
import { fakeCapability } from '@tests/__helpers__/supportData'

const access = (over: Partial<HelpAccess> = {}): HelpAccess => ({
  permissions: ['reports:read'],
  features: { RESERVATIONS: { included: true, enabled: true } },
  activations: {},
  fingerprint: 'f',
  role: 'MANAGER',
  ...over,
})
const denied = {
  result: 'NO_PERMISSION',
  text: 'Con tus permisos en esta sucursal no puedo mostrarte el dato de prueba. Pídeselo a quien administra tu negocio.',
}

it.each([[['reports:read']], [['reports:*']], [['*:read']], [['*:*']]])('grants with %j', permissions =>
  expect(checkCapabilityAccess(fakeCapability, access({ permissions }))).toBeNull(),
)
it.each([[[]], [['reports:export']], [['payments:read']]])('denies with %j', permissions =>
  expect(checkCapabilityAccess(fakeCapability, access({ permissions }))).toEqual(denied),
)
it('a role gate: a MANAGER with the permission is denied; ADMIN and OWNER pass', () => {
  const def = { ...fakeCapability, roles: ['ADMIN', 'OWNER'] as StaffRole[] }
  expect(checkCapabilityAccess(def, access())).toEqual(denied)
  for (const role of ['ADMIN', 'OWNER'] as const) expect(checkCapabilityAccess(def, access({ role }))).toBeNull()
})
it('every permission of a capability is required, not just one of them', () => {
  const def = { ...fakeCapability, permissions: ['reports:read', 'payments:read'] }
  for (const permissions of [['reports:read'], ['payments:read']])
    expect(checkCapabilityAccess(def, access({ permissions }))).toEqual(denied)
  expect(checkCapabilityAccess(def, access({ permissions: ['reports:read', 'payments:read'] }))).toBeNull()
})
it('a capability without permissions is never granted, not even with *:*', () => {
  const def = { ...fakeCapability, permissions: [] }
  expect(checkCapabilityAccess(def, access({ permissions: ['*:*'] }))).toEqual(denied)
})
it.each([
  [
    'a gate without its featureCode',
    { ...fakeCapability, gate: { gateKind: 'FEATURE' as const, refusal: 'PLAN_RESERVATIONS' as const } },
    access(),
  ],
  ['a feature the access does not carry', fakeCapability, access({ features: {} })],
])('the plan gate fails closed: %s → PLAN_REQUIRED', (_name, def, acc) =>
  expect(checkCapabilityAccess(def, acc)).toEqual({ result: 'PLAN_REQUIRED', text: SUPPORT_DATA_REFUSALS.PLAN_RESERVATIONS }),
)
it('the plan gate answers after the permission, with its own text', () => {
  const noPlan = access({ features: { RESERVATIONS: { included: false, enabled: false } } })
  expect(checkCapabilityAccess(fakeCapability, noPlan)).toEqual({
    result: 'PLAN_REQUIRED',
    text: SUPPORT_DATA_REFUSALS.PLAN_RESERVATIONS,
  })
  expect(checkCapabilityAccess(fakeCapability, { ...noPlan, permissions: [] })).toEqual(denied)
})
// T-B43: la negativa nunca lleva el nombre de la sucursal (ya no lo recibe), y un texto de plan que no es una llave del conjunto
// (un `as`) da la genérica, nunca ese texto.
it('a plan refusal that is not a key of the set gives the generic text, never the value', () => {
  const def = { ...fakeCapability, gate: { ...fakeCapability.gate!, refusal: 'Club $876.54' as DataRefusalKey } }
  expect(checkCapabilityAccess(def, access({ features: {} }))).toEqual({
    result: 'PLAN_REQUIRED',
    text: SUPPORT_DATA_REFUSALS.NOT_AVAILABLE,
  })
})
// Lo que esta prueba fija lo comprueba «tipos»: una capacidad con tipos concretos cabe en toda firma que recibe una (Codex plan r2 #1)
it('a typed capability fits the catalog, the gates and the list for the AI', () => {
  const catalog: DataCatalog = dataCatalog(fakeCapability, { ...fakeCapability, key: 'second' })
  const one: AnyDataCapability = catalog.fake
  expect(capabilityGates(one)).toEqual([fakeCapability.gate])
  expect(dataCatalogForAi(catalog)).toEqual([
    { capability: 'fake', description: fakeCapability.aiHint },
    { capability: 'second', description: fakeCapability.aiHint },
  ])
})
// El caso de Codex r7 (caso 49): la lista ya resuelta de un Conjunto de Permisos con `goals:org-manage`
it('a resolved list is never expanded again: goals:org-manage does not grant payments:read', () => {
  const resolved = ['goals:org-manage', 'commissions:read'] // lo que da getUserAccess para ese Conjunto
  const def = { ...fakeCapability, permissions: ['payments:read'], gate: undefined }
  expect(evaluatePermissionList(resolved, 'payments:read')).toBe(true) // el comprobador de las advertencias sí lo concede: por eso está prohibido aquí
  expect(checkCapabilityAccess(def, access({ permissions: resolved }))).toMatchObject({ result: 'NO_PERMISSION' })
})

// «Entender» cierra la lista con [...llaves, 'other', 'none'] (hybrid.service): una llave así repetiría el enum y se leería como
// «fuera del catálogo» o «ningún dato».
it('no capability key is other or none', () => {
  const keys = [...Object.entries(DATA_CAPABILITIES).flatMap(([name, c]) => [name, c.key]), fakeCapability.key]
  for (const key of keys) expect(['other', 'none']).not.toContain(key)
})

// ─── T-B44/T-B46: lo que se registra se congela en su lugar, y el catálogo guarda ese mismo objeto ──────────────────────────────────────────

// Codex b2-r2 #2: una capacidad reasignaba `label` y `object` después de declararlos literales, y el nombre de la sucursal salía en la
// negativa, en la lista de «fuera del catálogo» y en la marca del historial.
it('a registered capability is frozen: reassigning its label or object (Codex b2-r2 #2) throws, and the catalog keeps the literals', () => {
  const live: AnyDataCapability = { ...fakeCapability, gate: { ...fakeCapability.gate!, refusal: 'PLAN_RESERVATIONS' } }
  const catalog = dataCatalog(live)
  const venue = 'Club $876.54'
  expect(() => {
    live.object = venue
  }).toThrow(TypeError)
  expect(() => {
    live.label = venue
  }).toThrow(TypeError)
  expect(() => live.permissions.push(venue)).toThrow(TypeError)
  expect(() => Object.assign(live.gate!, { refusal: venue })).toThrow(TypeError)
  expect(() => Object.assign(catalog.fake, { label: venue })).toThrow(TypeError)
  expect(() => Object.assign(catalog, { other: live })).toThrow(TypeError)
  expect(Reflect.set(catalog.fake, 'object', venue)).toBe(false)
  expect([catalog.fake.key, catalog.fake.label, catalog.fake.object, catalog.fake.aiHint]).toEqual([
    'fake',
    'dato de prueba',
    'el dato de prueba',
    fakeCapability.aiHint,
  ])
  expect(checkCapabilityAccess(catalog.fake, access({ permissions: [] }))).toEqual(denied)
  expect(dataLabel(catalog, 'fake')).toBe('dato de prueba')
  expect(catalog.fake).toBe(live) // T-B46: sin copia, el mismo objeto, congelado
  expect(Object.isFrozen(DATA_CAPABILITIES)).toBe(true)
})
// T-B46: sin copia, un getter seguiría dando otro valor después de congelar: no se registra.
it.each<[string, () => AnyDataCapability, string]>([
  [
    'a getter for the label',
    () => ({
      ...fakeCapability,
      key: 'changing',
      get label() {
        return 'dato que cambia'
      },
    }),
    'label',
  ],
  [
    'a getter for the plan refusal',
    () => ({
      ...fakeCapability,
      key: 'changing',
      gate: {
        featureCode: 'RESERVATIONS',
        get refusal() {
          return 'PLAN_RESERVATIONS' as const
        },
      },
    }),
    'gate.refusal',
  ],
])('a capability with %s is not registered (it would give another value after freezing)', (_name, make, says) =>
  expect(() => dataCatalog(make())).toThrow(`Support data: capability changing cannot be registered: ${says}`),
)
it('two capabilities with the same key are not registered', () =>
  expect(() => dataCatalog(fakeCapability, { ...fakeCapability })).toThrow('two capabilities with the same key'))
it('dataLabel reads only own keys: a key of Object.prototype or one that left the catalog has no label', () => {
  const catalog = dataCatalog(fakeCapability)
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'gone', '']) expect(dataLabel(catalog, key)).toBeNull()
})

// ─── T-B45 (Codex b2-r3) y T-B46 (Codex b2-r4): sin copia, lo que ve cada método es lo que escribió quien la hizo ─────────────────────────

const scope = { venueId: 'v', timezone: 'America/Mexico_City', venueName: 'Norte', now: new Date() } as DataScope
/** La clase de Codex b2-r3: metadatos literales, `params`/`read`/`render` como flechas y `notOffered` como método del prototipo. */
class CodexCapability implements AnyDataCapability {
  key = 'codex'
  label = 'dato de clase'
  object = 'el dato de clase'
  aiHint = 'Dato de clase.'
  permissions = ['reports:read']
  params = fakeCapability.params
  read = () => Promise.resolve({ total: 1, name: 'Mesa 1' })
  render = fakeCapability.render
  notOffered(_scope: DataScope) {
    return 'NOT_AVAILABLE' as const
  }
}
/** Y una con TODAS sus funciones en el prototipo. */
class AllMethods {
  key = 'methods'
  label = 'dato de métodos'
  object = 'el dato de métodos'
  aiHint = 'Dato de métodos.'
  permissions = ['reports:read']
  params() {
    return { ok: true as const, value: {} }
  }
  read() {
    return Promise.resolve({ total: 2, name: 'Mesa 2' })
  }
  render() {
    return { text: 'Dato de métodos', figures: [] }
  }
}
// T-B46: la instancia de una clase pasa la revisión de forma (sus textos son propios y sus métodos, funciones) y, como no se copia,
// conserva su prototipo. La guardia (regla 9) no deja escribirla así; esto es la red de ejecución.
it('Codex b2-r3: a capability written as a class keeps its prototype notOffered, so its refusal still holds', () => {
  const catalog = dataCatalog(new CodexCapability())
  expect(typeof catalog.codex.notOffered).toBe('function')
  expect(catalog.codex.notOffered!(scope)).toBe('NOT_AVAILABLE')
  expect([catalog.codex.label, catalog.codex.object]).toEqual(['dato de clase', 'el dato de clase'])
})
it('a capability with all its functions on the prototype keeps params, read and render', async () => {
  const catalog = dataCatalog(new AllMethods() as unknown as AnyDataCapability)
  expect(catalog.methods.params({} as never, '', scope)).toEqual({ ok: true, value: {} })
  await expect(catalog.methods.read(scope, {})).resolves.toEqual({ total: 2, name: 'Mesa 2' })
  expect(catalog.methods.render(scope, {}, {})).toEqual({ text: 'Dato de métodos', figures: [] })
})
// Codex b2-r4: la copia por nombre tiraba la bandera que el método lee por `this`, y `NOT_OFFERED` se volvía `ANSWERED`.
it.each<[string, () => AnyDataCapability & { closed: boolean }]>([
  [
    'a flag of the same object',
    () => ({
      ...fakeCapability,
      key: 'r4',
      closed: true,
      notOffered() {
        return this.closed ? ('NOT_AVAILABLE' as const) : null
      },
    }),
  ],
  [
    'a flag brought by a spread',
    () => {
      const flags = { closed: true }
      return {
        ...fakeCapability,
        ...flags,
        key: 'r4',
        notOffered() {
          return this.closed ? ('NOT_AVAILABLE' as const) : null
        },
      }
    },
  ],
])('Codex b2-r4: notOffered reading %s through this keeps its refusal, and the flag cannot change afterwards', (_name, make) => {
  const live = make()
  const catalog = dataCatalog(live)
  expect(catalog.r4.notOffered!(scope)).toBe('NOT_AVAILABLE')
  expect(() => {
    live.closed = false
  }).toThrow(TypeError)
  expect(catalog.r4.notOffered!(scope)).toBe('NOT_AVAILABLE')
})
it.each<[string, Record<string, unknown>, string]>([
  ['without read', { read: undefined }, 'read'],
  ['a render that is not a function', { render: 'Dato' }, 'render'],
  ['a notOffered that is not a function', { notOffered: 'NOT_AVAILABLE' }, 'notOffered'],
  ['an available that is not a function', { available: true }, 'available'],
  ['a label that is not a text', { label: 42 }, 'label'],
  ['without permissions', { permissions: undefined }, 'permissions'],
  ['roles that are not a list', { roles: 'ADMIN' }, 'roles'],
])('registration fails closed at load: %s', (_name, change, says) =>
  expect(() => dataCatalog({ ...fakeCapability, key: 'broken', ...change } as AnyDataCapability)).toThrow(
    `Support data: capability broken cannot be registered: ${says}`,
  ),
)

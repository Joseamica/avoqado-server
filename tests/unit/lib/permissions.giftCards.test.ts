/**
 * Tarjetas de regalo — permisos (spec §9; índice C1).
 * Cajero: vender, cobrar con saldo y consultar. Gerente, administrador y dueño: además ajustar, bloquear, reponer y cancelar.
 * En marca blanca sólo VENDER depende de la función GIFT_CARDS: cobrar y consultar saldo existente nunca se apagan (spec §6).
 */
import { StaffRole } from '@prisma/client'
import {
  DEFAULT_PERMISSIONS,
  INDIVIDUAL_PERMISSIONS_BY_RESOURCE,
  PERMISSION_DEPENDENCIES,
  expandWildcards,
  hasPermission,
  resolvePermissions,
} from '@/lib/permissions'
import { PERMISSION_TO_FEATURE_MAP } from '@/services/access/access.service'

const TODOS = ['giftCards:read', 'giftCards:sell', 'giftCards:redeem', 'giftCards:manage']
const MOSTRADOR = ['giftCards:read', 'giftCards:sell', 'giftCards:redeem']

describe('giftCards: catálogo del editor de roles', () => {
  it('los cuatro permisos se pueden asignar uno por uno', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.giftCards).toEqual(TODOS)
  })

  it('giftCards:* se expande a los cuatro (sin la entrada del catálogo el comodín no se expandiría)', () => {
    expect(expandWildcards(['giftCards:*'])).toEqual([...TODOS].sort())
  })
})

describe('giftCards: dependencias de un nivel', () => {
  it.each([
    ['giftCards:read', ['giftCards:read']],
    ['giftCards:sell', ['giftCards:sell', 'giftCards:read']],
    ['giftCards:redeem', ['giftCards:redeem', 'giftCards:read']],
    ['giftCards:manage', ['giftCards:manage', 'giftCards:read']],
  ])('%s arrastra %j', (perm, deps) => {
    expect(PERMISSION_DEPENDENCIES[perm]).toEqual(deps)
  })

  it('administrar NO concede vender ni cobrar (ejes separados, como creditPacks)', () => {
    const r = resolvePermissions(['giftCards:manage'])
    expect(r.has('giftCards:read')).toBe(true)
    expect(r.has('giftCards:sell')).toBe(false)
    expect(r.has('giftCards:redeem')).toBe(false)
  })
})

describe('giftCards: permisos de fábrica', () => {
  it('el cajero vende, cobra con saldo y consulta, pero no administra', () => {
    for (const p of MOSTRADOR) expect(hasPermission(StaffRole.CASHIER, null, p)).toBe(true)
    expect(hasPermission(StaffRole.CASHIER, null, 'giftCards:manage')).toBe(false)
    expect(DEFAULT_PERMISSIONS[StaffRole.CASHIER]).toEqual(expect.arrayContaining(MOSTRADOR))
  })

  it.each([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])('%s tiene los cuatro por comodín', role => {
    expect(DEFAULT_PERMISSIONS[role]).toContain('giftCards:*')
    for (const p of TODOS) expect(hasPermission(role, null, p)).toBe(true)
  })

  it.each([StaffRole.WAITER, StaffRole.HOST, StaffRole.KITCHEN, StaffRole.VIEWER])('%s no tiene ninguno', role => {
    for (const p of TODOS) expect(hasPermission(role, null, p)).toBe(false)
  })

  it('SUPERADMIN pasa por *:*', () => {
    for (const p of TODOS) expect(hasPermission(StaffRole.SUPERADMIN, null, p)).toBe(true)
  })
})

describe('giftCards: marca blanca', () => {
  it('sólo VENDER exige la función GIFT_CARDS', () => {
    expect(PERMISSION_TO_FEATURE_MAP['giftCards:sell']).toBe('GIFT_CARDS')
    for (const p of ['giftCards:read', 'giftCards:redeem', 'giftCards:manage']) expect(PERMISSION_TO_FEATURE_MAP[p]).toBeUndefined()
  })
})

describe('regresión', () => {
  it('el mostrador conserva paquetes y el gerente su comodín', () => {
    for (const p of ['creditPacks:read', 'creditPacks:sell', 'creditPacks:redeem'])
      expect(hasPermission(StaffRole.CASHIER, null, p)).toBe(true)
    expect(DEFAULT_PERMISSIONS[StaffRole.MANAGER]).toContain('creditPacks:*')
  })

  it('los pases siguen atados a su función en marca blanca', () => {
    expect(PERMISSION_TO_FEATURE_MAP['reservations:manage-passes']).toBe('AGGREGATOR_PASSES')
  })
})

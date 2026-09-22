import fs from 'fs'
import path from 'path'
import { StaffRole } from '@prisma/client'
import {
  DEFAULT_PERMISSIONS,
  INDIVIDUAL_PERMISSIONS_BY_RESOURCE,
  PERMISSION_DEPENDENCIES,
  expandWildcards,
  getEffectiveRolePermissions,
  hasPermission,
  resolvePermissions,
} from '@/lib/permissions'

const P = 'inventory:log-waste'

// Lo que un rol recibe DE VERDAD, sin override: defaults + dependencias, con comodines abiertos.
const efectivos = (role: StaffRole) => expandWildcards(getEffectiveRolePermissions(role, null, null))

describe('permiso inventory:log-waste', () => {
  it('está en el catálogo (de ahí sale el editor de roles y la expansión de inventory:*)', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.inventory).toContain(P)
    expect(expandWildcards(['inventory:*'])).toContain(P)
  })

  it('🔴 de fábrica: mesero, cajero y gerente sí; cocina, host y viewer no', () => {
    for (const role of [StaffRole.WAITER, StaffRole.CASHIER, StaffRole.MANAGER]) {
      expect({ role, trae: DEFAULT_PERMISSIONS[role].includes(P) }).toEqual({ role, trae: true })
      expect({ role, puede: hasPermission(role, null, P) }).toEqual({ role, puede: true })
    }
    for (const role of [StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER]) {
      // Ni en la lista, ni de rebote por la dependencia de otro permiso que el rol sí trae.
      expect({ role, trae: expandWildcards(DEFAULT_PERMISSIONS[role]).includes(P) }).toEqual({ role, trae: false })
      expect({ role, efectivo: efectivos(role).includes(P) }).toEqual({ role, efectivo: false })
      expect({ role, puede: hasPermission(role, null, P) }).toEqual({ role, puede: false })
    }
  })

  it('ADMIN y OWNER lo heredan de inventory:*; SUPERADMIN de *:*', () => {
    for (const role of [StaffRole.ADMIN, StaffRole.OWNER]) {
      expect({ role, trae: expandWildcards(DEFAULT_PERMISSIONS[role]).includes(P) }).toEqual({ role, trae: true })
      expect({ role, puede: hasPermission(role, null, P) }).toEqual({ role, puede: true })
    }
    expect(hasPermission(StaffRole.SUPERADMIN, null, P)).toBe(true)
  })

  it('🔴 por sí solo NO concede leer existencias ni ajustar', () => {
    expect(PERMISSION_DEPENDENCIES[P]).toEqual([P])
    const resuelto = resolvePermissions([P])
    expect([...resuelto]).toEqual([P])
    expect(resuelto.has('inventory:read')).toBe(false)
    expect(resuelto.has('inventory:adjust')).toBe(false)
  })

  it('ningún otro permiso lo arrastra como dependencia (sólo se concede a propósito)', () => {
    const arrastran = Object.entries(PERMISSION_DEPENDENCIES)
      .filter(([permiso, deps]) => permiso !== P && deps.includes(P))
      .map(([permiso]) => permiso)
    expect(arrastran).toEqual([])
  })

  it('🔴 el mesero y el cajero lo traen SIN ganar inventory:adjust', () => {
    for (const role of [StaffRole.WAITER, StaffRole.CASHIER]) {
      expect({ role, ajusta: hasPermission(role, null, 'inventory:adjust') }).toEqual({ role, ajusta: false })
    }
  })

  it('el venue puede QUITÁRSELO a cualquiera de los tres con una exclusión', () => {
    for (const role of [StaffRole.WAITER, StaffRole.CASHIER, StaffRole.MANAGER]) {
      expect({ role, puede: hasPermission(role, null, P, [P]) }).toEqual({ role, puede: false })
    }
    // …y al gerente le queda inventory:adjust, que es el otro camino para anular un folio.
    expect(hasPermission(StaffRole.MANAGER, null, 'inventory:adjust', [P])).toBe(true)
  })

  it('🔴 white-label: se filtra con AVOQADO_INVENTORY (la configuración), NO con INVENTORY_TRACKING (el plan)', () => {
    // PERMISSION_TO_FEATURE_MAP no se exporta; se lee la fuente, como deliveryWhiteLabel.test.ts.
    // El efecto real (la lista filtrada de getUserAccess) lo prueba la integración de merma.
    const fuente = fs.readFileSync(path.join(__dirname, '../../../src/services/access/access.service.ts'), 'utf8')
    expect(fuente).toMatch(/'inventory:log-waste':\s*'AVOQADO_INVENTORY'/)
  })
})

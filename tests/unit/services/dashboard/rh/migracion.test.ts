import { planDeMigracion } from '@/services/dashboard/rh/migracion'

const sv = (id: string, role: any, active = true, start = '2026-01-15T07:00:00Z') => ({
  id,
  staffId: `s-${id}`,
  role,
  active,
  startDate: new Date(start),
})

describe('migración RH 1a (spec §8)', () => {
  describe('feature', () => {
    it('un puesto por rol en uso, una asignación por StaffVenue activo, relación vacía', () => {
      const p = planDeMigracion({
        venueId: 'v1',
        timezone: 'America/Mexico_City',
        venueType: 'RESTAURANT',
        roleConfigs: [],
        staffVenues: [sv('a', 'WAITER'), sv('b', 'WAITER'), sv('c', 'CASHIER')],
        existentes: new Set(),
      })
      expect(p.puestos.map(x => x.migrationKey)).toEqual(['role:v1:CASHIER', 'role:v1:WAITER'])
      expect(p.asignaciones).toHaveLength(3)
      expect(p.asignaciones[0]).toMatchObject({ migrationKey: 'sv:a', puestoKey: 'role:v1:WAITER' })
    })
    it('startDate se convierte al día de la sede', () => {
      const p = planDeMigracion({
        venueId: 'v1',
        timezone: 'America/Mexico_City',
        venueType: 'RESTAURANT',
        roleConfigs: [],
        staffVenues: [sv('a', 'WAITER', true, '2026-01-15T03:00:00Z')],
        existentes: new Set(),
      })
      expect(p.asignaciones[0].effectiveFrom).toBe('2026-01-14')
    })
    it('nombre: el displayName del negocio gana; si no hay, el default del giro (VenueType, incluido TELECOMUNICACIONES)', () => {
      const p = planDeMigracion({
        venueId: 'v1',
        timezone: 'UTC',
        venueType: 'TELECOMUNICACIONES',
        roleConfigs: [{ role: 'CASHIER' as any, displayName: '  Promotor  ' }],
        staffVenues: [sv('a', 'WAITER'), sv('b', 'CASHIER'), sv('c', 'MANAGER')],
        existentes: new Set(),
      })
      // TELECOMUNICACIONES es RETAIL: WAITER = «Vendedor»; MANAGER sin default del giro = «Gerente».
      expect(p.puestos.map(x => [x.suggestedRole, x.name])).toEqual([
        ['CASHIER', 'Promotor'],
        ['MANAGER', 'Gerente'],
        ['WAITER', 'Vendedor'],
      ])
    })
  })
  describe('regresión', () => {
    it('inactivos no se migran', () => {
      const p = planDeMigracion({
        venueId: 'v1',
        timezone: 'UTC',
        venueType: 'RESTAURANT',
        roleConfigs: [],
        staffVenues: [sv('a', 'WAITER', false)],
        existentes: new Set(),
      })
      expect(p.asignaciones).toHaveLength(0)
      expect(p.puestos).toHaveLength(0)
    })
    it('SUPERADMIN (interno de Avoqado, el negocio no lo ve) no recibe puesto ni asignación', () => {
      const p = planDeMigracion({
        venueId: 'v1',
        timezone: 'UTC',
        venueType: 'RESTAURANT',
        roleConfigs: [],
        staffVenues: [sv('a', 'SUPERADMIN'), sv('b', 'WAITER')],
        existentes: new Set(),
      })
      expect(p.puestos.map(x => x.suggestedRole)).toEqual(['WAITER'])
      expect(p.asignaciones.map(x => x.migrationKey)).toEqual(['sv:b'])
    })
    it('lo ya migrado (aunque se haya editado o archivado) no se repite', () => {
      const p = planDeMigracion({
        venueId: 'v1',
        timezone: 'UTC',
        venueType: 'RESTAURANT',
        roleConfigs: [],
        staffVenues: [sv('a', 'WAITER')],
        existentes: new Set(['role:v1:WAITER', 'sv:a']),
      })
      expect(p.puestos).toHaveLength(0)
      expect(p.asignaciones).toHaveLength(0)
    })
    it('dos roles con el mismo nombre visible: el segundo lleva el rol entre paréntesis', () => {
      const p = planDeMigracion({
        venueId: 'v1',
        timezone: 'UTC',
        venueType: 'RESTAURANT',
        roleConfigs: [
          { role: 'WAITER' as any, displayName: 'Staff' },
          { role: 'CASHIER' as any, displayName: 'Staff' },
        ],
        staffVenues: [sv('a', 'WAITER'), sv('b', 'CASHIER')],
        existentes: new Set(),
      })
      // roles en orden alfabético: CASHIER se queda con «Staff» y WAITER lleva su rol
      expect(p.puestos.map(x => x.name)).toEqual(['Staff', 'Staff (WAITER)'])
    })
    it('el choque de nombres no distingue mayúsculas, y el puesto ya migrado también aparta su nombre', () => {
      const p = planDeMigracion({
        venueId: 'v1',
        timezone: 'UTC',
        venueType: 'RESTAURANT',
        roleConfigs: [
          { role: 'WAITER' as any, displayName: 'Staff' },
          { role: 'CASHIER' as any, displayName: 'staff' },
        ],
        staffVenues: [sv('a', 'WAITER'), sv('b', 'CASHIER')],
        // CASHIER ya se migró: no se crea otra vez, pero su nombre sigue ocupado para WAITER (mismo nombre en cada corrida).
        existentes: new Set(['role:v1:CASHIER']),
      })
      expect(p.puestos.map(x => x.name)).toEqual(['Staff (WAITER)'])
    })
  })
})

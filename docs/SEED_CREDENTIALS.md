# Credenciales de Usuarios del Seed

Este documento contiene las credenciales de todos los usuarios creados por el seed script para facilitar las pruebas.

## Usuarios Globales (Acceso a Todos los Venues)

Estos usuarios tienen acceso a **ambos venues** (Avoqado Full y Avoqado Empty):

| Role       | Email                     | Password   | Description                    |
| ---------- | ------------------------- | ---------- | ------------------------------ |
| SUPERADMIN | superadmin@superadmin.com | superadmin | Acceso completo al sistema     |
| OWNER      | owner@owner.com           | owner      | Propietario de la organización |

---

## Usuarios Específicos de Avoqado Full

Estos usuarios **solo** tienen acceso al venue **Avoqado Full**:

| Role    | Email               | Password | Description             |
| ------- | ------------------- | -------- | ----------------------- |
| ADMIN   | admin@admin.com     | admin    | Administrador del venue |
| MANAGER | manager@manager.com | manager  | Gerente del venue       |
| CASHIER | cashier@cashier.com | cashier  | Cajero del venue        |
| WAITER  | waiter@waiter.com   | waiter   | Mesero del venue        |
| KITCHEN | kitchen@kitchen.com | kitchen  | Personal de cocina      |
| HOST    | host@host.com       | host     | Host/Recepcionista      |
| VIEWER  | viewer@viewer.com   | viewer   | Solo lectura            |

---

## Usuarios Específicos de Avoqado Empty

Estos usuarios **solo** tienen acceso al venue **Avoqado Empty**:

| Role    | Email                 | Password | Description             |
| ------- | --------------------- | -------- | ----------------------- |
| ADMIN   | admin2@admin2.com     | admin2   | Administrador del venue |
| MANAGER | manager2@manager2.com | manager2 | Gerente del venue       |
| CASHIER | cashier2@cashier2.com | cashier2 | Cajero del venue        |
| WAITER  | waiter2@waiter2.com   | waiter2  | Mesero del venue        |
| KITCHEN | kitchen2@kitchen2.com | kitchen2 | Personal de cocina      |
| HOST    | host2@host2.com       | host2    | Host/Recepcionista      |
| VIEWER  | viewer2@viewer2.com   | viewer2  | Solo lectura            |

---

## Patrón de Credenciales

El patrón utilizado es consistente y fácil de recordar:

- **Avoqado Full**:

  - Email: `{role}@{role}.com`
  - Password: `{role}`
  - Ejemplo: `manager@manager.com` / `manager`

- **Avoqado Empty**:
  - Email: `{role}2@{role}2.com`
  - Password: `{role}2`
  - Ejemplo: `manager2@manager2.com` / `manager2`

## Permisos por Rol

### SUPERADMIN

- Acceso completo a todo el sistema
- Puede administrar múltiples organizaciones
- PIN en Avoqado Full: `0000`

### OWNER

- Acceso completo a todos los venues de la organización
- Puede crear y administrar venues
- Gestión completa de staff

### ADMIN

- Acceso completo al venue asignado
- Gestión de staff, configuración, reportes financieros
- No puede crear venues

### MANAGER

- Acceso a operaciones del venue
- Gestión de turnos, inventario, reportes operacionales
- Puede procesar reembolsos (`payments:refund`)
- Puede exportar datos (`analytics:export`)

### CASHIER

- Procesamiento de pagos
- Gestión básica de órdenes
- Operaciones de TPV

### WAITER

- Gestión de órdenes y mesas
- Creación de pagos (`payments:create`)
- Lectura de pagos (`payments:read`)
- **Vista de solo lectura del menú** (`menu:read`) - puede ver menús, categorías, productos y modificadores
- **NO** puede crear, editar o eliminar elementos del menú (requiere MANAGER+)
- **NO** puede procesar reembolsos o enviar recibos

### KITCHEN

- Acceso al sistema de display de cocina
- Seguimiento de preparación de órdenes

### HOST

- Gestión de reservaciones
- Asignación de mesas
- Recepción de clientes

### VIEWER

- Acceso de solo lectura
- Puede ver reportes y datos
- No puede modificar nada

---

## Cómo Ejecutar el Seed

```bash
# 1. Resetear la base de datos
npx prisma migrate reset --force

# 2. Esto automáticamente ejecuta el seed
# O manualmente:
npm run seed

# 3. Verificar usuarios creados
npm run studio
# Navegar a la tabla "Staff" y "StaffVenue"
```

## Verificar Asignaciones en la Base de Datos

```sql
-- Ver todos los staff creados
SELECT id, email, "firstName", "lastName" FROM "Staff" ORDER BY email;

-- Ver asignaciones de staff a venues
SELECT
  s.email,
  v.name as venue,
  sv.role,
  sv.pin
FROM "StaffVenue" sv
JOIN "Staff" s ON s.id = sv."staffId"
JOIN "Venue" v ON v.id = sv."venueId"
ORDER BY v.name, sv.role;

-- Contar asignaciones por venue
SELECT
  v.name,
  COUNT(*) as staff_count
FROM "StaffVenue" sv
JOIN "Venue" v ON v.id = sv."venueId"
GROUP BY v.name;
```

## Ejemplo de Uso

```bash
# Iniciar sesión como MANAGER de Avoqado Full
Email: manager@manager.com
Password: manager
# → Solo verás el venue "Avoqado Full"

# Iniciar sesión como MANAGER de Avoqado Empty
Email: manager2@manager2.com
Password: manager2
# → Solo verás el venue "Avoqado Empty"

# Iniciar sesión como SUPERADMIN
Email: superadmin@superadmin.com
Password: superadmin
# → Verás ambos venues y podrás acceder a todo
```

---

**Nota**: Este documento es solo para desarrollo y pruebas. **NUNCA** uses estas credenciales en producción.

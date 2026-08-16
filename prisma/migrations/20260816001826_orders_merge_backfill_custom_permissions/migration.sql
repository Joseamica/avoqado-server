-- "Quien puede anular, puede fusionar" — opción A del founder (2026-08-15).
--
-- `orders:merge` nació como permiso propio (antes viajaba dentro de orders:update).
-- Los defaults de rol ya lo traen para MANAGER/ADMIN/OWNER, pero un conjunto de
-- permisos PERSONALIZADO reemplaza esos defaults: sin este backfill, en los venues
-- que personalizaron permisos NADIE —ni el gerente— podría fusionar cuentas ni
-- autorizar la fusión con su PIN, hasta que alguien editara el conjunto a mano en
-- el dashboard. La regla preserva la intención original de cada venue: quien ya
-- podía ANULAR una cuenta (la acción destructiva vecina) también puede fusionarla.
--
-- Se tocan las DOS estructuras que evalúa checkPermission:
--   1) PermissionSet.permissions      — lista efectiva, reemplaza al rol (evaluatePermissionList)
--   2) VenueRolePermission.permissions — permisos custom por rol/venue (hasPermission)
--
-- IDEMPOTENTE: el `NOT ('orders:merge' = ANY(...))` del WHERE hace que una segunda
-- corrida no encuentre filas. Los conjuntos con comodín (`orders:*` o `*:*`) YA
-- conceden merge y se excluyen a propósito: agregarles la línea sólo ensuciaría la
-- lista con un duplicado semántico.
--
-- `updatedAt` se mueve a propósito: la fila cambió de verdad, y esos índices
-- (`[venueId, updatedAt]`) son la bitácora de "qué permisos se movieron y cuándo".

BEGIN;

UPDATE "PermissionSet"
SET permissions = array_append(permissions, 'orders:merge'),
    "updatedAt" = NOW()
WHERE 'orders:cancel' = ANY (permissions)
  AND NOT ('orders:merge' = ANY (permissions))
  AND NOT ('orders:*' = ANY (permissions))
  AND NOT ('*:*' = ANY (permissions));

UPDATE "VenueRolePermission"
SET permissions = array_append(permissions, 'orders:merge'),
    "updatedAt" = NOW()
WHERE 'orders:cancel' = ANY (permissions)
  AND NOT ('orders:merge' = ANY (permissions))
  AND NOT ('orders:*' = ANY (permissions))
  AND NOT ('*:*' = ANY (permissions));

COMMIT;

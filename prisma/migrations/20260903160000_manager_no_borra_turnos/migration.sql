-- 🔴 DINERO — La decisión «el gerente edita un turno, pero no lo borra» (founder, 3-sep-2026) NO
-- quedaba aplicada quitando `shifts:delete` de DEFAULT_PERMISSIONS[MANAGER]. Hallazgo P1.1 de la
-- auditoría de Codex (docs/auditorias/2026-09-03-auditoria-codex-permisos-turno-de-caja.md).
--
-- Por qué: `VenueRolePermission.permissions` es ADITIVO —se suma a los de fábrica, no los
-- reemplaza— y el editor de roles del dashboard guarda la lista EFECTIVA ya expandida. Así que en
-- todo venue donde alguien abrió el editor de MANAGER y guardó, aunque fuera para cambiar otro
-- permiso, `shifts:delete` quedó ESCRITO en su fila. Ahí el gerente sigue pudiendo borrar un corte
-- de caja: un borrado DURO que además suelta sus órdenes, pagos, comisiones y la sesión de gaveta
-- (`onDelete: SetNull`). O sea que la política nueva sólo se cumplía para los venues que nunca
-- personalizaron el rol.
--
-- Alcance deliberado, y sus dos límites declarados:
--   · SÓLO el rol MANAGER y SÓLO ese permiso. No se toca ninguna otra fila, rol ni permiso.
--   · Antes de hoy `shifts:delete` era un DEFAULT del rol, así que nadie tuvo que concederlo a
--     mano: su presencia en un override no se puede distinguir de un eco del editor. Si un venue
--     de verdad lo quería, se vuelve a conceder desde el editor de roles — el permiso sigue en el
--     catálogo (`INDIVIDUAL_PERMISSIONS_BY_RESOURCE`), esto no tapia la puerta.
--
-- Idempotente: `array_remove` sobre una fila que ya no lo tiene no hace nada, y el WHERE la excluye.
UPDATE "VenueRolePermission"
SET "permissions" = array_remove("permissions", 'shifts:delete')
WHERE "role" = 'MANAGER'
  AND 'shifts:delete' = ANY("permissions");

-- D5 · bloque P (11-nov-2026): interruptor del piloto «cobrar mesas sin internet».
-- Sólo DATOS: la fila Feature para que el superadmin la conceda negocio por negocio desde el diálogo que ya existe.
-- $0, activa, fuera de FEATURE_CATALOG y de todo plan (CODIGOS_DE_PILOTO en basePlan.service.ts): ningún plan, demo,
-- exención ni sincronización con Stripe la concede o la vende. No crea ninguna VenueFeature.
-- Idempotente: si la fila ya existe no se toca (alguien pudo apagarla a propósito).
-- 🔴 Se publica DESPUÉS del código que la excluye (demos, exención, Stripe): con el servidor anterior todavía atendiendo, cada
-- demo creada durante el despliegue la recibiría (Codex p-r1 #1).
-- Fin del piloto: otra migración borra sus VenueFeature y esta fila.
INSERT INTO "Feature" ("id", "code", "name", "description", "category", "monthlyPrice", "active")
VALUES (
  'cmwd1boba000080waeobddcru',
  'MESAS_SIN_RED',
  'Mesas: cobrar sin internet (piloto)',
  'Piloto de Avoqado: la tablet que tomó la mesa la cobra en efectivo sin internet. Sólo la prende Avoqado, negocio por negocio.',
  'OPERATIONS',
  0.00,
  true
)
ON CONFLICT ("code") DO NOTHING;

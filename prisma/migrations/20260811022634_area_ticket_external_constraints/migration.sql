-- Escrita a mano: Prisma no modela CHECK constraints. Por eso mismo son la única
-- defensa que sobrevive a un script de datos que no pase por la capa de servicio.
--
-- `ADD CONSTRAINT ... CHECK` valida toda la tabla y toma ACCESS EXCLUSIVE. Verificado
-- contra la base local (av-db-25) antes de escribir esto: AreaTicket tiene 21 filas,
-- AreaTicketFulfillment 6 — muy lejos del umbral (~500k) donde haría falta partirlo en
-- `NOT VALID` + `VALIDATE CONSTRAINT` (patrón de
-- 20260808121126_add_catalog_publication_outbox_hot_parent_fks_not_valid). Aquí el
-- ADD CONSTRAINT normal es instantáneo.
--
-- Sin `SET lock_timeout` propio: scripts/prisma-migrate-deploy-bounded.js ya lo aplica
-- en la conexión (`-c lock_timeout=5s`) para todo deploy — es la única vía, verificado
-- por tests/unit/architecture/areaTicketMigrationLockSafety.test.ts.
BEGIN;

-- 1. La invariante NATIVA no se debilita: pasa de estar sostenida por el tipo de la
--    columna a estar sostenida por una restricción que dice lo que quiere decir.
ALTER TABLE "AreaTicketFulfillment"
  ADD CONSTRAINT "atf_order_required_for_avoqado_route"
  CHECK ("settlementRoute" <> 'AVOQADO' OR "orderId" IS NOT NULL);

-- 2. Un vale externo NUNCA entra al circuito de caja Avoqado: sin sesión de checkout
--    de Avoqado, sin Order propio, y solo en los tres estados que la ruta externa
--    conoce (nunca CLAIMED/PAID/DELIVERED — esos son vocabulario de la caja Avoqado).
ALTER TABLE "AreaTicket"
  ADD CONSTRAINT "area_ticket_external_no_avoqado_circuit"
  CHECK (
    "settlementRoute" <> 'EXTERNAL'
    OR (
      "checkoutSessionId" IS NULL
      AND "orderId" IS NULL
      AND "status" IN ('ISSUED', 'CANCELLED', 'EXPIRED')
    )
  );

COMMIT;

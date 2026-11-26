-- D27, decisión del founder (25-nov-2026): el vencimiento de puntos queda APAGADO en las configuraciones que ya existían.
-- Todas traían 365 días, el valor de origen de `getOrCreateLoyaltyConfig` que nadie eligió. Con los puntos venciendo de verdad
-- (vencimiento por inactividad, migración anterior), dejarlo así lo habría prendido sin que nadie lo pidiera. Cada negocio lo prende en
-- Lealtad si lo quiere, y ese día arranca su reloj. Sólo los 365: cualquier otro valor lo eligió alguien y se respeta.
UPDATE "LoyaltyConfig" SET "pointsExpireDays" = NULL WHERE "pointsExpireDays" = 365;

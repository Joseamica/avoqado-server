-- Rappi no admite modo de aceptación manual (F4 del founder, fase 2 de Rappi): cancela solo el pedido que no se acepta en 4 a 6
-- minutos. El servidor ya acepta siempre los pedidos de Rappi y ya rechaza crear o editar un vínculo de Rappi en MANUAL; esta
-- migración alinea los vínculos que quedaron en MANUAL de antes. MIGRACIÓN DE DATOS: el esquema no cambia.
-- Idempotente: una segunda corrida no encuentra filas por cambiar.
UPDATE "DeliveryChannelLink" SET "orderAcceptanceMode" = 'AUTO' WHERE "provider" = 'RAPPI' AND "orderAcceptanceMode" <> 'AUTO';

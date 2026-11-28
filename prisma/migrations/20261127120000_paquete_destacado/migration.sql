-- Destacado del paquete de créditos: etiqueta corta («Más popular») e ícono opcional.
-- Columnas nuevas y opcionales: los paquetes que ya existen quedan sin destacado.
ALTER TABLE "CreditPack" ADD COLUMN "badgeText" VARCHAR(40),
ADD COLUMN "badgeIcon" VARCHAR(20);

-- D27: los puntos de lealtad vencen de verdad. Sólo columnas nuevas y vacías (instantáneo en Postgres, sin reescribir las tablas).
-- Sin relleno a propósito: el job la fija la primera vez que ve cada negocio (el reloj arranca con el código, no con la migración).
ALTER TABLE "LoyaltyConfig" ADD COLUMN "pointsExpireSince" TIMESTAMP(3);

-- Marca de los vencimientos que se llevan todo el saldo (los de antes eran parciales): la reversa de un reembolso sólo confía en éstos.
ALTER TABLE "LoyaltyTransaction" ADD COLUMN "wholeBalance" BOOLEAN;

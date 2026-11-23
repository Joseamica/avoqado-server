-- D679 · Paquete «Ilimitado»: sólo agrega columnas (nada se quita). Un Ilimitado guarda 99,999 como cantidad y esta marca.
ALTER TABLE "CreditPackItem" ADD COLUMN "unlimited" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CreditItemBalance" ADD COLUMN "unlimited" BOOLEAN NOT NULL DEFAULT false;

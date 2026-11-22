-- La misma opción se puede elegir varias veces dentro de un grupo de extras (encargo a508f4, Flautas Coyoacán).
-- Aditiva y con default: los grupos de hoy quedan como estaban (cada opción una sola vez).
ALTER TABLE "ModifierGroup" ADD COLUMN "allowRepeat" BOOLEAN NOT NULL DEFAULT false;

-- Cuántas veces se puede elegir cada opción en un grupo que deja repetir. NULL = hasta el máximo del grupo.
ALTER TABLE "Modifier" ADD COLUMN "maxQuantity" INTEGER;

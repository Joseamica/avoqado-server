-- D40: la nota de cada parte (extra elegido) de un renglón. Nullable y aditiva: las apps viejas no la mandan.
ALTER TABLE "OrderItemModifier" ADD COLUMN "notes" TEXT;

-- TABLE_SERVICE courses: additive nullable column, no backfill needed.
ALTER TABLE "OrderItem" ADD COLUMN "course" TEXT;

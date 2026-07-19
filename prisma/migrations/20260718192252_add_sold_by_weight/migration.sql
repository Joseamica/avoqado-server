-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "weightQuantity" DECIMAL(12,3),
ADD COLUMN     "weightUnit" "Unit";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "soldByWeight" BOOLEAN NOT NULL DEFAULT false;

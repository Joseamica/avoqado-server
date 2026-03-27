-- AlterTable
ALTER TABLE "public"."Aggregator" ADD COLUMN "reportToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Aggregator_reportToken_key" ON "public"."Aggregator"("reportToken");

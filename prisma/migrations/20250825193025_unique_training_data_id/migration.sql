/*
  Warnings:

  - A unique constraint covering the columns `[trainingDataId]` on the table `ChatFeedback` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "public"."ChatFeedback_trainingDataId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "ChatFeedback_trainingDataId_key" ON "public"."ChatFeedback"("trainingDataId");

-- AlterTable
ALTER TABLE "public"."training_modules" ADD COLUMN     "quizMaxAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quizPassThreshold" INTEGER NOT NULL DEFAULT 70;

-- AlterTable
ALTER TABLE "public"."training_progress" ADD COLUMN     "attemptNumber" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "public"."training_quiz_questions" ADD COLUMN     "explanation" TEXT;

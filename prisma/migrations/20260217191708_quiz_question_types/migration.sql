-- CreateEnum
CREATE TYPE "public"."TrainingQuestionType" AS ENUM ('MULTIPLE_CHOICE', 'TRUE_FALSE', 'MULTI_SELECT');

-- AlterTable
ALTER TABLE "public"."training_quiz_questions" ADD COLUMN     "correctIndices" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "questionType" "public"."TrainingQuestionType" NOT NULL DEFAULT 'MULTIPLE_CHOICE';

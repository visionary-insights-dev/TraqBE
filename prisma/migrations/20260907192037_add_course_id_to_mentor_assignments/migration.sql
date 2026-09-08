/*
  Warnings:

  - Added the required column `course_id` to the `mentor_scholar_assignments` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "invitations" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "mentor_scholar_assignments" ADD COLUMN     "course_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "password_reset_tokens" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "refresh_tokens" ALTER COLUMN "id" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "mentor_scholar_assignments_course_id_idx" ON "mentor_scholar_assignments"("course_id");

-- CreateIndex
CREATE INDEX "mentor_scholar_assignments_scholar_id_course_id_idx" ON "mentor_scholar_assignments"("scholar_id", "course_id");

-- AddForeignKey
ALTER TABLE "mentor_scholar_assignments" ADD CONSTRAINT "mentor_scholar_assignments_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

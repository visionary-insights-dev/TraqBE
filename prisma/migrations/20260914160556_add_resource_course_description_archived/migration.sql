-- AlterTable
ALTER TABLE "resources" ADD COLUMN     "archived_at" TIMESTAMPTZ,
ADD COLUMN     "course_id" UUID,
ADD COLUMN     "description" TEXT;

-- CreateIndex
CREATE INDEX "resources_course_id_idx" ON "resources"("course_id");

-- CreateIndex
CREATE INDEX "resources_archived_at_idx" ON "resources"("archived_at");

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

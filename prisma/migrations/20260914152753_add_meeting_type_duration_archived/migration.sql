-- AlterTable
ALTER TABLE "meetings" ADD COLUMN     "archived_at" TIMESTAMPTZ,
ADD COLUMN     "duration_minutes" INTEGER,
ADD COLUMN     "type" TEXT;

-- CreateIndex
CREATE INDEX "meetings_archived_at_idx" ON "meetings"("archived_at");

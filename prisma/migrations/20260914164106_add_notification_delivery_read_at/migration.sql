-- AlterTable
ALTER TABLE "notification_deliveries" ADD COLUMN     "read_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "notification_deliveries_user_id_read_at_idx" ON "notification_deliveries"("user_id", "read_at");

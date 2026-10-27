-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('OPENED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "alert_events" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "kind" "AlertKind" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "last_error_kind" TEXT,
    "provider_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_events_status_next_attempt_at_idx" ON "alert_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "alert_events_incident_id_kind_key" ON "alert_events"("incident_id", "kind");

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

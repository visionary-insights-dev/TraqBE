# Traq BE — Phase by Phase Build Plan

## Agent Reference

| Agent | Role |
|---|---|
| `api-builder` | NestJS controllers, services, DTOs, Swagger |
| `db-architect` | Prisma schema changes, migrations, query optimisation |
| `job-worker` | BullMQ processors, queues, scheduled tasks |
| `tester` | Unit tests, integration tests, tenant isolation tests |

> Every phase ends with: `npx tsc --noEmit` + update `PROGRESS.md` + commit + push

---

## Phase 0 — Foundation ✅ DONE

All scaffolding, Prisma schema, 21 tables, common utilities, app config.

---

## Phase 1 — Auth & Security

**Depends on:** Phase 0
**Agents:** `api-builder`, `tester`

**Endpoints:**
- `GET /api/v1/health`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/forgot-password`
- `POST /api/v1/auth/verify-otp`
- `POST /api/v1/auth/reset-password`
- `POST /api/v1/auth/invitations/:token/validate`
- `POST /api/v1/auth/invitations/:token/register`

**Prompt:**
```
Use the api-builder agent to implement the full Auth module.

Build in this exact order:

1. GET /api/v1/health (public)
   Check DB: await this.prisma.$queryRaw`SELECT 1`
   Check Redis: await redis.ping()
   Return: { status: "ok", db: "ok", redis: "ok", timestamp }

2. POST /api/v1/auth/login
   Body: { email, password }
   - Find user by email in users table
   - Check archived_at is null (not archived)
   - Verify password with argon2.verify()
   - Generate access token (JWT, 15min) — return in body
   - Generate refresh token (JWT, 7d) — set as HTTP-only secure cookie
   - Return: { user: { id, email, role, organizationId, name }, accessToken }
   - Errors: INVALID_CREDENTIALS, ACCOUNT_ARCHIVED

3. POST /api/v1/auth/refresh
   - Read refresh token from HTTP-only cookie
   - Validate JWT signature and expiry
   - Issue new access token + rotate refresh token (new cookie)
   - Error: TOKEN_EXPIRED, TOKEN_INVALID

4. POST /api/v1/auth/logout
   - Clear refresh token cookie
   - Return 204

5. POST /api/v1/auth/forgot-password
   Body: { email }
   - Find user, generate 6-digit OTP
   - Store hashed OTP + expiry in DB
   - Queue email job (do not send inline)
   - Always return 200 (don't reveal if email exists)

6. POST /api/v1/auth/verify-otp
   Body: { email, otp }
   - Validate OTP hash + expiry
   - Return short-lived reset token
   - Error: OTP_INVALID, OTP_EXPIRED

7. POST /api/v1/auth/reset-password
   Body: { resetToken, newPassword }
   - Validate reset token
   - Hash new password with argon2.hash()
   - Update user record
   - Invalidate all refresh tokens for this user
   - Error: RESET_TOKEN_INVALID

8. POST /api/v1/auth/invitations/:token/validate
   - Find invitation by token_hash
   - Check not expired (48hr window)
   - Return: { email, role, organizationId }
   - Error: INVITATION_EXPIRED, INVITATION_NOT_FOUND

9. POST /api/v1/auth/invitations/:token/register
   Body: { password, name, phone }
   - Validate invitation token
   - Hash password with argon2.hash()
   - Create user record
   - Mark invitation as used
   - Return access token + set refresh cookie
   - Error: INVITATION_ALREADY_USED

JWT Strategy:
- Extract Bearer token from Authorization header
- Validate with JWT_ACCESS_SECRET
- Attach { id, email, role, organizationId } to req.user
- JwtAuthGuard uses this strategy
- @Public() decorator bypasses the guard

After implementation:
- Use the tester agent to write unit tests for AuthService
  covering: login success, wrong password, archived user,
  token refresh, OTP flow, invitation registration
- Run npx tsc --noEmit — zero errors
- Update PROGRESS.md
- Commit and push
```

---

## Phase 2 — Organization & User Management

**Depends on:** Phase 1
**Agents:** `api-builder`, `tester`

**Endpoints:**
- `GET /api/v1/organization/settings`
- `PATCH /api/v1/organization/settings`
- `GET /api/v1/users`
- `POST /api/v1/users/invite`
- `GET /api/v1/users/:id`
- `PATCH /api/v1/users/:id`
- `POST /api/v1/users/:id/archive`
- `GET /api/v1/users/me/profile`
- `PATCH /api/v1/users/me/profile`
- `POST /api/v1/users/bulk-import`

**Prompt:**
```
Use the api-builder agent to implement Organization Settings 
and User Management modules.

Organization Settings:
1. GET /api/v1/organization/settings
   Permission: organization.settings.read
   Return org settings including:
   - assignmentWeight (default 0.70)
   - attendanceWeight (default 0.30)
   - atRiskAttendanceThreshold (default 70)
   - atRiskAssignmentThreshold (default 60)
   - atRiskOverdueThreshold (default 3)
   - lateSubmissionPenaltyPercentage (default 20)
   - assignmentEditWindowMinutes (default 60)
   - invitationExpiryHours (default 48)

2. PATCH /api/v1/organization/settings
   Permission: organization.settings.update
   CRITICAL validation: assignmentWeight + attendanceWeight MUST equal 1.0
   Error: INVALID_WEIGHT_SUM if they don't
   Log audit entry on every settings change

User Management (SUPER_ADMIN only):
3. GET /api/v1/users?role=&page=&limit=
   Permission: users.read
   Scope: organization_id from session only
   Include: name, email, role, archived_at, progress summary

4. POST /api/v1/users/invite
   Permission: users.invite
   Body: { email, role, courseIds? }
   - Check email not already in org
   - Create invitation record with 48hr expiry
   - Store token_hash (never raw token)
   - Queue invitation email job
   - Return: { invitationId, expiresAt }
   - Error: USER_ALREADY_EXISTS, INVALID_ROLE_COMBINATION
   - BLOCK: SCHOLAR + MENTOR combination in same org

5. GET /api/v1/users/:id
   Permission: users.read
   Scope by organization_id — 404 if not in org

6. PATCH /api/v1/users/:id
   Permission: users.update
   Allowed fields: name, phone, role
   Log audit entry

7. POST /api/v1/users/:id/archive
   Permission: users.archive
   Set archived_at = now()
   Cannot archive yourself
   Log audit entry
   Error: CANNOT_ARCHIVE_SELF

8. GET /api/v1/users/me/profile
   Any authenticated user
   Return own profile

9. PATCH /api/v1/users/me/profile
   Any authenticated user
   Update own name, phone, profile photo URL

10. POST /api/v1/users/bulk-import
    Permission: users.invite
    Body: multipart CSV file
    - Parse CSV (email, name, role columns)
    - Validate all rows before processing any
    - Return 202 Accepted + jobId for large imports (>50 rows)
    - Return 200 with results for small imports
    - Queue bulk-invitation-dispatch job

After implementation:
- Use the tester agent for:
  - Tenant isolation test: user from org A cannot read org B users
  - Weight validation test: 0.60 + 0.30 = 0.90 must fail
  - Role combination test: SCHOLAR + MENTOR must be blocked
- Run npx tsc --noEmit — zero errors
- Update PROGRESS.md
- Commit and push
```

---

## Phase 3 — Programs & Courses

**Depends on:** Phase 2
**Agents:** `api-builder`, `tester`

**Endpoints:**
- `GET/POST /api/v1/programs`
- `GET/PATCH /api/v1/programs/:id`
- `POST /api/v1/programs/:id/archive`
- `GET/POST /api/v1/programs/:id/members`
- `GET/POST /api/v1/courses`
- `GET/PATCH /api/v1/courses/:id`
- `POST /api/v1/courses/:id/archive`
- `GET/POST /api/v1/courses/:id/members`
- `DELETE /api/v1/courses/:id/members/:userId`

**Prompt:**
```
Use the api-builder agent to implement Programs and Courses modules.

Programs:
1. GET /api/v1/programs?page=&limit=&archived=
   Permission: programs.read
   Scope by organization_id
   archived=false by default (archived_at IS NULL)

2. POST /api/v1/programs
   Permission: programs.create
   Body: { name, description, startDate, endDate }
   Log audit entry

3. GET /api/v1/programs/:id
   Permission: programs.read
   Include: course count, member count, progress summary

4. PATCH /api/v1/programs/:id
   Permission: programs.update
   Log audit entry

5. POST /api/v1/programs/:id/archive
   Permission: programs.archive
   Set archived_at = now()
   Show confirmation: historical data is preserved
   Log audit entry
   Error: PROGRAM_ALREADY_ARCHIVED

6. GET /api/v1/programs/:id/members
   Permission: programs.read
   Return scholar + mentor members

7. POST /api/v1/programs/:id/members
   Permission: programs.manage_members
   Body: { userId, membershipType }

Courses (same pattern):
8-14. Mirror the program endpoints for courses
   Additional: DELETE /api/v1/courses/:id/members/:userId
   - Cannot remove a scholar who has active assignments
   - Error: SCHOLAR_HAS_ACTIVE_ASSIGNMENTS

After:
- tester agent: tenant isolation for programs and courses
- npx tsc --noEmit
- Update PROGRESS.md, commit, push
```

---

## Phase 4 — Mentor Pairing

**Depends on:** Phase 3
**Agents:** `api-builder`, `tester`

**Endpoints:**
- `GET /api/v1/mentor-assignments`
- `POST /api/v1/mentor-assignments`
- `PATCH /api/v1/mentor-assignments/:id`
- `DELETE /api/v1/mentor-assignments/:id`

**Prompt:**
```
Use the api-builder agent to implement the Mentor Pairing module.

1. GET /api/v1/mentor-assignments
   Permission: mentor_assignments.read
   For SUPER_ADMIN: all pairings in org
   For MENTOR: only their own assignments
   For SCHOLAR: their own mentor assignment
   Scope: organization_id always

2. POST /api/v1/mentor-assignments (pair)
   Permission: mentor_assignments.create
   Body: { mentorId, scholarIds[], courseId }
   - Validate mentor has MENTOR role in org
   - Validate scholars have SCHOLAR role in org
   - Validate all are members of the course
   - Check scholars don't already have an active mentor in this course
   - Use a DB transaction: create all pairings atomically
   - Queue notification to mentor and each scholar
   - Log audit entry per pairing
   - Error: SCHOLAR_ALREADY_PAIRED, INVALID_ROLE

3. PATCH /api/v1/mentor-assignments/:id (reassign)
   Permission: mentor_assignments.update
   Body: { newMentorId, reason }
   - End current assignment (set ended_at = now())
   - Create new assignment
   - Use DB transaction
   - Queue notification to old mentor, new mentor, scholar
   - Log audit entry
   - Error: ASSIGNMENT_NOT_FOUND

4. DELETE /api/v1/mentor-assignments/:id (end)
   Permission: mentor_assignments.delete
   Set ended_at = now()
   Log audit entry
   Queue notification to mentor and scholar

After:
- tester agent: scholar cannot access another scholar's pairing
- npx tsc --noEmit
- Update PROGRESS.md, commit, push
```

---

## Phase 5 — Assignments

**Depends on:** Phase 4
**Agents:** `api-builder`, `job-worker`, `tester`

**Endpoints:**
- `GET/POST /api/v1/assignments`
- `GET/PATCH /api/v1/assignments/:id`
- `POST /api/v1/assignments/:id/publish`
- `POST /api/v1/assignments/:id/submissions`
- `POST /api/v1/assignments/:id/verify`
- `POST /api/v1/assignments/:id/change-requests`
- `PATCH /api/v1/assignments/:id/change-requests/:requestId`

**Prompt:**
```
Use the api-builder agent to implement the Assignments module.
This is the most complex module — read AGENTS.md carefully.

1. GET /api/v1/assignments
   SUPER_ADMIN: all org assignments
   MENTOR: assignments they created
   SCHOLAR: assignments assigned to them (via scholar_assignments)
   Always scope by organization_id

2. POST /api/v1/assignments (create as DRAFT)
   Permission: assignments.create (MENTOR, SUPER_ADMIN)
   Body: { title, description, courseId, dueAt (required), maxScore }
   - dueAt is MANDATORY — reject if missing
   - Status: DRAFT
   - Log audit entry

3. GET /api/v1/assignments/:id
   Scholar: return their scholar_assignment record (status, submission, etc.)
   Mentor/Admin: return full assignment with submission stats

4. PATCH /api/v1/assignments/:id
   Permission: assignments.update
   Only editable when:
   - Status is DRAFT, OR
   - Status is PUBLISHED AND current time < edit_window_expires_at
   Error: ASSIGNMENT_EDIT_WINDOW_EXPIRED
   Log audit entry

5. POST /api/v1/assignments/:id/publish
   Permission: assignments.publish
   - dueAt must exist (validate again)
   - Set status: PUBLISHED
   - Set published_at: now()
   - Set edit_window_expires_at: now() + org.assignmentEditWindowMinutes
   - Create scholar_assignment rows for all course scholars
   - Use DB transaction
   - Queue assignment-reminder-24h and assignment-reminder-1h jobs
   - Queue notification to all scholars
   - Log audit entry

6. POST /api/v1/assignments/:id/submissions (scholar marks done)
   Permission: assignments.submit (SCHOLAR only)
   - Scholar can only submit their own assignment
   - Cannot submit if status is OVERDUE (allow — mark as late)
   - Set scholar_assignment status: PENDING_VERIFICATION
   - Set marked_done_at: server time (NEVER trust client time)
   - Set is_late: marked_done_at > due_at (server comparison)
   - Queue notification to assigned mentor
   - Log audit entry

7. POST /api/v1/assignments/:id/verify
   Permission: assignments.verify (MENTOR, SUPER_ADMIN)
   CRITICAL: Scholar CANNOT verify their own assignment
   Body: { scholarId, action: "VERIFY" | "REQUEST_RESUBMISSION", feedback? }
   For VERIFY:
   - Set status: VERIFIED or VERIFIED_LATE (based on is_late)
   - Calculate earned_credit: is_late ? 100 - penalty : 100
   - Trigger progress recalculation (queue analytics-refresh job)
   - Log audit entry
   For REQUEST_RESUBMISSION:
   - Set status: RESUBMISSION_REQUIRED
   - Queue notification to scholar with feedback
   - Log audit entry

8. POST /api/v1/assignments/:id/change-requests
   Permission: assignments.request_change (MENTOR)
   Only after edit_window_expires_at has passed
   Body: { field, currentValue, requestedValue, reason }
   Status: PENDING
   Queue notification to SUPER_ADMIN
   Log audit entry

9. PATCH /api/v1/assignments/:id/change-requests/:requestId
   Permission: assignments.approve_change (SUPER_ADMIN only)
   Body: { action: "APPROVE" | "REJECT", adminNote? }
   For APPROVE:
   - Apply the change in a DB transaction
   - Mark change_request as APPROVED
   - Queue notification to mentor
   - Log audit entry
   For REJECT:
   - Mark change_request as REJECTED
   - Queue notification to mentor

Then use the job-worker agent to implement:
- assignment-reminder-24h processor
  Guard: skip if assignment already VERIFIED
- assignment-reminder-1h processor
  Guard: skip if assignment already VERIFIED
- overdue-check processor (cron: every hour)
  Find all scholar_assignments where:
  due_at < now() AND status IN (NOT_STARTED, IN_PROGRESS)
  Bulk update to OVERDUE

Then use the tester agent for:
- Scholar cannot verify own assignment (release-blocking)
- Tenant isolation: mentor cannot verify assignments from other orgs
- Edit window enforcement
- Late calculation uses server time not client
- npx tsc --noEmit
- Update PROGRESS.md, commit, push
```

---

## Phase 6 — Meetings & Attendance

**Depends on:** Phase 4
**Agents:** `api-builder`, `tester`

**Endpoints:**
- `GET/POST /api/v1/meetings`
- `GET/PATCH /api/v1/meetings/:id`
- `POST /api/v1/meetings/:id/archive`
- `POST /api/v1/meetings/:id/attendance`
- `PATCH /api/v1/meetings/:id/attendance/:scholarId`
- `GET /api/v1/meetings/:id/attendance/history`

**Prompt:**
```
Use the api-builder agent to implement Meetings and Attendance.

1. GET /api/v1/meetings?courseId=&page=&limit=
   SUPER_ADMIN: all org meetings
   MENTOR: meetings for their courses
   SCHOLAR: meetings for their enrolled courses
   Scope by organization_id

2. POST /api/v1/meetings
   Permission: meetings.create (MENTOR, SUPER_ADMIN)
   Body: { title, courseId, scheduledAt, durationMinutes, type }
   Log audit entry

3. GET/PATCH /api/v1/meetings/:id
   Standard CRUD. Log audit on PATCH.

4. POST /api/v1/meetings/:id/archive
   Permission: meetings.archive
   Log audit entry

5. POST /api/v1/meetings/:id/attendance (bulk record)
   Permission: attendance.create (MENTOR, SUPER_ADMIN)
   Body: { records: [{ scholarId, status: PRESENT|ABSENT|EXCUSED }] }
   - Validate all scholars are members of the meeting's course
   - Upsert attendance_records (allow re-recording)
   - Use DB transaction
   - Queue analytics-refresh job for affected scholars
   - Log audit entry per change
   - Queue notification to scholars marked ABSENT

6. PATCH /api/v1/meetings/:id/attendance/:scholarId (correction)
   Permission: attendance.correct (SUPER_ADMIN only)
   Body: { status, correctionReason }
   - Store previous status in audit log
   - Update attendance_record
   - Queue analytics-refresh job
   - Log audit entry with: who changed, from what, to what, reason

7. GET /api/v1/meetings/:id/attendance/history
   Permission: attendance.read
   Return all corrections with actor, timestamp, before/after

Attendance Rate Calculation (in AnalyticsService):
attendance_rate = present_count / (present_count + absent_count) * 100
EXCUSED sessions are excluded from both numerator and denominator
Return null when no applicable sessions exist — never divide by zero

After:
- tester agent: excused exclusion test (8 present, 1 absent, 1 excused = 88.9%)
- Tenant isolation: mentor cannot record attendance for other org meetings
- npx tsc --noEmit
- Update PROGRESS.md, commit, push
```

---

## Phase 7 — Resources

**Depends on:** Phase 1
**Agents:** `api-builder`, `tester`

**Endpoints:**
- `POST /api/v1/resources/upload-url`
- `POST /api/v1/resources`
- `GET /api/v1/resources`
- `GET /api/v1/resources/:id`
- `DELETE /api/v1/resources/:id`

**Prompt:**
```
Use the api-builder agent to implement the Resources module.
File uploads go directly to Cloudflare R2 — never proxied through the API.

Upload flow:
1. POST /api/v1/resources/upload-url
   Permission: resources.upload (MENTOR, SUPER_ADMIN)
   Body: { fileName, mimeType, fileSize, courseId? }
   Validate:
   - fileSize <= 20MB (20 * 1024 * 1024 bytes)
     Error: FILE_TOO_LARGE
   - mimeType is in allowed list (PDF, DOCX, PPTX, XLSX, PNG, JPG, MP4, etc.)
   - Extension matches mimeType
     Error: INVALID_FILE_TYPE
   Generate:
   - objectKey: {organizationId}/{uuid}.{extension}
     (never use original filename as storage key)
   - Signed PUT URL for R2 (15min expiry)
   Return: { uploadUrl, objectKey, expiresAt }

2. POST /api/v1/resources (create record after upload)
   Permission: resources.create
   Body: { objectKey, originalName, mimeType, fileSize, courseId?, description? }
   - Verify objectKey matches expected pattern for this org
   - Create resource record
   - Log audit entry

3. GET /api/v1/resources?courseId=&page=&limit=
   SUPER_ADMIN: all org resources
   MENTOR: resources for their courses
   SCHOLAR: resources for their enrolled courses only
   Always scope by organization_id

4. GET /api/v1/resources/:id
   Return resource + generate signed GET URL (1hr expiry) for download

5. DELETE /api/v1/resources/:id
   Permission: resources.delete
   Soft delete: set archived_at
   Also delete from R2 (fire and forget — don't fail if R2 delete fails)
   Log audit entry

R2 client setup (use @aws-sdk/client-s3 with R2 endpoint):
- endpoint: https://{CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com
- credentials: CLOUDFLARE_R2_ACCESS_KEY + CLOUDFLARE_R2_SECRET_KEY
- region: "auto"

After:
- tester agent: scholar cannot access resources from courses they're not in
- File size validation test
- npx tsc --noEmit
- Update PROGRESS.md, commit, push
```

---

## Phase 8 — Notifications & WebSocket

**Depends on:** Phase 1
**Agents:** `api-builder`, `job-worker`, `tester`

**Endpoints:**
- `GET /api/v1/notifications`
- `PATCH /api/v1/notifications/:id/read`
- `POST /api/v1/notifications/read-all`

**Prompt:**
```
Use the api-builder agent to implement Notifications module
and the WebSocket gateway.

Notification Service (used internally by all other modules):
Create NotificationsService.create() that:
- Inserts into notifications table
- Emits WebSocket event to user:{userId} room
- Queues email job via email queue (if channel includes EMAIL)
Never call this inline in a transaction — always after commit.

WebSocket Gateway (NestJS @WebSocketGateway):
- Path: /ws
- Authenticate on connection: validate Bearer token from handshake
- On auth success: server joins socket to room user:{userId}
- On SUPER_ADMIN: also join organization:{organizationId}:admins room
- NEVER let client join rooms themselves
Events to emit:
- notification.created → { id, type, title, body, createdAt }
- assignment.status_changed → { assignmentId, scholarId, newStatus }
- analytics.course.updated → { scope: "COURSE", courseId }
- analytics.dashboard.updated → { scope: "ORG" }

API Endpoints:
1. GET /api/v1/notifications?read=&page=&limit=
   Scope to authenticated user only
   Never return other users' notifications

2. PATCH /api/v1/notifications/:id/read
   User can only mark their own notifications as read
   Error: NOTIFICATION_NOT_FOUND

3. POST /api/v1/notifications/read-all
   Mark all unread for current user as read

Then use the job-worker agent to implement:
- email-dispatch processor
  Read job data: { to, subject, templateId, variables }
  Send via Resend API
  Update notification_deliveries: status SENT or FAILED
  Retry up to 3 times with exponential backoff
  Guard: check delivery status before resending

After:
- tester agent: user cannot read another user's notifications
- npx tsc --noEmit
- Update PROGRESS.md, commit, push
```

---

## Phase 9 — Analytics & Reports

**Depends on:** Phases 5, 6
**Agents:** `api-builder`, `job-worker`, `tester`

**Endpoints:**
- `GET /api/v1/analytics/dashboard`
- `GET /api/v1/analytics/scholars/:id/progress`
- `GET /api/v1/analytics/courses/:id`
- `POST /api/v1/reports`
- `GET /api/v1/reports/:id`
- `GET /api/v1/reports/:id/download`

**Prompt:**
```
Use the api-builder agent to implement Analytics and Reports.

Progress Calculation (core formula — implement in AnalyticsService):

assignment_score = sum(earned_credit for VERIFIED/VERIFIED_LATE) 
                   / count(total assignments) * 100

attendance_rate = present_count / (present_count + absent_count) * 100
                  (EXCUSED excluded from both numerator and denominator)

overall_progress = (assignment_score * org.assignmentWeight) 
                 + (attendance_rate * org.attendanceWeight)

is_at_risk = attendance_rate < org.atRiskAttendanceThreshold
          OR assignment_score < org.atRiskAssignmentThreshold
          OR overdue_count >= org.atRiskOverdueThreshold

Return null for any metric when insufficient data exists.
Never divide by zero.
Recalculate when: assignment verified, attendance recorded/corrected,
org settings changed.

Endpoints:
1. GET /api/v1/analytics/dashboard
   SUPER_ADMIN: org-wide metrics
   - total scholars, active scholars, at-risk count
   - avg program progress %, avg attendance %
   - assignments: pending verification count, overdue count
   - recent activity (last 10 audit events)
   MENTOR: their scholars' metrics
   SCHOLAR: their own metrics only

2. GET /api/v1/analytics/scholars/:id/progress
   SUPER_ADMIN/MENTOR: any scholar in org
   SCHOLAR: own progress only — cannot access peer progress
   Return: assignment_score, attendance_rate, overall_progress,
   is_at_risk, overdue_count, per-course breakdown

3. GET /api/v1/analytics/courses/:id
   Permission: analytics.read
   Return: course-level metrics, member progress list,
   at-risk scholars, assignment completion rates

Reports:
4. POST /api/v1/reports
   Permission: reports.generate (SUPER_ADMIN)
   Body: { type, filters, format: "csv"|"xlsx" }
   For small datasets (<1000 rows): return 200 + data
   For large: return 202 Accepted + { reportId, status: "PENDING" }
   Queue report-generator job

5. GET /api/v1/reports/:id (poll status)
   Return: { id, status, createdAt, completedAt?, expiresAt? }

6. GET /api/v1/reports/:id/download
   Status must be COMPLETED
   Generate signed R2 URL for download
   Error: REPORT_NOT_READY, REPORT_EXPIRED

Then use the job-worker agent to implement:
- report-generator processor
  Generate CSV/XLSX from DB query
  Upload to R2
  Update report_exports: status COMPLETED + r2_key
  Queue notification to requesting admin

- analytics-refresh processor
  Body: { scope: "SCHOLAR"|"COURSE"|"ORG", entityId }
  Recalculate and cache progress metrics
  Emit WebSocket event after recalculation

After:
- tester agent: scholar cannot access peer progress
- Progress formula unit tests
- npx tsc --noEmit
- Update PROGRESS.md, commit, push
```

---

## Phase 10 — Audit Log

**Depends on:** All phases (audit entries added throughout)
**Agents:** `api-builder`, `tester`

**Endpoints:**
- `GET /api/v1/audit-logs`

**Prompt:**
```
Use the api-builder agent to implement the Audit Log endpoint.

GET /api/v1/audit-logs
Permission: audit.read (SUPER_ADMIN only)
Filters: entityType, entityId, actorUserId, eventType, 
         dateFrom, dateTo, page, limit
Sort: created_at DESC always

Response per entry:
{
  id, organizationId, actorUserId, actorName,
  eventType, entityType, entityId,
  previousState, newState, metadata,
  ipAddress, createdAt
}

Rules:
- Append-only: no edit or delete endpoints exist
- Sensitive values must never appear (password_hash, token_hash)
- Scope strictly to organization_id from session
- SUPER_ADMIN only — 403 for MENTOR and SCHOLAR

Confirm AuditService.log() is being called correctly in:
- Auth module (login, password reset, registration)
- User management (invite, archive, role change)
- Programs and courses (create, update, archive)
- Assignments (create, publish, verify, change request)
- Attendance (record, correction)
- Organization settings (update)

After:
- tester agent: mentor cannot access audit logs (403)
- npx tsc --noEmit
- Update PROGRESS.md, commit, push
```

---

## Phase 11 — Invitation Management

**Depends on:** Phase 2
**Agents:** `api-builder`, `job-worker`, `tester`

**Endpoints:**
- `GET /api/v1/invitations`
- `POST /api/v1/invitations/:id/resend`
- `DELETE /api/v1/invitations/:id`

**Prompt:**
```
Use the api-builder agent to implement Invitation Management.

1. GET /api/v1/invitations?status=pending|expired|used&page=&limit=
   Permission: invitations.read (SUPER_ADMIN)
   Scope by organization_id
   Status derived from: used_at (used), expires_at < now (expired), else pending

2. POST /api/v1/invitations/:id/resend
   Permission: invitations.resend (SUPER_ADMIN)
   - Generate new token (invalidate old one)
   - Reset expires_at to now() + 48hrs
   - Queue invitation email job
   - Log audit entry
   - Error: INVITATION_ALREADY_USED

3. DELETE /api/v1/invitations/:id (revoke)
   Permission: invitations.revoke (SUPER_ADMIN)
   - Set expires_at = now() (immediately expire)
   - Log audit entry
   - Error: INVITATION_ALREADY_USED

Then use the job-worker agent to implement:
- invitation-reminder-1 processor
  Fires 24h after invite sent
  Guard: skip if invitation already used or already expired
  Queue email job

- invitation-reminder-2 processor
  Fires ~4h before expiry
  Guard: skip if already used
  Queue email job

After:
- npx tsc --noEmit
- Update PROGRESS.md, commit, push
```

---

## Phase 12 — Security Hardening & Tenant Isolation Tests

**Depends on:** All phases
**Agents:** `tester`

**Prompt:**
```
Use the tester agent to write the complete tenant isolation 
test suite in test/tenant-isolation.e2e-spec.ts.

These are release-blocking. Every test must FAIL (return 403 or 404)
for the unauthorized request:

Setup: Create two orgs (org A, org B) each with:
- 1 admin, 1 mentor, 1 scholar
- 1 program, 1 course, 1 assignment, 1 meeting

Tests:
1. Org A admin CANNOT read org B programs
   GET /programs/{orgBProgramId} with org A token → 404

2. Org A mentor CANNOT see org B scholars
   GET /users/{orgBScholarId} with org A mentor token → 404

3. Scholar CANNOT verify their own assignment
   POST /assignments/{id}/verify with scholar token → 403

4. Scholar CANNOT read peer progress
   GET /analytics/scholars/{peerScholarId}/progress → 403

5. Mentor CANNOT access scholars outside their courses
   GET /analytics/scholars/{unassignedScholarId}/progress → 403

6. Client-supplied organizationId is ignored
   POST /programs with body { organizationId: orgBId, name: "Test" }
   using org A token → creates in org A (not org B)

7. Mentor CANNOT bypass 60-minute assignment edit lock
   PATCH /assignments/{id} after edit_window_expires_at → 409

8. Non-admin CANNOT read audit logs
   GET /audit-logs with mentor token → 403
   GET /audit-logs with scholar token → 403

9. Scholar CANNOT access resources from other courses
   GET /resources/{resourceFromOtherCourse} with scholar token → 403

10. Mentor CANNOT record attendance for meetings outside their courses
    POST /meetings/{otherMeetingId}/attendance with mentor token → 403

All 10 must pass before any production deploy.
Run npm run test:e2e after.
Update PROGRESS.md, commit, push.
```

---

## Build Order Summary

| Phase | Module | Agent(s) | Blocks |
|---|---|---|---|
| 0 | Foundation | — | ✅ Done |
| 1 | Auth & Security | api-builder, tester | Everything |
| 2 | Org & Users | api-builder, tester | Phase 3, 4 |
| 3 | Programs & Courses | api-builder, tester | Phase 4, 5 |
| 4 | Mentor Pairing | api-builder, tester | Phase 5, 6 |
| 5 | Assignments | api-builder, job-worker, tester | Phase 9 |
| 6 | Meetings & Attendance | api-builder, tester | Phase 9 |
| 7 | Resources | api-builder, tester | — |
| 8 | Notifications & WebSocket | api-builder, job-worker, tester | — |
| 9 | Analytics & Reports | api-builder, job-worker, tester | — |
| 10 | Audit Log | api-builder, tester | — |
| 11 | Invitations | api-builder, job-worker, tester | — |
| 12 | Security & Tenant Tests | tester | **Release gate** |

## Rule Per Phase

Every phase must complete in this order:
1. Run prompt in OpenCode with the specified agent
2. `npx tsc --noEmit` — zero errors
3. `npm run test` — all green
4. Update `PROGRESS.md`
5. Commit and push to feature branch
6. Raise PR → review → merge to main
7. Render auto-deploys
8. Verify `GET /api/v1/health` returns ok after deploy

import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import request from 'supertest';
import * as argon2 from 'argon2';
import { PrismaClient, Role, AssignmentStatus } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter.js';
import { TransformInterceptor } from '../src/common/interceptors/transform.interceptor.js';

// ---------------------------------------------------------------------------
// RELEASE-BLOCKING TENANT ISOLATION SUITE
// ---------------------------------------------------------------------------
// Every cross-tenant / out-of-course request below MUST be denied (403/404).
// These tests are part of the release gate and must never be weakened.
//
// Seed topology:
//   Org A: adminA, mentorA, scholarA, peerA (SCHOLAR)
//          programA -> courseA1 (scholarA enrolled, mentorA paired)
//                    -> courseA2 (peerA enrolled, NO mentor pairing)
//          assignmentA1  (PUBLISHED, edit window EXPIRED)   [courseA1]
//          meetingA1, resourceA1                            [courseA1]
//          meetingA2, resourceA2                            [courseA2]
//   Org B: adminB, mentorB, scholarB
//          programB -> courseB1
//          assignmentB1, meetingB1, resourceB1              [courseB1]
// ---------------------------------------------------------------------------

const PASSWORD = 'TenantPass123!';

// Org / domain IDs (fixed valid UUIDs so fixtures are deterministic)
const ORG_A = '10000000-0000-4000-8000-000000000001';
const ORG_B = '20000000-0000-4000-8000-000000000001';
const PROGRAM_A = '30000000-0000-4000-8000-000000000001';
const PROGRAM_B = '30000000-0000-4000-8000-000000000002';
const COURSE_A1 = '40000000-0000-4000-8000-000000000001';
const COURSE_A2 = '40000000-0000-4000-8000-000000000002';
const COURSE_B1 = '40000000-0000-4000-8000-000000000003';
const ASSIGNMENT_A1 = '50000000-0000-4000-8000-000000000001';
const ASSIGNMENT_B1 = '50000000-0000-4000-8000-000000000002';
const MEETING_A1 = '60000000-0000-4000-8000-000000000001';
const MEETING_A2 = '60000000-0000-4000-8000-000000000002';
const MEETING_B1 = '60000000-0000-4000-8000-000000000003';
const RESOURCE_A1 = '70000000-0000-4000-8000-000000000001';
const RESOURCE_A2 = '70000000-0000-4000-8000-000000000002';
const RESOURCE_B1 = '70000000-0000-4000-8000-000000000003';

// User IDs
const ADMIN_A = '80000000-0000-4000-8000-000000000001';
const MENTOR_A = '80000000-0000-4000-8000-000000000002';
const SCHOLAR_A = '80000000-0000-4000-8000-000000000003';
const PEER_A = '80000000-0000-4000-8000-000000000004';
const ADMIN_B = '90000000-0000-4000-8000-000000000001';
const MENTOR_B = '90000000-0000-4000-8000-000000000002';
const SCHOLAR_B = '90000000-0000-4000-8000-000000000003';

const ALL_TABLES = [
  'organizations',
  'organization_settings',
  'users',
  'user_roles',
  'programs',
  'program_memberships',
  'courses',
  'course_memberships',
  'mentor_scholar_assignments',
  'resources',
  'assignment_resources',
  'assignments',
  'scholar_assignments',
  'assignment_change_requests',
  'meetings',
  'attendance_records',
  'notifications',
  'notification_deliveries',
  'report_exports',
  'audit_logs',
  'invitations',
  'refresh_tokens',
  'password_reset_tokens',
];

describe('Tenant Isolation (release-blocking)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let tokenAdminA: string;
  let tokenMentorA: string;
  let tokenScholarA: string;

  beforeAll(async () => {
    prisma = new PrismaClient();

    // Idempotent: wipe tenant tables so this suite can be re-run safely.
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
    );

    const passwordHash = await argon2.hash(PASSWORD);

    // --- Organizations -----------------------------------------------------
    await prisma.organization.createMany({
      data: [
        { id: ORG_A, name: 'Org A', slug: 'org-a' },
        { id: ORG_B, name: 'Org B', slug: 'org-b' },
      ],
    });

    // --- Users (shared users table, orgs linked via user_roles) ------------
    await prisma.user.createMany({
      data: [
        { id: ADMIN_A, email: 'admin-a@example.com', name: 'Admin A', password_hash: passwordHash },
        { id: MENTOR_A, email: 'mentor-a@example.com', name: 'Mentor A', password_hash: passwordHash },
        { id: SCHOLAR_A, email: 'scholar-a@example.com', name: 'Scholar A', password_hash: passwordHash },
        { id: PEER_A, email: 'peer-a@example.com', name: 'Peer A', password_hash: passwordHash },
        { id: ADMIN_B, email: 'admin-b@example.com', name: 'Admin B', password_hash: passwordHash },
        { id: MENTOR_B, email: 'mentor-b@example.com', name: 'Mentor B', password_hash: passwordHash },
        { id: SCHOLAR_B, email: 'scholar-b@example.com', name: 'Scholar B', password_hash: passwordHash },
      ],
    });

    // --- Roles --------------------------------------------------------------
    await prisma.userRole.createMany({
      data: [
        { organization_id: ORG_A, user_id: ADMIN_A, role: Role.SUPER_ADMIN },
        { organization_id: ORG_A, user_id: MENTOR_A, role: Role.MENTOR },
        { organization_id: ORG_A, user_id: SCHOLAR_A, role: Role.SCHOLAR },
        { organization_id: ORG_A, user_id: PEER_A, role: Role.SCHOLAR },
        { organization_id: ORG_B, user_id: ADMIN_B, role: Role.SUPER_ADMIN },
        { organization_id: ORG_B, user_id: MENTOR_B, role: Role.MENTOR },
        { organization_id: ORG_B, user_id: SCHOLAR_B, role: Role.SCHOLAR },
      ],
    });

    // --- Programs / Courses --------------------------------------------------
    await prisma.program.createMany({
      data: [
        { id: PROGRAM_A, organization_id: ORG_A, name: 'Program A' },
        { id: PROGRAM_B, organization_id: ORG_B, name: 'Program B' },
      ],
    });

    await prisma.course.createMany({
      data: [
        { id: COURSE_A1, organization_id: ORG_A, program_id: PROGRAM_A, name: 'Course A1' },
        { id: COURSE_A2, organization_id: ORG_A, program_id: PROGRAM_A, name: 'Course A2' },
        { id: COURSE_B1, organization_id: ORG_B, program_id: PROGRAM_B, name: 'Course B1' },
      ],
    });

    // --- Memberships + pairing ----------------------------------------------
    await prisma.courseMembership.createMany({
      data: [
        { organization_id: ORG_A, course_id: COURSE_A1, user_id: SCHOLAR_A },
        { organization_id: ORG_A, course_id: COURSE_A2, user_id: PEER_A },
      ],
    });

    // mentorA is paired ONLY to scholarA on courseA1 (never courseA2, never peerA)
    await prisma.mentorScholarAssignment.create({
      data: {
        organization_id: ORG_A,
        program_id: PROGRAM_A,
        course_id: COURSE_A1,
        mentor_id: MENTOR_A,
        scholar_id: SCHOLAR_A,
        ends_at: null,
      },
    });

    // --- Assignments ----------------------------------------------------------
    // assignmentA1: PUBLISHED with an EXPIRED edit window (PATCH must 409)
    await prisma.assignment.createMany({
      data: [
        {
          id: ASSIGNMENT_A1,
          organization_id: ORG_A,
          course_id: COURSE_A1,
          program_id: PROGRAM_A,
          created_by: MENTOR_A,
          title: 'Assignment A1',
          status: AssignmentStatus.PUBLISHED,
          max_score: 100,
          published_at: new Date('2026-01-10T00:00:00.000Z'),
          edit_window_expires_at: new Date('2026-01-10T01:00:00.000Z'),
        },
        {
          id: ASSIGNMENT_B1,
          organization_id: ORG_B,
          course_id: COURSE_B1,
          program_id: PROGRAM_B,
          created_by: MENTOR_B,
          title: 'Assignment B1',
          status: AssignmentStatus.PUBLISHED,
          max_score: 100,
        },
      ],
    });

    // --- Meetings --------------------------------------------------------------
    await prisma.meeting.createMany({
      data: [
        {
          id: MEETING_A1,
          organization_id: ORG_A,
          course_id: COURSE_A1,
          title: 'Meeting A1',
          starts_at: new Date('2026-12-01T10:00:00.000Z'),
        },
        {
          id: MEETING_A2,
          organization_id: ORG_A,
          course_id: COURSE_A2,
          title: 'Meeting A2',
          starts_at: new Date('2026-12-02T10:00:00.000Z'),
        },
        {
          id: MEETING_B1,
          organization_id: ORG_B,
          course_id: COURSE_B1,
          title: 'Meeting B1',
          starts_at: new Date('2026-12-03T10:00:00.000Z'),
        },
      ],
    });

    // --- Resources ---------------------------------------------------------------
    await prisma.resource.createMany({
      data: [
        { id: RESOURCE_A1, organization_id: ORG_A, course_id: COURSE_A1, object_key: 'a1.pdf', file_name: 'a1.pdf', mime_type: 'application/pdf', size_bytes: 100, uploader_id: ADMIN_A },
        { id: RESOURCE_A2, organization_id: ORG_A, course_id: COURSE_A2, object_key: 'a2.pdf', file_name: 'a2.pdf', mime_type: 'application/pdf', size_bytes: 100, uploader_id: ADMIN_A },
        { id: RESOURCE_B1, organization_id: ORG_B, course_id: COURSE_B1, object_key: 'b1.pdf', file_name: 'b1.pdf', mime_type: 'application/pdf', size_bytes: 100, uploader_id: ADMIN_B },
      ],
    });

    // --- Boot the real app ---------------------------------------------------------
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();

    // --- Authenticate via the real login endpoint ----------------------------------
    const login = async (email: string): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      return res.body.data.accessToken as string;
    };

    tokenAdminA = await login('admin-a@example.com');
    tokenMentorA = await login('mentor-a@example.com');
    tokenScholarA = await login('scholar-a@example.com');
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  // =========================================================================
  // 1. Cross-org program read
  // =========================================================================
  it('ORG A admin cannot read ORG B program (404 PROGRAM_NOT_FOUND)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/programs/${PROGRAM_B}`)
      .set(auth(tokenAdminA));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROGRAM_NOT_FOUND');
  });

  // =========================================================================
  // 2. Cross-org user read
  // =========================================================================
  it('ORG A mentor cannot read ORG B user (403 INSUFFICIENT_PERMISSIONS)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/users/${SCHOLAR_B}`)
      .set(auth(tokenMentorA));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('ORG A admin cannot read ORG B user (404 USER_NOT_FOUND — org-scoped)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/users/${SCHOLAR_B}`)
      .set(auth(tokenAdminA));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  // =========================================================================
  // 3. Scholar cannot verify assignments
  // =========================================================================
  it('SCHOLAR cannot verify an assignment (403 INSUFFICIENT_PERMISSIONS)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/assignments/${ASSIGNMENT_A1}/verify`)
      .set(auth(tokenScholarA))
      .send({ scholarId: SCHOLAR_A, action: 'VERIFY' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('cannot verify own assignment even with a privileged role (403 CANNOT_VERIFY_SELF)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/assignments/${ASSIGNMENT_A1}/verify`)
      .set(auth(tokenMentorA))
      .send({ scholarId: MENTOR_A, action: 'VERIFY' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_VERIFY_SELF');
  });

  // =========================================================================
  // 4. Scholar peer progress — same-org peer denied
  // =========================================================================
  it('SCHOLAR cannot read peer scholar progress in the SAME org (403 FORBIDDEN)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/analytics/scholars/${PEER_A}/progress`)
      .set(auth(tokenScholarA));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('SCHOLAR cannot read cross-org scholar progress (404 SCHOLAR_NOT_FOUND — no existence leak)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/analytics/scholars/${SCHOLAR_B}/progress`)
      .set(auth(tokenScholarA));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SCHOLAR_NOT_FOUND');
  });

  // =========================================================================
  // 5. Mentor cannot access scholars outside their pairings
  // =========================================================================
  it('MENTOR cannot read an unpaired scholar progress (403 FORBIDDEN)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/analytics/scholars/${PEER_A}/progress`)
      .set(auth(tokenMentorA));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  // =========================================================================
  // 6. Client-supplied organizationId is never trusted
  // =========================================================================
  it('POST /programs rejects a forged organizationId in the body (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/programs')
      .set(auth(tokenAdminA))
      .send({ organizationId: ORG_B, name: 'Sneaky Program' });

    expect(res.status).toBe(400);
  });

  it('POST /programs creates in the SESSION org when organizationId is omitted (201)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/programs')
      .set(auth(tokenAdminA))
      .send({ name: 'Session Org Program' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const created = await prisma.program.findFirst({
      where: { organization_id: ORG_A, name: 'Session Org Program' },
      select: { organization_id: true },
    });
    // The tenant is ALWAYS taken from the session — never from the client.
    expect(created?.organization_id).toBe(ORG_A);

    // And it is NOT visible to ORG B.
    const crossOrg = await prisma.program.findFirst({
      where: { organization_id: ORG_B, name: 'Session Org Program' },
    });
    expect(crossOrg).toBeNull();
  });

  // =========================================================================
  // 7. Edit window enforcement
  // =========================================================================
  it('MENTOR cannot PATCH an assignment after the edit window expires (409 ASSIGNMENT_EDIT_WINDOW_EXPIRED)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/assignments/${ASSIGNMENT_A1}`)
      .set(auth(tokenMentorA))
      .send({ title: 'Too late to change' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ASSIGNMENT_EDIT_WINDOW_EXPIRED');
  });

  // =========================================================================
  // 8. Audit logs are SUPER_ADMIN only
  // =========================================================================
  it('MENTOR cannot read audit logs (403 INSUFFICIENT_PERMISSIONS)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/audit-logs')
      .set(auth(tokenMentorA));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('SCHOLAR cannot read audit logs (403 INSUFFICIENT_PERMISSIONS)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/audit-logs')
      .set(auth(tokenScholarA));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  // =========================================================================
  // 9. Resources are course-scoped
  // =========================================================================
  it('SCHOLAR cannot read a resource from a course they are not enrolled in (404 RESOURCE_NOT_FOUND)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/resources/${RESOURCE_A2}`)
      .set(auth(tokenScholarA));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  // =========================================================================
  // 10. Attendance is mentor-course-scoped (SUPER_ADMIN exempt)
  // =========================================================================
  it('MENTOR cannot record attendance for a meeting outside their assigned courses (403 FORBIDDEN)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/meetings/${MEETING_A2}/attendance`)
      .set(auth(tokenMentorA))
      .send({ records: [{ scholarId: PEER_A, status: 'PRESENT' }] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('SUPER_ADMIN CAN record attendance on the same meeting (201 — exemption baseline)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/meetings/${MEETING_A2}/attendance`)
      .set(auth(tokenAdminA))
      .send({ records: [{ scholarId: PEER_A, status: 'PRESENT' }] });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.records[0]).toEqual(
      expect.objectContaining({ scholarId: PEER_A, status: 'PRESENT', isNew: true }),
    );
  });

  // Cross-org sanity: ORG A mentor cannot even see ORG B meetings (404)
  it('ORG A MENTOR cannot access an ORG B meeting (404 MEETING_NOT_FOUND)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/meetings/${MEETING_B1}/attendance`)
      .set(auth(tokenMentorA))
      .send({ records: [{ scholarId: SCHOLAR_B, status: 'PRESENT' }] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MEETING_NOT_FOUND');
  });
});
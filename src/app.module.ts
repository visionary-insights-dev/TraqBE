import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UserManagementModule } from './modules/users/users.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { ProgramsModule } from './modules/programs/programs.module.js';
import { CoursesModule } from './modules/courses/courses.module.js';
import { MembershipsModule } from './modules/memberships/memberships.module.js';
import { RolesModule } from './modules/roles/roles.module.js';
import { PermissionsModule } from './modules/permissions/permissions.module.js';
import { MentorPairingModule } from './modules/mentor-pairing/mentor-pairing.module.js';
import { ResourcesModule } from './modules/resources/resources.module.js';
import { AssignmentsModule } from './modules/assignments/assignments.module.js';
import { AssignmentSubmissionsModule } from './modules/assignment-submissions/assignment-submissions.module.js';
import { MeetingsModule } from './modules/meetings/meetings.module.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { UploadsModule } from './modules/uploads/uploads.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    BullModule.forRoot({
      redis: process.env.REDIS_URL ?? {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      },
    }),
    PrismaModule,
    AuthModule,
    UserManagementModule,
    OrganizationsModule,
    ProgramsModule,
    CoursesModule,
    MembershipsModule,
    RolesModule,
    PermissionsModule,
    MentorPairingModule,
    ResourcesModule,
    AssignmentsModule,
    AssignmentSubmissionsModule,
    MeetingsModule,
    AttendanceModule,
    NotificationsModule,
    AnalyticsModule,
    ReportsModule,
    AuditModule,
    UploadsModule,
    JobsModule,
    HealthModule,
  ],
})
export class AppModule {}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import type { Response } from 'express';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EMAIL_QUEUE } from '../../jobs/queues/email.queue.js';
import type { EmailDispatchJobData } from '../../jobs/queues/email.queue.js';
import { RegisterDto } from './dto/register.dto.js';

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------
const ERR = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_ARCHIVED: 'ACCOUNT_ARCHIVED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  RESET_TOKEN_INVALID: 'RESET_TOKEN_INVALID',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  INVITATION_NOT_FOUND: 'INVITATION_NOT_FOUND',
  INVITATION_ALREADY_USED: 'INVITATION_ALREADY_USED',
  REFRESH_TOKEN_REVOKED: 'REFRESH_TOKEN_REVOKED',
};

const ACCESS_TOKEN_EXPIRY = 900; // 15 minutes in seconds
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OTP_LIFE_MS = 10 * 60 * 1000; // 10 minutes
const RESET_TOKEN_EXPIRY = '10m';
const INVITATION_LIFE_MS = 48 * 60 * 60 * 1000; // 48 hours

export const REFRESH_COOKIE_NAME = 'refresh_token';

interface TokenUser {
  id: string;
  email: string;
  role: string;
  organizationId: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue<EmailDispatchJobData>,
  ) {}

  // =========================================================================
  // LOGIN
  // =========================================================================
  async login(
    email: string,
    password: string,
    response: Response,
  ): Promise<{ user: { id: string; email: string; role: string; organizationId: string; name: string }; accessToken: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // Always return the same error to avoid email enumeration
    if (!user) {
      throw new UnauthorizedException({ code: ERR.INVALID_CREDENTIALS, message: 'Invalid email or password' });
    }

    if (user.archived_at) {
      throw new ForbiddenException({ code: ERR.ACCOUNT_ARCHIVED, message: 'This account has been archived' });
    }

    const passwordValid = await argon2.verify(user.password_hash, password);
    if (!passwordValid) {
      throw new UnauthorizedException({ code: ERR.INVALID_CREDENTIALS, message: 'Invalid email or password' });
    }

    // Determine the user's role + organization from their first active UserRole.
    // MVP: single org/single role per user (SCHOLAR + MENTOR same org is blocked).
    const userRole = await this.prisma.userRole.findFirst({
      where: { user_id: user.id },
      orderBy: { created_at: 'asc' },
    });
    if (!userRole) {
      throw new ForbiddenException({ code: ERR.INVALID_CREDENTIALS, message: 'No organization membership found for this account' });
    }

    const tokenUser: TokenUser = {
      id: user.id,
      email: user.email,
      role: userRole.role,
      organizationId: userRole.organization_id,
    };

    const tokens = await this.generateTokens(tokenUser);

    this.setRefreshCookie(response, tokens.refreshToken);

    return {
      user: {
        id: user.id,
        email: user.email,
        role: userRole.role,
        organizationId: userRole.organization_id,
        name: user.name,
      },
      accessToken: tokens.accessToken,
    };
  }

  // =========================================================================
  // REFRESH
  // =========================================================================
  async refresh(refreshTokenValue: string | undefined, response: Response): Promise<{ accessToken: string }> {
    if (!refreshTokenValue) {
      throw new UnauthorizedException({ code: ERR.TOKEN_INVALID, message: 'No refresh token provided' });
    }

    let payload: { sub: string; email: string; role: string; organizationId: string };
    try {
      payload = this.jwtService.verify(refreshTokenValue, {
        secret: this.configService.get('JWT_REFRESH_SECRET') as string,
      }) as typeof payload;
    } catch (error: unknown) {
      const err = error as { name?: string };
      if (err?.name === 'TokenExpiredError') {
        throw new UnauthorizedException({ code: ERR.TOKEN_EXPIRED, message: 'Refresh token has expired' });
      }
      throw new UnauthorizedException({ code: ERR.TOKEN_INVALID, message: 'Invalid refresh token' });
    }

    const tokenHash = this.hashToken(refreshTokenValue);
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { token_hash: tokenHash },
    });

    if (!storedToken || storedToken.revoked_at) {
      throw new UnauthorizedException({ code: ERR.REFRESH_TOKEN_REVOKED, message: 'Refresh token is no longer valid' });
    }

    if (storedToken.expires_at.getTime() < Date.now()) {
      throw new UnauthorizedException({ code: ERR.TOKEN_EXPIRED, message: 'Refresh token has expired' });
    }

    // Rotate: revoke the old token, issue a new pair
    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revoked_at: new Date() },
    });

    const tokenUser: TokenUser = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      organizationId: payload.organizationId,
    };

    const tokens = await this.generateTokens(tokenUser);
    this.setRefreshCookie(response, tokens.refreshToken);

    return { accessToken: tokens.accessToken };
  }

  // =========================================================================
  // LOGOUT
  // =========================================================================
  async logout(userId: string, response: Response): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    this.clearRefreshCookie(response);
  }

  // =========================================================================
  // FORGOT PASSWORD (OTP)
  // =========================================================================
  async forgotPassword(email: string): Promise<void> {
    const normalized = email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    // Always return success regardless of whether the user exists
    if (!user) return;

    const otp = this.generateOtp();
    const otpHash = await argon2.hash(otp, { type: argon2.argon2id });

    await this.prisma.passwordResetToken.create({
      data: {
        user_id: user.id,
        otp_hash: otpHash,
        expires_at: new Date(Date.now() + OTP_LIFE_MS),
      },
    });

    // Queue email job (never send inline)
    await this.emailQueue.add({
      organizationId: '',
      to: user.email,
      subject: 'Your Traq password reset code',
      html: `Your password reset code is <strong>${otp}</strong>. It expires in 10 minutes.`,
    });
  }

  // =========================================================================
  // VERIFY OTP
  // =========================================================================
  async verifyOtp(email: string, otp: string): Promise<{ resetToken: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) {
      throw new UnauthorizedException({ code: ERR.OTP_INVALID, message: 'Invalid OTP' });
    }

    const reset = await this.prisma.passwordResetToken.findFirst({
      where: { user_id: user.id, used_at: null },
      orderBy: { created_at: 'desc' },
    });

    if (!reset) {
      throw new UnauthorizedException({ code: ERR.OTP_INVALID, message: 'Invalid OTP' });
    }

    if (reset.expires_at.getTime() < Date.now()) {
      throw new BadRequestException({ code: ERR.OTP_EXPIRED, message: 'OTP has expired' });
    }

    const otpValid = await argon2.verify(reset.otp_hash, otp);
    if (!otpValid) {
      throw new UnauthorizedException({ code: ERR.OTP_INVALID, message: 'Invalid OTP' });
    }

    // Mark OTP as used so it cannot be replayed
    await this.prisma.passwordResetToken.update({
      where: { id: reset.id },
      data: { used_at: new Date() },
    });

    // Issue a short-lived reset token
    const resetToken = this.jwtService.sign(
      { sub: user.id, email: user.email, purpose: 'password_reset' },
      { secret: this.configService.get('JWT_ACCESS_SECRET') as string, expiresIn: RESET_TOKEN_EXPIRY },
    );

    return { resetToken };
  }

  // =========================================================================
  // RESET PASSWORD
  // =========================================================================
  async resetPassword(resetToken: string, newPassword: string): Promise<void> {
    let payload: { sub: string; purpose: string };
    try {
      payload = this.jwtService.verify(resetToken, {
        secret: this.configService.get('JWT_ACCESS_SECRET') as string,
      }) as typeof payload;
    } catch {
      throw new BadRequestException({ code: ERR.RESET_TOKEN_INVALID, message: 'Invalid or expired reset token' });
    }

    if (payload.purpose !== 'password_reset' || !payload.sub) {
      throw new BadRequestException({ code: ERR.RESET_TOKEN_INVALID, message: 'Invalid or expired reset token' });
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.archived_at) {
      throw new BadRequestException({ code: ERR.RESET_TOKEN_INVALID, message: 'Invalid or expired reset token' });
    }

    const newHash = await argon2.hash(newPassword, { type: argon2.argon2id });

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { password_hash: newHash },
      }),
      // Invalidate all refresh tokens for this user
      this.prisma.refreshToken.updateMany({
        where: { user_id: user.id, revoked_at: null },
        data: { revoked_at: new Date() },
      }),
    ]);
  }

  // =========================================================================
  // CREATE INVITATION
  // =========================================================================
  async createInvitation(
    organizationId: string,
    email: string,
    role: Role,
    invitedByName?: string,
  ): Promise<{ invitationLink: string }> {
    const normalized = email.toLowerCase();

    // Prevent duplicate active invitations for the same email in this org
    const existing = await this.prisma.invitation.findFirst({
      where: {
        organization_id: organizationId,
        email: normalized,
        used_at: null,
        expires_at: { gt: new Date() },
      },
    });
    if (existing) {
      throw new BadRequestException({ code: 'INVITATION_EXISTS', message: 'An active invitation already exists for this email' });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);

    await this.prisma.invitation.create({
      data: {
        organization_id: organizationId,
        email: normalized,
        role,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + INVITATION_LIFE_MS),
      },
    });

    const invitationLink = `${this.configService.get('WEB_URL', 'http://localhost:3001')}/auth/invitations/${rawToken}`;

    // Queue invitation email (never send inline)
    await this.emailQueue.add({
      organizationId,
      to: normalized,
      subject: 'You have been invited to Traq',
      html: `You have been invited${invitedByName ? ` by ${invitedByName}` : ''} to join Traq. Click <a href="${invitationLink}">here</a> to accept your invitation. This link expires in 48 hours.`,
    });

    return { invitationLink };
  }

  // =========================================================================
  // VALIDATE INVITATION
  // =========================================================================
  async validateInvitation(token: string): Promise<{ email: string; role: string; organizationId: string }> {
    const tokenHash = this.hashToken(token);
    const invitation = await this.prisma.invitation.findUnique({ where: { token_hash: tokenHash } });

    if (!invitation) {
      throw new NotFoundException({ code: ERR.INVITATION_NOT_FOUND, message: 'Invitation not found' });
    }

    if (invitation.expires_at.getTime() < Date.now()) {
      throw new BadRequestException({ code: ERR.INVITATION_EXPIRED, message: 'Invitation has expired' });
    }

    if (invitation.used_at) {
      throw new BadRequestException({ code: ERR.INVITATION_ALREADY_USED, message: 'Invitation has already been used' });
    }

    return { email: invitation.email, role: invitation.role, organizationId: invitation.organization_id };
  }

  // =========================================================================
  // REGISTER FROM INVITATION
  // =========================================================================
  async registerFromInvitation(
    token: string,
    dto: RegisterDto,
    response: Response,
  ): Promise<{ user: { id: string; email: string; role: string; organizationId: string; name: string }; accessToken: string }> {
    const tokenHash = this.hashToken(token);
    const invitation = await this.prisma.invitation.findUnique({ where: { token_hash: tokenHash } });

    if (!invitation) {
      throw new NotFoundException({ code: ERR.INVITATION_NOT_FOUND, message: 'Invitation not found' });
    }
    if (invitation.expires_at.getTime() < Date.now()) {
      throw new BadRequestException({ code: ERR.INVITATION_EXPIRED, message: 'Invitation has expired' });
    }
    if (invitation.used_at) {
      throw new BadRequestException({ code: ERR.INVITATION_ALREADY_USED, message: 'Invitation has already been used' });
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    const user = await this.prisma.$transaction(async (tx) => {
      // Create the user
      const created = await tx.user.create({
        data: {
          email: invitation.email,
          name: dto.name,
          phone: dto.phone ?? null,
          password_hash: passwordHash,
        },
      });

      // Create the org role
      await tx.userRole.create({
        data: {
          organization_id: invitation.organization_id,
          user_id: created.id,
          role: invitation.role,
        },
      });

      // Mark invitation as used
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { used_at: new Date() },
      });

      return created;
    });

    const tokenUser: TokenUser = {
      id: user.id,
      email: user.email,
      role: invitation.role,
      organizationId: invitation.organization_id,
    };

    const tokens = await this.generateTokens(tokenUser);
    this.setRefreshCookie(response, tokens.refreshToken);

    return {
      user: {
        id: user.id,
        email: user.email,
        role: invitation.role,
        organizationId: invitation.organization_id,
        name: user.name,
      },
      accessToken: tokens.accessToken,
    };
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private async generateTokens(user: TokenUser): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = this.jwtService.sign(
      { sub: user.id, email: user.email, role: user.role, organizationId: user.organizationId },
      { expiresIn: ACCESS_TOKEN_EXPIRY },
    );

    const jti = crypto.randomUUID();
    const refreshToken = this.jwtService.sign(
      { sub: user.id, email: user.email, role: user.role, organizationId: user.organizationId, jti, purpose: 'refresh' },
      {
        secret: this.configService.get('JWT_REFRESH_SECRET') as string,
        expiresIn: '7d',
      },
    );

    await this.prisma.refreshToken.create({
      data: {
        user_id: user.id,
        token_hash: this.hashToken(refreshToken),
        expires_at: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
      },
    });

    return { accessToken, refreshToken };
  }

  private setRefreshCookie(response: Response, refreshToken: string): void {
    response.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: this.configService.get('NODE_ENV') === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: REFRESH_TOKEN_EXPIRY_MS,
    });
  }

  private clearRefreshCookie(response: Response): void {
    response.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: this.configService.get('NODE_ENV') === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
    });
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private generateOtp(): string {
    return String(crypto.randomInt(100000, 1000000));
  }
}

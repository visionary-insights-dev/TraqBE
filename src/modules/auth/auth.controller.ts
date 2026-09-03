import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { AuthUser } from '../../common/types/auth-user.types.js';
import { AuthService, REFRESH_COOKIE_NAME } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { VerifyOtpDto } from './dto/verify-otp.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { CreateInvitationDto } from './dto/create-invitation.dto.js';
import { Role } from '@prisma/client';

@Controller('api/v1/auth')
@ApiTags('Auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Log in and receive access + refresh tokens' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'INVALID_CREDENTIALS' })
  @ApiResponse({ status: 403, description: 'ACCOUNT_ARCHIVED' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto.email, dto.password, res);
    return result;
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  @ApiResponse({ status: 200, description: 'New access token issued' })
  @ApiResponse({ status: 401, description: 'TOKEN_EXPIRED / TOKEN_INVALID' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
    const result = await this.authService.refresh(token, res);
    return result;
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke all refresh tokens and clear the refresh cookie' })
  @ApiResponse({ status: 204, description: 'Logged out' })
  async logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(user.id, res);
  }

  @Public()
  @Post('forgot-password')
  @ApiOperation({ summary: 'Request a password reset OTP (always returns 200)' })
  @ApiResponse({ status: 200, description: 'Request processed' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email);
    return { message: 'If an account exists for this email, a reset code has been sent.' };
  }

  @Public()
  @Post('verify-otp')
  @ApiOperation({ summary: 'Verify a password reset OTP and receive a short-lived reset token' })
  @ApiResponse({ status: 200, description: 'OTP verified, reset token returned' })
  @ApiResponse({ status: 401, description: 'OTP_INVALID' })
  @ApiResponse({ status: 400, description: 'OTP_EXPIRED' })
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.email, dto.otp);
  }

  @Public()
  @Post('reset-password')
  @ApiOperation({ summary: 'Reset the password using a reset token and invalidate refresh tokens' })
  @ApiResponse({ status: 200, description: 'Password reset' })
  @ApiResponse({ status: 400, description: 'RESET_TOKEN_INVALID' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.resetToken, dto.newPassword);
    return { message: 'Password has been reset. Please log in again.' };
  }

  @Post('invitations')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create an organization invite (admin)' })
  @ApiResponse({ status: 201, description: 'Invitation created' })
  @ApiResponse({ status: 401, description: 'Authorization required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async createInvitation(@CurrentUser() user: AuthUser, @Body() dto: CreateInvitationDto) {
    if (!user.roles.includes(Role.SUPER_ADMIN)) {
      throw new ForbiddenException({ code: 'INSUFFICIENT_PERMISSIONS', message: 'Only admins can invite users' });
    }
    const result = await this.authService.createInvitation(user.organizationId, dto.email, dto.role, user.email);
    return result;
  }

  @Public()
  @Post('invitations/:token/validate')
  @ApiOperation({ summary: 'Validate an invitation token' })
  @ApiResponse({ status: 200, description: 'Invitation details returned' })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND' })
  @ApiResponse({ status: 400, description: 'INVITATION_EXPIRED / INVITATION_ALREADY_USED' })
  async validateInvitation(@Param('token') token: string) {
    return this.authService.validateInvitation(token);
  }

  @Public()
  @Post('invitations/:token/register')
  @ApiOperation({ summary: 'Register a new user from an invitation' })
  @ApiResponse({ status: 200, description: 'Account created' })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND' })
  @ApiResponse({ status: 400, description: 'INVITATION_EXPIRED / INVITATION_ALREADY_USED' })
  async register(
    @Param('token') token: string,
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.authService.registerFromInvitation(token, dto, res);
  }
}

import { ValidationPipe as NestValidationPipe } from '@nestjs/common';

export const AppValidationPipe = new NestValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly configured: boolean;

  constructor(private readonly configService: ConfigService) {
    const accountId = this.configService.get<string>('CLOUDFLARE_R2_ACCOUNT_ID');
    const accessKey = this.configService.get<string>('CLOUDFLARE_R2_ACCESS_KEY');
    const secretKey = this.configService.get<string>('CLOUDFLARE_R2_SECRET_KEY');
    this.bucket = this.configService.get<string>('CLOUDFLARE_R2_BUCKET') ?? '';

    this.configured = Boolean(accountId && accessKey && secretKey && this.bucket);

    if (!this.configured) {
      this.logger.warn(
        'R2 environment variables not fully configured. Upload URLs will fail until configured.',
      );
    }

    this.client = new S3Client({
      endpoint: accountId
        ? `https://${accountId}.r2.cloudflarestorage.com`
        : 'https://placeholder.r2.cloudflarestorage.com',
      region: 'auto',
      credentials: accessKey && secretKey
        ? { accessKeyId: accessKey, secretAccessKey: secretKey }
        : { accessKeyId: 'placeholder', secretAccessKey: 'placeholder' },
      forcePathStyle: true,
    });
  }

  /**
   * Generate a presigned PUT URL for uploading a file directly to R2.
   * Valid for 15 minutes (900 seconds).
   */
  async getUploadUrl(
    objectKey: string,
    contentType: string,
    contentLength: number,
  ): Promise<string> {
    if (!this.configured) {
      throw new ServiceUnavailableException({
        code: 'R2_NOT_CONFIGURED',
        message: 'File storage is not configured. Please contact your administrator.',
      });
    }

    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
      { expiresIn: 900 },
    );
  }

/**
   * Upload a buffer directly to R2 (server-side, no presigning).
   * Used by background jobs that generate files server-side (e.g. report CSVs).
   */
  async putObject(objectKey: string, body: Buffer, contentType: string): Promise<void> {
    if (!this.configured) {
      throw new ServiceUnavailableException({
        code: 'R2_NOT_CONFIGURED',
        message: 'File storage is not configured. Please contact your administrator.',
      });
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Get a signed GET URL for downloading a file from R2.
   * Valid for 1 hour (3600 seconds).
   */
  async getDownloadUrl(objectKey: string): Promise<string> {
    if (!this.configured) {
      throw new ServiceUnavailableException({
        code: 'R2_NOT_CONFIGURED',
        message: 'File storage is not configured. Please contact your administrator.',
      });
    }

    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }),
      { expiresIn: 3600 },
    );
  }

  /**
   * Delete an object from R2. Non-fatal — callers should catch and log.
   */
  async deleteObject(objectKey: string): Promise<void> {
    if (!this.configured) {
      this.logger.warn('R2 not configured — skipping delete');
      return;
    }

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }),
    );
  }
}

import crypto from 'node:crypto';
import { PlatformEventType, Prisma } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { env } from '../config/env.js';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import type {
  ApiKeyScope,
  CreateApiKeyInput,
  RotateApiKeyInput,
} from '../validators/apiKey.validator.js';
import { eventService } from './event.service.js';

export const API_KEY_PREFIX_TAG = 'pq_live_';

export interface ApiKeyView {
  id: string;
  organisationId: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  metadata: Prisma.JsonValue;
  createdById: string | null;
  rotatedFromId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticatedApiKey {
  id: string;
  organisationId: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
}

export interface CreateApiKeyResult {
  apiKey: ApiKeyView;
  /** Plaintext secret — displayed strictly ONCE at creation/rotation and never persisted. */
  plaintextKey: string;
}

/**
 * Computes a keyed HMAC-SHA256 hash of a plaintext API key using the dedicated `API_KEY_SECRET` pepper.
 */
export function hashApiKey(plaintextKey: string): string {
  return crypto.createHmac('sha256', env.API_KEY_SECRET).update(plaintextKey).digest('hex');
}

/**
 * Constant-time comparison between two hex-encoded HMAC digests.
 */
export function constantTimeHashEquals(aHex: string, bHex: string): boolean {
  const aBuf = Buffer.from(aHex, 'hex');
  const bBuf = Buffer.from(bHex, 'hex');
  if (aBuf.length === 0 || aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Generates a cryptographically secure random API key with a non-secret display prefix
 * (`pq_live_<8hex>_<48hex>`, 192 bits of secret entropy).
 */
export function generatePlaintextApiKey(): { plaintextKey: string; keyPrefix: string } {
  const prefixId = crypto.randomBytes(4).toString('hex');
  const secretBody = crypto.randomBytes(24).toString('hex');
  const keyPrefix = `${API_KEY_PREFIX_TAG}${prefixId}`;
  const plaintextKey = `${keyPrefix}_${secretBody}`;
  return { plaintextKey, keyPrefix };
}

function toApiKeyView(row: {
  id: string;
  organisationId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  metadata: Prisma.JsonValue;
  createdById: string | null;
  rotatedFromId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ApiKeyView {
  return {
    id: row.id,
    organisationId: row.organisationId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes as ApiKeyScope[],
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    metadata: row.metadata,
    createdById: row.createdById,
    rotatedFromId: row.rotatedFromId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ApiKeyService {
  async create(
    organisationId: string,
    actorUserId: string,
    input: CreateApiKeyInput,
  ): Promise<CreateApiKeyResult> {
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestError('expiresAt must be in the future');
    }

    const { plaintextKey, keyPrefix } = generatePlaintextApiKey();
    const keyHash = hashApiKey(plaintextKey);

    const created = await db.apiKey.create({
      data: {
        organisationId,
        name: input.name,
        keyPrefix,
        keyHash,
        scopes: input.scopes,
        expiresAt,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        createdById: actorUserId,
      },
    });

    await eventService.record({
      type: PlatformEventType.API_KEY_CREATED,
      organisationId,
      message: `API key "${created.name}" (${created.keyPrefix}...) created`,
      metadata: {
        apiKeyId: created.id,
        keyPrefix: created.keyPrefix,
        scopes: created.scopes,
        actorUserId,
        expiresAt: created.expiresAt?.toISOString() ?? null,
      },
    });

    return {
      apiKey: toApiKeyView(created),
      plaintextKey,
    };
  }

  async list(organisationId: string): Promise<ApiKeyView[]> {
    const rows = await db.apiKey.findMany({
      where: { organisationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toApiKeyView);
  }

  async revoke(organisationId: string, apiKeyId: string, actorUserId: string): Promise<ApiKeyView> {
    if (!uuidSchema.safeParse(apiKeyId).success) {
      throw new NotFoundError('API key not found');
    }

    const existing = await db.apiKey.findFirst({
      where: { id: apiKeyId, organisationId },
    });
    if (!existing) {
      throw new NotFoundError('API key not found');
    }
    if (existing.revokedAt) {
      return toApiKeyView(existing);
    }

    const revoked = await db.apiKey.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    await eventService.record({
      type: PlatformEventType.API_KEY_REVOKED,
      organisationId,
      message: `API key "${revoked.name}" (${revoked.keyPrefix}...) revoked`,
      metadata: {
        apiKeyId: revoked.id,
        keyPrefix: revoked.keyPrefix,
        actorUserId,
      },
    });

    return toApiKeyView(revoked);
  }

  async rotate(
    organisationId: string,
    apiKeyId: string,
    actorUserId: string,
    input: RotateApiKeyInput,
  ): Promise<CreateApiKeyResult & { revokedKeyId: string }> {
    if (!uuidSchema.safeParse(apiKeyId).success) {
      throw new NotFoundError('API key not found');
    }

    const existing = await db.apiKey.findFirst({
      where: { id: apiKeyId, organisationId },
    });
    if (!existing) {
      throw new NotFoundError('API key not found');
    }
    if (existing.revokedAt) {
      throw new ConflictError('Cannot rotate an already revoked API key');
    }

    const nextExpiresAt =
      input.expiresAt !== undefined
        ? input.expiresAt
          ? new Date(input.expiresAt)
          : null
        : existing.expiresAt;
    if (nextExpiresAt && nextExpiresAt.getTime() <= Date.now()) {
      throw new BadRequestError('expiresAt must be in the future');
    }

    const { plaintextKey, keyPrefix } = generatePlaintextApiKey();
    const keyHash = hashApiKey(plaintextKey);
    const now = new Date();

    const created = await db.$transaction(async (tx) => {
      const revoked = await tx.apiKey.updateMany({
        where: { id: existing.id, organisationId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) {
        throw new ConflictError('API key was already revoked concurrently');
      }

      return tx.apiKey.create({
        data: {
          organisationId,
          name: input.name ?? existing.name,
          keyPrefix,
          keyHash,
          scopes: input.scopes ?? existing.scopes,
          expiresAt: nextExpiresAt,
          metadata: existing.metadata as Prisma.InputJsonValue,
          createdById: actorUserId,
          rotatedFromId: existing.id,
        },
      });
    });

    await eventService.record({
      type: PlatformEventType.API_KEY_ROTATED,
      organisationId,
      message: `API key "${existing.name}" rotated (${existing.keyPrefix}... -> ${created.keyPrefix}...)`,
      metadata: {
        revokedKeyId: existing.id,
        newApiKeyId: created.id,
        keyPrefix: created.keyPrefix,
        scopes: created.scopes,
        actorUserId,
      },
    });

    return {
      apiKey: toApiKeyView(created),
      plaintextKey,
      revokedKeyId: existing.id,
    };
  }

  /**
   * Authenticates a raw API key header value.
   * Returns null if invalid, malformed, revoked, or expired.
   */
  async authenticateKey(rawKey: string): Promise<AuthenticatedApiKey | null> {
    if (!rawKey || !rawKey.startsWith(API_KEY_PREFIX_TAG) || rawKey.length > 128) {
      return null;
    }

    const candidateHash = hashApiKey(rawKey);
    const record = await db.apiKey.findUnique({
      where: { keyHash: candidateHash },
      select: {
        id: true,
        organisationId: true,
        name: true,
        keyPrefix: true,
        keyHash: true,
        scopes: true,
        revokedAt: true,
        expiresAt: true,
      },
    });

    if (!record) {
      return null;
    }
    if (!constantTimeHashEquals(candidateHash, record.keyHash)) {
      return null;
    }
    if (record.revokedAt !== null) {
      return null;
    }
    if (record.expiresAt !== null && record.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    // Fire-and-forget lastUsedAt update so auth path stays fast and resilient
    void db.apiKey
      .update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {
        // Ignore transient write errors on telemetry timestamp
      });

    return {
      id: record.id,
      organisationId: record.organisationId,
      name: record.name,
      keyPrefix: record.keyPrefix,
      scopes: record.scopes as ApiKeyScope[],
    };
  }
}

export const apiKeyService = new ApiKeyService();

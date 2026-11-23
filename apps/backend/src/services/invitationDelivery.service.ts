import { Role } from '@prisma/client';
import { logger } from '../utils/logger.js';

export interface InvitationDeliveryPayload {
  invitationId: string;
  organisationId: string;
  organisationName: string;
  invitedEmail: string;
  role: Role;
  invitedByName: string;
  expiresAt: Date;
  /** Raw token passed to email transport only; NEVER logged or stored in plaintext. */
  rawToken: string;
}

export interface InvitationDeliveryProvider {
  sendInvitation(payload: InvitationDeliveryPayload): Promise<void>;
}

/**
 * Default delivery provider used before an external email provider (SMTP/SES/Resend)
 * is wired in. Records safe metadata only and never logs the raw invitation token.
 */
class LogOnlyInvitationDeliveryProvider implements InvitationDeliveryProvider {
  async sendInvitation(payload: InvitationDeliveryPayload): Promise<void> {
    logger.info('Invitation queued for delivery', {
      invitationId: payload.invitationId,
      organisationId: payload.organisationId,
      organisationName: payload.organisationName,
      invitedEmail: payload.invitedEmail,
      role: payload.role,
      expiresAt: payload.expiresAt.toISOString(),
    });
  }
}

export class InvitationDeliveryService {
  private provider: InvitationDeliveryProvider;

  constructor(provider?: InvitationDeliveryProvider) {
    this.provider = provider ?? new LogOnlyInvitationDeliveryProvider();
  }

  setProvider(provider: InvitationDeliveryProvider): void {
    this.provider = provider;
  }

  async deliverInvitation(payload: InvitationDeliveryPayload): Promise<void> {
    await this.provider.sendInvitation(payload);
  }
}

export const invitationDeliveryService = new InvitationDeliveryService();

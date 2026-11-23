import { z } from 'zod';
import { Role } from '@prisma/client';

export const uuidSchema = z.string().uuid('Invalid identifier format');

export const createOrgSchema = z.object({
  name: z
    .string({ required_error: 'Organisation name is required' })
    .trim()
    .min(2, 'Organisation name must be at least 2 characters')
    .max(100, 'Organisation name must not exceed 100 characters'),
});

export const updateOrgSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Organisation name must be at least 2 characters')
      .max(100, 'Organisation name must not exceed 100 characters')
      .optional(),
  })
  .refine((data) => data.name !== undefined, {
    message: 'At least one updatable field must be provided',
  });

export const updateMemberRoleSchema = z.object({
  role: z.nativeEnum(Role, {
    errorMap: () => ({ message: 'Role must be OWNER, ADMIN, or MEMBER' }),
  }),
});

export const transferOwnershipSchema = z.object({
  targetUserId: z
    .string({ required_error: 'targetUserId is required' })
    .uuid('targetUserId must be a valid UUID'),
});

export const createInvitationSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .trim()
    .email('Invalid email address')
    .toLowerCase(),
  role: z.nativeEnum(Role, {
    errorMap: () => ({ message: 'Invitation role must be OWNER, ADMIN, or MEMBER' }),
  }),
});

export const acceptInvitationSchema = z.object({
  token: z
    .string({ required_error: 'Invitation token is required' })
    .trim()
    .min(1, 'Invitation token is required'),
});

export type CreateOrgInput = z.infer<typeof createOrgSchema>;
export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

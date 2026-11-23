import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { healthApi } from '../../api/health.api';
import { ApiClientError } from '../../api/error';
import { useOrganisation } from '../../contexts/OrganisationContext';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/ErrorState';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Sidebar } from './Sidebar';
import { TopHeader } from './TopHeader';

const createOrgSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Organisation name must be at least 2 characters')
    .max(100, 'Organisation name must not exceed 100 characters'),
});

type CreateOrgFormValues = z.infer<typeof createOrgSchema>;

export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [createOrgError, setCreateOrgError] = useState<string | null>(null);
  const { createOrganisation } = useOrganisation();

  const { data: health, isError: healthError } = useQuery({
    queryKey: ['system-health'],
    queryFn: healthApi.getHealth,
    refetchInterval: 30_000,
    retry: false,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrgFormValues>({
    resolver: zodResolver(createOrgSchema),
    defaultValues: { name: '' },
  });

  const onCreateOrg = async (values: CreateOrgFormValues) => {
    setCreateOrgError(null);
    try {
      await createOrganisation(values.name);
      reset();
      setCreateOrgOpen(false);
    } catch (err) {
      setCreateOrgError(
        err instanceof ApiClientError ? err.message : 'Failed to create organisation',
      );
    }
  };

  return (
    <div className="min-h-screen bg-canvas text-slate-100">
      <Sidebar
        isMobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        health={health}
        healthError={healthError}
      />

      <div className="flex min-h-screen flex-col lg:pl-60">
        <TopHeader
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenCreateOrg={() => {
            setCreateOrgError(null);
            setCreateOrgOpen(true);
          }}
        />
        <main className="flex-1">
          <Outlet context={{ openCreateOrgModal: () => setCreateOrgOpen(true), health }} />
        </main>
      </div>

      <Modal
        isOpen={createOrgOpen}
        onClose={() => setCreateOrgOpen(false)}
        title="Create Organisation"
        description="Organisations isolate queues, jobs, schedules, DLQ records, and team RBAC."
      >
        <form onSubmit={handleSubmit(onCreateOrg)} className="space-y-4">
          {createOrgError && <ErrorState compact message={createOrgError} />}
          <Input
            label="Organisation Name"
            placeholder="e.g. Acme Payments Production"
            error={errors.name?.message}
            {...register('name')}
          />
          <div className="flex items-center justify-end gap-2.5 pt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setCreateOrgOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" isLoading={isSubmitting}>
              Create Organisation
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

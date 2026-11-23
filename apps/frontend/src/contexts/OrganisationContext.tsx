import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { organisationApi } from '../api/organisation.api';
import type { OrganisationView } from '../types/api';
import { useAuth } from './AuthContext';

const ACTIVE_ORG_STORAGE_KEY = 'pulsequeue.activeOrgId';

interface OrganisationContextValue {
  organisations: OrganisationView[];
  activeOrganisation: OrganisationView | null;
  activeOrganisationId: string | null;
  setActiveOrganisationId: (orgId: string) => void;
  createOrganisation: (name: string) => Promise<OrganisationView>;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

const OrganisationContext = createContext<OrganisationContextValue | null>(null);

function readStoredOrgId(): string | null {
  try {
    return window.sessionStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredOrgId(orgId: string | null): void {
  try {
    if (orgId) {
      window.sessionStorage.setItem(ACTIVE_ORG_STORAGE_KEY, orgId);
    } else {
      window.sessionStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors in restricted contexts
  }
}

export function OrganisationProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(() => readStoredOrgId());

  const {
    data: organisations = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['organisations'],
    queryFn: organisationApi.list,
    enabled: isAuthenticated,
  });

  // Resolve valid active organisation strictly from the user's real backend memberships
  const activeOrganisation = useMemo(() => {
    if (organisations.length === 0) {
      return null;
    }
    if (selectedOrgId) {
      const matched = organisations.find((o) => o.id === selectedOrgId);
      if (matched) return matched;
    }
    return organisations[0];
  }, [organisations, selectedOrgId]);

  useEffect(() => {
    if (!isAuthenticated) {
      setSelectedOrgId(null);
      writeStoredOrgId(null);
      return;
    }
    if (activeOrganisation && activeOrganisation.id !== selectedOrgId) {
      setSelectedOrgId(activeOrganisation.id);
      writeStoredOrgId(activeOrganisation.id);
    }
  }, [isAuthenticated, activeOrganisation, selectedOrgId]);

  const setActiveOrganisationId = useCallback((orgId: string) => {
    setSelectedOrgId(orgId);
    writeStoredOrgId(orgId);
  }, []);

  const createOrganisation = useCallback(
    async (name: string): Promise<OrganisationView> => {
      const created = await organisationApi.create(name);
      await queryClient.invalidateQueries({ queryKey: ['organisations'] });
      setSelectedOrgId(created.id);
      writeStoredOrgId(created.id);
      return created;
    },
    [queryClient],
  );

  const value = useMemo<OrganisationContextValue>(
    () => ({
      organisations,
      activeOrganisation,
      activeOrganisationId: activeOrganisation?.id ?? null,
      setActiveOrganisationId,
      createOrganisation,
      isLoading: isAuthenticated && isLoading,
      error: error instanceof Error ? error : null,
      refetch,
    }),
    [
      organisations,
      activeOrganisation,
      setActiveOrganisationId,
      createOrganisation,
      isAuthenticated,
      isLoading,
      error,
      refetch,
    ],
  );

  return <OrganisationContext.Provider value={value}>{children}</OrganisationContext.Provider>;
}

export function useOrganisation(): OrganisationContextValue {
  const ctx = useContext(OrganisationContext);
  if (!ctx) {
    throw new Error('useOrganisation must be used within an OrganisationProvider');
  }
  return ctx;
}

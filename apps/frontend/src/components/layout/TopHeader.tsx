import { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown, LogOut, Menu, Plus, User } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useOrganisation } from '../../contexts/OrganisationContext';
import { StatusBadge } from '../ui/StatusBadge';

interface TopHeaderProps {
  onOpenMobileNav: () => void;
  onOpenCreateOrg: () => void;
}

export function TopHeader({ onOpenMobileNav, onOpenCreateOrg }: TopHeaderProps) {
  const { user, logout } = useAuth();
  const { organisations, activeOrganisation, setActiveOrganisationId, isLoading } =
    useOrganisation();

  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const orgRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (orgRef.current && !orgRef.current.contains(e.target as Node)) {
        setOrgMenuOpen(false);
      }
      if (userRef.current && !userRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  const initials = (user?.name ?? 'PQ')
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
    } finally {
      setIsLoggingOut(false);
      setUserMenuOpen(false);
    }
  };

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-border-subtle bg-canvas/90 px-4 backdrop-blur-md lg:px-6">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation menu"
          className="rounded-lg p-1.5 text-slate-400 hover:bg-surface hover:text-slate-100 lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Organisation selector */}
        <div className="relative" ref={orgRef}>
          <button
            type="button"
            onClick={() => setOrgMenuOpen((prev) => !prev)}
            aria-haspopup="listbox"
            aria-expanded={orgMenuOpen}
            className="flex h-9 items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 text-sm text-slate-100 transition-colors hover:border-border-strong hover:bg-surface-elevated"
          >
            <Building2 className="h-4 w-4 text-sky-400 shrink-0" />
            <span className="max-w-[160px] truncate font-medium sm:max-w-[220px]">
              {isLoading
                ? 'Loading workspaces…'
                : activeOrganisation
                  ? activeOrganisation.name
                  : 'No organisation'}
            </span>
            {activeOrganisation?.role && (
              <span className="hidden sm:inline-flex">
                <StatusBadge status={activeOrganisation.role} />
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          </button>

          {orgMenuOpen && (
            <div
              role="listbox"
              aria-label="Select organisation"
              className="absolute left-0 mt-2 w-72 rounded-xl border border-border-strong bg-surface p-1.5 shadow-popover"
            >
              <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Your Organisations ({organisations.length})
              </div>
              {organisations.length === 0 ? (
                <p className="px-2.5 py-2 text-xs text-slate-400">
                  You do not belong to any organisation yet.
                </p>
              ) : (
                <div className="max-h-60 overflow-y-auto space-y-0.5">
                  {organisations.map((org) => {
                    const isSelected = org.id === activeOrganisation?.id;
                    return (
                      <button
                        key={org.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          setActiveOrganisationId(org.id);
                          setOrgMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                          isSelected
                            ? 'bg-sky-400/12 text-sky-200'
                            : 'text-slate-300 hover:bg-surface-elevated hover:text-slate-100'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">{org.name}</p>
                          <p className="text-[10px] text-slate-500 font-mono truncate">{org.id}</p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {org.role && <StatusBadge status={org.role} />}
                          {isSelected && <Check className="h-3.5 w-3.5 text-sky-400" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="mt-1 border-t border-border-subtle pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setOrgMenuOpen(false);
                    onOpenCreateOrg();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-sky-300 hover:bg-sky-400/10"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create organisation
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* User account menu */}
      <div className="relative" ref={userRef}>
        <button
          type="button"
          onClick={() => setUserMenuOpen((prev) => !prev)}
          aria-haspopup="menu"
          aria-expanded={userMenuOpen}
          className="flex h-9 items-center gap-2.5 rounded-lg border border-border-subtle bg-surface px-2.5 text-left transition-colors hover:border-border-strong hover:bg-surface-elevated"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-400/15 text-[11px] font-semibold text-sky-300">
            {initials}
          </span>
          <div className="hidden sm:block leading-tight">
            <span className="block max-w-[130px] truncate text-xs font-medium text-slate-100">
              {user?.name}
            </span>
          </div>
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
        </button>

        {userMenuOpen && (
          <div
            role="menu"
            className="absolute right-0 mt-2 w-60 rounded-xl border border-border-strong bg-surface p-1.5 shadow-popover"
          >
            <div className="border-b border-border-subtle px-2.5 py-2">
              <div className="flex items-center gap-2">
                <User className="h-3.5 w-3.5 text-slate-400" />
                <p className="truncate text-xs font-semibold text-slate-100">{user?.name}</p>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-slate-400">{user?.email}</p>
            </div>
            <div className="pt-1">
              <button
                type="button"
                role="menuitem"
                disabled={isLoggingOut}
                onClick={() => void handleLogout()}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
              >
                <LogOut className="h-3.5 w-3.5" />
                {isLoggingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

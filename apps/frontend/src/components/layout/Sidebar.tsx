import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  Activity,
  AlertOctagon,
  Bell,
  CalendarClock,
  Layers,
  LayoutDashboard,
  ListChecks,
  Settings,
  X,
  Zap,
} from 'lucide-react';
import type { HealthReport } from '../../types/api';
import { StatusBadge } from '../ui/StatusBadge';

export interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const PRIMARY_NAV_ITEMS: NavItem[] = [
  { label: 'Overview', to: '/dashboard', icon: LayoutDashboard },
  { label: 'Queues', to: '/queues', icon: Layers },
  { label: 'Jobs', to: '/jobs', icon: ListChecks },
  { label: 'Schedules', to: '/schedules', icon: CalendarClock },
  { label: 'Workers & Monitoring', to: '/monitoring', icon: Activity },
  { label: 'Alerts', to: '/alerts', icon: Bell },
  { label: 'Dead Letter Queue', to: '/dlq', icon: AlertOctagon },
];

export const SECONDARY_NAV_ITEMS: NavItem[] = [
  { label: 'Organisation Settings', to: '/settings', icon: Settings },
];

interface SidebarProps {
  isMobileOpen: boolean;
  onCloseMobile: () => void;
  health?: HealthReport;
  healthError?: boolean;
}

export function Sidebar({ isMobileOpen, onCloseMobile, health, healthError }: SidebarProps) {
  const renderNavLink = (item: NavItem) => {
    const Icon = item.icon;
    return (
      <NavLink
        key={item.to}
        to={item.to}
        onClick={onCloseMobile}
        className={({ isActive }) =>
          `group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors border ${
            isActive
              ? 'bg-sky-400/10 text-sky-300 border-sky-400/20'
              : 'text-slate-400 border-transparent hover:bg-surface-elevated hover:text-slate-100'
          }`
        }
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{item.label}</span>
      </NavLink>
    );
  };

  const content = (
    <div className="flex h-full flex-col bg-surface border-r border-border-subtle">
      {/* Brand header */}
      <div className="flex h-14 items-center justify-between px-4 border-b border-border-subtle">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-400/15 border border-sky-400/30 text-sky-400">
            <Zap className="h-4 w-4" />
          </div>
          <div className="leading-tight">
            <span className="block text-sm font-semibold tracking-tight text-slate-100">
              PulseQueue
            </span>
            <span className="block text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Control Plane
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation"
          className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 lg:hidden"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Navigation sections */}
      <nav aria-label="Main navigation" className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        <div>
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Platform
          </p>
          <div className="space-y-1">{PRIMARY_NAV_ITEMS.map(renderNavLink)}</div>
        </div>

        <div>
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Workspace
          </p>
          <div className="space-y-1">{SECONDARY_NAV_ITEMS.map(renderNavLink)}</div>
        </div>
      </nav>

      {/* Infrastructure health footer */}
      <div className="border-t border-border-subtle p-3">
        <div className="rounded-lg bg-canvas/80 border border-border-subtle px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-slate-400">System Health</span>
            {healthError ? (
              <StatusBadge status="ERROR" label="Offline" showDot />
            ) : health ? (
              <StatusBadge
                status={health.status}
                label={health.status === 'ok' ? 'Healthy' : 'Degraded'}
                showDot
              />
            ) : (
              <span className="text-[11px] text-slate-500">Checking…</span>
            )}
          </div>
          {health && (
            <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500 font-mono">
              <span>PG: {health.services.database}</span>
              <span>Redis: {health.services.redis}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop fixed sidebar */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:block lg:w-60">
        {content}
      </aside>

      {/* Mobile slide-over drawer */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-xs"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative z-50 w-64 max-w-[82vw]">{content}</aside>
        </div>
      )}
    </>
  );
}

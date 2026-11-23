import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, CheckCheck, ExternalLink } from 'lucide-react';
import { useOrganisation } from '../../contexts/OrganisationContext';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
} from '../../hooks/useAlerts';
import { StatusBadge } from '../ui/StatusBadge';
import type { NotificationView } from '../../types/api';

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function NotificationBell() {
  const navigate = useNavigate();
  const { activeOrganisation } = useOrganisation();
  const orgId = activeOrganisation?.id ?? null;

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const unreadQuery = useUnreadNotificationCount(orgId);
  const listQuery = useNotifications(orgId, { page: 1, limit: 10 }, { enabled: open });
  const markRead = useMarkNotificationRead(orgId);
  const markAllRead = useMarkAllNotificationsRead(orgId);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  const unreadCount = unreadQuery.data ?? 0;
  const notifications = listQuery.data?.notifications ?? [];

  const handleOpenNotification = (item: NotificationView) => {
    if (!item.isRead) {
      markRead.mutate(item.id);
    }
    setOpen(false);
    navigate(item.alertId ? `/alerts?alertId=${item.alertId}` : '/alerts');
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle bg-surface text-slate-300 transition-colors hover:border-border-strong hover:bg-surface-elevated hover:text-slate-100"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span
            data-testid="notification-unread-badge"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold leading-none text-white"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Recent notifications"
          className="absolute right-0 mt-2 w-80 sm:w-96 rounded-xl border border-border-strong bg-surface shadow-popover overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-border-subtle px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-100">Notifications</span>
              {unreadCount > 0 && (
                <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300">
                  {unreadCount} unread
                </span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                disabled={markAllRead.isPending}
                onClick={() => markAllRead.mutate()}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-400 hover:text-sky-300 disabled:opacity-50"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-border-subtle">
            {listQuery.isLoading ? (
              <div className="px-4 py-6 text-center text-xs text-slate-400">
                Loading notifications…
              </div>
            ) : listQuery.isError ? (
              <div className="px-4 py-6 text-center text-xs text-rose-300">
                Failed to load notifications.
              </div>
            ) : notifications.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-slate-400">
                No notifications yet.
              </div>
            ) : (
              notifications.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-start gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-surface-elevated ${
                    !item.isRead ? 'bg-sky-500/[0.04]' : ''
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleOpenNotification(item)}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="flex items-center gap-1.5">
                      {!item.isRead && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                      )}
                      <StatusBadge status={item.severity} />
                      <span className="ml-auto text-[10px] text-slate-500 shrink-0">
                        {formatRelativeTime(item.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs font-medium text-slate-100">{item.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-400">{item.message}</p>
                  </button>
                  {!item.isRead && (
                    <button
                      type="button"
                      aria-label={`Mark "${item.title}" as read`}
                      onClick={(e) => {
                        e.stopPropagation();
                        markRead.mutate(item.id);
                      }}
                      className="mt-1 rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-emerald-300"
                      title="Mark read"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="border-t border-border-subtle bg-canvas/50 px-3.5 py-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate('/alerts');
              }}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg py-1 text-xs font-medium text-sky-400 hover:bg-sky-400/10 hover:text-sky-300"
            >
              <span>View all alerts & notifications</span>
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

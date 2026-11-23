import React from 'react';
import { TableSkeleton } from './Skeleton';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  className?: string;
  render: (row: T) => React.ReactNode;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  rowKey: (row: T) => string;
  isLoading?: boolean;
  emptyState?: React.ReactNode;
  skeletonRows?: number;
}

export function DataTable<T>({
  columns,
  data,
  rowKey,
  isLoading = false,
  emptyState,
  skeletonRows = 5,
}: DataTableProps<T>) {
  if (isLoading) {
    return <TableSkeleton rows={skeletonRows} columns={columns.length} />;
  }

  if (data.length === 0) {
    return (
      <div className="p-6">
        {emptyState ?? (
          <p className="text-center text-sm text-slate-400">No records to display yet.</p>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border-subtle bg-surface-subtle/60">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 ${
                  col.align === 'right' ? 'text-right' : 'text-left'
                } ${col.className ?? ''}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle text-sm">
          {data.map((row) => (
            <tr key={rowKey(row)} className="transition-colors hover:bg-surface-elevated/60">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-5 py-3 text-slate-200 ${
                    col.align === 'right' ? 'text-right' : 'text-left'
                  } ${col.className ?? ''}`}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

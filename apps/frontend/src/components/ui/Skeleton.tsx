export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-slate-800/80 ${className}`} />;
}

export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="divide-y divide-border-subtle">
      {Array.from({ length: rows }).map((_, rIdx) => (
        <div key={rIdx} className="flex items-center gap-4 px-5 py-3.5">
          {Array.from({ length: columns }).map((__, cIdx) => (
            <Skeleton
              key={cIdx}
              className={`h-4 ${cIdx === 0 ? 'w-32' : cIdx === columns - 1 ? 'w-20 ml-auto' : 'w-24'}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

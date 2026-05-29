import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { Card, CardHead } from "./atoms";

type Numeric = number | string;

function dim(v: Numeric | undefined, fallback: Numeric): string {
  const x = v ?? fallback;
  return typeof x === "number" ? `${x}px` : x;
}

type SkelProps = HTMLAttributes<HTMLSpanElement>;

export function SkeletonLine({
  width, height, style, className = "", ...rest
}: SkelProps & { width?: Numeric; height?: Numeric }) {
  return (
    <span
      aria-hidden
      className={`skel ${className}`}
      style={{ width: dim(width, "100%"), height: dim(height, 12), ...style }}
      {...rest}
    />
  );
}

export function SkeletonCircle({
  size, style, className = "", ...rest
}: SkelProps & { size?: Numeric }) {
  const s = dim(size, 24);
  return (
    <span
      aria-hidden
      className={`skel ${className}`}
      style={{ width: s, height: s, borderRadius: "50%", ...style }}
      {...rest}
    />
  );
}

export function SkeletonBlock({
  width, height, style, className = "", ...rest
}: SkelProps & { width?: Numeric; height?: Numeric }) {
  return (
    <span
      aria-hidden
      className={`skel ${className}`}
      style={{ width: dim(width, "100%"), height: dim(height, 80), ...style }}
      {...rest}
    />
  );
}

export function SkeletonPill({ width, style, className = "", ...rest }: SkelProps & { width?: Numeric }) {
  return (
    <span
      aria-hidden
      className={`skel ${className}`}
      style={{ width: dim(width, 64), height: 20, borderRadius: 999, ...style }}
      {...rest}
    />
  );
}

// SkeletonRow renders a row that mirrors a list-row grid. `columns` is the
// per-cell shape spec; defaults to a SkeletonLine in each cell.
type RowCell = "line" | "circle" | "pill" | "blank";
export function SkeletonRow({
  gridTemplateColumns,
  columns,
  style,
  className = "",
}: {
  gridTemplateColumns: string;
  columns: RowCell[];
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={`list-row ${className}`}
      style={{ gridTemplateColumns, alignItems: "center", ...style }}
    >
      {columns.map((c, i) => {
        if (c === "blank") return <span key={i} />;
        if (c === "circle") return <SkeletonCircle key={i} size={20} />;
        if (c === "pill") return <SkeletonPill key={i} />;
        return <SkeletonLine key={i} />;
      })}
    </div>
  );
}

export function SkeletonCard({
  title,
  lines = 3,
  after,
}: {
  title?: ReactNode;
  lines?: number;
  after?: ReactNode;
}) {
  return (
    <Card>
      <CardHead title={title ?? <SkeletonLine width={120} height={14} />} after={after} />
      <div className="card-body col gap-3">
        {Array.from({ length: lines }).map((_, i) => (
          <SkeletonLine key={i} width={i === lines - 1 ? "70%" : "100%"} />
        ))}
      </div>
    </Card>
  );
}

// 4-up KPI strip used on /accounts/[id] and /initiatives/[id].
export function SkeletonKpiStrip({ count = 4 }: { count?: number }) {
  return (
    <div className="row gap-6" style={{ alignItems: "flex-end" }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="kpi" style={{ alignItems: "center", gap: 4 }}>
          <SkeletonLine width={32} height={22} />
          <SkeletonLine width={56} height={10} style={{ opacity: 0.7 }} />
        </div>
      ))}
    </div>
  );
}

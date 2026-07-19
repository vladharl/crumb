import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from "react";

type CardProps = HTMLAttributes<HTMLDivElement> & { className?: string };
export const Card = ({ children, className = "", ...rest }: CardProps) => (
  <div className={`card ${className}`} {...rest}>{children}</div>
);

export const CardHead = ({ title, after }: { title: ReactNode; after?: ReactNode }) => (
  <div className="card-head">
    <h3>{title}</h3>
    <div style={{ flex: 1 }} />
    {after}
  </div>
);

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string;
  sm?: boolean;
  lg?: boolean;
  full?: boolean;
  icon?: ReactNode;
  iconOnly?: boolean;
};
export const Btn = ({ variant, sm, lg, full, icon, iconOnly, children, className, ...rest }: BtnProps) => {
  const cls = ["btn", variant, sm ? "sm" : "", lg ? "lg" : "", full ? "full" : "", iconOnly ? "icon-only" : "", className || ""]
    .filter(Boolean).join(" ");
  return (
    <button className={cls} {...rest}>
      {icon}{children}
    </button>
  );
};

type PillProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: string;
  dot?: boolean;
  ring?: boolean;
  ringFill?: boolean;
  solid?: boolean;
};
export const Pill = ({ variant, children, dot, ring, ringFill, solid, className, ...rest }: PillProps) => {
  const cls = ["pill", variant, solid ? "solid" : "", className].filter(Boolean).join(" ");
  return (
    <span className={cls} {...rest}>
      {ring && <span className={`ring ${ringFill ? "fill" : ""}`} />}
      {dot && <span className="dot" />}
      {children}
    </span>
  );
};

type AvatarProps = HTMLAttributes<HTMLSpanElement> & { kind?: string; size?: string };
export const Avatar = ({ kind = "", size = "", children, className, ...rest }: AvatarProps) => (
  <span className={`avatar ${size} ${kind} ${className || ""}`} {...rest}>{children}</span>
);

export const Switch = ({ on, onClick }: { on?: boolean; onClick?: () => void }) => (
  <button type="button" className={`switch ${on ? "on" : ""}`} onClick={onClick} role="switch" aria-checked={!!on} />
);

export const Field = ({ label, help, htmlFor, children }: { label?: ReactNode; help?: ReactNode; htmlFor?: string; children?: ReactNode }) => (
  <div className="field">
    {label && <label className="field-label" htmlFor={htmlFor}>{label}</label>}
    {children}
    {help && <span className="field-help">{help}</span>}
  </div>
);

export const PageHead = ({ crumb, title, lede, actions, titleStyle }: {
  crumb?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  // Lets a page tag its heading as a View Transition shared element — e.g. the
  // thread title that an inbox row morphs into. Inert everywhere else.
  titleStyle?: CSSProperties;
}) => (
  <div className="content-head">
    <div className="top-row">
      <div className="col gap-2 grow">
        {crumb && <span className="crumb">{crumb}</span>}
        <h1 style={titleStyle}>{title}</h1>
      </div>
      {actions && <div className="row gap-2" style={{ flexWrap: "wrap" }}>{actions}</div>}
    </div>
    {lede && <p className="lede">{lede}</p>}
  </div>
);

export const Phone = ({ children }: { children?: ReactNode }) => (
  <div className="phone-frame">{children}</div>
);

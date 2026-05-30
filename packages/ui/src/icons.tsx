import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export const Ic = {
  inbox: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 9.5V13a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 13V9.5M2 9.5l2-6h8l2 6M2 9.5h3.5l1 1.5h3l1-1.5H14" />
    </svg>
  ),
  chart: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 14h12" />
      <path d="M4 14V8M8 14V3M12 14v-5" />
    </svg>
  ),
  chat: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 11.5a1.5 1.5 0 0 1-1.5 1.5H6l-3 2.5V13H3.5A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5z" />
    </svg>
  ),
  send: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8l12-6-4 13-3-6z" />
    </svg>
  ),
  bell: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h10l-1.5-2v-3a3.5 3.5 0 1 0-7 0v3L3 12zm4 1.5a1.5 1.5 0 0 0 3 0" />
    </svg>
  ),
  settings: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M13 8c0 .5-.1 1-.2 1.5l1.4 1.1-1.5 2.6-1.6-.7c-.7.6-1.6 1.1-2.5 1.3L8.3 15h-3l-.3-1.7c-.9-.2-1.8-.7-2.5-1.3l-1.6.7L0 10l1.4-1.1A6 6 0 0 1 1.2 8c0-.5.1-1 .2-1.5L0 5.4 1.5 2.8l1.6.7c.7-.6 1.6-1.1 2.5-1.3L6 0h3l.3 1.7c.9.2 1.8.7 2.5 1.3l1.6-.7L15 5.4l-1.4 1.1c.1.5.2 1 .2 1.5z" transform="scale(0.85) translate(1.3, 1.3)" />
    </svg>
  ),
  user: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" />
    </svg>
  ),
  users: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <path d="M1.5 14c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" />
      <circle cx="11.5" cy="5" r="2" />
      <path d="M14.5 12c0-1.8-1.3-3.5-3-3.5" />
    </svg>
  ),
  building: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 14V3a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v11M3 14h10M3 14H1m12 0h2M6 5h1m2 0h1M6 8h1m2 0h1M6 11h1m2 0h1" />
    </svg>
  ),
  plug: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 1v3M10 1v3M4 4h8v3a4 4 0 0 1-8 0V4zM8 11v4" />
    </svg>
  ),
  sparkle: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v3M8 11v3M2 8h3M11 8h3M3.5 3.5l2 2M10.5 10.5l2 2M3.5 12.5l2-2M10.5 5.5l2-2" />
    </svg>
  ),
  search: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  ),
  filter: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4h12M4 8h8M6 12h4" />
    </svg>
  ),
  plus: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  ),
  check: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5l3.5 3 7-7" />
    </svg>
  ),
  x: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  ),
  copy: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="5" width="9" height="9" rx="1" />
      <path d="M3 11V3a1 1 0 0 1 1-1h7" />
    </svg>
  ),
  link: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 9a2 2 0 0 1 0-3l2-2a2 2 0 1 1 3 3l-1 1M9 7a2 2 0 0 1 0 3l-2 2a2 2 0 1 1-3-3l1-1" />
    </svg>
  ),
  attach: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5l-5.5 5.5a2 2 0 0 0 3 3l6-6a3 3 0 0 0-4-4L4 9.5a4 4 0 1 0 5.5 5.5l5-5" />
    </svg>
  ),
  chevR: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4l4 4-4 4" />
    </svg>
  ),
  chevD: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6l4 4 4-4" />
    </svg>
  ),
  more: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="3" cy="8" r="0.8" />
      <circle cx="8" cy="8" r="0.8" />
      <circle cx="13" cy="8" r="0.8" />
    </svg>
  ),
  bug: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="5" width="6" height="8" rx="3" />
      <path d="M3 6l2 1M3 10h2M3 13l2-1M13 6l-2 1M13 10h-2M13 13l-2-1M6 4l1-2h2l1 2" />
    </svg>
  ),
  idea: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5A4.5 4.5 0 0 0 3.5 6c0 2 1 3 2 4v1h5V10c1-1 2-2 2-4A4.5 4.5 0 0 0 8 1.5zM6 13.5h4M6.5 15h3" />
    </svg>
  ),
  q: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M6 6.5a2 2 0 1 1 3 1.5L8 9.5M8 11.5v.01" />
    </svg>
  ),
  road: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="3" rx="0.5" />
      <rect x="2" y="9" width="9" height="3" rx="0.5" />
    </svg>
  ),
  doc: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
      <path d="M9 2v3h3M6 8h4M6 11h4" />
    </svg>
  ),
  slack: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="currentColor">
      <path d="M5 9.5a1.5 1.5 0 0 1-3 0 1.5 1.5 0 0 1 3 0v0zm0-4a1.5 1.5 0 0 1 0 3H1.5a1.5 1.5 0 0 1 0-3H5zM7 5.5a1.5 1.5 0 0 1-3 0V2a1.5 1.5 0 0 1 3 0v3.5zm0 1A1.5 1.5 0 1 1 7 9.5h3.5a1.5 1.5 0 0 1 0-3H7zM9 6.5a1.5 1.5 0 0 1 3 0v3.5a1.5 1.5 0 0 1-3 0V6.5zm0 4a1.5 1.5 0 1 1 0 3H8a1.5 1.5 0 0 1-1.5-1.5v0a1.5 1.5 0 0 1 1.5-1.5h1z" />
    </svg>
  ),
  lock: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  ),
  globe: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13M8 1.5c2 2 3 4 3 6.5s-1 4.5-3 6.5C6 12.5 5 10.5 5 8s1-4.5 3-6.5z" />
    </svg>
  ),
  menu: (p: IconProps) => (
    <svg {...p} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4h12M2 8h12M2 12h12" />
    </svg>
  ),
};

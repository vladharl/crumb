type MarkProps = { width?: number; height?: number };

export const BrandMark = ({ width = 28, height = 28 }: MarkProps) => (
  <svg viewBox="0 0 32 32" width={width} height={height} aria-hidden="true">
    <circle cx="16" cy="5"  r="2.0" fill="var(--ember)" opacity="0.45" />
    <circle cx="26" cy="11" r="2.4" fill="var(--ember)" opacity="0.60" />
    <circle cx="27" cy="22" r="2.8" fill="var(--ember)" opacity="0.75" />
    <circle cx="18" cy="28" r="3.2" fill="var(--ember)" opacity="0.88" />
    <circle cx="7"  cy="22" r="3.6" fill="var(--ember)" />
  </svg>
);

// Padded viewBox so the edge-hugging dots have ~4px of breathing room and
// never get clipped — same fix as the widget launcher mark.
export const FaviconMark = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="-5 -5 42 42" width={size} height={size} aria-hidden="true" overflow="visible">
    <circle cx="16" cy="3"  r="3.0" fill="var(--ember)" opacity="0.40" />
    <circle cx="28" cy="11" r="3.5" fill="var(--ember)" opacity="0.60" />
    <circle cx="28" cy="22" r="4.0" fill="var(--ember)" opacity="0.78" />
    <circle cx="17" cy="29" r="4.5" fill="var(--ember)" opacity="0.92" />
    <circle cx="4"  cy="22" r="5.0" fill="var(--ember)" />
  </svg>
);

import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { BRAND } from "./scenes";

// The Crumb "Loop" mark — five ember dots curving into a comma, ported from
// packages/ui/src/brand.tsx (same coordinates + graded opacity). Animated as a
// staggered draw-on (each dot springs up in sequence) with a gentle rotation
// settle, echoing the widget launcher's boot shimmer.
const DOTS: Array<{ cx: number; cy: number; r: number; o: number }> = [
  { cx: 16, cy: 5,  r: 2.0, o: 0.45 },
  { cx: 26, cy: 11, r: 2.4, o: 0.60 },
  { cx: 27, cy: 22, r: 2.8, o: 0.75 },
  { cx: 18, cy: 28, r: 3.2, o: 0.88 },
  { cx: 7,  cy: 22, r: 3.6, o: 1.0 },
];

export const LoopMark: React.FC<{ size?: number; delay?: number }> = ({ size = 132, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Whole-mark settle: a small counter-rotation easing to 0°.
  const spin = spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 90 }, durationInFrames: 40 });
  const rotate = interpolate(spin, [0, 1], [-22, 0]);

  return (
    <svg
      viewBox="-4 -4 40 40"
      width={size}
      height={size}
      style={{ overflow: "visible", transform: `rotate(${rotate}deg)`, transformOrigin: "center" }}
      aria-hidden
    >
      {DOTS.map((d, i) => {
        const dotDelay = delay + i * 4;
        const s = spring({ frame: frame - dotDelay, fps, config: { damping: 12, stiffness: 120 }, durationInFrames: 30 });
        const scale = interpolate(s, [0, 1], [0, 1]);
        const opacity = interpolate(s, [0, 1], [0, d.o]);
        return (
          <circle key={i} cx={d.cx} cy={d.cy} r={d.r * scale} fill={BRAND.ember} opacity={opacity} />
        );
      })}
    </svg>
  );
};

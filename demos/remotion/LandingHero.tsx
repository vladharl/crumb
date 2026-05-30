import React from "react";
import {
  AbsoluteFill,
  Series,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { FPS, SCENES, BRAND, INTRO_SECONDS, OUTRO_SECONDS } from "./scenes";

const sec = (s: number) => Math.round(s * FPS);

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame, fps, config: { damping: 200 } });
  const y = interpolate(rise, [0, 1], [28, 0]);
  const opacity = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: BRAND.cream, alignItems: "center", justifyContent: "center" }}>
      <div style={{ transform: `translateY(${y}px)`, opacity, textAlign: "center", fontFamily: "Georgia, serif" }}>
        <div style={{ fontSize: 128, fontWeight: 800, color: BRAND.brown, letterSpacing: -3 }}>Crumb</div>
        <div style={{ fontSize: 42, color: BRAND.ember, marginTop: 6, fontStyle: "italic" }}>Follow the trail.</div>
        <div style={{ fontSize: 30, color: BRAND.warmGray, marginTop: 26, fontFamily: "Helvetica, Arial, sans-serif" }}>
          Open-source B2B feedback — capture, triage, ship.
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Window: React.FC<{ src: string }> = ({ src }) => {
  const frame = useCurrentFrame();
  // Slow ken-burns zoom over the scene.
  const scale = interpolate(frame, [0, 8 * FPS], [1.0, 1.05], { extrapolateRight: "clamp" });
  return (
    <div
      style={{
        width: 1280,
        borderRadius: 16,
        overflow: "hidden",
        boxShadow: "0 40px 120px rgba(74,46,31,0.30)",
        border: `1px solid ${BRAND.cream2}`,
        transform: `scale(${scale})`,
      }}
    >
      <div style={{ height: 36, background: BRAND.cream2, display: "flex", alignItems: "center", paddingLeft: 14, gap: 8 }}>
        {[BRAND.ember, BRAND.amber, BRAND.green].map((c) => (
          <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
        ))}
      </div>
      <OffthreadVideo src={src} muted style={{ width: 1280, display: "block" }} />
    </div>
  );
};

const Scene: React.FC<{ clip: string; title: string; caption: string }> = ({ clip, title, caption }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: BRAND.cream }}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity }}>
        <Window src={staticFile(`clips/${clip}`)} />
      </AbsoluteFill>
      <div style={{ position: "absolute", left: 96, bottom: 76, maxWidth: 820, opacity, fontFamily: "Helvetica, Arial, sans-serif" }}>
        <div style={{ display: "inline-block", background: BRAND.ember, color: "white", fontSize: 24, fontWeight: 700, padding: "6px 14px", borderRadius: 8 }}>
          {title}
        </div>
        <div style={{ marginTop: 14, fontSize: 36, lineHeight: 1.25, color: BRAND.brown, fontWeight: 600 }}>
          {caption}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: BRAND.brown, alignItems: "center", justifyContent: "center", fontFamily: "Georgia, serif" }}>
      <div style={{ textAlign: "center", opacity }}>
        <div style={{ fontSize: 104, fontWeight: 800, color: BRAND.cream }}>Crumb</div>
        <div style={{ fontSize: 38, color: BRAND.ember, marginTop: 12 }}>Self-host it. Own your feedback loop.</div>
        <div style={{ fontSize: 28, color: "#D9CBBA", marginTop: 30, fontFamily: "Helvetica, Arial, sans-serif" }}>
          crumb.localhostlabs.net
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const LandingHero: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: BRAND.cream }}>
      <Series>
        <Series.Sequence durationInFrames={sec(INTRO_SECONDS)}>
          <Intro />
        </Series.Sequence>
        {SCENES.map((s) => (
          <Series.Sequence key={s.clip} durationInFrames={sec(s.seconds)}>
            <Scene clip={s.clip} title={s.title} caption={s.caption} />
          </Series.Sequence>
        ))}
        <Series.Sequence durationInFrames={sec(OUTRO_SECONDS)}>
          <Outro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};

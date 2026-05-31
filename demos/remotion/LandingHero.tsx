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
import { DISPLAY, BODY } from "./fonts";
import { LoopMark } from "./LoopMark";

const sec = (s: number) => Math.round(s * FPS);

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // The wordmark + taglines rise in just after the Loop begins drawing.
  const rise = spring({ frame: frame - 14, fps, config: { damping: 200 } });
  const y = interpolate(rise, [0, 1], [22, 0]);
  const opacity = interpolate(frame, [14, 34], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: BRAND.cream, alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center" }}>
        <LoopMark size={120} />
        <div style={{ transform: `translateY(${y}px)`, opacity, marginTop: 30 }}>
          <div style={{ fontFamily: DISPLAY, fontSize: 128, fontWeight: 700, color: BRAND.brown, letterSpacing: -4, lineHeight: 1 }}>
            Crumb
          </div>
          <div style={{ fontFamily: DISPLAY, fontSize: 40, fontWeight: 500, color: BRAND.ember, marginTop: 10, letterSpacing: -0.5 }}>
            Follow the trail.
          </div>
          <div style={{ fontFamily: BODY, fontSize: 28, fontWeight: 400, color: BRAND.warmGray, marginTop: 26, letterSpacing: 0.2, maxWidth: 1000, marginLeft: "auto", marginRight: "auto", lineHeight: 1.35 }}>
            Dramatically shorten the loop between customers and product teams.
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// A browser "window" framing the captured clip. The ken-burns zoom spans the
// whole scene (driven by the scene's frame count) so it never finishes early
// and sits static.
const Window: React.FC<{ src: string; sceneFrames: number }> = ({ src, sceneFrames }) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, sceneFrames], [1.0, 1.045], { extrapolateRight: "clamp" });
  return (
    <div
      style={{
        width: 1180,
        borderRadius: 16,
        overflow: "hidden",
        boxShadow: "0 36px 110px rgba(74,46,31,0.28)",
        border: `1px solid ${BRAND.cream2}`,
        transform: `scale(${scale})`,
      }}
    >
      <div style={{ height: 34, background: BRAND.cream2, display: "flex", alignItems: "center", paddingLeft: 14, gap: 8 }}>
        {[BRAND.ember, BRAND.amber, BRAND.green].map((c) => (
          <div key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c }} />
        ))}
      </div>
      <OffthreadVideo src={src} muted style={{ width: 1180, display: "block" }} />
    </div>
  );
};

const Scene: React.FC<{
  clip: string; act: string; title: string; caption: string; seconds: number;
}> = ({ clip, act, title, caption, seconds }) => {
  const frame = useCurrentFrame();
  const sceneFrames = sec(seconds);
  const opacity = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  // Fade the whole scene out in its final ~12 frames for a clean cut.
  const outOpacity = interpolate(frame, [sceneFrames - 12, sceneFrames], [1, 0], { extrapolateLeft: "clamp" });
  return (
    <AbsoluteFill style={{ background: BRAND.cream, opacity: Math.min(opacity, outOpacity) }}>
      {/* Window sits in the upper area; caption band owns the bottom. */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", paddingTop: 70 }}>
        <Window src={staticFile(`clips/${clip}.webm`)} sceneFrames={sceneFrames} />
      </AbsoluteFill>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 210, background: `linear-gradient(to top, ${BRAND.cream} 62%, rgba(251,247,240,0))` }} />
      <div style={{ position: "absolute", left: 110, right: 110, bottom: 60, textAlign: "center" }}>
        <div style={{ display: "inline-block", background: BRAND.ember, color: "white", fontSize: 21, fontWeight: 600, padding: "5px 15px", borderRadius: 999, letterSpacing: 0.4, fontFamily: DISPLAY }}>
          {act}
        </div>
        <div style={{ marginTop: 14, fontSize: 46, lineHeight: 1.12, color: BRAND.brown, fontWeight: 600, letterSpacing: -1, fontFamily: DISPLAY }}>
          {title}
        </div>
        <div style={{ marginTop: 10, fontSize: 26, lineHeight: 1.3, color: BRAND.warmGray, fontFamily: BODY }}>
          {caption}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// The Outro mirrors the Intro exactly — same cream background, the Loop mark
// stacked above the wordmark, identical sizing — so the reel bookends cleanly.
// Only the supporting copy changes (closing message + positioning line).
const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame: frame - 14, fps, config: { damping: 200 } });
  const y = interpolate(rise, [0, 1], [22, 0]);
  const opacity = interpolate(frame, [14, 34], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: BRAND.cream, alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center" }}>
        <LoopMark size={120} />
        <div style={{ transform: `translateY(${y}px)`, opacity, marginTop: 30 }}>
          <div style={{ fontFamily: DISPLAY, fontSize: 128, fontWeight: 700, color: BRAND.brown, letterSpacing: -4, lineHeight: 1 }}>
            Crumb
          </div>
          <div style={{ fontFamily: DISPLAY, fontSize: 40, fontWeight: 500, color: BRAND.ember, marginTop: 10, letterSpacing: -0.5 }}>
            Shorten your feedback loop.
          </div>
          <div style={{ fontFamily: BODY, fontSize: 28, fontWeight: 400, color: BRAND.warmGray, marginTop: 26, letterSpacing: 0.2 }}>
            Open source · Cloud or self-hosted · crumb.localhostlabs.net
          </div>
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
            <Scene clip={s.clip} act={s.act} title={s.title} caption={s.caption} seconds={s.seconds} />
          </Series.Sequence>
        ))}
        <Series.Sequence durationInFrames={sec(OUTRO_SECONDS)}>
          <Outro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};

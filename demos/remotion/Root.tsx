import React from "react";
import { Composition } from "remotion";
import { LandingHero } from "./LandingHero";
import { FPS, SCENES, INTRO_SECONDS, OUTRO_SECONDS } from "./scenes";

const totalSeconds =
  INTRO_SECONDS + SCENES.reduce((sum, s) => sum + s.seconds, 0) + OUTRO_SECONDS;

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="LandingHero"
      component={LandingHero}
      durationInFrames={Math.round(totalSeconds * FPS)}
      fps={FPS}
      width={1920}
      height={1080}
    />
  );
};

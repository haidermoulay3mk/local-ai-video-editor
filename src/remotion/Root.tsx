import type React from "react";
import { Composition } from "remotion";
import { type CompositionProps, emptySpec } from "../shared/spec";
import { totalFrames } from "../shared/timeline";
import { Main } from "./Main";

const defaultProps: CompositionProps = {
  spec: emptySpec(),
  media: {},
  analysis: {},
  preview: false,
  sfxBaseUrl: "",
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Main"
    component={Main}
    durationInFrames={30}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={defaultProps}
    calculateMetadata={({ props }) => ({
      durationInFrames: totalFrames(props.spec),
      fps: props.spec.format.fps,
      width: props.spec.format.width,
      height: props.spec.format.height,
    })}
  />
);

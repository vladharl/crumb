import { InitiativeFeedbackSkeleton, InitiativeHeaderSkeleton } from "./InitiativeSkeletons";

export default function Loading() {
  return (
    <>
      <InitiativeHeaderSkeleton />
      <InitiativeFeedbackSkeleton />
    </>
  );
}

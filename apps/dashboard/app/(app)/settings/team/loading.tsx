import { SkeletonCard } from "@crumb/ui";

export default function Loading() {
  return (
    <>
      <SkeletonCard title="Team & roles" lines={5} />
      <SkeletonCard title="Invite a teammate" lines={2} />
    </>
  );
}

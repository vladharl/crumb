import { PageHead } from "@crumb/ui";
import { CapturesTile } from "./CapturesTile";

export const dynamic = "force-dynamic";

// "Meet customers where they are" triage queue. Feedback forwarded from email,
// Slack, or an extension lands here pending — map it to a customer account and
// turn it into a real item (or dismiss).
export default function CapturesPage() {
  return (
    <>
      <PageHead
        crumb="Triage"
        title="Captures"
        lede="Feedback forwarded from email, Slack, or an extension — map each to a customer and turn it into an item."
      />
      <CapturesTile />
    </>
  );
}

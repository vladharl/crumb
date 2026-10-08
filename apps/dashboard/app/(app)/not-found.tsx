import Link from "next/link";
import { PageHead } from "@crumb/ui";

export const metadata = { title: "Not found" };

// Shown inside the app shell when a thread, account or initiative calls
// notFound(): a stale email link, a deleted item, an id from another workspace.
export default function AppNotFound() {
  return (
    <>
      <PageHead
        crumb="Not found"
        title="We couldn't find that"
        lede="The link may be out of date, or it points to another workspace."
      />
      <div className="row gap-2">
        <Link href="/inbox" className="btn primary" style={{ textDecoration: "none" }}>Back to inbox</Link>
      </div>
    </>
  );
}

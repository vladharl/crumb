"use client";

import { useEffect, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHead } from "@crumb/ui";

// A page under the app shell threw. The topbar stays usable; this replaces only
// the page body. Logs only the digest, which matches the server's log line.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (error.digest) console.error(`Crumb page error, digest ${error.digest}`);
  }, [error.digest]);

  // reset() alone re-renders the same failed server payload; refresh fetches a
  // fresh one first, and the transition swaps both in together.
  const retry = () => startTransition(() => { router.refresh(); reset(); });

  return (
    <>
      <PageHead
        crumb="Something went wrong"
        title="This page didn't load"
        lede="Try again in a moment, or head back to the inbox."
      />
      <div className="row gap-2">
        <button type="button" className="btn primary" onClick={retry} disabled={pending}>
          {pending ? "Trying again…" : "Try again"}
        </button>
        <Link href="/inbox" className="btn" style={{ textDecoration: "none" }}>Back to inbox</Link>
      </div>
    </>
  );
}

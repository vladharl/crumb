"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Btn } from "@crumb/ui";
import { markAllRead } from "./actions";

export function MarkAllReadButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Btn
      sm
      variant="ghost"
      disabled={disabled || pending}
      onClick={() => startTransition(async () => {
        const res = await markAllRead();
        if (res.ok) router.refresh();
      })}
    >
      {pending ? "Marking…" : "Mark all read"}
    </Btn>
  );
}

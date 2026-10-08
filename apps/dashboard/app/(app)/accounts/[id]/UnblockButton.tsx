"use client";

import { useTransition } from "react";
import { Btn } from "@crumb/ui";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/action-error";
import { unblockPerson } from "./people-actions";

// Unblock on the account's people list, shown to admins only (the action
// checks again). The list re-renders without the Blocked badge once it lands.
export function UnblockButton({ accountUserId, name }: { accountUserId: string; name: string }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const unblock = () => start(async () => {
    const r = await unblockPerson(accountUserId).catch(() => null);
    if (r?.ok) toast.show({ message: `${name} can send feedback again.` });
    else toast.show({ message: errorMessage(r?.error), tone: "error" });
  });
  return (
    <Btn sm variant="ghost" onClick={unblock} disabled={pending} aria-label={`Unblock ${name}`}>
      Unblock
    </Btn>
  );
}

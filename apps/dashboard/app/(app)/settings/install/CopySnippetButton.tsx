"use client";

import { useState } from "react";
import { Btn, Ic } from "@crumb/ui";

export function CopySnippetButton({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Btn
      variant="primary"
      icon={<Ic.copy style={{ width: 12, height: 12 }} />}
      onClick={() => {
        navigator.clipboard.writeText(snippet).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }).catch(() => { /* clipboard blocked — silently ignore */ });
      }}
    >
      {copied ? "Copied" : "Copy snippet"}
    </Btn>
  );
}

"use client";

import { useState } from "react";
import { Btn, Ic } from "@crumb/ui";

export function CopySnippetButton({ snippet, label = "Copy snippet" }: { snippet: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Btn
      sm
      variant="ghost"
      icon={<Ic.copy style={{ width: 11, height: 11 }} />}
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        navigator.clipboard.writeText(snippet).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }).catch(() => { /* clipboard blocked — silently ignore */ });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Btn>
  );
}

// A labelled code sample with its own Copy button.
export function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div className="col gap-2">
      <div className="row gap-2 center">
        <span className="eyebrow">{title}</span>
        <div style={{ flex: 1 }} />
        <CopySnippetButton snippet={code} label={`Copy ${title}`} />
      </div>
      <div className="code">{code}</div>
    </div>
  );
}

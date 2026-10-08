"use client";

import { useState } from "react";
import { Snippet } from "./CopySnippetButton";

export function SigningExamples({ examples }: { examples: Array<{ label: string; code: string }> }) {
  const [active, setActive] = useState(0);
  const ex = examples[active]!;
  return (
    <div className="col gap-3">
      <div className="seg" role="tablist" aria-label="Server language" style={{ alignSelf: "flex-start", maxWidth: "100%", overflowX: "auto" }}>
        {examples.map((e, i) => (
          <button key={e.label} type="button" role="tab" aria-selected={i === active} onClick={() => setActive(i)}>
            {e.label}
          </button>
        ))}
      </div>
      <Snippet title={`${ex.label} example`} code={ex.code} />
    </div>
  );
}

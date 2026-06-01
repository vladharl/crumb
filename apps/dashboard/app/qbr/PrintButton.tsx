"use client";

import { Btn, Ic } from "@crumb/ui";

// Browser "Save as PDF" — no server-side PDF dependency. Hidden in the printed
// output via the .no-print class.
export function PrintButton() {
  return (
    <Btn sm variant="primary" icon={<Ic.doc style={{ width: 12, height: 12 }} />} onClick={() => window.print()}>
      Print / Save as PDF
    </Btn>
  );
}

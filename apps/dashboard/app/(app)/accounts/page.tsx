import { Suspense } from "react";
import { Btn, Ic, PageHead } from "@crumb/ui";
import { AccountsTableTile } from "./AccountsTableTile";
import { AccountsTableSkeleton } from "./AccountsTableSkeleton";

export const dynamic = "force-dynamic";

export default function AccountsListPage() {
  return (
    <>
      <PageHead
        crumb="Accounts"
        title="Customer accounts"
        lede="Everyone who's sent feedback, sorted by ARR. The view to open before every QBR."
        actions={
          <>
            <Btn icon={<Ic.doc style={{ width: 12, height: 12 }} />}>Export</Btn>
            <Btn variant="primary" icon={<Ic.plus style={{ width: 12, height: 12 }} />}>Add account</Btn>
          </>
        }
      />
      <Suspense fallback={<AccountsTableSkeleton />}>
        <AccountsTableTile />
      </Suspense>
    </>
  );
}

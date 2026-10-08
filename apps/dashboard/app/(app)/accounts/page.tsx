import { Suspense } from "react";
import { Btn, Ic, PageHead } from "@crumb/ui";
import { AccountsTableTile } from "./AccountsTableTile";
import { AccountsTableSkeleton } from "./AccountsTableSkeleton";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accounts" };

export default function AccountsListPage() {
  return (
    <>
      <PageHead
        crumb="Accounts"
        title="Customer accounts"
        lede="Everyone who's sent feedback, sorted by ARR. The view to open before every QBR."
        actions={
          <>
            <a href="/settings/account-mapping/export"><Btn icon={<Ic.doc style={{ width: 12, height: 12 }} />}>Export</Btn></a>
            <a href="/settings/account-mapping"><Btn variant="primary" icon={<Ic.plus style={{ width: 12, height: 12 }} />}>Add account</Btn></a>
          </>
        }
      />
      <Suspense fallback={<AccountsTableSkeleton />}>
        <AccountsTableTile />
      </Suspense>
    </>
  );
}

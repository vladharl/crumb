import { Suspense } from "react";
import { Ic, PageHead } from "@crumb/ui";
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
            {/* Links styled as buttons: a <button> inside <a> is invalid HTML. */}
            <a href="/settings/account-mapping/export" className="btn" style={{ textDecoration: "none" }}><Ic.doc style={{ width: 12, height: 12 }} />Export</a>
            <a href="/settings/account-mapping" className="btn primary" style={{ textDecoration: "none" }}><Ic.plus style={{ width: 12, height: 12 }} />Add account</a>
          </>
        }
      />
      <Suspense fallback={<AccountsTableSkeleton />}>
        <AccountsTableTile />
      </Suspense>
    </>
  );
}

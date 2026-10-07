// The customer account the Install page's "Try it" preview signs in as.
// GET /api/v1/me checks it so a preview never counts as the widget's first
// real ping (workspaces.widget_first_ping_at).
export const TEST_CUSTOMER_ACCOUNT = "Test customer (you)";

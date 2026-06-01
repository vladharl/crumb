import "server-only";

// Slack modal (views.open) for the `/crumb` slash command — capture feedback
// on behalf of a customer from inside Slack. The account select carries the
// account id as its value; the interactivity handler resolves it to a name (or
// treats a typed value as a new account name when there are no accounts yet).

const SLACK_API = "https://slack.com/api";

type AccountChoice = { id: string; name: string };

export function buildCaptureModal(accounts: AccountChoice[]): unknown {
  const accountElement = accounts.length > 0
    ? {
        type: "static_select",
        action_id: "v",
        placeholder: { type: "plain_text", text: "Pick an account" },
        options: accounts.slice(0, 100).map((a) => ({
          text: { type: "plain_text", text: a.name.slice(0, 75) },
          value: a.id,
        })),
      }
    : { type: "plain_text_input", action_id: "v", placeholder: { type: "plain_text", text: "Customer / company name" } };

  return {
    type: "modal",
    callback_id: "crumb_capture",
    title: { type: "plain_text", text: "New feedback" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "account", label: { type: "plain_text", text: "Customer account" }, element: accountElement },
      {
        type: "input", block_id: "type", label: { type: "plain_text", text: "Type" },
        element: {
          type: "static_select", action_id: "v",
          initial_option: { text: { type: "plain_text", text: "Question" }, value: "question" },
          options: [
            { text: { type: "plain_text", text: "Bug" }, value: "bug" },
            { text: { type: "plain_text", text: "Idea" }, value: "idea" },
            { text: { type: "plain_text", text: "Question" }, value: "question" },
          ],
        },
      },
      { type: "input", block_id: "title", label: { type: "plain_text", text: "Title" }, element: { type: "plain_text_input", action_id: "v" } },
      { type: "input", block_id: "body", optional: true, label: { type: "plain_text", text: "Details" }, element: { type: "plain_text_input", action_id: "v", multiline: true } },
      { type: "input", block_id: "email", optional: true, label: { type: "plain_text", text: "Customer email (optional)" }, element: { type: "plain_text_input", action_id: "v" } },
    ],
  };
}

export async function openView(botToken: string, triggerId: string, view: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(`${SLACK_API}/views.open`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${botToken}` },
      body: JSON.stringify({ trigger_id: triggerId, view }),
    });
    const data = (await resp.json()) as { ok?: boolean; error?: string };
    return { ok: !!data.ok, error: data.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "views_open_failed" };
  }
}

// Plain-language text for the error codes server actions (and the mutation
// cores behind them) return as { ok: false, error }, so a failed write tells
// people what happened instead of failing silently or showing a raw code.
// Client-safe: no server imports.

const FALLBACK = "Something went wrong. Please try again.";

export function errorMessage(code: string | undefined | null): string {
  // Some actions already return a sentence written for people (compose,
  // help, a few settings forms). Codes never contain spaces, so show those as-is.
  if (code && /\s/.test(code)) return code;
  switch (code) {
    case "forbidden":             return "You don't have permission to do that.";
    case "admin_only":            return "Only workspace admins can do that.";
    case "not_found":             return "We couldn't find that. It may have been deleted.";
    case "no_item":
    case "no_items":              return "Nothing was selected.";
    case "too_many_items":        return "Select up to 50 at a time.";
    case "bad_status":            return "That status isn't allowed.";
    case "bad_type":              return "That type isn't allowed.";
    case "bad_assignee":
    case "not_a_member":          return "That assignee isn't in this workspace.";
    case "bad_initiative":        return "That initiative isn't in this workspace.";
    case "no_initiatives":        return "Create an initiative first.";
    case "no_suggestion":         return "There's no suggestion to accept.";
    case "reason_required":       return "Add a short reason first.";
    case "empty":                 return "Write a message first.";
    case "title_required":
    case "missing_title":         return "Add a title first.";
    case "name_required":         return "Give it a name first.";
    case "name_too_long":         return "That name is too long.";
    case "description_too_long":  return "That description is too long.";
    case "already_decided":       return "This was already handled.";
    case "already_closed":        return "This loop is already closed.";
    case "same_item":             return "A request can't be merged into itself.";
    case "target_is_duplicate":   return "That request is already merged into another one. Merge into that one instead.";
    case "source_has_duplicates": return "Other requests are merged into this one. Unmerge them first.";
    case "not_merged":            return "This request isn't merged into anything.";
    case "rate_limited":          return "Too many attempts at once. Wait a moment and try again.";
    case "ai_cap_reached":        return "You've reached this month's AI usage limit. It resets on the 1st.";
    case "not_entitled":          return "This isn't available on your workspace.";
    case "plan_required":         return "Your current plan doesn't include this.";
    case "not_configured":        return "This isn't set up on this deployment.";
    case "draft_failed":          return "Couldn't write a draft. Try again, or write it yourself.";
    case "translate_failed":      return "Couldn't translate that. Try again.";
    default:                      return FALLBACK;
  }
}

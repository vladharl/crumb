# Product

## Register

product

## Users

**Primary — the vendor side.** Product managers and solutions/customer-success teams at B2B software companies who are tired of watching feedback vanish into a black hole. Their context is a working session: an inbox of incoming bugs, ideas, and questions that needs to be triaged, tied to the accounts and ARR behind it, moved through a status flow, pushed to engineering, and — the step most tools skip — answered back to the customer. They live in the dashboard several times a day; speed, density, and trust matter more than spectacle.

**Secondary — the end customer.** People using the vendor's product who drop feedback through the embedded widget without leaving the app, and who follow the public roadmap (Now / Next / Later) to see whether what they asked for is shipping. They meet Crumb only briefly and in-context; the experience has to feel native to whatever product it's embedded in.

**The job to be done:** close the feedback loop. Capture in context, prioritize by revenue rather than volume, ship, and tell the customer when it's done — one continuous loop, no spreadsheets and no screenshot-and-forget forms.

## Product Purpose

Crumb is an open-source B2B feedback platform: **embed, triage, ship, notify.** Customers send feedback from inside the product through an embedded widget, with their account and session already attached. Vendors triage it in an inbox where every item carries the account and ARR behind it, move it through a status flow, group items into public initiatives on a roadmap, and push the work to Linear / Jira / GitHub as AI-drafted tickets. When status moves or a reply is sent, the customer hears back — by email or in the widget. That closing step is the product's whole reason to exist.

It ships from one repo to two shapes: a free, AGPL **community** build for self-host, and a **cloud** build for the hosted tier (managed delivery, one-click integrations, AI clustering, session replay). Success looks like feedback that never goes dark: every customer note has a visible trail from "heard" to "the customer heard the outcome."

## Brand Personality

**Warm · attentive · quietly confident** — playful in microdoses.

The voice is plainspoken and a little wry, never corporate ("feedback vanish into a black hole," "the step most feedback tools quietly skip"). It earns trust through follow-through and calm craft rather than enterprise chrome or hype. The guiding metaphor runs through the whole product: **"Follow the trail."** Feedback is a crumb; the loop is a trail of crumbs from heard → answered → decided → closed, made literally visible as a row of growing dots. Personality shows in microdoses — a warm palette, a wink of copy, the trail motif — and then gets out of the way so the work can happen.

Emotional goals: the vendor feels *on top of it* (calm, in control, nothing slipping through); the customer feels *heard* (their note went somewhere real and will come back).

## Anti-references

The dashboard should explicitly NOT look like:

- **A generic SaaS dashboard** — cold blue/gray neutrals, gradient hero-metric cards, identical icon + heading + text card grids, a Linear-clone-by-default. Crumb's warmth and the trail motif are the whole differentiator; don't sand them off into template SaaS.
- **Enterprise heaviness** — Jira / Salesforce density and chrome: joyless, over-toolbarred, every pixel a control. Crumb is dense where the work needs it (inbox, tables) and calm everywhere else.
- **Trendy "AI tool" dark mode** — neon accents, glassmorphism, purple gradients. Crumb is light, warm, and on paper; glass and neon would break the material.
- **Childish or over-playful** — emoji-soup, bubbly over-rounded shapes, toy-like UI. The playfulness stays *micro*: it's a seasoning, not the dish.

## Design Principles

1. **Show the loop.** The product exists to close feedback loops, so the interface should always make the next step toward "the customer heard back" visible — open vs. closed, answered vs. unanswered, what's left to do. The trail of dots is this principle made literal.
2. **Revenue is the unit of priority.** Surface the account and the dollars behind every ask, not a raw upvote count. Prioritization UI should make the ARR legible at a glance.
3. **Capture in context, never re-ask.** The system already knows the account, session, and build. Never make a user restate what Crumb can attach automatically.
4. **Warm, not corporate.** Trust is earned through calm craft and follow-through, not density-as-seriousness. Choose the warm, human option over the enterprise-default one.
5. **Quiet confidence; the tool disappears into the task.** Familiarity is a feature here. Standard affordances, consistent vocabulary screen to screen, personality reserved for moments — not sprayed across every surface.

## Accessibility & Inclusion

Target **WCAG 2.1 AA.**

- Body text meets ≥4.5:1 against its surface; the primary ink (toasted brown) on cream clears this comfortably. Muted and tertiary tones are reserved for secondary, non-essential, or large text — never load-bearing body copy.
- Full keyboard operability with a visible focus treatment (ember focus ring / soft glow) on every interactive control.
- Color is never the only signal: status carries a dot **and** a label, the trail carries shape **and** an `aria-label`.
- `prefers-reduced-motion: reduce` has a real alternative for every animation (the skeleton shimmer and trail pulse already degrade to static); motion only ever conveys state, never decorates.

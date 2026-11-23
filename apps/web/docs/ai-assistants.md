# AI-assistant referral analytics

This document is the GA4-side setup for issue #213. The site code is in
`apps/web/app/utils/analytics.ts`, `apps/web/app/composables/useAnalyticsConsent.ts` and
`apps/web/app/plugins/analytics.client.ts`.

## What the site records

On the first page view where analytics is active, an external referrer or the landing page's
`utm_source` value is classified against:

```text
chatgpt.com, chat.openai.com, perplexity.ai, claude.ai, gemini.google.com,
copilot.microsoft.com, deepseek.com, grok.com, x.ai, you.com, phind.com, meta.ai
```

The first matching referral is stored once in first-party storage as `onv_ai_first_touch`:

```json
{
  "source": "chatgpt.com",
  "landing_path": "/apps/visual-studio-code",
  "timestamp": "2026-11-04T00:00:00.000Z"
}
```

- `landing_path` is a path only: no query string, fragment or user data.
- The record is never overwritten by later visits.
- Both the referrer and `utm_source` use the same host list, so an assistant that strips the
  referrer but keeps `?utm_source=chatgpt.com` is still recorded.
- Manual `page_view` events retain only standard `utm_*` campaign parameters in `page_location`;
  unrelated query data stays excluded. This lets GA4 attribute a referrer-stripped AI visit to
  its `utm_source` while keeping the first-party landing path free of query strings.
- The first GA event after delayed activation is the remembered landing `page_view`, including its
  original path, campaign query, title and language. If a client-side navigation happened first,
  that landing view is followed by the current page view and then `ai_referral_landing`.
- `ai_first_touch_source` and `ai_first_touch_landing` are set before that first `page_view`, so
  GA4 applies the user properties to both the landing and current page views.
- Page views are deduplicated by campaign-aware URL rather than pathname, so adding a UTM to the
  same page is recorded while unrelated query changes remain ignored.
- `page_referrer` is set explicitly: the landing hit uses the external referrer and a later hit
  uses the previous `page_location`. A delayed activation after a client-side navigation therefore
  does not attribute the current page back to the original AI site.
- Nothing is stored and no event is sent while analytics is disabled or opted out. If a visitor
  accepts later in the same page load, the original referrer, landing path and campaign query are
  still used.
- On activation, the site sets user properties `ai_first_touch_source` and
  `ai_first_touch_landing`, and sends `ai_referral_landing` once for a newly captured referral.
- The first-touch `ai_source` is attached to every subsequent key event.

## GA4 channel group

Create this once in GA4 Admin (it is reporting configuration, not site code):

1. **Admin → Data display → Channel groups → Create new channel group**.
2. Name it `AI Assistants`.
3. Add a channel named `AI Assistants` with the condition **Session source** matches regex:

   ```text
   chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|deepseek\.com|grok\.com|x\.ai|you\.com|phind\.com|meta\.ai|l\.meta\.ai
   ```

4. Save and make the group the primary channel group. Do not add a bare `bing\.com` condition;
   ordinary Bing referrals would be misclassified.
5. Drag the `AI Assistants` channel above `Referral` (preferably to the top). GA4 uses the first
   matching channel, so `chatgpt.com/referral` otherwise stays in `Referral` and never reaches the
   AI condition.

## Custom definitions

Create event-scoped custom dimensions for the event parameters that need reporting:

| Name              | Scope | Event parameter |
| ----------------- | ----- | --------------- |
| `AI source`       | Event | `ai_source`     |
| `AI landing path` | Event | `landing_path`  |
| `GitHub link`     | Event | `link_url`      |

Create user-scoped custom dimensions for the first-touch properties:

| Name                     | Scope | User property            |
| ------------------------ | ----- | ------------------------ |
| `AI first-touch source`  | User  | `ai_first_touch_source`  |
| `AI first-touch landing` | User  | `ai_first_touch_landing` |

## Key events

The site keeps the existing GA4 event names so current reports and audiences do not change when
there is no AI referrer. Map the proposed names to the existing ones:

| Proposed name           | Event sent by the site                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `app_download_click`    | `download_client` for the macOS client download CTA; `get_app` remains the package "Get" action |
| `install_command_copy`  | `copy_install_command`                                                                          |
| `github_outbound_click` | `github_outbound_click` (new)                                                                   |
| `ai_referral_landing`   | `ai_referral_landing` (new)                                                                     |

Mark `download_client`, `copy_install_command`, `github_outbound_click` and
`ai_referral_landing` as key events in **Admin → Events → Key events**. If package "Get" clicks
also need to count as app downloads, mark `get_app` as a key event too; it is unchanged.
`open_in_app` remains a non-key event.

## Verification

1. Open the site with GA4 DebugView available (GA Debugger extension or Tag Assistant).
2. Visit from an AI-assistant link (for example a `chatgpt.com` result) in a fresh profile or after
   clearing `onv_ai_first_touch` and `onv:analytics-consent`.
   Also test a link with `?utm_source=chatgpt.com` and no referrer.
3. Confirm `ai_referral_landing` appears once with `ai_source`, `landing_path` (no query string) and
   a `page_location` that keeps only campaign parameters.
4. Reload: the event must not repeat; the first-touch user properties remain.
5. Copy an install command and download the client; both key events should carry the same
   `ai_source`.
6. Click the GitHub repository link in the hero; `github_outbound_click` should carry `link_url`.
7. In GA4 reports, confirm the `AI Assistants` channel group separates these sessions from
   organic/direct.

If consent is declined, step 3 must produce no event and no `onv_ai_first_touch` entry; accepting
in footer settings should then produce one landing event using the original landing path.

// Beta disclaimer banner shared by every missions page. The missions section is
// still in beta: seed data is hand-curated and derived from SDE/ESI, so combat
// intel, EWAR, rewards, and damage profiles can be incomplete or out of date.
// We surface a one-time dismissible banner; the permanent BETA badge in the
// header carries the status after the banner is dismissed.
import { el } from "./dom-util.js";

const DISMISS_KEY = "missions:beta-notice:dismissed";

function isDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissal() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* private mode / storage disabled — the banner just reappears next load */
  }
}

// Inserts the beta notice directly under the sticky topbar. No-op once the user
// has dismissed it, or if the page has no topbar to anchor against.
export function installBetaNotice() {
  if (isDismissed()) return;
  const topbar = document.querySelector(".missions-topbar");
  if (!topbar) return;

  const banner = el("div", { class: "beta-notice", role: "note" }, [
    el("span", { class: "beta-notice-tag" }, "BETA"),
    el(
      "p",
      { class: "beta-notice-text" },
      "Mission data is hand-curated and still being verified — damage profiles, EWAR, rewards, and combat intel may be incomplete or inaccurate. Confirm anything mission-critical in game."
    ),
    el(
      "button",
      {
        type: "button",
        class: "beta-notice-dismiss",
        "aria-label": "Dismiss beta notice",
        onClick: () => {
          rememberDismissal();
          banner.remove();
        }
      },
      "Dismiss"
    )
  ]);

  topbar.after(banner);
}

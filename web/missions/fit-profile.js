import { el } from "./dom-util.js";
import { DAMAGE_ICON_PATHS } from "./missions-util.js";

const STORAGE_KEY = "eve-fit-profile-v1";
const DAMAGE_KEYS = ["em", "therm", "kin", "exp"];
const DAMAGE_FULL = { em: "EM", therm: "Thermal", kin: "Kinetic", exp: "Explosive" };
const DEFAULT_PROFILE = { enabled: false, em: 0, therm: 0, kin: 0, exp: 0 };

function clamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(99, Math.round(n)));
}

export function loadProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PROFILE };
    return {
      enabled: Boolean(parsed.enabled),
      em: clamp(parsed.em),
      therm: clamp(parsed.therm),
      kin: clamp(parsed.kin),
      exp: clamp(parsed.exp)
    };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

function saveProfile(profile) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    /* localStorage unavailable, drop silently */
  }
}

export function profileIsActive(profile) {
  return Boolean(profile && profile.enabled);
}

export function effectiveMultiplier(profile, key) {
  if (!profileIsActive(profile)) return 1;
  return 1 - clamp(profile[key]) / 100;
}

export function summarizeProfile(profile) {
  if (!profileIsActive(profile)) return null;
  return DAMAGE_KEYS.map((k) => clamp(profile[k])).join("/");
}

// DPS threat tier shared by the arc diagram and the detail combat ribbon.
export function dpsSeverity(dps) {
  if (dps >= 1500) return "danger";
  if (dps >= 500) return "warning";
  return "info";
}

const subscribers = new Set();

export function onProfileChange(handler) {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

function notify(profile) {
  for (const handler of subscribers) {
    try {
      handler(profile);
    } catch (error) {
      console.error("fit-profile subscriber failed", error);
    }
  }
}

function setProfile(profile) {
  saveProfile(profile);
  notify(profile);
}

function buildPopover(initial, close) {
  const popover = el("div", { class: "fit-profile-popover", role: "dialog", "aria-label": "Effective DPS fit profile" });
  const heading = el("header", { class: "fit-profile-heading" }, [
    el("strong", { text: "Fit profile" }),
    el("button", {
      class: "fit-profile-close",
      type: "button",
      "aria-label": "Close",
      onclick: close,
      text: "×"
    })
  ]);

  const description = el("p", {
    class: "fit-profile-desc",
    text: "Apply your hull resists to NPC damage. Values are percent (0–99)."
  });

  const enableLabel = el("label", { class: "fit-profile-toggle" }, [
    el("input", {
      type: "checkbox",
      id: "fit-profile-enabled",
      checked: initial.enabled ? "" : null
    }),
    el("span", { text: "Apply my resists" })
  ]);

  const grid = el("div", { class: "fit-profile-grid" });
  const inputs = {};
  for (const key of DAMAGE_KEYS) {
    const wrap = el("label", { class: `fit-profile-field damage-${key}` });
    wrap.append(el("img", {
      class: `eve-icon damage-icon damage-${key} fit-profile-icon`,
      src: DAMAGE_ICON_PATHS[key],
      alt: "",
      "aria-hidden": "true",
      decoding: "async",
      draggable: "false",
      width: 18,
      height: 18
    }));
    wrap.append(el("span", { class: "fit-profile-label", text: DAMAGE_FULL[key] }));
    const input = el("input", {
      type: "number",
      min: "0",
      max: "99",
      step: "1",
      inputmode: "numeric",
      value: String(initial[key] ?? 0)
    });
    inputs[key] = input;
    wrap.append(input);
    wrap.append(el("span", { class: "fit-profile-unit", text: "%" }));
    grid.append(wrap);
  }

  function currentProfile() {
    const next = {
      enabled: enableLabel.querySelector("input").checked
    };
    for (const key of DAMAGE_KEYS) {
      next[key] = clamp(inputs[key].value);
    }
    return next;
  }

  function emit() {
    const next = currentProfile();
    for (const key of DAMAGE_KEYS) inputs[key].value = String(next[key]);
    setProfile(next);
  }

  enableLabel.addEventListener("change", emit);
  for (const key of DAMAGE_KEYS) inputs[key].addEventListener("change", emit);

  const actions = el("div", { class: "fit-profile-actions" });
  const presetsLabel = el("span", { class: "fit-profile-presets-label", text: "Presets:" });
  const omni = el("button", {
    type: "button",
    class: "fit-profile-preset",
    text: "Omni 70%",
    onclick: () => {
      for (const key of DAMAGE_KEYS) inputs[key].value = "70";
      enableLabel.querySelector("input").checked = true;
      emit();
    }
  });
  const reset = el("button", {
    type: "button",
    class: "fit-profile-preset",
    text: "Reset",
    onclick: () => {
      for (const key of DAMAGE_KEYS) inputs[key].value = "0";
      enableLabel.querySelector("input").checked = false;
      emit();
    }
  });
  actions.append(presetsLabel, omni, reset);

  popover.append(heading, description, enableLabel, grid, actions);
  return popover;
}

export function installFitProfileButton(navContainer) {
  if (!navContainer) return;
  const wrap = el("div", { class: "fit-profile-wrap" });
  const button = el("button", {
    class: "button ghost fit-profile-button",
    type: "button",
    "aria-haspopup": "dialog",
    "aria-expanded": "false"
  });
  const dot = el("span", { class: "fit-profile-dot", "aria-hidden": "true" });
  const label = el("span", { class: "fit-profile-label-text", text: "Fit profile" });
  const value = el("span", { class: "fit-profile-value" });
  button.append(dot, label, value);
  wrap.append(button);

  let popover = null;

  function render() {
    const profile = loadProfile();
    const active = profileIsActive(profile);
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    const summary = summarizeProfile(profile);
    value.textContent = summary ? `· ${summary}` : "";
    value.hidden = !summary;
  }

  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", outsideClick);
    document.removeEventListener("keydown", escClose);
  }

  function outsideClick(event) {
    if (!popover) return;
    if (popover.contains(event.target) || button.contains(event.target)) return;
    closePopover();
  }

  function escClose(event) {
    if (event.key === "Escape") closePopover();
  }

  button.addEventListener("click", () => {
    if (popover) {
      closePopover();
      return;
    }
    popover = buildPopover(loadProfile(), closePopover);
    wrap.append(popover);
    button.setAttribute("aria-expanded", "true");
    setTimeout(() => {
      document.addEventListener("mousedown", outsideClick);
      document.addEventListener("keydown", escClose);
    }, 0);
  });

  onProfileChange(render);
  render();

  navContainer.prepend(wrap);
}

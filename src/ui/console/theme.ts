import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "quaymesh.theme";
const listeners = new Set<() => void>();
let volatilePref: ThemePref | undefined;
const media = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;

export function getThemePref(): ThemePref {
  if (volatilePref !== undefined) return volatilePref;
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function resolvedTheme(): Theme {
  const pref = getThemePref();
  if (pref !== "system") return pref;
  return media?.matches ? "dark" : "light";
}

export function applyTheme(): void {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  listeners.forEach((listener) => listener());
}

export function setThemePref(pref: ThemePref): void {
  volatilePref = undefined;
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    volatilePref = pref;
  }
  applyTheme();
}

media?.addEventListener?.("change", () => {
  if (getThemePref() === "system") applyTheme();
});

if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === KEY || event.key === null) { volatilePref = undefined; applyTheme(); }
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTheme(): { theme: Theme; pref: ThemePref } {
  const theme = useSyncExternalStore(subscribe, resolvedTheme);
  const pref = useSyncExternalStore(subscribe, getThemePref);
  return { theme, pref };
}

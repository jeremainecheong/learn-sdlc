"use client";
import { usePresentationViewSetting, writePresentationView } from "./presentation-view";

/**
 * The switch that hides learners' email addresses while the screen is shared.
 * It says plainly while it is on; it changes nothing else. It
 * draws the stored value, so it reads "on" only once the switch is read and on.
 */
export function PresentationToggle() {
  const on = usePresentationViewSetting() === true;
  return (
    <button
      type="button"
      className={`exp-button${on ? " exp-primary" : ""}`}
      aria-pressed={on}
      data-testid="presentation-view-toggle"
      title="Hides learners' email addresses on these pages while you share your screen. Nothing else changes."
      onClick={() => writePresentationView(!on)}
    >
      {on ? "Presentation view on" : "Presentation view"}
    </button>
  );
}

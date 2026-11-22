// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScrollRegion } from "@/components/experience/ScrollRegion";

let host: HTMLDivElement;
let root: Root;
let resize: () => void;
let disconnect: ReturnType<typeof vi.fn>;
let reduced = false;

beforeEach(() => {
  reduced = false;
  disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<ScrollRegion label="Phase evidence" hint="Scroll sideways for all phases."><div><a href="/feedback?submission=original">Original review</a></div></ScrollRegion>));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function measure(width: number, content: number, left = 0) {
  const viewport = host.querySelector<HTMLDivElement>('[role="region"]')!;
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: width },
    scrollWidth: { configurable: true, value: content },
    scrollLeft: { configurable: true, writable: true, value: left },
  });
  act(() => resize());
  return viewport;
}
function button(direction: "left" | "right") {
  return host.querySelector<HTMLButtonElement>(`[aria-label="Scroll Phase evidence ${direction}"]`)!;
}

it("keeps a fitting region uncluttered and preserves its exact evidence links", () => {
  const viewport = measure(800, 800);
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(viewport.getAttribute("aria-describedby")).toBeNull();
  expect(viewport.tabIndex).toBe(0);
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/feedback?submission=original");
});

it("announces overflow, connects buttons to the region, and disables only the reached edge", () => {
  const viewport = measure(250, 820);
  expect(button("left").disabled).toBe(true);
  expect(button("right").disabled).toBe(false);
  expect(button("right").getAttribute("aria-controls")).toBe(viewport.id);
  expect(document.getElementById(viewport.getAttribute("aria-describedby")!)?.textContent).toBe("Scroll sideways for all phases.");
  viewport.scrollLeft = 570;
  act(() => viewport.dispatchEvent(new Event("scroll")));
  expect(button("left").disabled).toBe(false);
  expect(button("right").disabled).toBe(true);
});

it("scrolls by less than a viewport, retains button focus, and leaves evidence untouched", () => {
  const viewport = measure(250, 820);
  const scroll = vi.fn();
  viewport.scrollBy = scroll;
  button("right").focus();
  act(() => button("right").click());
  expect(scroll).toHaveBeenCalledWith({ left: 200, behavior: "smooth" });
  expect(document.activeElement).toBe(button("right"));
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/feedback?submission=original");
});

it("uses immediate scrolling when reduced motion is requested", () => {
  reduced = true;
  const viewport = measure(250, 820, 200);
  const scroll = vi.fn();
  viewport.scrollBy = scroll;
  act(() => button("left").click());
  expect(scroll).toHaveBeenCalledWith({ left: -200, behavior: "auto" });
});

it("removes overflow controls when a resize makes the entire content readable", () => {
  measure(250, 820);
  expect(host.querySelectorAll("button")).toHaveLength(2);
  measure(900, 900);
  expect(host.querySelectorAll("button")).toHaveLength(0);
});

it("disconnects observation when the region is removed", () => {
  act(() => root.render(<p>Another page</p>));
  expect(disconnect).toHaveBeenCalledOnce();
});

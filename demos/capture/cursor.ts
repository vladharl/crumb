import type { Page, Locator } from "@playwright/test";

// Playwright clicks are instant and the OS cursor isn't captured, so raw
// footage looks robotic. We inject a soft "ember" cursor that follows the
// intermediate mousemove events Playwright emits during page.mouse.move({steps}).
// This is the single biggest quality lever for "app in action" recordings.
export async function installCursor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const ensure = () => {
      if (document.getElementById("__demo_cursor")) return;
      const dot = document.createElement("div");
      dot.id = "__demo_cursor";
      Object.assign(dot.style, {
        position: "fixed", top: "0", left: "0", width: "20px", height: "20px",
        marginLeft: "-10px", marginTop: "-10px", borderRadius: "50%",
        background: "rgba(226,125,58,0.25)", border: "2px solid #E27D3A",
        boxShadow: "0 2px 10px rgba(180,95,35,0.35)", pointerEvents: "none",
        zIndex: "2147483647", opacity: "0",
        transition: "opacity 0.2s ease-out, width 0.12s, height 0.12s",
        transform: "translate(-100px, -100px)",
      } as Partial<CSSStyleDeclaration>);
      document.documentElement.appendChild(dot);
      const move = (e: MouseEvent) => {
        dot.style.opacity = "1";
        dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        // Keep the dot painted above late-mounted layers (e.g. the widget's
        // shadow host) by re-appending it last among equal z-index siblings.
        if (dot.nextElementSibling) document.documentElement.appendChild(dot);
      };
      window.addEventListener("mousemove", move, { passive: true });
      window.addEventListener("mousedown", () => { dot.style.width = "13px"; dot.style.height = "13px"; }, { passive: true });
      window.addEventListener("mouseup", () => { dot.style.width = "20px"; dot.style.height = "20px"; }, { passive: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensure);
    else ensure();
  });
}

export async function pause(page: Page, ms = 700): Promise<void> {
  await page.waitForTimeout(ms);
}

// Glide the pointer to an absolute point in eased steps.
export async function glideTo(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y, { steps: 28 });
}

// Glide to (the top-ish of) a target element, scrolling it into view first so
// the move lands where the element actually is.
export async function moveTo(page: Page, locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await pause(page, 250);
  const box = await locator.boundingBox();
  if (!box) return;
  await glideTo(page, box.x + box.width / 2, box.y + Math.min(box.height / 2, 18));
  await pause(page, 320);
}

export async function demoClick(page: Page, locator: Locator): Promise<void> {
  await moveTo(page, locator);
  await locator.click();
  await pause(page, 600);
}

// Type with a visible per-character delay so the keystrokes read on camera.
export async function demoType(page: Page, locator: Locator, text: string): Promise<void> {
  await moveTo(page, locator);
  await locator.click();
  await locator.pressSequentially(text, { delay: 34 });
  await pause(page, 450);
}

// Smoothly bring an element into view (native smooth scroll on whatever
// scroll container actually holds it), then settle. Replaces abrupt
// page.mouse.wheel jumps that read as "weird scrolling" on camera.
export async function smoothScrollTo(page: Page, locator: Locator, block: ScrollLogicalPosition = "center"): Promise<void> {
  await locator.evaluate((el, b) => el.scrollIntoView({ behavior: "smooth", block: b as ScrollLogicalPosition }), block).catch(() => {});
  await pause(page, 900);
}

// A gentle "reading" scroll of the largest scrollable container on the page.
export async function readingScroll(page: Page, dy = 320): Promise<void> {
  await page.evaluate((delta) => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .filter((el) => el.scrollHeight - el.clientHeight > 40 && getComputedStyle(el).overflowY !== "visible");
    const target = candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
      ?? (document.scrollingElement as HTMLElement | null);
    target?.scrollBy({ top: delta, behavior: "smooth" });
  }, dy);
  await pause(page, 1000);
}

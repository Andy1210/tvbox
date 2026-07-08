import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { AVAILABLE_LOCALES } from "../lib/i18n";
import { SetupWizard } from "./SetupWizard";
import { setupRemote, remote, setFocus, getCurrentFocusKey } from "../test/remote";

// Regression cover for the on-device focus bugs: the Finish button must be
// focusable and fire completion (it used to have a mutating focusKey, which
// norigin left stale so Enter did nothing), and picking a language must move
// focus to the Next button so the choice is obviously registered. Focus is
// driven by key (no geometry needed); the async picker/WiFi fetches fail
// harmlessly in the test env, which also exercises the "never strand" fallback.
setupRemote();

// Flush the step-change setFocus effects (setTimeout 0) + pending microtasks.
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

describe("SetupWizard", () => {
  beforeEach(() => {
    localStorage.clear();
    // No shell in the test env: the picker/WiFi fetches would hit the network.
    // Reject cleanly so the lib catch-blocks return empty (also exercises the
    // "never strand focus" fallback) without noisy real connection attempts.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("no shell"))),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reaches the finish step and completing it marks setup done", async () => {
    const onDone = vi.fn();
    render(<SetupWizard onDone={onDone} />);
    await flush();

    // Language -> WiFi -> Timezone -> Keyboard -> Finish via the primary button.
    for (let s = 0; s < 4; s++) {
      act(() => setFocus("wizard-primary"));
      remote.ok();
      await flush();
    }

    act(() => setFocus("wizard-primary"));
    expect(getCurrentFocusKey()).toBe("wizard-primary");
    expect(onDone).not.toHaveBeenCalled();

    remote.ok(); // Finish
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("tvbox.setup.done")).toBe("1");
  });

  it("moves focus to Next after a language is picked", async () => {
    render(<SetupWizard onDone={vi.fn()} />);
    await flush();

    const first = "lang-" + AVAILABLE_LOCALES[0].id;
    act(() => setFocus(first));
    expect(getCurrentFocusKey()).toBe(first);

    remote.ok(); // picks the language -> onPicked moves focus to the primary button
    await flush();
    expect(getCurrentFocusKey()).toBe("wizard-primary");
  });
});

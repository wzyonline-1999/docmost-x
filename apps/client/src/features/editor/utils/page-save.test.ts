import { describe, expect, it, vi } from "vitest";
import {
  isPageSaveRequestFor,
  PAGE_SAVE_REQUEST_EVENT,
  requestPageSave,
} from "./page-save";

describe("page save requests", () => {
  it("dispatches the page identity with a save request", () => {
    const listener = vi.fn();
    document.addEventListener(PAGE_SAVE_REQUEST_EVENT, listener);

    requestPageSave("page-1");

    expect(listener).toHaveBeenCalledOnce();
    expect(isPageSaveRequestFor(listener.mock.calls[0][0], "page-1")).toBe(
      true,
    );
    document.removeEventListener(PAGE_SAVE_REQUEST_EVENT, listener);
  });

  it("does not match requests intended for another page", () => {
    const event = new CustomEvent(PAGE_SAVE_REQUEST_EVENT, {
      detail: { pageId: "page-2" },
    });

    expect(isPageSaveRequestFor(event, "page-1")).toBe(false);
    expect(
      isPageSaveRequestFor(new Event(PAGE_SAVE_REQUEST_EVENT), "page-1"),
    ).toBe(false);
  });
});

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_SAVE_REQUEST_EVENT } from "../utils/page-save";
import { usePageSaveHotkey } from "./use-page-save-hotkey";

function createSaveHotkey(): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: "KeyS",
    ctrlKey: true,
    key: "s",
  });
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("usePageSaveHotkey", () => {
  it.each([
    ["page body", () => document.body],
    ["input", () => document.createElement("input")],
    [
      "contenteditable",
      () => {
        const element = document.createElement("div");
        element.contentEditable = "true";
        return element;
      },
    ],
    ["toolbar control", () => document.createElement("button")],
  ])("handles the save shortcut from the %s", (_label, createTarget) => {
    const listener = vi.fn();
    document.addEventListener(PAGE_SAVE_REQUEST_EVENT, listener);
    renderHook(() => usePageSaveHotkey("page-1"));
    const target = createTarget();
    if (target !== document.body) document.body.appendChild(target);
    const event = createSaveHotkey();

    act(() => {
      target.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].detail).toEqual({ pageId: "page-1" });
    document.removeEventListener(PAGE_SAVE_REQUEST_EVENT, listener);
  });

  it("respects a nested tool that already handled the shortcut", () => {
    const listener = vi.fn();
    const target = document.createElement("button");
    target.addEventListener("keydown", (event) => event.preventDefault());
    document.body.appendChild(target);
    document.addEventListener(PAGE_SAVE_REQUEST_EVENT, listener);
    renderHook(() => usePageSaveHotkey("page-1"));
    const event = createSaveHotkey();

    act(() => {
      target.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    document.removeEventListener(PAGE_SAVE_REQUEST_EVENT, listener);
  });

  it("leaves the browser shortcut alone before a page is available", () => {
    const listener = vi.fn();
    document.addEventListener(PAGE_SAVE_REQUEST_EVENT, listener);
    renderHook(() => usePageSaveHotkey(undefined));
    const event = createSaveHotkey();

    act(() => {
      document.body.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    document.removeEventListener(PAGE_SAVE_REQUEST_EVENT, listener);
  });
});

import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SearchControl } from "./search-control";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SearchControl", () => {
  beforeAll(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("keeps the header search label on one line", () => {
    render(
      <MantineProvider>
        <SearchControl />
      </MantineProvider>,
    );

    const label = screen.getByText("Search");
    expect(label.style.whiteSpace).toBe("nowrap");
    expect(label.closest("button")).toBeTruthy();
  });
});

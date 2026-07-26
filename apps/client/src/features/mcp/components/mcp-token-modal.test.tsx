import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { McpTokenModal } from "./mcp-token-modal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const response = {
  token: "dm_mcp_secret-token",
  client: {
    id: "client-1",
    name: "Codex",
  },
  permissions: [],
};

describe("McpTokenModal", () => {
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

  it("requires an explicit storage confirmation before closing", () => {
    const onClose = vi.fn();

    render(
      <MantineProvider>
        <McpTokenModal response={response as never} onClose={onClose} />
      </MantineProvider>,
    );

    const done = screen.getByRole("button", { name: "Done" });
    expect((done as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("dm_mcp_secret-token")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I stored this token in a secure password manager.",
      }),
    );
    fireEvent.click(done);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requires confirmation again when a newly rotated token is shown", () => {
    const { rerender } = render(
      <MantineProvider>
        <McpTokenModal response={response as never} onClose={vi.fn()} />
      </MantineProvider>,
    );

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I stored this token in a secure password manager.",
      }),
    );
    expect(
      (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    rerender(
      <MantineProvider>
        <McpTokenModal
          response={{ ...response, token: "dm_mcp_rotated-token" } as never}
          onClose={vi.fn()}
        />
      </MantineProvider>,
    );

    expect(
      (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

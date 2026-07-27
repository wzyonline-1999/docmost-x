import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { McpConnectionGuide } from "./mcp-connection-guide";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/config", () => ({
  getMcpPublicUrl: () => "https://docs.example.com/mcp",
  getDeveloperApiBaseUrl: () => "https://docs.example.com/api/developer/v1",
}));

describe("McpConnectionGuide", () => {
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
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

  it("shows a safe placeholder for existing clients", () => {
    render(
      <MantineProvider>
        <McpConnectionGuide clientName="Codex" />
      </MantineProvider>,
    );

    expect(
      screen.getByText(/Existing tokens cannot be displayed again/),
    ).toBeTruthy();
    expect(screen.getAllByText(/YOUR_ACCESS_TOKEN/).length).toBeGreaterThan(0);
    expect(screen.getByText("https://docs.example.com/mcp")).toBeTruthy();
    expect(screen.getByText(/codex mcp add docmost/)).toBeTruthy();
    expect(
      screen.getByText(/--bearer-token-env-var DOCMOST_ACCESS_TOKEN/),
    ).toBeTruthy();
  });

  it("builds a ready-to-copy generic MCP configuration with a new token", () => {
    render(
      <MantineProvider>
        <McpConnectionGuide token="dmost_mcp_secret" clientName="Codex" />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByText("MCP JSON"));

    expect(screen.getByText(/Bearer dmost_mcp_secret/)).toBeTruthy();
    expect(
      screen.queryByText(/Existing tokens cannot be displayed again/),
    ).toBeNull();
  });

  it("shows the developer API endpoint and matching tool call", () => {
    render(
      <MantineProvider>
        <McpConnectionGuide token="dmost_mcp_secret" />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByText("HTTP API"));

    expect(
      screen.getByText("https://docs.example.com/api/developer/v1"),
    ).toBeTruthy();
    expect(
      screen.getByText(/api\/developer\/v1\/tools\/search_docs/),
    ).toBeTruthy();
  });
});

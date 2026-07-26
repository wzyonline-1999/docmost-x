import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAuditLog } from "./mcp-audit-log";

const mocks = vi.hoisted(() => ({
  auditParams: vi.fn(),
  clientsQuery: vi.fn(),
  logsQuery: vi.fn(),
  spacesQuery: vi.fn(),
}));

const auditLog = {
  id: "audit-1",
  workspaceId: "workspace-1",
  clientId: "client-1",
  actorUserId: "actor-1",
  event: "mcp.client.update",
  resourceType: "mcp_client",
  resourceId: "client-1",
  spaceId: null,
  toolName: "mcp_admin.update_client",
  requestId: "request-1",
  before: { name: "Before", status: "active" },
  after: { name: "After", status: "active" },
  metadata: { outcome: "completed" },
  ipAddress: "127.0.0.1",
  createdAt: "2026-07-01T00:00:00.000Z",
};

function makeLogsQuery() {
  return {
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
    data: {
      items: [auditLog],
      meta: {
        limit: 25,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    },
  };
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/mcp/queries/mcp-query", () => ({
  useMcpAuditLogsQuery: (params: unknown) => {
    mocks.auditParams(params);
    return mocks.logsQuery();
  },
  useMcpClientsQuery: () => mocks.clientsQuery(),
}));

vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpacesQuery: () => mocks.spacesQuery(),
}));

function renderAuditLog() {
  return render(
    <MantineProvider>
      <McpAuditLog />
    </MantineProvider>,
  );
}

describe("McpAuditLog", () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logsQuery.mockReturnValue(makeLogsQuery());
    mocks.clientsQuery.mockReturnValue({
      data: {
        items: [{ id: "client-1", name: "Codex" }],
      },
    });
    mocks.spacesQuery.mockReturnValue({
      data: {
        items: [{ id: "space-1", name: "Knowledge" }],
      },
    });
  });

  it("renders a structured field diff before the raw audit values", async () => {
    renderAuditLog();

    fireEvent.click(
      screen.getByRole("button", {
        name: "View details for mcp.client.update",
      }),
    );

    expect(await screen.findByText("Audit log details")).toBeTruthy();
    expect(screen.getByText("Changes")).toBeTruthy();
    expect(screen.getByText("name")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Before" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "After" })).toBeTruthy();
    expect(screen.getAllByText("Before").length).toBeGreaterThan(1);
    expect(screen.getAllByText("After").length).toBeGreaterThan(1);
    expect(screen.getByText("Raw before value")).toBeTruthy();
    expect(screen.getByText("Raw after value")).toBeTruthy();
  });

  it("uses cursor pagination for audit records", () => {
    const query = makeLogsQuery();
    query.data.meta.hasNextPage = true;
    query.data.meta.nextCursor = "next-audit";
    mocks.logsQuery.mockReturnValue(query);

    renderAuditLog();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(mocks.auditParams).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "next-audit", limit: 25 }),
    );
  });

  it("renders an explicit retry action after a request failure", () => {
    const refetch = vi.fn();
    mocks.logsQuery.mockReturnValue({
      ...makeLogsQuery(),
      data: undefined,
      isError: true,
      refetch,
    });

    renderAuditLog();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(refetch).toHaveBeenCalledOnce();
  });
});

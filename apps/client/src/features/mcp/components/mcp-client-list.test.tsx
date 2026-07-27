import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpClientList } from "./mcp-client-list";

const mocks = vi.hoisted(() => ({
  clientsParams: vi.fn(),
  clientsQuery: vi.fn(),
}));

function makeClientQuery() {
  return {
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
    data: {
      items: [
        {
          id: "client-1",
          name: "Codex",
          scope: "workspace",
          status: "active",
          actorUserId: "actor-1",
          ownerUserId: null,
          tokenLastFour: "1234",
          lastUsedAt: null,
          expiresAt: null,
          capabilities: {
            canEdit: true,
            canRotateToken: true,
            canDisable: true,
            canDelete: true,
          },
        },
      ],
      meta: {
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null as string | null,
        prevCursor: null as string | null,
      },
    },
  };
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/workspace/queries/workspace-query", () => ({
  useWorkspaceMembersQuery: () => ({
    data: { items: [{ id: "actor-1", name: "Test Actor" }] },
  }),
}));

vi.mock("@/features/mcp/queries/mcp-query", () => ({
  useMcpClientsQuery: (params: unknown) => {
    mocks.clientsParams(params);
    return mocks.clientsQuery();
  },
  useDeleteMcpClientMutation: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useDisableMcpClientMutation: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useRotateMcpClientTokenMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useUpdateMcpClientMutation: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
}));

function renderClientList() {
  return render(
    <MantineProvider>
      <McpClientList
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onConfigure={vi.fn()}
        onToken={vi.fn()}
      />
    </MantineProvider>,
  );
}

describe("McpClientList", () => {
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientsQuery.mockReturnValue(makeClientQuery());
  });

  it("shows client ownership, actor, and the explicit page count", () => {
    renderClientList();

    expect(screen.getByText(/Workspace client/)).toBeTruthy();
    expect(screen.getByText("Test Actor")).toBeTruthy();
    expect(screen.getByText(/This page shows 1 clients/)).toBeTruthy();
  });

  it("passes the next cursor to the client query", () => {
    const query = makeClientQuery();
    query.data.meta.hasNextPage = true;
    query.data.meta.nextCursor = "next-client";
    mocks.clientsQuery.mockReturnValue(query);

    renderClientList();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(mocks.clientsParams).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "next-client", limit: 25 }),
    );
  });

  it("debounces server-side client search and resets pagination", () => {
    vi.useFakeTimers();
    renderClientList();

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search access clients" }),
      {
        target: { value: "codex prod" },
      },
    );
    act(() => vi.advanceTimersByTime(300));

    expect(mocks.clientsParams).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: undefined,
        query: "codex prod",
      }),
    );
    vi.useRealTimers();
  });

  it("shows a retry action when the client list fails", () => {
    const refetch = vi.fn();
    mocks.clientsQuery.mockReturnValue({
      ...makeClientQuery(),
      data: undefined,
      isError: true,
      refetch,
    });

    renderClientList();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(refetch).toHaveBeenCalledOnce();
  });
});

import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpPermissions } from "./mcp-permissions";
import classes from "./mcp-settings.module.css";

const mocks = vi.hoisted(() => ({
  bulkMutate: vi.fn(),
  clientParams: vi.fn(),
  clientsQuery: vi.fn(),
  deleteMutate: vi.fn(),
  matrixQuery: vi.fn(),
  membersQuery: vi.fn(),
  openConfirmModal: vi.fn(
    (options: { children?: ReactNode; onConfirm?: () => void }) =>
      options.onConfirm?.(),
  ),
  spacesQuery: vi.fn(),
  spaceParams: vi.fn(),
  upsertMutate: vi.fn(),
}));

const emptyPermissions = {
  canSearch: false,
  canSemanticSearch: false,
  canRead: false,
  canCreate: false,
  canUpdate: false,
  canAppend: false,
  canDelete: false,
  canRestore: false,
  canIndex: false,
};

const allPermissions = Object.fromEntries(
  Object.keys(emptyPermissions).map((field) => [field, true]),
);

function makeClientsQuery(status = "active") {
  return {
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
    data: {
      items: [
        {
          actorUserId: "actor-1",
          actorUserName: "Test Actor",
          id: "client-1",
          name: "Codex",
          scope: "workspace",
          status,
          capabilities: { canManagePermissions: true },
          permissions: [],
        },
      ],
      meta: {
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    },
  };
}

function makeSpacesQuery() {
  return {
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
    data: {
      items: [
        { id: "space-1", name: "Space One", slug: "space-one" },
        { id: "space-2", name: "Space Two", slug: "space-two" },
      ],
      meta: {
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
      },
    },
  };
}

function makeMatrixQuery() {
  return {
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    data: {
      clientId: "client-1",
      actorUserId: "actor-1",
      actorAvailable: true,
      actorReason: null,
      spaces: [
        {
          spaceId: "space-1",
          actorRole: "admin",
          reason: null,
          ceiling: allPermissions,
          configured: {
            ...emptyPermissions,
            canSearch: true,
            canRead: true,
          },
          effective: {
            ...emptyPermissions,
            canSearch: true,
            canRead: true,
          },
          permission: {
            id: "permission-1",
            clientId: "client-1",
            spaceId: "space-1",
            ...emptyPermissions,
            canSearch: true,
            canRead: true,
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
        },
        {
          spaceId: "space-2",
          actorRole: "reader",
          reason: "read_only",
          ceiling: {
            ...emptyPermissions,
            canSearch: true,
            canSemanticSearch: true,
            canRead: true,
            canIndex: true,
          },
          configured: {
            ...emptyPermissions,
            canUpdate: true,
          },
          effective: emptyPermissions,
          permission: {
            id: "permission-2",
            clientId: "client-1",
            spaceId: "space-2",
            ...emptyPermissions,
            canUpdate: true,
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
        },
      ],
    },
  };
}

vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpacesQuery: (params: unknown) => {
    mocks.spaceParams(params);
    return mocks.spacesQuery();
  },
}));

vi.mock("@/features/workspace/queries/workspace-query", () => ({
  useWorkspaceMembersQuery: () => mocks.membersQuery(),
}));

vi.mock("@mantine/modals", () => ({
  modals: {
    openConfirmModal: mocks.openConfirmModal,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/mcp/queries/mcp-query", () => ({
  useMcpClientsQuery: (params: unknown) => {
    mocks.clientParams(params);
    return mocks.clientsQuery();
  },
  useMcpPermissionMatrixQuery: () => mocks.matrixQuery(),
  useUpsertMcpPermissionMutation: () => ({
    isPending: false,
    mutate: mocks.upsertMutate,
  }),
  useBulkUpsertMcpPermissionsMutation: () => ({
    isPending: false,
    mutate: mocks.bulkMutate,
  }),
  useDeleteMcpPermissionMutation: () => ({
    isPending: false,
    mutate: mocks.deleteMutate,
  }),
}));

function renderPermissions() {
  return render(
    <MantineProvider>
      <McpPermissions />
    </MantineProvider>,
  );
}

function setMediaMatches(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("McpPermissions", () => {
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
      value: vi.fn(),
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setMediaMatches(false);
    mocks.clientsQuery.mockReturnValue(makeClientsQuery());
    mocks.matrixQuery.mockReturnValue(makeMatrixQuery());
    mocks.membersQuery.mockReturnValue({
      data: { items: [{ id: "actor-1", name: "Test Actor" }] },
    });
    mocks.spacesQuery.mockReturnValue(makeSpacesQuery());
  });

  it("selects all eligible permissions without enabling permissions above the ceiling", () => {
    renderPermissions();

    const selectAll = screen.getByRole("checkbox", {
      name: "Select or clear all permissions",
    });
    expect((selectAll as HTMLInputElement).indeterminate).toBe(true);

    fireEvent.click(selectAll);

    expect(mocks.bulkMutate).toHaveBeenCalledOnce();
    const [updates] = mocks.bulkMutate.mock.calls[0];
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      spaceId: "space-1",
      canCreate: true,
      canUpdate: true,
    });
    expect(updates[1]).toMatchObject({
      spaceId: "space-2",
      canSearch: true,
      canSemanticSearch: true,
      canRead: true,
      canIndex: true,
    });
    expect(updates[1]).not.toHaveProperty("canCreate");
    expect(updates[1]).not.toHaveProperty("canUpdate");
  });

  it("selects a permission column without changing existing permissions", () => {
    renderPermissions();

    const selectSearch = screen.getByRole("checkbox", {
      name: "Select or clear all Search permissions",
    });
    expect((selectSearch as HTMLInputElement).indeterminate).toBe(true);

    fireEvent.click(selectSearch);

    expect(mocks.bulkMutate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          clientId: "client-1",
          spaceId: "space-2",
          canSearch: true,
          expectedUpdatedAt: "2026-07-02T00:00:00.000Z",
        }),
      ],
      expect.objectContaining({
        onError: expect.any(Function),
        onSuccess: expect.any(Function),
      }),
    );
    const [updates] = mocks.bulkMutate.mock.calls[0];
    expect(updates[0]).not.toHaveProperty("canRead");
    expect(updates[0]).not.toHaveProperty("canUpdate");
  });

  it("shows stale configured permissions and allows only clearing them", () => {
    renderPermissions();

    expect(
      screen.getByText(/1 configured permission is inactive/),
    ).toBeTruthy();

    const inactiveUpdate = screen.getByRole("checkbox", {
      name: "Update permission for Space Two (configured but inactive)",
    });
    expect((inactiveUpdate as HTMLInputElement).checked).toBe(true);
    expect((inactiveUpdate as HTMLInputElement).disabled).toBe(false);
    const describedBy = inactiveUpdate.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "read-only role",
    );

    const unavailableCreate = screen.getByRole("checkbox", {
      name: "Create permission for Space Two",
    });
    expect((unavailableCreate as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(inactiveUpdate);
    expect(mocks.upsertMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "client-1",
        spaceId: "space-2",
        canUpdate: false,
        expectedUpdatedAt: "2026-07-02T00:00:00.000Z",
      }),
      expect.objectContaining({
        onError: expect.any(Function),
        onSuccess: expect.any(Function),
      }),
    );
    const [update] = mocks.upsertMutate.mock.calls[0];
    expect(update).not.toHaveProperty("canRead");
    expect(update).not.toHaveProperty("canSearch");
  });

  it("clears stale and active grants together with the explicit page action", () => {
    renderPermissions();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear page permissions" }),
    );

    expect(mocks.openConfirmModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Confirm bulk removal",
      }),
    );
    const [updates] = mocks.bulkMutate.mock.calls[0];
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spaceId: "space-1",
          canSearch: false,
          canRead: false,
        }),
        expect.objectContaining({
          spaceId: "space-2",
          canUpdate: false,
        }),
      ]),
    );
  });

  it("keeps the matrix concise while preserving batch scope in confirmation", () => {
    renderPermissions();

    expect(screen.queryByText(/This client page shows/)).toBeNull();
    expect(
      screen.queryByText(
        /Effective access is the intersection of these settings/,
      ),
    ).toBeNull();
    expect(screen.queryByText(/Bulk actions affect only/)).toBeNull();
    expect(screen.queryByText(/This space page shows/)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear page permissions" }),
    );
    const [{ children }] = mocks.openConfirmModal.mock.calls[0];
    render(<MantineProvider>{children}</MantineProvider>);

    expect(screen.getByText(/spaces on this page/)).toBeTruthy();
    expect(screen.getByText(/affects this page only/)).toBeTruthy();
  });

  it("shows disabled client context before the permission matrix", () => {
    mocks.clientsQuery.mockReturnValue(makeClientsQuery("disabled"));

    renderPermissions();

    expect(screen.getByText("Client disabled")).toBeTruthy();
    expect(
      screen.getByText(
        "This client is disabled. Its permissions are visible but requests are rejected.",
      ),
    ).toBeTruthy();
  });

  it("renders an explicit retry action when spaces fail to load", () => {
    const refetch = vi.fn();
    mocks.spacesQuery.mockReturnValue({
      ...makeSpacesQuery(),
      data: undefined,
      isError: true,
      refetch,
    });

    renderPermissions();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(refetch).toHaveBeenCalledOnce();
  });

  it("uses a compact per-space editor at narrow widths", () => {
    setMediaMatches(true);

    const { container } = renderPermissions();

    expect(screen.getByText("Space One")).toBeTruthy();
    expect(container.querySelector(`.${classes.permissionTable}`)).toBeNull();
    const spaceControl = screen.getByRole("button", {
      name: /Space One space-one Representative user: Admin/,
    });
    fireEvent.click(spaceControl);
    expect(spaceControl.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector(`.${classes.compactPermissions}`),
    ).toBeTruthy();
  });

  it("passes the next client cursor to the server query", () => {
    const query = makeClientsQuery();
    query.data.meta.hasNextPage = true;
    query.data.meta.nextCursor = "next-client";
    mocks.clientsQuery.mockReturnValue(query);

    renderPermissions();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(mocks.clientParams).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "next-client", limit: 20 }),
    );
  });

  it("passes the next space cursor to the server query", () => {
    const query = makeSpacesQuery();
    query.data.meta.hasNextPage = true;
    query.data.meta.nextCursor = "next-space";
    mocks.spacesQuery.mockReturnValue(query);

    renderPermissions();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(mocks.spaceParams).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "next-space", limit: 20 }),
    );
  });

  it("shows saved feedback after a permission update succeeds", () => {
    renderPermissions();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Create permission for Space One",
      }),
    );
    const callbacks = mocks.upsertMutate.mock.calls[0][1];
    act(() => callbacks.onSuccess());

    expect(screen.getByText("All changes saved")).toBeTruthy();
  });

  it("centers every row control in a full-width wrapper", () => {
    const { container } = renderPermissions();

    const controlCells = container.querySelectorAll(
      `tbody .${classes.permissionCell}`,
    );

    expect(controlCells).toHaveLength(20);
  });
});

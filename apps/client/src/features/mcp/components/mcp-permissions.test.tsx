import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpPermissions } from "./mcp-permissions";
import classes from "./mcp-settings.module.css";

const mocks = vi.hoisted(() => ({
  bulkMutate: vi.fn(),
  deleteMutate: vi.fn(),
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

vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpacesQuery: () => ({
    isLoading: false,
    data: {
      items: [
        { id: "space-1", name: "Space One", slug: "space-one" },
        { id: "space-2", name: "Space Two", slug: "space-two" },
      ],
    },
  }),
}));

vi.mock("@/features/mcp/queries/mcp-query", () => ({
  useMcpClientsQuery: () => ({
    isLoading: false,
    data: {
      items: [
        {
          id: "client-1",
          name: "Codex",
          capabilities: { canManagePermissions: true },
          permissions: [],
        },
      ],
    },
  }),
  useMcpPermissionMatrixQuery: () => ({
    isLoading: false,
    isError: false,
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
          },
        },
      ],
    },
  }),
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
      canCreate: false,
      canUpdate: true,
    });
  });

  it("selects a permission column without changing existing permissions", () => {
    renderPermissions();

    const selectSearch = screen.getByRole("checkbox", {
      name: "Select or clear all Search permissions",
    });
    expect((selectSearch as HTMLInputElement).indeterminate).toBe(true);

    fireEvent.click(selectSearch);

    expect(mocks.bulkMutate).toHaveBeenCalledWith([
      expect.objectContaining({
        clientId: "client-1",
        spaceId: "space-2",
        canSearch: true,
        canRead: false,
        canUpdate: true,
      }),
    ]);
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
      }),
    );
  });

  it("centers every row control in a full-width wrapper", () => {
    const { container } = renderPermissions();

    const controlCells = container.querySelectorAll(
      `tbody .${classes.permissionCell}`,
    );

    expect(controlCells).toHaveLength(20);
  });
});

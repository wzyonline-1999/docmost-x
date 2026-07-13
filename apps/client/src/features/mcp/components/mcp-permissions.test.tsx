import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpPermissions } from "./mcp-permissions";

const mocks = vi.hoisted(() => ({
  bulkMutate: vi.fn(),
  deleteMutate: vi.fn(),
  upsertMutate: vi.fn(),
}));

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
          permissions: [
            {
              clientId: "client-1",
              spaceId: "space-1",
              canSearch: true,
              canSemanticSearch: false,
              canRead: true,
              canCreate: false,
              canUpdate: false,
              canAppend: false,
              canDelete: false,
              canRestore: false,
              canIndex: false,
            },
          ],
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

  it("selects all permissions with one update per changed space", () => {
    renderPermissions();

    const selectAll = screen.getByRole("checkbox", {
      name: "Select or clear all permissions",
    });
    expect((selectAll as HTMLInputElement).indeterminate).toBe(true);

    fireEvent.click(selectAll);

    expect(mocks.bulkMutate).toHaveBeenCalledOnce();
    const [updates] = mocks.bulkMutate.mock.calls[0];
    expect(updates).toHaveLength(2);
    expect(
      updates.every((update: Record<string, unknown>) =>
        Object.entries(update)
          .filter(([field]) => field.startsWith("can"))
          .every(([, checked]) => checked === true),
      ),
    ).toBe(true);
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
      }),
    ]);
  });
});

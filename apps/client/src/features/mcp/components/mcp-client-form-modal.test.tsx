import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpClientFormModal } from "./mcp-client-form-modal";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  memberParams: vi.fn(),
  membersQuery: vi.fn(),
  update: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("jotai", () => ({
  useAtomValue: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/features/user/atoms/current-user-atom", () => ({
  currentUserAtom: {},
}));

vi.mock("@/hooks/use-user-role", () => ({
  default: () => ({ isOwner: true }),
}));

vi.mock("@/features/workspace/queries/workspace-query", () => ({
  useWorkspaceMembersQuery: (params: unknown) => {
    mocks.memberParams(params);
    return mocks.membersQuery();
  },
}));

vi.mock("@/features/mcp/queries/mcp-query", () => ({
  useCreateMcpClientMutation: () => ({
    isPending: false,
    mutateAsync: mocks.create,
  }),
  useUpdateMcpClientMutation: () => ({
    isPending: false,
    mutateAsync: mocks.update,
  }),
}));

describe("McpClientFormModal", () => {
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
    mocks.membersQuery.mockReturnValue({
      data: {
        items: [{ id: "user-1", name: "Zeyu", email: "zeyu@example.com" }],
      },
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    mocks.create.mockResolvedValue({
      token: "dm_mcp_token",
      client: { id: "client-1", name: "Codex" },
      permissions: [],
    });
  });

  it("creates a localized personal client and uses focused member queries", async () => {
    const onClose = vi.fn();
    const onToken = vi.fn();

    render(
      <MantineProvider>
        <McpClientFormModal
          opened
          client={null}
          onClose={onClose}
          onToken={onToken}
        />
      </MantineProvider>,
    );

    expect(mocks.memberParams).toHaveBeenLastCalledWith({
      query: undefined,
      limit: 25,
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Codex knowledge" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Codex knowledge",
          scope: "personal",
          actorUserId: "user-1",
          permissions: [],
        }),
      ),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(onToken).toHaveBeenCalledWith(
      expect.objectContaining({ token: "dm_mcp_token" }),
    );
  });
});

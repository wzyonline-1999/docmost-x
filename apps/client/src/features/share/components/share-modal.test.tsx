import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ShareModal from "./share-modal";

const mocks = vi.hoisted(() => ({
  createShare: vi.fn(),
  deleteShare: vi.fn(),
  updateShare: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ pageSlug: "public-page-1", spaceSlug: "general" }),
}));

vi.mock("@/lib", () => ({
  extractPageSlugId: () => "page-1",
  getPageIcon: () => null,
}));

vi.mock("@/features/page/queries/page-query.ts", () => ({
  usePageQuery: () => ({ data: { id: "page-1" } }),
}));

vi.mock("@/features/share/queries/share-query.ts", () => ({
  useShareForPageQuery: () => ({ data: null }),
  useCreateShareMutation: () => ({
    isPending: false,
    mutateAsync: mocks.createShare,
  }),
  useDeleteShareMutation: () => ({
    isPending: false,
    mutateAsync: mocks.deleteShare,
  }),
  useUpdateShareMutation: () => ({
    isPending: false,
    mutateAsync: mocks.updateShare,
  }),
}));

vi.mock("@/features/share/components/share.module.css", () => ({
  default: {},
}));

vi.mock("@/components/common/copy.tsx", () => ({
  default: () => null,
}));

vi.mock("@/lib/config.ts", () => ({
  getAppUrl: () => "https://docs.example.com",
  isCloud: () => false,
}));

vi.mock("@/features/page/page.utils.ts", () => ({
  buildPageUrl: () => "/s/general/p/page-1",
}));

vi.mock("@/oss/hooks/use-trial.tsx", () => ({
  default: () => ({ isTrial: false }),
}));

vi.mock("jotai", () => ({
  useAtom: () => [{}],
}));

vi.mock("@/features/user/atoms/current-user-atom.ts", () => ({
  workspaceAtom: {},
}));

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useSpaceQuery: () => ({ data: { settings: {} } }),
}));

describe("ShareModal", () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createShare.mockResolvedValue({ id: "share-1" });
  });

  it("renders the page-header action and shares only the current page by default", async () => {
    render(
      <MantineProvider>
        <ShareModal readOnly={false} />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(await screen.findByRole("switch"));

    await waitFor(() =>
      expect(mocks.createShare).toHaveBeenCalledWith({
        pageId: "page-1",
        includeSubPages: false,
        searchIndexing: false,
      }),
    );
  });
});

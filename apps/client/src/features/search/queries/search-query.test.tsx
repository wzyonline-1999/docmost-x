import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUnifiedSearch } from "../hooks/use-unified-search";
import { useSearchSuggestionsQuery } from "./search-query";

const serviceMocks = vi.hoisted(() => ({
  searchAttachments: vi.fn(),
  searchPage: vi.fn(),
  searchPagesAdvanced: vi.fn(),
  searchShare: vi.fn(),
  searchSuggestions: vi.fn(),
}));

vi.mock("@/features/search/services/search-service", () => serviceMocks);
vi.mock("@/oss/hooks/use-feature", () => ({
  useHasFeature: () => false,
}));

describe("search query cache boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses suggestion filters as part of the query key", async () => {
    serviceMocks.searchSuggestions.mockImplementation(
      async ({ spaceId }: { spaceId?: string }) => ({
        pages: [{ id: spaceId }],
      }),
    );
    const { wrapper } = queryWrapper();
    const { result, rerender } = renderHook(
      ({ spaceId }) =>
        useSearchSuggestionsQuery({
          query: "runbook",
          spaceId,
          includePages: true,
        }),
      {
        initialProps: { spaceId: "space-1" },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.data?.pages?.[0]).toMatchObject({
        id: "space-1",
      });
    });
    rerender({ spaceId: "space-2" });
    await waitFor(() => {
      expect(result.current.data?.pages?.[0]).toMatchObject({
        id: "space-2",
      });
    });

    expect(serviceMocks.searchSuggestions).toHaveBeenCalledTimes(2);
    expect(serviceMocks.searchSuggestions).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "runbook", spaceId: "space-2" }),
    );
  });

  it("clears old results while a new directory scope is loading", async () => {
    let resolveSecond:
      | ((value: {
          items: Array<{ id: string }>;
          mode: string;
          semanticAvailable: boolean;
        }) => void)
      | undefined;
    serviceMocks.searchPagesAdvanced
      .mockResolvedValueOnce({
        items: [{ id: "page-from-first-scope" }],
        mode: "hybrid",
        semanticAvailable: true,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const { wrapper } = queryWrapper();
    const { result, rerender } = renderHook(
      ({ rootPageId }) =>
        useUnifiedSearch({
          query: "runbook",
          rootPageId,
          mode: "hybrid",
        }),
      {
        initialProps: { rootPageId: "root-1" },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.data?.items[0]).toMatchObject({
        id: "page-from-first-scope",
      });
    });
    rerender({ rootPageId: "root-2" });

    await waitFor(() => {
      expect(result.current.isFetching).toBe(true);
      expect(result.current.data).toBeUndefined();
    });

    resolveSecond?.({
      items: [{ id: "page-from-second-scope" }],
      mode: "hybrid",
      semanticAvailable: true,
    });
    await waitFor(() => {
      expect(result.current.data?.items[0]).toMatchObject({
        id: "page-from-second-scope",
      });
    });
  });
});

function queryWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return {
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

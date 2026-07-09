export function useBaseQuery(_pageId?: string | null) {
  return {
    data: null,
    isLoading: false,
    isPending: false,
    isError: false,
  };
}

export function useConvertPageToBaseMutation() {
  return {
    mutate: (_variables?: any) => undefined,
    mutateAsync: async (_variables?: any) => undefined,
    isPending: false,
  };
}

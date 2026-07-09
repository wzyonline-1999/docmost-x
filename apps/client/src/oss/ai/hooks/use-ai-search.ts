export function useAiSearch() {
  return {
    data: null,
    isPending: false,
    mutate: (_variables?: any) => undefined,
    reset: () => undefined,
    error: null,
    streamingAnswer: "",
    streamingSources: [],
    clearStreaming: () => undefined,
  };
}

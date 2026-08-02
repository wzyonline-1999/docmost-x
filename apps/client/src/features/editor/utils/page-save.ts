export const PAGE_SAVE_REQUEST_EVENT = "docmost:page-save-request";

export interface PageSaveRequestDetail {
  pageId: string;
}

export type PageSaveRequestEvent = CustomEvent<PageSaveRequestDetail>;

export function requestPageSave(pageId: string): void {
  document.dispatchEvent(
    new CustomEvent<PageSaveRequestDetail>(PAGE_SAVE_REQUEST_EVENT, {
      detail: { pageId },
    }),
  );
}

export function isPageSaveRequestFor(
  event: Event,
  pageId: string,
): event is PageSaveRequestEvent {
  return (
    event instanceof CustomEvent &&
    event.type === PAGE_SAVE_REQUEST_EVENT &&
    event.detail?.pageId === pageId
  );
}

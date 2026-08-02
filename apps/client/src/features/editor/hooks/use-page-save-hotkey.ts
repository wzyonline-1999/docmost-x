import { useHotkeys } from "@mantine/hooks";
import { requestPageSave } from "@/features/editor/utils/page-save";

export function usePageSaveHotkey(pageId: string | undefined): void {
  useHotkeys(
    [
      [
        "mod+S",
        (event) => {
          if (event.defaultPrevented || !pageId) return;

          event.preventDefault();
          requestPageSave(pageId);
        },
        { preventDefault: false, usePhysicalKeys: true },
      ],
    ],
    [],
    true,
  );
}

import "@/features/editor/styles/index.css";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Heading } from "@tiptap/extension-heading";
import { Text } from "@tiptap/extension-text";
import { Placeholder } from "@tiptap/extension-placeholder";
import { useAtomValue } from "jotai";
import {
  currentPageEditModeAtom,
  pageEditorAtom,
  titleSyncFeedbackAtom,
  titleEditorAtom,
} from "@/features/editor/atoms/editor-atoms";
import { useDebouncedCallback, getHotkeyHandler } from "@mantine/hooks";
import { useAtom, useSetAtom } from "jotai";
import { History } from "@tiptap/extension-history";
import { buildPageUrl } from "@/features/page/page.utils.ts";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import EmojiCommand from "@/features/editor/extensions/emoji-command.ts";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import { searchSpotlight } from "@/features/search/constants.ts";
import { platformModifierKey } from "@/lib";
import {
  getPendingTitle,
  persistPendingTitle,
  requestPendingTitleSync,
  TitleSyncScope,
} from "@/features/editor/utils/title-sync-storage.ts";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";

export interface TitleEditorProps {
  pageId: string;
  slugId: string;
  title: string;
  spaceSlug: string;
  editable: boolean;
  isBase?: boolean;
}

export function TitleEditor({
  pageId,
  slugId,
  title,
  spaceSlug,
  editable,
  isBase,
}: TitleEditorProps) {
  const { t } = useTranslation();
  const pageEditor = useAtomValue(pageEditorAtom);
  const [, setTitleEditor] = useAtom(titleEditorAtom);
  const currentUser = useAtomValue(currentUserAtom);
  const setTitleSyncFeedback = useSetAtom(titleSyncFeedbackAtom);
  const navigate = useNavigate();
  const [activePageId, setActivePageId] = useState(pageId);
  const currentPageEditMode = useAtomValue(currentPageEditModeAtom);
  const accountId = currentUser?.user.id;
  const workspaceId = currentUser?.workspace.id;
  const syncScope = useMemo<TitleSyncScope | null>(() => {
    if (!accountId || !workspaceId) return null;
    return {
      accountId,
      workspaceId,
    };
  }, [accountId, workspaceId]);
  const initialTitle = useMemo(
    () =>
      syncScope ? (getPendingTitle(syncScope, pageId)?.title ?? title) : title,
    [pageId, syncScope, title],
  );
  const requestDebouncedTitleSync = useDebouncedCallback(
    requestPendingTitleSync,
    500,
  );

  const queueTitleUpdate = useCallback(
    (nextTitle: string) => {
      if (!syncScope || activePageId !== pageId) return;

      persistPendingTitle(syncScope, pageId, nextTitle);
      setTitleSyncFeedback({
        status: navigator.onLine ? "syncing" : "offline",
        pageId,
      });
      requestDebouncedTitleSync();
    },
    [
      activePageId,
      pageId,
      requestDebouncedTitleSync,
      setTitleSyncFeedback,
      syncScope,
    ],
  );

  const titleEditor = useEditor({
    extensions: [
      Document.extend({
        content: "heading",
      }),
      Heading.configure({
        levels: [1],
      }),
      Text,
      Placeholder.configure({
        placeholder: isBase ? t("Untitled base") : t("Untitled"),
        showOnlyWhenEditable: false,
      }),
      History.configure({
        depth: 20,
      }),
      EmojiCommand,
    ],
    onCreate({ editor }) {
      if (editor) {
        // @ts-ignore
        setTitleEditor(editor);
        setActivePageId(pageId);
      }
    },
    onUpdate({ editor }) {
      queueTitleUpdate(editor.getText());
    },
    editable: editable,
    content: initialTitle,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        "aria-label": t("Page title"),
      },
      handleDOMEvents: {
        keydown: (_view, event) => {
          if (platformModifierKey(event) && event.code === "KeyS") {
            event.preventDefault();
            return true;
          }
          if (platformModifierKey(event) && event.code === "KeyK") {
            searchSpotlight.open();
            return true;
          }
        },
      },
    },
  });

  useEffect(() => {
    // Canonicalize only the path slug; keep query params (?row=, ?view=
    // deep links) and the hash anchor intact.
    const pageSlug = buildPageUrl(spaceSlug, slugId, title);
    navigate(
      {
        pathname: pageSlug,
        search: window.location.search,
        hash: window.location.hash,
      },
      { replace: true },
    );
  }, [title]);

  useEffect(() => {
    if (!titleEditor || titleEditor.isDestroyed) return;
    const pendingTitle = syncScope ? getPendingTitle(syncScope, pageId) : null;
    const nextTitle = pendingTitle?.title ?? title;
    if (nextTitle !== titleEditor.getText()) {
      titleEditor.commands.setContent(nextTitle, { emitUpdate: false });
    }
  }, [pageId, syncScope, title, titleEditor]);

  useEffect(() => {
    if (!syncScope) return;
    const pendingTitle = getPendingTitle(syncScope, pageId);
    if (!pendingTitle) return;

    setTitleSyncFeedback({
      status:
        pendingTitle.status === "blocked"
          ? "failed"
          : navigator.onLine
            ? "syncing"
            : "offline",
      pageId,
    });
    if (pendingTitle.status === "pending") requestPendingTitleSync();
  }, [pageId, setTitleSyncFeedback, syncScope]);

  useEffect(() => {
    setTimeout(() => {
      // guard against Cannot access view['hasFocus'] error
      if (!titleEditor?.isInitialized) return;
      titleEditor?.commands?.focus("end");
    }, 300);
  }, [titleEditor]);

  useEffect(() => {
    return () => {
      if (syncScope && getPendingTitle(syncScope, pageId)) {
        requestPendingTitleSync();
      }
    };
  }, [pageId, syncScope]);

  useEffect(() => {
    if (!titleEditor) return;
    titleEditor.setEditable(
      editable && currentPageEditMode === PageEditMode.Edit,
    );
  }, [currentPageEditMode, titleEditor, editable]);

  const openSearchDialog = () => {
    const event = new CustomEvent("openFindDialogFromEditor", {});
    document.dispatchEvent(event);
  };

  function handleTitleKeyDown(event: any) {
    if (!titleEditor || !pageEditor || event.shiftKey) return;

    // Prevent focus shift when IME composition is active
    // `keyCode === 229` is added to support Safari where `isComposing` may not be reliable
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;

    const { key } = event;
    const { $head } = titleEditor.state.selection;

    if (key === "Enter") {
      event.preventDefault();

      const { $from } = titleEditor.state.selection;
      const titleText = titleEditor.getText();

      // Get the text offset within the heading node (not document position)
      const textOffset = $from.parentOffset;

      const textAfterCursor = titleText.slice(textOffset);

      // Delete text after cursor from title (this will be in undo history)
      const endPos = titleEditor.state.doc.content.size;
      if (textAfterCursor) {
        titleEditor.commands.deleteRange({ from: $from.pos, to: endPos });
      }

      // Don't add to history so undo in page editor won't remove this split
      pageEditor
        .chain()
        .command(({ tr }) => {
          tr.setMeta("addToHistory", false);
          return true;
        })
        .insertContentAt(0, {
          type: "paragraph",
          content: textAfterCursor
            ? [{ type: "text", text: textAfterCursor }]
            : undefined,
        })
        .focus("start")
        .run();
      return;
    }

    const shouldFocusEditor =
      key === "ArrowDown" || (key === "ArrowRight" && !$head.nodeAfter);

    if (shouldFocusEditor) {
      pageEditor.commands.focus("start");
    }
  }

  return (
    <div className="page-title">
      <EditorContent
        editor={titleEditor}
        onKeyDown={(event) => {
          // First handle the search hotkey
          getHotkeyHandler([["mod+F", openSearchDialog]])(event);

          // Then handle other key events
          handleTitleKeyDown(event);
        }}
      />
    </div>
  );
}

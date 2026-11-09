import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { type RefObject, useImperativeHandle } from "react";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { type PromptStashEntry, usePromptStashStore } from "../../promptStashStore";
import { useComposerStash } from "./useComposerStash";

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) };
});

const ENV = EnvironmentId.make("env-1");
const EDIT_TARGET = DraftId.make("queued-edit:env-1:thread-1:run-1");

type StashHook = ReturnType<typeof useComposerStash>;

function Harness(props: { hookRef: RefObject<StashHook | null>; prompt: string }) {
  const promptRef = { current: props.prompt };
  const result = useComposerStash({
    environmentId: ENV,
    composerDraftTarget: EDIT_TARGET,
    promptRef,
    readAttachmentDraft: () => ({ images: [], files: [] }),
    readTerminalContexts: () => [],
    routeThreadRef: { environmentId: ENV, threadId: ThreadId.make("thread-1") },
    projectSelectionRequired: false,
    pendingUserInputs: [],
    activePendingProgress: null,
    prompt: props.prompt,
    composerMenuOpen: false,
    isComposerCollapsedMobile: false,
    isEditingQueuedMessage: true,
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    composerThreadContexts: [],
    attachmentTargetKey: EDIT_TARGET,
    isComposerDraftTargetOpen: () => true,
    composerEditorRef: { current: null },
    isRevertingCheckpoint: () => false,
    pendingThreadImportsRef: { current: new Map() },
    setComposerCursor: () => {},
    setComposerTrigger: () => {},
    importContextRecords: () => new Map(),
    expandMobileComposer: () => {},
  });
  useImperativeHandle(props.hookRef, () => result);
  return null;
}

const editPrompt = () => useComposerDraftStore.getState().getComposerDraft(EDIT_TARGET)?.prompt;

// The composer shows the edit's own draft, so the stash must not save it aside or restore into it.
it("leaves an open queued-message edit alone on stash and restore", async () => {
  usePromptStashStore.setState({ entries: [] });
  useComposerDraftStore.getState().setPrompt(EDIT_TARGET, "edited text");
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const hook: { current: StashHook | null } = { current: null };
  await using _screen = await render(<Harness hookRef={hook} prompt="edited text" />);

  await userEvent.keyboard("{Control>}s{/Control}");
  expect(usePromptStashStore.getState().entries).toEqual([]);
  expect(editPrompt()).toBe("edited text");

  const entry: PromptStashEntry = {
    id: "stashed",
    createdAt: "2026-10-01T00:00:00.000Z",
    prompt: "stashed prompt",
    attachments: [],
    droppedImageNames: [],
  };
  usePromptStashStore.setState({ entries: [entry] });
  await act(() => hook.current?.restoreStashEntryStable(entry));
  expect(usePromptStashStore.getState().entries).toEqual([entry]);
  expect(editPrompt()).toBe("edited text");
});

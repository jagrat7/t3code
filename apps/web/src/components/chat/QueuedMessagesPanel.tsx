import { ChevronDownIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import type { QueuedComposerMessage } from "../../queuedMessageStore";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

/**
 * Zed-style message queue, docked to the composer as a banner attachment.
 * Each row shows the message and discard / edit / Send now actions.
 * Editing moves the message back into the composer.
 */
export const QueuedMessagesPanel = memo(function QueuedMessagesPanel({
  messages,
  showEnterToSendHint,
  onSendNow,
  onEdit,
  onDiscard,
  onClearAll,
}: {
  messages: ReadonlyArray<QueuedComposerMessage>;
  /** Enter on the empty composer fast-tracks the front entry — hint it on Send Now. */
  showEnterToSendHint: boolean;
  onSendNow: (id: string) => void;
  /** Takes the message off the queue and puts its content back in the composer. */
  onEdit: (id: string) => void;
  /** Removes the message from the queue without keeping its content. */
  onDiscard: (id: string) => void;
  onClearAll: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (messages.length === 0) {
    return null;
  }
  return (
    <ComposerBanner.Attachment
      data-chat-composer-queue="true"
      data-chat-composer-collapsed-controls="true"
    >
      <ComposerBanner.Root>
        <div
          className={cn(
            "flex items-center justify-between gap-2 px-2 py-1",
            expanded && "border-b border-(--chat-composer-attached-outline)",
          )}
        >
          <button
            type="button"
            aria-expanded={expanded}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setExpanded((current) => !current)}
            className="flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 flex-none transition-transform duration-150",
                !expanded && "-rotate-90",
              )}
            />
            <span className="truncate">{messages.length} queued</span>
          </button>
          <Button
            size="micro"
            variant="ghost-muted"
            className="shrink-0"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onClearAll}
          >
            Clear all
          </Button>
        </div>
        {expanded ? (
          <ComposerBanner.Scroll className="max-h-40">
            {messages.map((message, index) => (
              <QueuedMessageRow
                key={message.id}
                message={message}
                isNext={index === 0}
                showEnterToSendHint={index === 0 && showEnterToSendHint}
                onSendNow={onSendNow}
                onEdit={onEdit}
                onDiscard={onDiscard}
              />
            ))}
          </ComposerBanner.Scroll>
        ) : null}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});

function QueuedMessageRow({
  message,
  isNext,
  showEnterToSendHint,
  onSendNow,
  onEdit,
  onDiscard,
}: {
  message: QueuedComposerMessage;
  isNext: boolean;
  showEnterToSendHint: boolean;
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  const attachmentCount = message.images.length + message.files.length;
  const contextCount =
    message.terminalContexts.length +
    message.previewAnnotations.length +
    message.reviewComments.length;
  const text = message.prompt.trim();
  return (
    <div
      className="group/queue-entry flex items-center gap-1 px-2 py-1.5 not-last:border-b not-last:border-(--chat-composer-attached-outline)"
      data-queued-message-id={message.id}
    >
      <div className="min-w-0 flex-1 text-sm/5">
        {text.length > 0 ? (
          <div className="whitespace-pre-wrap break-words text-foreground/90">{text}</div>
        ) : null}
        {attachmentCount > 0 || contextCount > 0 ? (
          <div className={cn("text-muted-foreground text-xs", text.length > 0 && "mt-0.5")}>
            {[
              attachmentCount > 0
                ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
                : null,
              contextCount > 0
                ? `${contextCount} context item${contextCount === 1 ? "" : "s"}`
                : null,
            ]
              .filter(Boolean)
              .join(", ")}
          </div>
        ) : null}
      </div>
      <div
        className={cn(
          "flex flex-none items-center justify-end gap-0.5",
          !isNext &&
            "opacity-0 transition-opacity duration-150 group-hover/queue-entry:opacity-100 group-focus-within/queue-entry:opacity-100 [@media(pointer:coarse)]:opacity-100",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                className="size-6"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => onDiscard(message.id)}
                aria-label="Remove from queue"
              />
            }
          >
            <Trash2Icon className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="top">Remove from queue</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                className="size-6"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => onEdit(message.id)}
                aria-label="Edit in the composer"
              />
            }
          >
            <PencilIcon className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="top">Edit in the composer</TooltipPopup>
        </Tooltip>
        <Button
          size="xs"
          variant={isNext ? "outline" : "ghost-muted"}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onSendNow(message.id)}
        >
          Send now
          {showEnterToSendHint ? (
            <Kbd className="h-4 min-w-4 px-0.5 text-[10px] leading-none">↵</Kbd>
          ) : null}
        </Button>
      </div>
    </div>
  );
}

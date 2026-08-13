"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  style,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/20 backdrop-blur-[2px] transition-opacity duration-150 ease-[var(--ease-out)] data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="dialog-overlay"
      style={{
        WebkitBackdropFilter: "blur(2px)",
        backdropFilter: "blur(2px)",
        ...style,
      }}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  style,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
        <DialogPrimitive.Popup
          className={cn(
            "pointer-events-auto relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg origin-center flex-col overflow-hidden rounded-xl bg-popover text-sm text-popover-foreground shadow-[0_24px_80px_-24px_rgb(0_0_0/0.35),0_8px_24px_-12px_rgb(0_0_0/0.18)] ring-1 ring-foreground/10 outline-none transition-[opacity,transform] duration-200 ease-[var(--ease-out)] data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:translate-y-1 data-starting-style:scale-[0.97] data-starting-style:opacity-0",
            className,
          )}
          data-slot="dialog-content"
          style={{
            maxWidth: "32rem",
            width: "calc(100vw - 2rem)",
            ...style,
          }}
          {...props}
        >
          {children}
          {showCloseButton ? (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              render={
                <Button
                  className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Popup>
      </div>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1.5 border-b border-border/70 px-5 py-4 pr-14 sm:px-6 sm:py-5 sm:pr-16",
        className,
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6",
        className,
      )}
      data-slot="dialog-body"
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-border/70 bg-muted/30 px-5 py-3.5 sm:flex-row sm:justify-end sm:px-6",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn(
        "font-heading text-lg leading-6 font-semibold tracking-tight",
        className,
      )}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn(
        "max-w-md text-sm leading-5 text-muted-foreground",
        className,
      )}
      data-slot="dialog-description"
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};

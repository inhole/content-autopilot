import type { ReactNode } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet.tsx'

/**
 * Right-side sheet for the operations page's edit forms (full width on a phone). Closing it the
 * way any sheet closes (X, Escape, outside click) is the same as the form's cancel.
 */
export function EditSheet({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="pr-8">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </SheetContent>
    </Sheet>
  )
}

/** The form's save / cancel row, kept in view at the bottom of the sheet while it scrolls. */
export const SHEET_ACTIONS_CLASS =
  'sticky bottom-0 -mx-4 -mb-4 flex flex-wrap gap-2 border-t bg-background p-4'

import { TriangleAlertIcon } from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert.tsx'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet.tsx'

/**
 * Right-side sheet for the operations page's edit forms (full width on a phone). Closing it the
 * way any sheet closes (X, Escape, outside click) is the same as the form's cancel, except while
 * a save is in flight: the form would unmount and its result (an error, `applied: false`) be lost.
 */
export function EditSheet({
  open,
  busy = false,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean
  /** A save is in flight: the sheet stays open until it answers. */
  busy?: boolean
  onClose: () => void
  title: string
  description: string
  children: ReactNode
}) {
  // The edit button is not a SheetTrigger, so Radix cannot return focus to it on close by itself.
  // When the sheet opens, focus is still on the element that opened it.
  const opener = useRef<HTMLElement | null>(null)
  return (
    <Sheet open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <SheetContent
        className="w-full gap-0 sm:max-w-xl"
        onOpenAutoFocus={() => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(e) => {
          if (opener.current?.isConnected) {
            e.preventDefault()
            opener.current.focus()
          }
        }}
      >
        <SheetHeader className="border-b">
          <SheetTitle className="pr-8">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * A save failure shown inside the sheet: the sheet covers the page (fully on a phone) and hides
 * the page's notices from assistive technology while it is open.
 */
export function SheetFormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

/** The form's save / cancel row, kept in view at the bottom of the sheet while it scrolls. */
export const SHEET_ACTIONS_CLASS =
  'sticky bottom-0 -mx-4 -mb-4 flex flex-wrap gap-2 border-t bg-background p-4'

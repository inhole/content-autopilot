import * as React from 'react'
import { cn } from '@/lib/utils.ts'

export const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="w-full overflow-x-auto">
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  ),
)
Table.displayName = 'Table'

export const TableHeader = (props: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <thead {...props} className={cn('[&_tr]:border-b', props.className)} />
)

export const TableBody = (props: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody {...props} className={cn('[&_tr:last-child]:border-0', props.className)} />
)

export const TableRow = ({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn('border-b transition-colors hover:bg-muted/50', className)} {...props} />
)

export const TableHead = ({
  className,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th
    className={cn(
      'h-9 px-3 text-left align-middle text-xs font-medium text-muted-foreground',
      className,
    )}
    {...props}
  />
)

export const TableCell = ({
  className,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn('px-3 py-2 align-middle', className)} {...props} />
)

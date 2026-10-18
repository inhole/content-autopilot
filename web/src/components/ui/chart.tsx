import * as React from 'react'
import * as RechartsPrimitive from 'recharts'
import { cn } from '@/lib/utils.ts'

export type ChartConfig = Record<string, { label: string; color: string }>

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null)

/** shadcn chart container: exposes `--color-<key>` CSS variables for each series. */
export function ChartContainer({
  config,
  className,
  children,
}: {
  config: ChartConfig
  className?: string
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
}) {
  const style = Object.fromEntries(
    Object.entries(config).map(([k, v]) => [`--color-${k}`, v.color]),
  ) as React.CSSProperties
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        style={style}
        className={cn(
          'h-40 w-full text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border',
          className,
        )}
      >
        <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

export const ChartTooltip = RechartsPrimitive.Tooltip

type TooltipPayload = { dataKey?: string | number; value?: number | string }

export function ChartTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: TooltipPayload[]
  label?: string | number
}) {
  const ctx = React.useContext(ChartContext)
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-md">
      <div className="mb-1 font-medium">{label}</div>
      {payload.map((p) => {
        const key = String(p.dataKey)
        const item = ctx?.config[key]
        return (
          <div key={key} className="flex items-center gap-2">
            <span
              className="inline-block size-2 rounded-sm"
              style={{ background: item?.color }}
              aria-hidden
            />
            <span className="text-muted-foreground">{item?.label ?? key}</span>
            <span className="ml-auto font-mono tabular-nums">
              {typeof p.value === 'number' ? p.value.toLocaleString('en-US') : p.value}
            </span>
          </div>
        )
      })}
    </div>
  )
}

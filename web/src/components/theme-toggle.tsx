import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { type Theme, useTheme } from './theme-provider.tsx'

const OPTIONS: { value: Theme; label: string; icon: typeof SunIcon }[] = [
  { value: 'light', label: '라이트', icon: SunIcon },
  { value: 'dark', label: '다크', icon: MoonIcon },
  { value: 'system', label: '시스템', icon: MonitorIcon },
]

export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme()
  const Icon = resolved === 'dark' ? MoonIcon : SunIcon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="테마 바꾸기">
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
            {OPTIONS.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                <o.icon />
                {o.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'ca-theme'

const ThemeContext = createContext<{
  theme: Theme
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
} | null>(null)

export function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // storage can be blocked; fall back to the system theme
  }
  return 'system'
}

const systemPrefersDark = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

export const resolveTheme = (t: Theme): 'light' | 'dark' =>
  t === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : t

/** Sets the `dark` class on <html> and returns the resolved theme. */
export function applyTheme(t: Theme): 'light' | 'dark' {
  const resolved = resolveTheme(t)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  return resolved
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(theme))

  useEffect(() => {
    setResolved(applyTheme(theme))
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setResolved(applyTheme('system'))
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    try {
      localStorage.setItem(STORAGE_KEY, t)
    } catch {
      // not persisted; still applied for this visit
    }
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

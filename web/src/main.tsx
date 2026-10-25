import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppRoutes, createQueryClient } from './app.tsx'
import { applyTheme, readStoredTheme, ThemeProvider } from './components/theme-provider.tsx'
// Self-hosted (CSP font-src 'self'); both are split by unicode range, so only used glyphs load.
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
import '@fontsource-variable/hahmlet/wght.css'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

// Set the theme class before the first render so there is no flash of the wrong theme.
applyTheme(readStoredTheme())

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)

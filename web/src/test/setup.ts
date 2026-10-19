import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom has neither matchMedia (theme, sidebar) nor ResizeObserver (recharts, radix).
const media = (matches: boolean) => (query: string) => ({
  matches,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})
window.matchMedia ??= media(false) as unknown as typeof window.matchMedia

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}

afterEach(() => {
  cleanup()
  document.documentElement.classList.remove('dark')
  try {
    localStorage.clear()
  } catch {
    // ignore
  }
})

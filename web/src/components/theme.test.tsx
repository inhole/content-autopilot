import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from './theme-provider.tsx'
import { ThemeToggle } from './theme-toggle.tsx'

afterEach(() => vi.restoreAllMocks())

const choose = async (name: string) => {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '테마 바꾸기' }))
  await user.click(await screen.findByRole('menuitemradio', { name }))
}

describe('ThemeToggle', () => {
  it('applies the dark class and persists the choice', async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )
    expect(document.documentElement).not.toHaveClass('dark')
    await choose('다크')
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('ca-theme')).toBe('dark')
    await choose('라이트')
    expect(document.documentElement).not.toHaveClass('dark')
    expect(localStorage.getItem('ca-theme')).toBe('light')
  })

  it('restores the stored choice and follows the system when set to system', () => {
    localStorage.setItem('ca-theme', 'dark')
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )
    expect(document.documentElement).toHaveClass('dark')
  })

  it('defaults to the system preference', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }) as never,
    )
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )
    expect(document.documentElement).toHaveClass('dark')
  })

  it('still works when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )
    await choose('다크')
    expect(document.documentElement).toHaveClass('dark')
  })
})

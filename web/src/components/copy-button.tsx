import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button.tsx'

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Copies `text` to the clipboard. Clipboard access can be missing (insecure context) or refused,
 * so a failure is said out loud and the text stays selectable on the page for a manual copy.
 */
export function CopyButton({ text, label = '복사' }: { text: string; label?: string }) {
  const [state, setState] = useState<CopyState>('idle')
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
    setTimeout(() => setState('idle'), 4000)
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
        {state === 'copied' ? (
          <CheckIcon data-icon="inline-start" />
        ) : (
          <CopyIcon data-icon="inline-start" />
        )}
        {state === 'copied' ? '복사했어요' : label}
      </Button>
      {state === 'failed' && (
        <span role="status" className="text-xs text-destructive">
          복사하지 못했어요. 글을 길게 눌러 직접 복사해 주세요
        </span>
      )}
    </span>
  )
}

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import satori from 'satori'
import type { Scene } from './types.ts'

// Frame pictures (docs/plans/video.md 5): satori lays out an element tree into SVG (flexbox and
// Korean keep-all line breaking), resvg turns it into a PNG. 1080x1920, nothing in the bottom
// ~400px or the right ~140px where Reels/Shorts draw their own buttons and captions.

export const WIDTH = 1080
export const HEIGHT = 1920
/** Bump when the look changes, so the render hash (and the cached video) changes too. */
export const TEMPLATE_VERSION = 'frames-v1+pretendard-1.3.9'

const FONT_DIR = join(import.meta.dirname, '..', '..', 'assets', 'fonts')
const COLORS = {
  bgTop: '#0b1020',
  bgBottom: '#1b2440',
  text: '#ffffff',
  muted: '#9aa4bf',
  accent: '#6ee7b7',
  track: 'rgba(255,255,255,0.18)',
  subtitleBg: 'rgba(0,0,0,0.55)',
}
const PAD_LEFT = 72
const PAD_RIGHT = 160

type Font = { name: string; data: Buffer; weight: 600 | 700; style: 'normal' }
let fonts: Promise<Font[]> | undefined

function loadFonts(): Promise<Font[]> {
  fonts ??= Promise.all([
    readFile(join(FONT_DIR, 'Pretendard-Bold.otf')).then(
      (data): Font => ({ name: 'Pretendard', data, weight: 700, style: 'normal' }),
    ),
    readFile(join(FONT_DIR, 'Pretendard-SemiBold.otf')).then(
      (data): Font => ({ name: 'Pretendard', data, weight: 600, style: 'normal' }),
    ),
  ])
  return fonts
}

type Style = Record<string, string | number>
type Node = { type: string; props: { style: Style; children?: Child } }
type Child = Node | string | (Node | string)[] | undefined

const el = (style: Style, children?: Child): Node => ({
  type: 'div',
  props: { style: { display: 'flex', ...style }, children },
})

export type FrameInput = {
  scenes: Scene[]
  /** Index into scenes, or scenes.length for the closing source card. */
  scene: number
  subtitle: string | null
  brand: string | null
  sourceLabel: string | null
}

function progressBar(total: number, current: number): Node {
  const segments: Node[] = []
  for (let i = 0; i < total; i++) {
    segments.push(
      el({
        flexGrow: 1,
        height: 8,
        borderRadius: 4,
        marginRight: i === total - 1 ? 0 : 10,
        backgroundColor: i <= current ? COLORS.accent : COLORS.track,
      }),
    )
  }
  return el({ flexDirection: 'row', width: '100%' }, segments)
}

/** The element tree of one frame (exported for tests). */
export function frameTree(f: FrameInput): Node {
  const total = f.scenes.length + 1
  const closing = f.scene >= f.scenes.length
  const top = el({ flexDirection: 'column', height: 200, justifyContent: 'flex-end' }, [
    el(
      { fontSize: 36, fontWeight: 600, color: COLORS.muted, marginBottom: 28, height: 44 },
      f.brand ?? '',
    ),
    progressBar(total, f.scene),
  ])

  let body: Node
  if (closing) {
    body = el({ flexDirection: 'column', height: 1080, justifyContent: 'center' }, [
      el({ fontSize: 48, fontWeight: 600, color: COLORS.accent, marginBottom: 24 }, '출처'),
      el(
        { fontSize: 84, fontWeight: 700, color: COLORS.text, wordBreak: 'break-all' },
        f.sourceLabel ?? '원문 링크는 캡션에',
      ),
      el(
        { fontSize: 44, fontWeight: 600, color: COLORS.muted, marginTop: 48 },
        f.brand ? `더 많은 소식은 ${f.brand}` : '자세한 내용은 캡션의 링크에서',
      ),
    ])
  } else {
    const scene = f.scenes[f.scene]
    const hook = f.scene === 0
    body = el({ flexDirection: 'column', height: 1080 }, [
      el({ flexDirection: 'column', height: 620, justifyContent: 'flex-end', paddingBottom: 60 }, [
        el(
          {
            fontSize: hook ? 112 : 88,
            fontWeight: 700,
            color: COLORS.text,
            lineHeight: 1.22,
            wordBreak: 'keep-all',
          },
          scene?.heading ?? '',
        ),
        el({ width: 120, height: 10, marginTop: 36, backgroundColor: COLORS.accent }),
      ]),
      f.subtitle
        ? el(
            {
              fontSize: 54,
              fontWeight: 600,
              color: COLORS.text,
              lineHeight: 1.42,
              wordBreak: 'keep-all',
              backgroundColor: COLORS.subtitleBg,
              borderRadius: 24,
              padding: '28px 36px',
            },
            f.subtitle,
          )
        : el({}),
    ])
  }

  return el(
    {
      width: WIDTH,
      height: HEIGHT,
      flexDirection: 'column',
      paddingLeft: PAD_LEFT,
      paddingRight: PAD_RIGHT,
      backgroundImage: `linear-gradient(180deg, ${COLORS.bgTop}, ${COLORS.bgBottom})`,
      fontFamily: 'Pretendard',
    },
    [top, body],
  )
}

/** Renders one frame to PNG bytes. */
export async function renderFrame(f: FrameInput): Promise<Buffer> {
  const svg = await satori(frameTree(f) as unknown as Parameters<typeof satori>[0], {
    width: WIDTH,
    height: HEIGHT,
    fonts: await loadFonts(),
  })
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng())
}

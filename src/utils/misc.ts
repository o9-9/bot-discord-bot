import type { MessageActionRowComponent } from 'oceanic.js'
import { Buffer } from 'node:buffer'
import { randomUUIDv7 } from 'bun'
import { ButtonStyles, ComponentTypes } from 'oceanic.js'

export interface DiscordFile { name: string, contents: Buffer }

export async function downloadImage(url: string): Promise<DiscordFile | Error> {
  const arrayBuffer = await fetch(url).then(r => r.arrayBuffer()).catch(() => null)
  if (arrayBuffer === null) return new Error('failed to download image')
  const filetype = /\.([a-z]{3,4})(?=[?:]|$)/i.exec(url)?.[1] ?? 'jpg'
  return {
    name: `${randomUUIDv7('base64url')}.${filetype}`,
    contents: Buffer.from(arrayBuffer),
  }
}

export function paginationButtons(currentIndex: number, arrayLen: number, paginationLookup: string): MessageActionRowComponent[] {
  return [
    {
      type: ComponentTypes.BUTTON,
      style: ButtonStyles.SECONDARY,
      customID: `setPage|${paginationLookup}|${currentIndex - 1}`,
      label: '<',
      disabled: currentIndex === 0,
    },
    {
      type: ComponentTypes.BUTTON,
      style: ButtonStyles.PRIMARY,
      customID: 'page number',
      label: `${currentIndex + 1} / ${arrayLen}`,
      disabled: true,
    },
    {
      type: ComponentTypes.BUTTON,
      style: ButtonStyles.SECONDARY,
      customID: `setPage|${paginationLookup}|${currentIndex + 1}`,
      label: '>',
      disabled: currentIndex === arrayLen - 1,
    },
  ]
}

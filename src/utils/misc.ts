import { Buffer } from 'node:buffer'
import { randomUUIDv7 } from 'bun'

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

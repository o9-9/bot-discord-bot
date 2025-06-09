import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { Buffer } from 'node:buffer'
import { $, file as getFile } from 'bun'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, Constants } from 'oceanic.js'
import tryCatch from 'try-catch'

export const description: CreateApplicationCommandOptions = {
  name: 'download',
  description: 'download a media url',
  type: ApplicationCommandTypes.CHAT_INPUT,
  options: [{
    name: 'url',
    description: 'the media url to download',
    type: ApplicationCommandOptionTypes.STRING,
    maxLength: 1024,
    required: true,
  }],
}

const MAX_FILE_SIZE = 25_000_000 // 25MB
const DLP_FORMAT = `b[filesize<${MAX_FILE_SIZE}][height<=1080][ext=webm]/b[filesize<${MAX_FILE_SIZE}][height<=1080][ext=mp4]/w[height<=1080][filesize<${MAX_FILE_SIZE}]`
export async function handler(interaction: CommandInteraction) {
  await interaction.defer(Constants.MessageFlags.EPHEMERAL)

  const url = interaction.data.options.getStringOption('url', true)!.value.trim()
  const mediaError = await validateMedia(url)
  if (Error.isError(mediaError))
    return interaction.reply({ content: `⚠️ ${mediaError.message}` })

  const destination = Math.random().toString(36).slice(2)
  const downloadOutput = await $`yt-dlp --format ${DLP_FORMAT} --playlist-items 1 --output ${destination}.%\(ext\)s ${url}`.nothrow().quiet()
  if (downloadOutput.exitCode !== 0)
    return interaction.reply({ content: `⚠️ download failed:\n\`\`\`\n${downloadOutput.stderr.toString()}\n\`\`\`` })

  const mp4 = getFile(`${destination}.mp4`)
  const webm = getFile(`${destination}.webm`)
  const mp4Exists = await mp4.exists()
  const file = await (mp4Exists ? mp4 : webm).arrayBuffer()
  interaction.createFollowup({
    files: [{
      name: `${destination}.${mp4Exists ? 'mp4' : 'webm'}`,
      contents: Buffer.from(file),
    }],
  })
  await $`rm ${destination}.${mp4Exists ? 'mp4' : 'webm'}`
}

async function validateMedia(url: string): Promise<void | Error> {
  if (!URL.canParse(url))
    return new Error('Invalid URL provided')

  const shellResponse = await $`yt-dlp --no-warnings --dump-single-json --playlist-items 1 ${url}`.nothrow().quiet()

  if (shellResponse.exitCode !== 0 || shellResponse.stdout.length === 0) {
    const stderr = shellResponse.stderr.toString().replace(/^ERROR: /, '')
    if (stderr.startsWith('[generic]')) // generic errors throw way too much info in, remove most of it
      return new Error(stderr.replace(/:.*/, ''))
    return new Error(stderr)
  }

  const [error, metadata] = tryCatch(JSON.parse, shellResponse.stdout.toString())
  if (error)
    return new Error('Failed to parse media metadata')

  if (metadata.is_live)
    return new Error('Live streams are not supported')

  if (metadata.duration > 1800)
    return new Error('Video is too long (over 30 minutes)')
}

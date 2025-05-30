import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { $, file as getFile } from 'bun'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, Constants } from 'oceanic.js'

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
  await interaction.defer(Constants.MessageFlags.LOADING)
  
  const url = interaction.data.options.getStringOption('url', true)!.value.trim()
  const metadata = await validateMedia(url)
  if (Error.isError(metadata)) {
    return interaction.reply({
      content: metadata.message,
      flags: Constants.MessageFlags.EPHEMERAL,
    })
  }

  const destination = Math.random().toString(36).slice(2)
  const downloadOutput = await $`yt-dlp --format ${DLP_FORMAT} --playlist-items 1 --output ${destination}.%\(ext\)s ${url}`.nothrow().quiet()
  if (downloadOutput.exitCode !== 0) {
    return interaction.reply({
      content: `download failed:\n\`\`\`\n${downloadOutput.stderr.toString()}\n\`\`\``,
      flags: Constants.MessageFlags.EPHEMERAL,
    })
  }

  const mp4 = getFile(`${destination}.mp4`)
  const webm = getFile(`${destination}.webm`)
  const mp4Exists = await mp4.exists()
  const file = await (mp4Exists ? mp4 : webm).arrayBuffer()
  interaction.reply({
    files: [{
      name: `${destination}.${mp4Exists ? 'mp4' : 'webm'}`,
      contents: Buffer.from(file),
    }],
  })
  await $`rm ${destination}.${mp4Exists ? 'mp4' : 'webm'}`
}

async function validateMedia(url: string): Promise<void | Error> {
  if (!URL.canParse(url))
    return new Error('Invalid URL provided.')

  const metadata = await $`yt-dlp --no-warnings --dump-single-json ${url}`.nothrow().quiet().then(t => t.json())
  if (!metadata)
    return new Error('URL not supported by yt-dlp')

  if (metadata.is_live)
    return new Error('Live streams are not supported')
}

import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { Buffer } from 'node:buffer'
import { readdir } from 'node:fs/promises'
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

export async function handler(interaction: CommandInteraction) {
  await interaction.reply({ content: 'downloading...', flags: Constants.MessageFlags.EPHEMERAL })

  const url = interaction.data.options.getStringOption('url', true)!.value.trim()
  const mediaError = await validateMedia(url)
  if (Error.isError(mediaError))
    return interaction.editOriginal({ content: `⚠️ ${mediaError.message}` })

  const media = await acquireMedia(url)
  if (Error.isError(media))
    return interaction.editOriginal({ content: `⚠️ ${media.message}` })

  return interaction.createFollowup({
    files: [{ name: 'download.mp4', contents: media }],
  })
}

const MAX_FILE_SIZE = 25_000_000 // 25MB
const DLP_FORMAT = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]'
async function acquireMedia(url: string): Promise<Error | Buffer> {
  const destinationPrefix = Math.random().toString(36).slice(2) // USE THIS AS A PREFIX FOR ALL FILENAMES

  // download
  const dlpShellResp = await $`yt-dlp --format ${DLP_FORMAT} --playlist-items 1 --output ${destinationPrefix}.%\(ext\)s ${url}`.nothrow().quiet()
  if (dlpShellResp.exitCode !== 0)
    return new Error('failed to download media with yt-dlp')
  const dlpFilename = await readdir('./').then(files => files.find(f => f.startsWith(destinationPrefix))) // file can have tons of extensions, determine what it's actual extension is
  if (dlpFilename === undefined || dlpFilename === '')
    return new Error('couldn\'t find file downloaded by yt-dlp')
  const dlpFile = getFile(dlpFilename)

  // skip transcoding nonsense for images/audio
  if (/\.(?:mp3|flac|opus|wav|png|jpg|jpeg|gif|webp)$/.exec(dlpFilename) !== null) {
    const buffer = Buffer.from(await dlpFile.arrayBuffer())
    dlpFile.delete()
    if (buffer.length > MAX_FILE_SIZE)
      return new Error('Output too big (>25MB)')
    return buffer
  }

  // transcode to format known good for discord (x264 mp4)
  // TODO: smarter transcode with math to fit into filesize more often
  const ffmpegShellResp = await $`ffmpeg -y -i ${dlpFilename} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart ${destinationPrefix}-FINAL.mp4`.nothrow().quiet()
  dlpFile.delete()
  if (ffmpegShellResp.exitCode !== 0)
    return new Error('failed to transcode media with ffmpeg')
  const ffmpegFile = getFile(`${destinationPrefix}-FINAL.mp4`)

  const buffer = Buffer.from(await ffmpegFile.arrayBuffer())
  ffmpegFile.delete()
  if (buffer.length > MAX_FILE_SIZE)
    return new Error('Output too big (>25MB)')

  return buffer
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

  if (metadata.duration > 900)
    return new Error('Video is too long (over 15 minutes)')
}

import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { Buffer } from 'node:buffer'
import { readdir } from 'node:fs/promises'
import { $, file, randomUUIDv7 } from 'bun'
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
    files: [{ name: `${randomUUIDv7('base64url')}.mp4`, contents: media }],
  })
}
const MAX_FILE_SIZE = 10_000_000 // 10MB
const TARGET_TOTAL_KB = (MAX_FILE_SIZE * 0.95 * 8) / 1_000
const AUDIO_BITRATE_K = 96
const DLP_FORMAT = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]'
async function acquireMedia(url: string): Promise<Error | Buffer> {
  const destinationPrefix = randomUUIDv7('base64url')
  try {
    // download
    const dlpShellResp = await $`yt-dlp --format ${DLP_FORMAT} --playlist-items 1 --output ${destinationPrefix}.%\(ext\)s ${url}`.nothrow().quiet()
    if (dlpShellResp.exitCode !== 0)
      return new Error('failed to download media with yt-dlp')
    const dlpFilename = await readdir('./').then(files => files.find(f => f.startsWith(destinationPrefix))) // file can have tons of extensions, determine what it's actual extension is
    if (dlpFilename === undefined || dlpFilename === '')
      return new Error('couldn\'t find file downloaded by yt-dlp')
    const dlpFile = file(dlpFilename)

    // skip transcoding nonsense for images/audio
    if (/\.(?:mp3|flac|opus|wav|png|jpg|jpeg|gif|webp)$/i.exec(dlpFilename) !== null) {
      const buffer = Buffer.from(await dlpFile.arrayBuffer())
      if (buffer.length > MAX_FILE_SIZE)
        return new Error('output too big (>10MB)')
      return buffer
    }

    // calculate target bitrate
    const durationShellResp = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${dlpFilename}`.nothrow().quiet()
    const duration = Number.parseFloat(durationShellResp.stdout.toString())
    if (durationShellResp.exitCode !== 0 || Number.isNaN(duration) || duration <= 0)
      return new Error('ffprobe failed to get media duration.')

    const targetTotalBitrateK = TARGET_TOTAL_KB / duration
    const targetVideoBitrateK = Math.floor(targetTotalBitrateK - AUDIO_BITRATE_K)
    if (targetVideoBitrateK <= 0)
      return new Error(`media cant fit within 10MB at a reasonable audio quality.`)

    // 2 pass transcode
    const ffmpegPass1 = await $`ffmpeg -y -i ${dlpFilename} -c:v libx264 -preset fast -b:v ${targetVideoBitrateK}k -pass 1 -passlogfile ${destinationPrefix}-passlog -an -f mp4 /dev/null`.nothrow().quiet()
    if (ffmpegPass1.exitCode !== 0)
      return new Error('ffmpeg transcoding pass 1 failed.')

    const ffmpegPass2 = await $`ffmpeg -i ${dlpFilename} -c:v libx264 -preset fast -b:v ${targetVideoBitrateK}k -pass 2 -passlogfile ${destinationPrefix}-passlog -c:a aac -b:a ${AUDIO_BITRATE_K}k -movflags +faststart ${destinationPrefix}-FINAL.mp4`.nothrow().quiet()
    if (ffmpegPass2.exitCode !== 0)
      return new Error('ffmpeg transcoding pass 2 failed.')

    const finalFile = file(`${destinationPrefix}-FINAL.mp4`)
    const buffer = Buffer.from(await finalFile.arrayBuffer())

    if (buffer.length > MAX_FILE_SIZE)
      return new Error(`Transcoded output is still too big (${(buffer.length / 1_000_000).toFixed(2)}MB)`)
    return buffer
  }
  finally {
    // cleanup!
    const processFiles = await readdir('./').then(files => files.filter(f => f.startsWith(destinationPrefix)))
    processFiles.forEach(f => file(f).delete())
  }
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

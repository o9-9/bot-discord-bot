import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { Buffer } from 'node:buffer'
import { readdir } from 'node:fs/promises'
import { $, file, randomUUIDv7 } from 'bun'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, Constants } from 'oceanic.js'
import tryCatch from 'try-catch'

interface BufferAndFiletype { buffer: Buffer, filetype: string }

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
  const url = interaction.data.options.getStringOption('url', true)!.value.trim()
  if (!URL.canParse(url))
    return interaction.reply({ content: '⚠️ Invalid URL provided', flags: Constants.MessageFlags.EPHEMERAL })

  await interaction.reply({ content: 'downloading...', flags: Constants.MessageFlags.EPHEMERAL })

  const fileBuffers: BufferAndFiletype[] = []

  let mediaAcquisitioner = acquireMediaDLP
  if (url.includes('reddit.com') || url.includes('redd.it'))
    mediaAcquisitioner = acquireRedditMedia

  const acquisitionerResult = await mediaAcquisitioner(url)
  if (Error.isError(acquisitionerResult))
    return interaction.editOriginal({ content: `⚠️ ${acquisitionerResult.message}` })
  else
    fileBuffers.push(...acquisitionerResult)

  const chunkedFileBuffers: BufferAndFiletype[][] = []
  for (let i = 0; i < fileBuffers.length; i += 10)
    chunkedFileBuffers.push(fileBuffers.slice(i, i + 10))
  for (const fileBufferChunk of chunkedFileBuffers) {
    await interaction.createFollowup({
      files: fileBufferChunk.map(({ buffer, filetype }) => ({ name: `${randomUUIDv7('base64url')}.${filetype}`, contents: buffer })),
    })
  }
}

// fix for reddit galleries & gifs
async function acquireRedditMedia(url: string): Promise<Error | BufferAndFiletype[]> {
  // TODO: handle /r/*/s/* urls, ex https://reddit.com/r/YouShouldKnow/s/l6p7VF51z7
  if (/\/s\//.exec(url) !== null)
    return new Error('reddit share urls `https://reddit.com/r/.../s/...` aren\'t supported')

  const postId = /(?<=\/)\w{3,10}$|(?<=comments\/)\w{3,10}/.exec(url)?.[0]
  if (postId === null)
    return new Error('failed to acquire reddit post id')

  const postData: any | null = await fetch(`https://api.reddit.com/${postId}.json`)
    .then<any>(r => r.json())
    .then(r => r[0].data.children[0].data)
    .catch(() => null)
  if (postData === null)
    return new Error('failed to get reddit post metadata')

  // fallback on yt-dlp for reddit videos
  if (postData.is_video)
    return acquireMediaDLP(url)

  if (postData.is_gallery) {
    const imageUrls = Object.values(postData.media_metadata)
      .map((item: any) => (item.s.u as string).replace('preview', 'i').replace(/\?.*$/, ''))
    const imageBuffers = await Promise.all([...imageUrls.map(url => imgUrlToBuffer(url))])
    if (imageBuffers.some(Error.isError))
      return new Error('failed to download gallery images')
    return imageBuffers as BufferAndFiletype[]
  }

  // posts that are normal text, or single image end up here, filter out normal text first
  // example of text post data: https://api.reddit.com/1i5bx0d.json, this should error
  // example of single image post data: https://api.reddit.com/1l6w06k.json, this should respond with https://i.redd.it/mihhvbmazt5f1.gif (in postData.url)
  return new Error('temp cant be assed to implement rn')
}
async function imgUrlToBuffer(url: string): Promise<BufferAndFiletype | Error> {
  const arrayBuffer = await fetch(url).then(r => r.arrayBuffer()).catch(() => null)
  if (arrayBuffer === null) return new Error('failed to download image')
  return { buffer: Buffer.from(arrayBuffer), filetype: url.split('.').at(-1)! }
}

const MAX_FILE_SIZE = 10_000_000 // 10MB
const TARGET_TOTAL_KB = (MAX_FILE_SIZE * 0.9 * 8) / 1_000
const AUDIO_BITRATE_K = 96
const DLP_FORMAT = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]'
async function acquireMediaDLP(url: string): Promise<Error | BufferAndFiletype[]> {
  const mediaError = await validateMediaDLP(url)
  if (Error.isError(mediaError))
    return mediaError

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
      return [{ buffer, filetype: dlpFilename.split('.').at(-1)! }]
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
      return new Error(`transcoded output is still too big (${(buffer.length / 1_000_000).toFixed(2)}MB)`)
    return [{ buffer, filetype: 'mp4' }]
  }
  finally {
    // cleanup!
    const processFiles = await readdir('./').then(files => files.filter(f => f.startsWith(destinationPrefix)))
    processFiles.forEach(f => file(f).delete())
  }
}

async function validateMediaDLP(url: string): Promise<void | Error> {
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

import type { CommandInteraction, CreateApplicationCommandOptions, File as DiscordFile } from 'oceanic.js'
import { Buffer } from 'node:buffer'
import { readdir } from 'node:fs/promises'
import { $, file, randomUUIDv7 } from 'bun'
import _ from 'lodash'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, MessageFlags } from 'oceanic.js'
import tryCatch from 'try-catch'

const { EPHEMERAL } = MessageFlags
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
    return interaction.createMessage({ content: '⚠️ Invalid URL provided', flags: EPHEMERAL })

  await interaction.createMessage({ content: `downloading \`${url}\`` })
  const statusMessageId = await interaction.createFollowup({ content: '_ _', flags: EPHEMERAL })
    .then(({ message }) => message.id)

  const fileBuffers: BufferAndFiletype[] = []

  let mediaAcquisitioner = acquireMediaDLP
  if (url.includes('reddit.com') || url.includes('redd.it'))
    mediaAcquisitioner = acquireRedditMedia

  const acquisitionerResult = await mediaAcquisitioner(url)
  if (Error.isError(acquisitionerResult)) {
    interaction.deleteOriginal()
    const statusText = await getStatusText(interaction, statusMessageId)
    return interaction.editFollowup(statusMessageId, { content: `${statusText}\n\n⚠️ ${acquisitionerResult.message}` })
  }
  else {
    interaction.deleteFollowup(statusMessageId)
    fileBuffers.push(...acquisitionerResult)
  }

  const chunkedFileEmbeds: DiscordFile[][] = _.chunk(fileBuffers.map(({ buffer, filetype }) => ({ name: `${randomUUIDv7('base64url')}.${filetype}`, contents: buffer })))
  await interaction.editOriginal({ content: ' ', files: chunkedFileEmbeds.shift()! })
  for (const fileBufferChunk of chunkedFileEmbeds)
    await interaction.reply({ files: fileBufferChunk })
}

// fix for reddit galleries & gifs
async function acquireRedditMedia(url: string): Promise<Error | BufferAndFiletype[]> {
  // handle reddit share urls, ex: https://reddit.com/r/.../s/...
  if (url.includes('/s/')) {
    const realUrl = await fetch(url, { redirect: 'manual' })
      .then(r => r.headers.get('location'))
      .catch(() => null)
    if (realUrl === null || realUrl.includes('/s/'))
      return new Error('failed to follow reddit share url(`https://reddit.com/r/.../s/...`), please try again')
    url = realUrl
  }

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

  if (postData.url.includes('i.redd.it')) {
    const buffer = await imgUrlToBuffer(postData.url)
    if (Error.isError(buffer))
      return new Error('failed to download image')
    return [buffer]
  }

  return new Error('I don\'t think that reddit post has images or videos on it')
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

async function getStatusText(interaction: CommandInteraction, messageID: string): Promise<string> {
  const statusText = await interaction.getFollowup(messageID).then(f => f.content)
  if (statusText === '_ _') return ''
  return statusText
}

import type { CommandInteraction, CreateApplicationCommandOptions, File as DiscordFile } from 'oceanic.js'
import { Buffer } from 'node:buffer'
import { readdir } from 'node:fs/promises'
import { $, file, randomUUIDv7 } from 'bun'
import _ from 'lodash'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, MessageFlags } from 'oceanic.js'
import tryCatch from 'try-catch'
import { codeBlock, last2000 } from '../utils/formatting'

const { EPHEMERAL } = MessageFlags
interface BufferAndFiletype { buffer: Buffer, filetype: string }
interface LiveStatusThing { interaction: CommandInteraction, statusMessageId: string }

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
  const liveStatusThing = { interaction, statusMessageId }

  const fileBuffers: BufferAndFiletype[] = []

  let mediaAcquisitioner = acquireMediaDLP
  if (url.includes('reddit.com') || url.includes('redd.it'))
    mediaAcquisitioner = acquireRedditMedia

  const acquisitionerResult = await mediaAcquisitioner(url, { interaction, statusMessageId })
  if (Error.isError(acquisitionerResult)) {
    interaction.deleteOriginal()
    return appendTextToStatus(liveStatusThing, `\n⚠️ ${acquisitionerResult.message}`)
  }
  else {
    fileBuffers.push(...acquisitionerResult)
  }

  await appendTextToStatus(liveStatusThing, 'uploading media to discord!')
  const chunkedFileEmbeds: DiscordFile[][] = _.chunk(fileBuffers.map(({ buffer, filetype }) => ({ name: `${randomUUIDv7('base64url')}.${filetype}`, contents: buffer })))
  await interaction.editOriginal({ content: ' ', files: chunkedFileEmbeds.shift()! })
  for (const fileBufferChunk of chunkedFileEmbeds)
    await interaction.reply({ files: fileBufferChunk })

  await appendTextToStatus(liveStatusThing, 'done! (deleting status message in 20 seconds)')
  setTimeout(() => interaction.deleteFollowup(statusMessageId), 20_000)
}

// fix for reddit galleries & gifs
async function acquireRedditMedia(url: string, liveStatusThing: LiveStatusThing): Promise<Error | BufferAndFiletype[]> {
  await appendTextToStatus(liveStatusThing, 'acquiring reddit post metadata')

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
    return acquireMediaDLP(url, liveStatusThing)

  if (postData.is_gallery) {
    const imageUrls = Object.values(postData.media_metadata)
      .map((item: any) => (item.s.u as string).replace('preview', 'i').replace(/\?.*$/, ''))
    await appendTextToStatus(liveStatusThing, `downloading ${imageUrls.length} gallery items`)
    const imageBuffers = await Promise.all([...imageUrls.map(url => imgUrlToBuffer(url))])
    if (imageBuffers.some(Error.isError))
      return new Error('failed to download gallery images')
    return imageBuffers as BufferAndFiletype[]
  }

  if (postData.url.includes('i.redd.it')) {
    await appendTextToStatus(liveStatusThing, 'downloading post image')
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
async function acquireMediaDLP(url: string, liveStatusThing: LiveStatusThing): Promise<Error | BufferAndFiletype[]> {
  const mediaError = await validateMediaDLP(url, liveStatusThing)
  if (Error.isError(mediaError))
    return mediaError

  const destinationPrefix = randomUUIDv7('base64url')
  try {
    // download
    await appendTextToStatus(liveStatusThing, 'downloading with yt-dlp')
    const dlpShellResp = await liveStatusShell(liveStatusThing, `yt-dlp --format '${DLP_FORMAT}' --playlist-items 1 --output '${destinationPrefix}.%(ext)s' '${url}'`)
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
    await appendTextToStatus(liveStatusThing, 'determining target bitrate')
    const durationShellResp = await liveStatusShell(liveStatusThing, `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${dlpFilename}`)
    const duration = Number.parseFloat(durationShellResp.stdout.toString())
    if (durationShellResp.exitCode !== 0 || Number.isNaN(duration) || duration <= 0)
      return new Error('ffprobe failed to get media duration.')

    const targetTotalBitrateK = TARGET_TOTAL_KB / duration
    const targetVideoBitrateK = Math.floor(targetTotalBitrateK - AUDIO_BITRATE_K)
    if (targetVideoBitrateK <= 0)
      return new Error(`media cant fit within 10MB at a reasonable audio quality.`)

    // 2 pass transcode
    await appendTextToStatus(liveStatusThing, 'transcode pass 1')
    const ffmpegPass1 = await liveStatusShell(liveStatusThing, `ffmpeg -y -i ${dlpFilename} -c:v libx264 -preset fast -b:v ${targetVideoBitrateK}k -pass 1 -passlogfile ${destinationPrefix}-passlog -an -f mp4 /dev/null`)
    if (ffmpegPass1.exitCode !== 0)
      return new Error('ffmpeg transcoding pass 1 failed.')

    await appendTextToStatus(liveStatusThing, 'transcode pass 2')
    const ffmpegPass2 = await liveStatusShell(liveStatusThing, `ffmpeg -i ${dlpFilename} -c:v libx264 -preset fast -b:v ${targetVideoBitrateK}k -pass 2 -passlogfile ${destinationPrefix}-passlog -c:a aac -b:a ${AUDIO_BITRATE_K}k -movflags +faststart ${destinationPrefix}-FINAL.mp4`)
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
    await appendTextToStatus(liveStatusThing, 'cleaning up loose files')
    const processFiles = await readdir('./').then(files => files.filter(f => f.startsWith(destinationPrefix)))
    processFiles.forEach(f => file(f).delete())
  }
}

async function validateMediaDLP(url: string, liveStatusThing: LiveStatusThing): Promise<void | Error> {
  await appendTextToStatus(liveStatusThing, 'ensuring media can be scraped')
  const shellResponse = await liveStatusShell(liveStatusThing, `yt-dlp --no-warnings --dump-single-json --playlist-items 1 '${url}'`)

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

async function appendTextToStatus(liveStatusThing: LiveStatusThing, content: string) {
  const statusText = await getStatusText(liveStatusThing)
  liveStatusThing.interaction.editFollowup(liveStatusThing.statusMessageId, { content: last2000(`${statusText}\n${content}`) })
}

async function getStatusText({ interaction, statusMessageId }: LiveStatusThing): Promise<string> {
  const statusText = await interaction.getFollowup(statusMessageId).then(f => f.content)
  if (statusText === '_ _') return ''
  return statusText
}

async function liveStatusShell({ interaction, statusMessageId }: LiveStatusThing, command: string): Promise<$.ShellOutput> {
  const statusContent = await getStatusText({ interaction, statusMessageId })
  let shellContent = ''
  let editPromise: Promise<any>
  function liveEditShellContent(newLine: string) {
    newLine = newLine.slice(0, 100) // prevent Invalid Form Body on PATCH --- content Must be 2000 or fewer in length.
    shellContent = `${shellContent}\n${newLine}`.trim()
    editPromise = interaction.editFollowup(statusMessageId, { content: last2000(`${statusContent}\n${codeBlock(shellContent)}`) })
  }
  liveEditShellContent(`$ ${command}`)
  const shellPromise = $`${{ raw: command }}`.quiet().nothrow()
  for await (const line of shellPromise.lines())
    liveEditShellContent(line)
  const shellResp = await shellPromise
  if (shellResp.stderr.length > 0)
    liveEditShellContent(shellResp.stderr.toString())
  await editPromise!
  return shellResp
}

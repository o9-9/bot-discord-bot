import type { CommandInteraction, CreateApplicationCommandOptions, File as DiscordFile } from 'oceanic.js'
import { $, randomUUIDv7 } from 'bun'
import _ from 'lodash'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, MessageFlags } from 'oceanic.js'
import tryCatch from 'try-catch'
import { codeBlock, last2000 } from '../utils/formatting'
import { downloadImage } from '../utils/misc'

const { EPHEMERAL } = MessageFlags
interface LiveStatusThing { interaction: CommandInteraction, statusMessageId: string }
interface AcquisitionerArgs {
  url: string
  cutSegments: { start: number, end: undefined | number }
  liveStatusThing: LiveStatusThing
}

const CLIP_FORMAT_TEXT = 'formatted as either number of seconds or XXhXXmXXs (ex: 2h15m3s)'
export const description: CreateApplicationCommandOptions = {
  name: 'download',
  description: 'download a media url',
  type: ApplicationCommandTypes.CHAT_INPUT,
  options: [
    {
      name: 'url',
      description: 'the media url to download',
      type: ApplicationCommandOptionTypes.STRING,
      maxLength: 1024,
      required: true,
    },
    {
      name: 'clip-start',
      description: `starting timestamp of clip, ${CLIP_FORMAT_TEXT}`,
      type: ApplicationCommandOptionTypes.STRING,
      maxLength: 20,
    },
    {
      name: 'clip-end',
      description: `ending timestamp of clip, ${CLIP_FORMAT_TEXT}`,
      type: ApplicationCommandOptionTypes.STRING,
      maxLength: 20,
    },
  ],
}

export async function handler(interaction: CommandInteraction) {
  const options = interaction.data.options
  const url = options.getStringOption('url', true)!.value.trim()
  if (!URL.canParse(url))
    return interaction.createMessage({ content: '⚠️ Invalid URL provided', flags: EPHEMERAL })

  const clipStart = parseClipTime(options.getStringOption('clip-start')?.value.trim())
  const clipEnd = parseClipTime(options.getStringOption('clip-end')?.value.trim())
  if (Error.isError(clipStart) || Error.isError(clipEnd))
    return interaction.createMessage({ content: `Invalid clip-start/clip-end, must be ${CLIP_FORMAT_TEXT}`, flags: EPHEMERAL })
  const cutSegments = { start: clipStart ?? 0, end: clipEnd }

  await interaction.createMessage({ content: `downloading \`${url}\`` })
  const statusMessageId = await interaction.createFollowup({ content: '_ _', flags: EPHEMERAL })
    .then(({ message }) => message.id)
  const liveStatusThing = { interaction, statusMessageId }

  const files: DiscordFile[] = []

  let mediaAcquisitioner = acquireMediaDLP
  if (url.includes('reddit.com') || url.includes('redd.it'))
    mediaAcquisitioner = acquireRedditMedia

  const acquisitionerResult = await mediaAcquisitioner({ url, cutSegments, liveStatusThing })
  if (Error.isError(acquisitionerResult)) {
    interaction.deleteOriginal()
    return appendTextToStatus(liveStatusThing, `\n⚠️ ${acquisitionerResult.message}`)
  }
  else {
    files.push(...acquisitionerResult)
  }

  await appendTextToStatus(liveStatusThing, 'uploading media to discord!')
  const chunkedFiles: DiscordFile[][] = _.chunk(files, 10)
  await interaction.editOriginal({ content: ' ', files: chunkedFiles.shift()! })
  for (const fileEmbedChunk of chunkedFiles)
    await interaction.reply({ files: fileEmbedChunk })

  await appendTextToStatus(liveStatusThing, 'done! (deleting status message in 20 seconds)')
  setTimeout(() => interaction.deleteFollowup(statusMessageId), 20_000)
}

// fix for reddit galleries & gifs
async function acquireRedditMedia(args: AcquisitionerArgs): Promise<Error | DiscordFile[]> {
  await appendTextToStatus(args.liveStatusThing, 'acquiring reddit post metadata')

  // handle reddit share urls, ex: https://reddit.com/r/.../s/...
  if (args.url.includes('/s/')) {
    const realUrl = await fetch(args.url, { redirect: 'manual' })
      .then(r => r.headers.get('location'))
      .catch(() => null)
    if (realUrl === null || realUrl.includes('/s/'))
      return new Error('failed to follow reddit share url(`https://reddit.com/r/.../s/...`), please try again')
    args.url = realUrl
  }

  const postId = /(?<=\/)\w{3,10}$|(?<=comments\/)\w{3,10}/.exec(args.url)?.[0]
  if (postId === null)
    return new Error('failed to acquire reddit post id')

  const postData: any | null = await fetch(`https://api.reddit.com/${postId}.json`, { headers: { 'User-Agent': 'Cassie DiscordBot by CodeF53' } })
    .then<any>(r => r.json())
    .then(r => r[0].data.children[0].data)
    .catch(() => null)
  if (postData === null)
    return new Error('failed to get reddit post metadata')

  // fallback on yt-dlp for reddit videos
  if (postData.is_video)
    return acquireMediaDLP(args)

  if (postData.is_gallery) {
    const imageIds: string[] = postData.gallery_data.items.map((item: { media_id: string }) => item.media_id)
    const sliceStart = Math.max(0, args.cutSegments.start - 1)
    const imageUrls = imageIds.slice(sliceStart, args.cutSegments.end).map(id => postData.media_metadata[id].s.u.replace('preview', 'i').replace(/\?.*$/, ''))
    await appendTextToStatus(args.liveStatusThing, `downloading ${imageUrls.length} gallery items`)
    const imageBuffers = await Promise.all([...imageUrls.map(downloadImage)])
    if (imageBuffers.some(Error.isError))
      return new Error('failed to download gallery images')
    return imageBuffers as DiscordFile[]
  }

  if (postData.url.includes('i.redd.it')) {
    await appendTextToStatus(args.liveStatusThing, 'downloading post image')
    const buffer = await downloadImage(postData.url)
    if (Error.isError(buffer))
      return new Error('failed to download image')
    return [buffer]
  }

  return new Error('I don\'t think that reddit post has images or videos on it')
}

const MAX_FILE_SIZE = 10_000_000 // 10MB
const TARGET_TOTAL_KB = (MAX_FILE_SIZE * 0.8 * 8) / 1_000
const AUDIO_BITRATE_K = 72
const DLP_FORMAT = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best'
async function acquireMediaDLP(args: AcquisitionerArgs): Promise<Error | DiscordFile[]> {
  const mediaMetadata = await getMediaMetadataDLP(args)
  if (Error.isError(mediaMetadata))
    return mediaMetadata

  const cutSegments = args.cutSegments
  let clipArg = '' // only clip video if cut segments were actually specified
  if (cutSegments.start !== 0 || cutSegments.end !== undefined)
    clipArg = `--download-sections '*${cutSegments.start}-${cutSegments.end}'`
  cutSegments.end ??= mediaMetadata.duration as number
  const duration = cutSegments.end - cutSegments.start

  const isVideo = mediaMetadata.vcodec !== 'none'
  if (!isVideo) {
    await appendTextToStatus(args.liveStatusThing, 'downloading audio')
    const downloadShellResp = await liveStatusShell(args.liveStatusThing, `yt-dlp '${args.url}' --format 'bestaudio/best' ${clipArg} --playlist-items 1 --output -`, true)
    if (downloadShellResp.exitCode !== 0)
      return new Error('failed to download audio with yt-dlp')
    const contents = downloadShellResp.stdout
    if (contents.length > MAX_FILE_SIZE)
      return new Error('output too big (>10MB)')
    const filetype = mediaMetadata.ext ?? 'bin'
    return [{ contents, name: `${randomUUIDv7('base64url')}.${filetype}` }]
  }

  // calculate target bitrate
  const targetTotalBitrateK = TARGET_TOTAL_KB / duration
  const targetVideoBitrateK = Math.floor(targetTotalBitrateK - AUDIO_BITRATE_K)
  if (targetVideoBitrateK <= 0)
    return new Error(`media can't fit within 10MB at a reasonable audio quality.`)

  await appendTextToStatus(args.liveStatusThing, 'downloading and transcoding video')
  const dlpCommand = `yt-dlp '${args.url}' --format '${DLP_FORMAT}' ${clipArg} --playlist-items 1 --output -`
  const ffmpegCommand = `ffmpeg -i pipe:0 -c:v libx264 -preset veryfast -b:v ${targetVideoBitrateK}k -c:a aac -b:a ${AUDIO_BITRATE_K}k -movflags +frag_keyframe+empty_moov -f mp4 pipe:1`
  const downloadShellResp = await liveStatusShell(args.liveStatusThing, `${dlpCommand} | ${ffmpegCommand}`, true)
  if (downloadShellResp.exitCode !== 0)
    return new Error(`download/transcode failed\n${codeBlock(downloadShellResp.stderr.toString())}`)
  const contents = downloadShellResp.stdout
  if (contents.length > MAX_FILE_SIZE)
    return new Error(`transcoded output is still too big (${(contents.length / 1_000_000).toFixed(2)}MB)`)
  return [{ contents, name: `${randomUUIDv7('base64url')}.mp4` }]
}

async function getMediaMetadataDLP(args: AcquisitionerArgs): Promise<any | Error> {
  await appendTextToStatus(args.liveStatusThing, 'ensuring media can be scraped')
  const shellResponse = await liveStatusShell(args.liveStatusThing, `yt-dlp --no-warnings --dump-single-json --playlist-items 1 '${args.url}'`, true)

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

  return metadata
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

async function liveStatusShell({ interaction, statusMessageId }: LiveStatusThing, command: string, disableStdout: boolean = false): Promise<$.ShellOutput> {
  const statusContent = await getStatusText({ interaction, statusMessageId })
  let shellContent = ''
  let editPromise: Promise<any>
  function liveEditShellContent(newLine: string) {
    shellContent = `${shellContent}\n${newLine}`.trim()
    editPromise = interaction.editFollowup(statusMessageId, { content: last2000(`${statusContent}\n${codeBlock(shellContent)}`) })
  }
  liveEditShellContent(`$ ${command}`)
  const shellPromise = $`${{ raw: command }}`.quiet().nothrow()
  if (!disableStdout) {
    for await (const line of shellPromise.lines())
      liveEditShellContent(line)
  }
  const shellResp = await shellPromise
  if (shellResp.stderr.length > 0)
    liveEditShellContent(shellResp.stderr.toString())
  await editPromise!
  return shellResp
}

function parseClipTime(str: string | undefined): number | undefined | Error {
  if (str === undefined) return

  const simpleParse = Number(str)
  if (!Number.isNaN(simpleParse))
    return simpleParse

  const parseResult = /(?:(\d+)h)?(?:(\d+)m)?(\d+)s?/.exec(str)
  if (parseResult === null)
    return new Error('invalid format')
  const [_, hourStr, minuteStr, secondStr] = parseResult

  return Number(hourStr ?? 0) * 60 * 60
    + Number(minuteStr ?? 0) * 60
    + Number(secondStr ?? 0)
}

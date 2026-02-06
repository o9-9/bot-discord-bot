import type { CommandInteraction, ComponentInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import type { DiscordFile } from '../utils/misc'
import { bingImages } from '@f53/bing-image-scraper'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, ButtonStyles, ComponentTypes, MessageFlags } from 'oceanic.js'
import { downloadImage } from '../utils/misc'

export const description: CreateApplicationCommandOptions = {
  name: 'image',
  description: 'search google for images',
  type: ApplicationCommandTypes.CHAT_INPUT,
  options: [{
    name: 'query',
    description: 'image search query',
    type: ApplicationCommandOptionTypes.STRING,
    maxLength: 256,
    required: true,
  }],
}

const urlMemory = new Map<string, string[]>()

export async function handler(interaction: CommandInteraction) {
  const query = interaction.data.options.getStringOption('query', true)!.value

  interaction.reply({ content: `searching for images of "${query}"` })

  const bingResp = await bingImages(query, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' })
  if (Error.isError(bingResp))
    return interaction.editOriginal({ content: 'failed to scrape images' })
  const urls = new Set(bingResp.map(i => i.direct))

  interaction.editOriginal({ content: 'downloading images' })

  const imgs: { url: string, file: DiscordFile }[] = []
  for (const url of urls) {
    if (imgs.length >= 5) break

    const file = await downloadImage(url)
    if (Error.isError(file)) continue
    imgs.push({ url, file })
  }

  if (imgs.length === 0)
    return interaction.editOriginal({ content: 'all downloads failed, sorry' })

  const message = await interaction.editOriginal({
    content: '',
    files: imgs.map(i => i.file) as DiscordFile[],
    components: [{
      type: ComponentTypes.ACTION_ROW,
      components: imgs.map((_, i) => ({
        type: ComponentTypes.BUTTON,
        style: ButtonStyles.SECONDARY,
        customID: `setImage|${i}`,
        label: `${i + 1}`,
      })),
    }],
  })

  urlMemory.set(message.id, imgs.map(i => i.url))
}

export async function handleComponentInteraction(interaction: ComponentInteraction) {
  await interaction.deferUpdate()

  if (interaction.authorizingIntegrationOwners[1] !== interaction.user.id) {
    return interaction.createFollowup({
      flags: MessageFlags.EPHEMERAL,
      content: 'cant select image on a message that is isn\'t yours',
    })
  }

  if (!interaction.data.customID.startsWith('setImage'))
    return console.error(`unknown component interaction ${interaction.data.customID}`)
  const [_id, imageIndex] = interaction.data.customID.split('|')

  const urls = urlMemory.get(interaction.message.id)
  urlMemory.delete(interaction.message.id) // remove memory of images we don't care about anymore
  if (urls === undefined) {
    return interaction.createFollowup({
      flags: MessageFlags.EPHEMERAL,
      content: 'I don\'t remember those images sorry',
    })
  }

  const imageBuffer = await downloadImage(urls[Number(imageIndex!)]!)
  if (Error.isError(imageBuffer)) {
    return interaction.createFollowup({
      flags: MessageFlags.EPHEMERAL,
      content: 'Failed to refetch image data, sorry',
    })
  }

  interaction.editOriginal({
    content: '',
    files: [imageBuffer],
    components: [],
  })
}

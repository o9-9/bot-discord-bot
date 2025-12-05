import type { CommandInteraction, ComponentInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import type { DiscordFile } from '../utils/misc'
import gis from 'async-g-i-s'
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

  const urls = await gis(query).then(r => r.slice(0, 5).map(i => i.url))

  interaction.editOriginal({ content: `downloading 5 images` })

  const imageBuffers = await Promise.all([...urls.map(downloadImage)])
  if (imageBuffers.some(Error.isError))
    return interaction.editOriginal({ content: 'download failed, sorry' })

  const message = await interaction.editOriginal({
    content: '',
    files: imageBuffers as DiscordFile[],
    components: [{
      type: ComponentTypes.ACTION_ROW,
      components: urls.map((_, i) => ({
        type: ComponentTypes.BUTTON,
        style: ButtonStyles.SECONDARY,
        customID: `setImage|${i}`,
        label: `${i + 1}`,
      })),
    }],
  })

  urlMemory.set(message.id, urls)
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

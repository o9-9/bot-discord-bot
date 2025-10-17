import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import type { DiscordFile } from '../utils/misc'
import gis from 'async-g-i-s'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes } from 'oceanic.js'
import { downloadImage } from '../utils/misc'

const defaultImageCount = 5
export const description: CreateApplicationCommandOptions = {
  name: 'image',
  description: 'search google for images',
  type: ApplicationCommandTypes.CHAT_INPUT,
  options: [
    {
      name: 'query',
      description: 'image search query',
      type: ApplicationCommandOptionTypes.STRING,
      maxLength: 256,
      required: true,
    },
    {
      name: 'count',
      description: `number of images to return (default ${defaultImageCount})`,
      type: ApplicationCommandOptionTypes.NUMBER,
      maxValue: 10,
      minValue: 1,
    },
  ],
}

export async function handler(interaction: CommandInteraction) {
  const query = interaction.data.options.getStringOption('query', true)!.value
  const count = interaction.data.options.getNumberOption('count')?.value ?? defaultImageCount

  interaction.reply({ content: `searching for images of "${query}"` })

  const urls = await gis(query).then(r => r.slice(0, count).map(i => i.url))

  interaction.editOriginal({ content: `downloading ${count} images` })

  const imageBuffers = await Promise.all([...urls.map(downloadImage)])
  if (imageBuffers.some(Error.isError))
    return interaction.editOriginal({ content: 'download failed, sorry' })

  interaction.editOriginal({ content: '', files: imageBuffers as DiscordFile[] })
}

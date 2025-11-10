import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { env } from 'bun'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes } from 'oceanic.js'

const { WOLFRAM_KEY } = env

export const description: CreateApplicationCommandOptions = {
  name: 'wolfram',
  description: 'compute a query via wolfram alpha',
  type: ApplicationCommandTypes.CHAT_INPUT,
  options: [
    {
      name: 'query',
      description: 'computational query',
      type: ApplicationCommandOptionTypes.STRING,
      maxLength: 1024,
      required: true,
    },
  ],
}

export async function handler(interaction: CommandInteraction) {
  const query = interaction.data.options.getStringOption('query', true)!.value
  interaction.defer()

  const text = await fetch(`https://api.wolframalpha.com/v1/result?i=${query}&appid=${WOLFRAM_KEY}`)
    .then(r => r.text())
    .catch((e: Error) => e)
  if (Error.isError(text))
    return interaction.editOriginal({ content: '⚠️ query failed, sorry' })

  interaction.editOriginal({ content: `> ${query}\n${text}` })
}

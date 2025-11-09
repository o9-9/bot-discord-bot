import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { env } from 'bun'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes } from 'oceanic.js'
import { codeBlock } from '../utils/formatting'

const { DICTIONARY_KEY } = env

export const description: CreateApplicationCommandOptions = {
  name: 'dictionary',
  description: 'get a (word / term)\'s definition',
  type: ApplicationCommandTypes.CHAT_INPUT,
  options: [{
    name: 'term',
    description: 'term to define',
    type: ApplicationCommandOptionTypes.STRING,
    maxLength: 256,
    required: true,
  }],
}

export async function handler(interaction: CommandInteraction) {
  const term = interaction.data.options.getStringOption('term', true)!.value

  interaction.defer()

  const data: any | Error = await fetch(`https://www.dictionaryapi.com/api/v3/references/collegiate/json/${term}?key=${DICTIONARY_KEY}`)
    .then(r => r.json())
    .catch(e => e)
  if (Error.isError(data))
    return interaction.editOriginal({ content: `⚠️ failed to get definition for ${term}:\n${codeBlock(data.message)}` })
  // it should always return an array
  if (!Array.isArray(data))
    return interaction.editOriginal({ content: `⚠️ failed to parse response from dictionary api` })
  // When the term isn't found, it returns an array of strings for similar terms
  if (data[0] === undefined || typeof data[0] === 'string')
    return interaction.editOriginal({ content: `⚠️ no definition found for ${term}` })

  const definition = data[0]

  const content = `
    ## ${term}
    -# ${definition.hwi.prs[0].mw} • ${definition.fl}
    ${(definition.shortdef as string[]).map((def, i) => `${i + 1}. ${def}`).join('\n')}
  `.trim().split('\n').map(line => line.trim()).join('\n')

  interaction.editOriginal({ content })
}

import type { CommandInteraction, ComponentInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, ComponentTypes, MessageFlags } from 'oceanic.js'
import { codeBlock } from '../utils/formatting'
import { paginationButtons } from '../utils/misc'

export const description: CreateApplicationCommandOptions = {
  name: 'urbandictionary',
  description: 'get a (word / term)\'s definition from the urban dictionary',
  type: ApplicationCommandTypes.CHAT_INPUT,
  options: [{
    name: 'term',
    description: 'term to define',
    type: ApplicationCommandOptionTypes.STRING,
    maxLength: 256,
    required: true,
  }],
}

const definitionCache = new Map<string, string[]>()

export async function handler(interaction: CommandInteraction) {
  const term = interaction.data.options.getStringOption('term', true)!.value

  interaction.defer()

  const definitions = await getDefinitions(term)
  if (Error.isError(definitions))
    return interaction.editOriginal({ content: `⚠️ failed to get definition for ${term}:\n${codeBlock(definitions.message)}` })
  if (definitions.length === 0)
    return interaction.editOriginal({ content: `⚠️ no definition found for ${term}` })

  interaction.editOriginal({
    content: definitions[0],
    components: [{
      type: ComponentTypes.ACTION_ROW,
      components: paginationButtons(0, definitions.length, term),
    }],
  })
}

export async function handleComponentInteraction(interaction: ComponentInteraction) {
  await interaction.deferUpdate()

  if (interaction.authorizingIntegrationOwners[1] !== interaction.user.id) {
    return interaction.createFollowup({
      flags: MessageFlags.EPHEMERAL,
      content: 'cant paginate on a message that is isn\'t yours',
    })
  }

  if (!interaction.data.customID.startsWith('setPage'))
    return console.error(`unknown component interaction ${interaction.data.customID}`)
  const [_id, term, targetPageStr] = interaction.data.customID.split('|')
  const targetPage = Number(targetPageStr!)
  const definitions = definitionCache.get(term!)
  if (definitions === undefined)
    return interaction.createFollowup({ flags: MessageFlags.EPHEMERAL, content: 'failed to get pagination context, try doing a new /dictionary and interacting with that one' })

  interaction.editOriginal({
    content: definitions?.[targetPage],
    components: [{
      type: ComponentTypes.ACTION_ROW,
      components: paginationButtons(targetPage, definitions.length, term!),
    }],
  })
}

async function getDefinitions(term: string): Promise<Error | string[]> {
  if (definitionCache.has(term))
    return definitionCache.get(term)!

  const data: any | Error = await fetch(`https://unofficialurbandictionaryapi.com/api/search?term=${term}`)
    .then(r => r.json())
    .catch(e => e)
  if (Error.isError(data))
    return data
  const rawDefinitions = data.data
  if (!Array.isArray(rawDefinitions))
    return new Error('failed to parse response from urban dictionary api')

  const definitions: string[] = []
  for (const definitionMeta of rawDefinitions) {
    definitions.push(`
      ## ${term}
      ${definitionMeta.meaning.slice(0, 500)}
      ### Example
      ${definitionMeta.example.slice(0, 1250)}
    `.trim().split('\n').map(line => line.trim()).join('\n'))
  }

  definitionCache.set(term, definitions)
  return definitions
}

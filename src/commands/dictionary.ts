import type { CommandInteraction, ComponentInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { env } from 'bun'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, ComponentTypes, MessageFlags } from 'oceanic.js'
import { codeBlock } from '../utils/formatting'
import { paginationButtons } from '../utils/misc'

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
    return interaction.createFollowup({ flags: MessageFlags.EPHEMERAL, content: 'failed to get pagination context, try doing a new `/dictionary` and interacting with that one' })

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

  const data: any | Error = await fetch(`https://www.dictionaryapi.com/api/v3/references/collegiate/json/${term}?key=${DICTIONARY_KEY}`)
    .then(r => r.json())
    .catch(e => e)
  if (Error.isError(data))
    return data
  // it should always return an array
  if (!Array.isArray(data))
    return new Error('failed to parse response from dictionary api')
  // When the term isn't found, it returns an array of strings for similar terms
  if (data[0] === undefined || typeof data[0] === 'string')
    return []

  const definitions: string[] = []
  for (const definitionMeta of data) {
    const pronunciation = definitionMeta?.hwi?.prs?.[0]?.mw
    const wordClass = definitionMeta?.fl
    const subtext = [pronunciation, wordClass].filter(Boolean).join(' • ')
    definitions.push(`
      ## ${term}
      -# ${subtext}
      ${(definitionMeta.shortdef as string[]).map((def, i) => `${i + 1}. ${def}`).join('\n')}
    `.trim().split('\n').map(line => line.trim()).join('\n'))
  }

  definitionCache.set(term, definitions)
  return definitions
}

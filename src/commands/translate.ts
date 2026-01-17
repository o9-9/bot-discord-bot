import type { AutocompleteInteraction, CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import type { LangCode } from '../utils/translate'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes } from 'oceanic.js'
import { codeBlock } from '../utils/formatting'
import { LangCodeToName, LangNameToCode, translateText } from '../utils/translate'

export const description: CreateApplicationCommandOptions = {
  name: 'translate',
  description: 'translate',
  type: ApplicationCommandTypes.CHAT_INPUT,
  options: [
    {
      name: 'text',
      description: 'text to translate',
      type: ApplicationCommandOptionTypes.STRING,
      maxLength: 1024,
      required: true,
    },
    {
      name: 'target-language',
      description: 'language to translate to',
      type: ApplicationCommandOptionTypes.STRING,
      required: false,
      autocomplete: true,
    },
    {
      name: 'source-language',
      description: 'language to translate from',
      type: ApplicationCommandOptionTypes.STRING,
      required: false,
      autocomplete: true,
    },
  ],
}

export async function handler(interaction: CommandInteraction) {
  const text = interaction.data.options.getStringOption('text', true)!.value
  const sourceLanguage = interaction.data.options.getStringOption('source-language')?.value as LangCode | undefined
  const targetLanguage = (interaction.data.options.getStringOption('target-language')!.value ?? 'en') as LangCode
  interaction.defer()

  const translation = await translateText({ text, sourceLanguage, targetLanguage })
  if (Error.isError(translation))
    return interaction.editOriginal({ content: `⚠️ translation failed:\n${codeBlock(translation.message)}` })

  interaction.editOriginal({ content: `${translation.translatedText}\n-# ${LangCodeToName[translation.detectedLanguageCode]} -> ${LangCodeToName[targetLanguage]}` })
}

const unfilteredChoices = Object.entries(LangNameToCode).map(([name, code]) => ({ name, value: code }))
export async function handleAutocompleteInteraction(interaction: AutocompleteInteraction) {
  const focusedOption = interaction.data.options.getFocused()
  if (focusedOption === undefined)
    return console.error('autocomplete requested with no focused option')
  if (!['target-language', 'source-language'].includes(focusedOption.name))
    return console.error(`unknown autocomplete target ${focusedOption.name}`)

  const q = focusedOption.value.toString().toLowerCase()
  interaction.result(unfilteredChoices.filter(({ name }) => name.toLowerCase().startsWith(q)).slice(0, 25))
}

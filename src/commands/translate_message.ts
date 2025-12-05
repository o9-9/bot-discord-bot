import type { AnyInteractionChannel, CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { ApplicationCommandTypes, MessageFlags } from 'oceanic.js'
import { codeBlock } from '../utils/formatting'
import { LangCodeToName, translateText } from '../utils/translate'

export const description: CreateApplicationCommandOptions = {
  name: 'Translate Message',
  type: ApplicationCommandTypes.MESSAGE,
}

export async function handler(interaction: CommandInteraction<AnyInteractionChannel, ApplicationCommandTypes.MESSAGE>) {
  const text = interaction.data.target.content
  interaction.defer()

  const translation = await translateText({ text, sourceLanguage: undefined, targetLanguage: 'en' })
  if (Error.isError(translation)) {
    return interaction.reply({
      flags: MessageFlags.EPHEMERAL,
      content: `⚠️ translation failed:\n${codeBlock(translation.message)}`,
    })
  }

  interaction.reply({ content: `${translation.translatedText}\n-# ${LangCodeToName[translation.detectedLanguageCode]} -> English` })
}

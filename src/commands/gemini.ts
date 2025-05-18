import type { GenerateContentConfig } from '@google/genai'
import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { GoogleGenAI } from '@google/genai'
import { env } from 'bun'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes } from 'oceanic.js'

const { GEMINI_KEY } = env
const ai = new GoogleGenAI({ apiKey: GEMINI_KEY! })

export const description: CreateApplicationCommandOptions = {
  name: 'gemini',
  description: 'ask gemini [google ai] a question',
  type: ApplicationCommandTypes.CHAT_INPUT,
  options: [
    {
      name: 'input',
      description: 'the input to gemini',
      type: ApplicationCommandOptionTypes.STRING,
      minLength: 2,
      maxLength: 1_000,
      required: true,
    },
    {
      name: 'model',
      description: 'the model to use',
      type: ApplicationCommandOptionTypes.STRING,
      choices: [
        {
          name: '2.0 flash (default)',
          value: 'gemini-2.0-flash',
        },
        // TODO: implement ratelimiting to 10 per 24 hours
        {
          name: '2.5 flash (thinking)',
          value: 'gemini-2.5-flash-preview-04-17',
        },
        // TODO: implement ratelimiting to 5 per 24 hours
        // {
        //   name: '2.5 pro',
        //   value: 'gemini-2.5-pro-preview-05-06',
        // },
      ],
      required: false,
    },
  ],
}

export async function handler(interaction: CommandInteraction) {
  interaction.defer()

  const input = interaction.data.options.getStringOption('input', true)
  const model = interaction.data.options.getStringOption('model')?.value ?? 'gemini-2.0-flash'

  const config: GenerateContentConfig = {
    systemInstruction: 'use discord markdown, try to keep your response concise and under 2000 characters',
  }
  if (model !== 'gemini-2.0-flash')
    config.thinkingConfig = { includeThoughts: true, thinkingBudget: 2_048 }

  let respText = await ai.models.generateContent({
    model,
    config,
    contents: [{
      role: 'user',
      parts: [{ text: input.value }],
    }],
  }).then(r => r.text!)

  await interaction.reply({
    content: respText.slice(0, 2000),
  })

  // incase resp length > 2000
  respText = respText.slice(2000)
  while (respText.length > 0) {
    await interaction.createFollowup({
      content: respText.slice(0, 2000),
    })
    respText = respText.slice(2000)
  }
}

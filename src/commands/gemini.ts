import type { GenerateContentConfig } from '@google/genai'
import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { GoogleGenAI } from '@google/genai'
import { env } from 'bun'
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, Constants } from 'oceanic.js'
import { codeBlock, split2000 } from '../utils/formatting'

const { GEMINI_KEY } = env
const ai = new GoogleGenAI({ apiKey: GEMINI_KEY! })

const PRO_USERS = env.PRO_USER_IDS!.split(',')
// I really really hope people understand this is a joke...
const NOT_PRO_MESSAGE = `# Whoops! <:whoops:1375727444199215124>
You are not in the pro(💎) user list!
Paypal fseusb@gmail.com \`$14.99\` and dm <@280411966126948353> your receipt :3
-# dm cassie for terms & conditions~`

export const description: CreateApplicationCommandOptions = {
  name: 'gemini',
  description: 'ask gemini [google ai] a question',
  type: ApplicationCommandTypes.CHAT_INPUT,
  options: [
    {
      name: 'input',
      description: 'the input to gemini',
      type: ApplicationCommandOptionTypes.STRING,
      maxLength: 1024,
      required: true,
    },
    {
      name: 'thinking',
      description: 'number of thinking tokens to use',
      type: ApplicationCommandOptionTypes.NUMBER,
      choices: Object.entries({
        'none': 0,
        'low': 1024,
        'medium': 4096,
        '💎 high ': 16384,
      }).map(([name, value]) => ({ name: `${name} (${value})`, value })),
    },
  ],
}

// gemini ignores the system prompt so here we are...
const systemInstruction = `use discord markdown, DO NOT UNDER ANY CIRCUMSTANCES USE MARKDOWN TABLES, ALWAYS keep your response concise and under 2000 characters
When writing code:
- **Style:** always use trailing commas, don't use semicolons in languages where they're optional (js/ts), favor single-line if statements without curly braces, and prioritize guard clauses for early exits.
- **Conciseness:** Write concise code using guard clauses and prefer methods instead of statements
- **Comments:** Add code comments sparingly. Focus on *why* something is done, especially for complex logic, rather than *what* is done. Only add high-value comments if necessary for clarity or if requested by the user. Do not edit comments that are separate from the code you are changing. *NEVER* talk to the user or describe your changes through comments.
- **Explaining Changes:** After completing a code modification or file operation *do not* provide summaries unless asked.`

export async function handler(interaction: CommandInteraction) {
  let input = interaction.data.options.getStringOption('input', true)!.value
  input = `${systemInstruction}\n\n${input}` // gemini just ignores system instruction so put it in user text as well
  const thinkingBudget = interaction.data.options.getNumberOption('thinking')?.value ?? 0

  if (thinkingBudget > 4_096 && !PRO_USERS.includes(interaction.user.id)) {
    return interaction.reply({
      content: NOT_PRO_MESSAGE,
      flags: Constants.MessageFlags.EPHEMERAL,
    })
  }

  interaction.defer()

  const config: GenerateContentConfig = {
    systemInstruction,
    thinkingConfig: { thinkingBudget },
    // enable use of google search grounding
    tools: [{ googleSearch: {} }],
  }
  const runtimeStart = performance.now()
  let respText = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    config,
    contents: [{
      role: 'user',
      parts: [{ text: input }],
    }],
  }).then(r => r.text!).catch(e => `⚠️ generation error:\n${codeBlock(e)}`)
  const runtime = ((performance.now() - runtimeStart) / 1000).toFixed(2)
  if (thinkingBudget > 0)
    respText = `-# thought for ${runtime} seconds\n${respText}`

  const replyChunks = split2000(respText.replaceAll(/(?<!\n)```/g, '\n```'))
  await interaction.reply({ content: replyChunks.shift() })
  for (const chunk of replyChunks)
    await interaction.createFollowup({ content: chunk })
}

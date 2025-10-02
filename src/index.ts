import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { env, Glob } from 'bun'
import { Client, InteractionContextTypes, InteractionTypes } from 'oceanic.js'

const { TOKEN, TEST } = env

const client = new Client({ auth: `Bot ${TOKEN}` })
client.on('error', err => console.error('Bot Error:', err))
client.connect()
await new Promise<void>(r => client.on('ready', r))

console.log('Initialized as', client.user.tag)

// get commands
const commands: {
  description: CreateApplicationCommandOptions
  handler: (interaction: CommandInteraction) => Promise<void> | void
}[] = await Promise.all(Iterator.from(new Glob('./commands/**.ts').scanSync('src')).map(f => import(f)).toArray()) // no pipe operator stinky (please just give me elixir with a tiny runtime and packages for scripting)

// modify descriptions
commands.forEach(({ description }) => {
  // prefix commands with test_ prefix if running in test environment
  if (TEST) description.name = `test_${description.name}`
  // usable in all message contexts
  description.contexts = [InteractionContextTypes.BOT_DM, InteractionContextTypes.GUILD, InteractionContextTypes.PRIVATE_CHANNEL]
})

// register commands with discord
await client.application.bulkEditGlobalCommands(commands.map(c => c.description))
client.on('interactionCreate', async (interaction) => {
  if (interaction.type !== InteractionTypes.APPLICATION_COMMAND)
    return console.error(`unhandled interaction type: ${interaction.type}`)

  console.log(
    `@${interaction.user.username} /${interaction.data.name}`,
    interaction.data.options.raw.filter(o => 'value' in o).map(o => `${o.name}:${o.value}`).join(' '),
  )

  const usedCommand = commands.find(command => command.description.name === interaction.data.name)
  if (!usedCommand)
    return console.error(`received interaction for unknown command ${interaction.data.name}`)

  await usedCommand.handler(interaction)
})

import type { CommandInteraction, CreateApplicationCommandOptions } from 'oceanic.js'
import { join as joinPath } from 'node:path'
import { env } from 'bun'
import { Client, InteractionContextTypes, InteractionTypes } from 'oceanic.js'
import rra from 'recursive-readdir-async'

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
}[] = await rra.list(joinPath(__dirname, 'commands')) // recursively get the path to every command in ./commands
  .then(r => r.map((file: any) => file.fullnameb.toString())) // for some reason this HATES giving the real file names
  .then((fileNames: string[]) => Promise.all(fileNames.map(f => import(f)))) // import each command file

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
